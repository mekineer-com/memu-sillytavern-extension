import { OVERRIDE_SUMMARIZER, memuExtras, st } from "utils/context-extra";
import {
    addPendingRetrieveToPrompt,
    summaryIfNeed,
    getChatIdSafe,
    retrieveForLatestUserMessage,
    dispatchConversationTurn,
    dropPendingTurnIfStopped,
    resetRetrievePipelineState,
} from "./memorize";
import { setIsTerminated, startSummaryPolling, stopSummaryPolling } from "./summary-poller";
import { initChatExtraInfo } from "./utils";
import { getPluginPing, scopeStorageProbe } from "utils/network";
import { info, warn } from "utils/log";
import { getInspectData, stashInspectData } from "ui/inspect-panel";
import { main_api } from "@silly-tavern/script.js";

const summaryIfNeedDebounced = st.debounce(() => {
    try {
        void summaryIfNeed();
    } catch { }
}, st.debounce_timeout.extended);

const staleCursorResetOnceByScope = new Set<string>();
let lastGenerationStoppedAt = 0;

function stripWorldInfoInjection(eventData: any): void {
    const chat = eventData?.chat;
    if (!Array.isArray(chat) || chat.length === 0) return;

    for (let i = chat.length - 1; i >= 0; i--) {
        const row: any = chat[i];
        const id = String(row?.identifier || '');
        if (id === 'worldInfoBefore' || id === 'worldInfoAfter') {
            chat.splice(i, 1);
        }
    }
}

/**
 * Reset stale local cursor state on chat-open in two deterministic cases:
 * 1) backend restarted with ephemeral DB (in-memory reset),
 * 2) scoped backend storage (userId+soulId) is missing or empty.
 *
 * Case (2) is one-shot per chat scope to avoid repeated wipes when backend is still warming up.
 */
async function maybeClearStaleLocalState(): Promise<void> {
    const chatId = getChatIdSafe();
    const userId = String(memuExtras.baseInfo?.userId || '').trim();
    const soulId = String(memuExtras.baseInfo?.characterId || '').trim();

    const cached = memuExtras.retrieve?.nowRetrieve?.summary;
    const hasCached = !!cached && cached.trim().length > 0;
    const hasCursor = hasCached || !!memuExtras.summary?.summaryRange;

    if (!hasCursor) return;

    let changed = false;

    let ping: any = null;
    try {
        ping = await getPluginPing();
    } catch { }

    const pingSession = (ping?.serverInstanceId) as (string | undefined);
    const pingEphemeral = !!ping?.ephemeralDb;
    const prevSession = memuExtras.serverInstanceId;

    let cursorCleared = false;

    // If the server restarted AND the DB is ephemeral (in-memory), our cached cursor is guaranteed stale.
    if (pingSession && pingEphemeral && hasCursor && prevSession !== pingSession) {
        memuExtras.summary = undefined;
        memuExtras.retrieve = undefined;
        changed = true;
        cursorCleared = true;
        info(`cursor cleared (server restarted with in-memory db, old=${String(prevSession || 'none')}, new=${pingSession})`);
    }

    const scopeKey = (chatId && userId && soulId) ? `${chatId}::${userId}::${soulId}` : '';

    // If scoped storage is missing/empty but we still have a local cursor, clear once so digest restarts at 0.
    if (!cursorCleared && hasCursor && userId && soulId) {
        try {
            const probe = await scopeStorageProbe(userId, soulId);
            const missingOrEmpty = probe?.ok === true && probe?.missingOrEmpty === true;
            if (missingOrEmpty) {
                const alreadyReset = scopeKey ? staleCursorResetOnceByScope.has(scopeKey) : false;
                if (!alreadyReset) {
                    memuExtras.summary = undefined;
                    memuExtras.retrieve = undefined;
                    changed = true;
                    cursorCleared = true;
                    if (scopeKey) staleCursorResetOnceByScope.add(scopeKey);
                    info(`cursor cleared (storage probe missing/empty, userId=${userId}, soulId=${soulId}, reason=${String(probe?.reason || 'none')})`);
                }
            } else if (scopeKey) {
                // Storage recovered/populated: allow a future one-shot reset if the DB is reset again.
                staleCursorResetOnceByScope.delete(scopeKey);
            }
        } catch { }
    }

    if (pingSession && prevSession !== pingSession) {
        memuExtras.serverInstanceId = pingSession;
        changed = true;
    }

    if (changed) {
        await st.saveChat();
    }
}

