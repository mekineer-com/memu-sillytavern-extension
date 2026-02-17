import { OVERRIDE_SUMMARIZER, memuExtras, st } from "utils/context-extra";
import { addSummaryToPrompt, summaryIfNeed, clearLocalCursor, ensureMemULorebooksUiOnly, healOrphanLocalCursorIfNeeded, getChatIdSafe } from "./memorize";
import { setIsTerminated, startSummaryPolling, stopSummaryPolling } from "./summary-poller";
import { initChatExtraInfo } from "./utils";
import { getPluginConfig, getPluginPing, retrieveDefaultCategories } from "utils/network";

const summaryIfNeedDebounced = st.debounce(() => {
    try {
        void summaryIfNeed();
    } catch { }
}, st.debounce_timeout.extended);



/**
 * If memU is running in local mode with an in-memory DB, a SillyTavern restart wipes the DB.
 * The chat metadata (memuExtras.summary/retrieve) may still say "already processed", which makes
 * the extension skip memorizing. So on chat-load we do a cheap probe:
 * - If we have cached memU output, but local retrieve returns nothing, we clear the cached cursor.
 */
async function maybeClearStaleLocalState(): Promise<void> {
    const chatId = getChatIdSafe();

    const cached = memuExtras.retrieve?.nowRetrieve?.summary;
    const hasCached = !!cached && cached.trim().length > 0;
    const hasCursor = hasCached || !!memuExtras.summary?.summaryRange;

    if (!hasCursor) return;

    let changed = false;

    let cfg: any;
    try {
        cfg = await getPluginConfig();
    } catch {
        return;
    }
    if (cfg?.mode !== 'local') return;

    const base = memuExtras.baseInfo;
    if (!base) return;

    let ping: any = null;
    try {
        ping = await getPluginPing();
    } catch { }

    try {
        // Local backend ignores apiKey, so empty string is fine.
        const resp: any = await retrieveDefaultCategories('', base.userId, base.characterId);
        const cats = Array.isArray(resp?.categories) ? resp.categories : [];
        const hasAnyUseful = cats.some((c: any) => {
            const s = String(c?.summary ?? '').trim();
            if (!s) return false;
            const low = s.toLowerCase();
            if (low === 'null' || low === 'none' || low === 'undefined' || low === 'n/a' || low === 'na') return false;
            return true;
        });
        if (!hasAnyUseful && hasCursor) {
            memuExtras.summary = undefined;
            memuExtras.retrieve = undefined;
            clearLocalCursor(chatId);
            changed = true;
            console.log('memu-ext: cleared stale memU cursor (local DB appears empty)');
        }
    } catch {
        // If the probe fails, don't destroy the user's cached state.
    }

    const pingSession = ping?.bridgeSessionId as (string | undefined);
    const pingEphemeral = !!ping?.ephemeralDb;
    const prevSession = memuExtras.bridgeSessionId;

    // If the local bridge restarted AND the DB is ephemeral (in-memory), our cached cursor is guaranteed stale.
    if (pingSession && pingEphemeral && hasCursor && prevSession !== pingSession) {
        memuExtras.summary = undefined;
        memuExtras.retrieve = undefined;
        clearLocalCursor(chatId);
        changed = true;
        console.log('memu-ext: cleared stale memU cursor (bridge restarted; in-memory DB)');
    }

    if (pingSession && prevSession !== pingSession) {
        memuExtras.bridgeSessionId = pingSession;
        changed = true;
    }

    if (changed) {
        await st.saveChat();
    }
}

export function onMessageReceived(_msgIdAny: any): void {
    summaryIfNeedDebounced();
}

export function onMessageEdited(_msgIdAny: any): void {
    summaryIfNeedDebounced();
}

export function onMessageSwiped(_msgIdAny: any): void {
    summaryIfNeedDebounced();
}

export function onChatCompletionPromptReady(eventData: any): void {
    if (eventData?.dryRun) return;
    addSummaryToPrompt(eventData, OVERRIDE_SUMMARIZER.get());
}

export function onChatChanged(): void {
    const ctx = st.getContext();

    if (ctx.getCurrentChatId() === undefined) {
        stopSummaryPolling();
        return;
    }

    async function init() {
        try {
            setIsTerminated(false);
            await initChatExtraInfo(ctx);
            await maybeClearStaleLocalState();

            // Heal older builds that advanced a cursor but never created lorebooks/state.
            // (Fixes "Seraphina has chatLen>0 but no memU lorebooks + no memorize")
            try { await healOrphanLocalCursorIfNeeded(); } catch { }

            // Keep memU lorebooks UI-only to avoid prompt token duplication.
            try { await ensureMemULorebooksUiOnly(); } catch { }
            startSummaryPolling();

            // On chat-open: run the normal "should we memorize?" check.
            // Only in local mode, so cloud users don't get surprise API calls.
            // This reads only from chat history, so it won't ever include Prompt Inspector / dry-run prompts.
            if ((localStorage.getItem('memu-plugin-mode') || 'cloud') === 'local') {
                summaryIfNeedDebounced();
            }
        } catch { }
    }
    void init();
}
