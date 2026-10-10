import { OVERRIDE_SUMMARIZER, memuExtras, st } from "utils/context-extra";
import {
    cancelPendingRetrieveRequest,
    getChatIdSafe,
    dispatchConversationTurn,
    preparePendingRetrieveTurnForInterceptor,
    dropPendingTurnIfStopped,
    resetRetrievePipelineState,
    bindSavedSource,
    publishSavedSource,
    SavedSource,
} from "./memorize";
import { setIsTerminated, startSummaryPolling, stopSummaryPolling } from "./summary-poller";
import { appReady, currentScope, initChatExtraInfo, isMemuActive, refreshMemuGate } from "./utils";
import { getPluginPing, scopeStorageProbe, conversationTurnUndo } from "utils/network";
import { info, error as logError } from "utils/log";
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

function queueConversationUndo(ctx: any, conversationId: string, soulId: string): void {
    const scope = currentScope(ctx);
    _pendingSwipeUndo = (async () => {
        if (!(await isMemuActive())) return;
        await initChatExtraInfo(ctx);
        if (currentScope() !== scope) return;
        const userId = String(memuExtras.baseInfo?.userId || '');
        if (conversationId && userId && soulId) {
            await conversationTurnUndo(conversationId, userId, soulId);
        }
    })();
}

/**
 * Reset stale local cursor state on chat-open in two deterministic cases:
 * 1) backend restarted with ephemeral DB (in-memory reset),
 * 2) scoped backend storage (userId+soulId) is missing or empty.
 *
 * Case (2) is one-shot per chat scope to avoid repeated wipes when backend is still warming up.
 */