export function onMessageReceived(_msgIdAny: any): void {
    summaryIfNeedDebounced();
}

export function onUserMessageSent(msgIdAny: any): void {
    retrieveForLatestUserMessage(msgIdAny);
}

export function onMessageEdited(_msgIdAny: any): void {
    summaryIfNeedDebounced();
}

export function onMessageSwiped(_msgIdAny: any): void {
    summaryIfNeedDebounced();
}

export function onGenerationStopped(): void {
    lastGenerationStoppedAt = Date.now();
}

export async function onChatCompletionPromptReady(eventData: any): Promise<void> {
    if (eventData?.dryRun) return;
    if (!Array.isArray(eventData?.chat)) return;
    try {
        // Keep ST lorebooks UI-only; never inject World Info into model context.
        stripWorldInfoInjection(eventData);
        await addPendingRetrieveToPrompt(eventData, OVERRIDE_SUMMARIZER.get());
    } catch (e: any) {
        const msg = e instanceof Error ? e.message : String(e);
        warn(`memu retrieve skipped: ${msg}`);
        const prev = getInspectData();
        stashInspectData({
            ...(prev || { timestamp: Date.now() }),
            timestamp: Date.now(),
            status: 'error',
            error: msg,
        });
    }
}

export async function onGenerateAfterCombinePrompts(eventData: any): Promise<void> {
    if (eventData?.dryRun) return;
    if (main_api === 'openai') return;
    if (typeof eventData?.prompt !== 'string') return;
    try {
        await addPendingRetrieveToPrompt(eventData, OVERRIDE_SUMMARIZER.get());
    } catch (e: any) {
        const msg = e instanceof Error ? e.message : String(e);
        warn(`memu retrieve skipped: ${msg}`);
        const prev = getInspectData();
        stashInspectData({
            ...(prev || { timestamp: Date.now() }),
            timestamp: Date.now(),
            status: 'error',
            error: msg,
        });
    }
}

export async function onGenerateAfterData(generateData: any, dryRun?: boolean): Promise<void> {
    if (dryRun) return;
    if (dropPendingTurnIfStopped(lastGenerationStoppedAt)) {
        const prev = getInspectData();
        stashInspectData({
            ...(prev || { timestamp: Date.now() }),
            timestamp: Date.now(),
            turnStatus: 'error',
            turnError: 'Generation cancelled before memU turn dispatch',
        });
        return;
    }
    try {
        await dispatchConversationTurn(generateData, { debug: true });
    } catch (e: any) {
        const msg = e instanceof Error ? e.message : String(e);
        const prev = getInspectData();
        stashInspectData({
            ...(prev || { timestamp: Date.now() }),
            timestamp: Date.now(),
            turnStatus: 'error',
            turnError: msg,
        });
        throw e;
    }
}

export function onChatChanged(): void {
    const ctx = st.getContext();
    resetRetrievePipelineState();

    if (ctx.getCurrentChatId() === undefined) {
        stopSummaryPolling();
        return;
    }

    async function init() {
        try {
            setIsTerminated(false);
            await initChatExtraInfo(ctx);
            window.dispatchEvent(new Event('memu:server-ready'));
            await maybeClearStaleLocalState();
            startSummaryPolling();
            // On chat-open: run the normal "should we memorize?" check.
            summaryIfNeedDebounced();
        } catch { }
    }
    void init();
}
