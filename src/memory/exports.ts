import { OVERRIDE_SUMMARIZER, memuExtras, st } from "utils/context-extra";
import {
    cancelPendingRetrieveRequest,
    getChatIdSafe,
    dispatchConversationTurn,
    preparePendingRetrieveTurnForInterceptor,
    dropPendingTurnIfStopped,
    resetRetrievePipelineState,
} from "./memorize";
import { setIsTerminated, startSummaryPolling, stopSummaryPolling } from "./summary-poller";
import { initChatExtraInfo } from "./utils";
import { getPluginPing, scopeStorageProbe, conversationTurnUndo } from "utils/network";
import { info } from "utils/log";
import { getInspectData, stashInspectData } from "ui/inspect-panel";

const staleCursorResetOnceByScope = new Set<string>();
let lastGenerationStoppedAt = 0;
let _pendingSwipeUndo: Promise<void> | null = null;
let _lastChatLength = 0;
let _lastTailIsUser = false;

function refreshChatSnapshot(): void {
    const ctx = st.getContext();
    const chat = Array.isArray(ctx?.chat) ? ctx.chat : [];
    _lastChatLength = chat.length;
    _lastTailIsUser = !!chat[chat.length - 1]?.is_user;
}

async function waitForPendingSwipeUndo(): Promise<void> {
    const pending = _pendingSwipeUndo;
    if (!pending) return;
    try {
        await pending;
    } finally {
        if (_pendingSwipeUndo === pending) {
            _pendingSwipeUndo = null;
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

    const ping = await getPluginPing();
    if (ping?.ok !== true) {
        throw new Error(`memu plugin ping failed: ${String((ping as any)?.error || 'unknown error')}`);
    }

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
        const probe = await scopeStorageProbe(userId, soulId);
        if (probe?.ok !== true) {
            throw new Error(`memu scopeStorageProbe failed: ${String((probe as any)?.reason || 'unknown error')}`);
        }
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
        } else if (scopeKey && probe?.ok === true) {
            // Storage recovered/populated: allow a future one-shot reset if the DB is reset again.
            staleCursorResetOnceByScope.delete(scopeKey);
        }
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
    refreshChatSnapshot();
}

export function onUserMessageSent(_msgIdAny: any): void {
    refreshChatSnapshot();
}

export function onMessageEdited(_msgIdAny: any): void {
    refreshChatSnapshot();
}

export function onMessageDeleted(): void {
    const ctx = st.getContext();
    const conversationId = getChatIdSafe();
    const userId = String(memuExtras.baseInfo?.userId || '');
    const soulId = String(ctx.characters?.[ctx.characterId]?.name || '');
    const chat = Array.isArray(ctx?.chat) ? ctx.chat : [];
    const nowLength = chat.length;
    const nowTailIsUser = !!chat[nowLength - 1]?.is_user;
    const deletedLatestAssistant = _lastChatLength === nowLength + 1 && !_lastTailIsUser && nowTailIsUser;
    if (deletedLatestAssistant && conversationId && userId && soulId) {
        _pendingSwipeUndo = conversationTurnUndo(conversationId, userId, soulId);
    }
    refreshChatSnapshot();
}

export function onMessageSwiped(_msgIdAny: any): void {
    const ctx = st.getContext();
    const conversationId = getChatIdSafe();
    const userId = String(memuExtras.baseInfo?.userId || '');
    const soulId = String(ctx.characters?.[ctx.characterId]?.name || '');
    if (conversationId && userId && soulId) {
        _pendingSwipeUndo = conversationTurnUndo(conversationId, userId, soulId);
    }
    refreshChatSnapshot();
}

export function onGenerationStopped(): void {
    lastGenerationStoppedAt = Date.now();
    cancelPendingRetrieveRequest('Retrieve cancelled by stop button');
}

function _skipInterceptorType(type: string): boolean {
    return type === 'quiet' || type === 'impersonate';
}

function stampLatestSoulMessageGenerationMetadata(ctx: any, metadata: any): void {
    if (!metadata || typeof metadata !== 'object') return;
    const api = typeof metadata.api === 'string' ? metadata.api.trim() : '';
    const model = typeof metadata.model === 'string' ? metadata.model.trim() : '';
    if (!api && !model) return;

    const chat = Array.isArray(ctx?.chat) ? ctx.chat : [];
    const message = chat[chat.length - 1];
    if (!message || message.is_user) return;

    message.extra = message.extra && typeof message.extra === 'object' ? message.extra : {};
    if (api) message.extra.api = api;
    if (model) message.extra.model = model;

    const swipeId = typeof message.swipe_id === 'number' ? message.swipe_id : 0;
    const swipeInfo = Array.isArray(message.swipe_info) ? message.swipe_info[swipeId] : null;
    if (swipeInfo && typeof swipeInfo === 'object') {
        swipeInfo.extra = swipeInfo.extra && typeof swipeInfo.extra === 'object' ? swipeInfo.extra : {};
        if (api) swipeInfo.extra.api = api;
        if (model) swipeInfo.extra.model = model;
    }
}

export async function memuGenerationInterceptor(
    _chat: any[],
    _contextSize: number,
    abort: (immediately?: boolean) => void,
    type: string,
): Promise<void> {
    if (_skipInterceptorType(String(type || '').trim())) return;
    abort(true);
    await waitForPendingSwipeUndo();
    if (dropPendingTurnIfStopped(lastGenerationStoppedAt)) {
        return;
    }
    try {
        const prepared = await preparePendingRetrieveTurnForInterceptor(OVERRIDE_SUMMARIZER.get());
        if (!prepared) {
            throw new Error('memU retrieve prep failed — turn blocked.');
        }
        const turnResult = await dispatchConversationTurn({ debug: true });
        const reply = turnResult.reply;
        const ctx: any = st.getContext();
        if (reply && typeof ctx?.saveReply !== 'function') {
            throw new Error('SillyTavern context.saveReply is unavailable');
        }
        if (reply) {
            await ctx.saveReply({ type, getMessage: reply });
            stampLatestSoulMessageGenerationMetadata(ctx, turnResult.generationMetadata);
        }
        await st.saveChat();
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
        refreshChatSnapshot();
        return;
    }

    async function init() {
        setIsTerminated(false);
        await initChatExtraInfo(ctx);
        window.dispatchEvent(new Event('memu:server-ready'));
        startSummaryPolling();
        await maybeClearStaleLocalState();
        refreshChatSnapshot();
    }
    void init().catch((error) => window.alert(`memU: ${error instanceof Error ? error.message : String(error)}`));
}