async function maybeClearStaleLocalState(): Promise<void> {
    const scope = currentScope();
    const chatId = getChatIdSafe();
    const userId = String(memuExtras.baseInfo?.userId || '').trim();
    const soulId = String(memuExtras.baseInfo?.characterId || '').trim();

    const cached = memuExtras.retrieve?.nowRetrieve?.summary;
    const hasCached = !!cached && cached.trim().length > 0;
    const hasCursor = hasCached || !!memuExtras.summary?.summaryRange;

    if (!hasCursor) return;

    let changed = false;

    const ping = await getPluginPing();
    if (!(await isMemuActive()) || currentScope() !== scope) return;
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
        if (!(await isMemuActive()) || currentScope() !== scope) return;
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

export async function onMessageReceived(_msgIdAny: any): Promise<void> {
    if (!(await isMemuActive())) return;
    refreshChatSnapshot();
}

export async function onUserMessageSent(_msgIdAny: any): Promise<void> {
    if (!(await isMemuActive())) return;
    refreshChatSnapshot();
}

export async function onMessageEdited(_msgIdAny: any): Promise<void> {
    if (!(await isMemuActive())) return;
    refreshChatSnapshot();
}

export async function onMessageDeleted(): Promise<void> {
    const scope = currentScope();
    if (!(await isMemuActive())) return;
    if (currentScope() !== scope) return;
    const ctx = st.getContext();
    const conversationId = getChatIdSafe();
    const soulId = String(ctx.characters?.[ctx.characterId]?.name || '');
    const chat = Array.isArray(ctx?.chat) ? ctx.chat : [];
    const nowLength = chat.length;
    const nowTailIsUser = !!chat[nowLength - 1]?.is_user;
    const deletedLatestAssistant = _lastChatLength === nowLength + 1 && !_lastTailIsUser && nowTailIsUser;
    if (deletedLatestAssistant && conversationId && soulId) {
        queueConversationUndo(ctx, conversationId, soulId);
    }
    refreshChatSnapshot();
    try {
        await initChatExtraInfo(ctx);
        if (currentScope() !== scope) return;
        const source = bindSavedSource(ctx);
        if (currentScope() !== scope) return;
        await publishSavedSource(source, 'publish_only');
    } catch (error) {
        logError('Saved chat publication after deletion failed', error);
        if (currentScope() === scope) window.alert(`memU saved chat publication failed: ${error instanceof Error ? error.message : String(error)}`);
    }
}

export async function onMessageSwiped(msgIdAny: any): Promise<void> {
    if (!(await isMemuActive())) return;
    const ctx = st.getContext();
    const conversationId = getChatIdSafe();
    const soulId = String(ctx.characters?.[ctx.characterId]?.name || '');
    const chat = Array.isArray(ctx?.chat) ? ctx.chat : [];
    const messageId = Number(msgIdAny);
    const message = chat[messageId];
    const isSyntheticRegeneration = messageId === chat.length - 1
        && message && !message.is_user
        && Array.isArray(message.swipes)
        && message.swipe_id === message.swipes.length;
    if (isSyntheticRegeneration && conversationId && soulId) {
        queueConversationUndo(ctx, conversationId, soulId);
    }
    refreshChatSnapshot();
}

export async function onGenerationStopped(): Promise<void> {
    if (!(await isMemuActive())) return;
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
    const scope = currentScope();
    try {
        const active = await isMemuActive();
        if (currentScope() !== scope) {
            abort(true);
            return;
        }
        if (!active) return;
    } catch (error) {
        abort(true);
        window.alert(`memU: ${error instanceof Error ? error.message : String(error)}`);
        return;
    }
    abort(true);
    if (type === 'continue') {
        window.alert('memU does not support Continue. Send a new message instead.');
        return;
    }
    await waitForPendingSwipeUndo();
    if (currentScope() !== scope) return;
    if (dropPendingTurnIfStopped(lastGenerationStoppedAt)) {
        return;
    }
    let savedSource: SavedSource | undefined;
    try {
        const prepared = await preparePendingRetrieveTurnForInterceptor(OVERRIDE_SUMMARIZER.get());
        if (currentScope() !== scope) return;
        if (!prepared) {
            throw new Error('memU retrieve prep failed — turn blocked.');
        }
        const turnResult = await dispatchConversationTurn({ debug: true });
        if (currentScope() !== scope) return;
        savedSource = turnResult.savedSource;
        const reply = turnResult.reply;
        const ctx: any = st.getContext();
        if (reply && typeof ctx?.saveReply !== 'function') {
            throw new Error('SillyTavern context.saveReply is unavailable');
        }
        if (reply) {
            await ctx.saveReply({ type, getMessage: reply });
            if (currentScope() !== scope) return;
            stampLatestSoulMessageGenerationMetadata(ctx, turnResult.generationMetadata);
        }
        if (currentScope() !== scope) return;
        await st.saveChat();
    } catch (e: any) {
        if (currentScope() !== scope) return;
        const msg = e instanceof Error ? e.message : String(e);
        const prev = getInspectData();
        stashInspectData({
            ...(prev || { timestamp: Date.now() }),
            timestamp: Date.now(),
            turnStatus: 'error',
            turnError: msg,
            errorCode: e?.code,
            userId: memuExtras.baseInfo?.userId,
            soulId: memuExtras.baseInfo?.characterId,
        });
        throw e;
    }
    if (!savedSource || currentScope() !== scope) return;
    try {
        await publishSavedSource(savedSource, 'automatic');
    } catch (error) {
        logError('Saved chat Memorize after reply failed', error);
        if (currentScope() === scope) window.alert(`memU saved chat Memorize failed: ${error instanceof Error ? error.message : String(error)}`);
    }
}

export function onChatChanged(): void {
    const ctx = st.getContext();
    const scope = currentScope(ctx);
    resetRetrievePipelineState();
    stopSummaryPolling();
    refreshMemuGate();
    _pendingSwipeUndo = null;

    if (ctx.getCurrentChatId() === undefined) {
        stopSummaryPolling();
        refreshChatSnapshot();
        return;
    }

    async function init() {
        await appReady;
        if (!(await isMemuActive()) || currentScope() !== scope) return;
        await initChatExtraInfo(ctx);
        if (!(await isMemuActive()) || currentScope() !== scope) return;
        setIsTerminated(false);
        window.dispatchEvent(new Event('memu:server-ready'));
        startSummaryPolling();
        await maybeClearStaleLocalState();
        refreshChatSnapshot();
    }
    void init().catch((error) => window.alert(`memU: ${error instanceof Error ? error.message : String(error)}`));
}
