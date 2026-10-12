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
let _pendingUndo: Promise<void> | null = null;
let _lastReplyMessage: any;
let _lastReplyTurnId = '';
let _lastSelectedTurnId = '';
let _lastSelectedSwipes: number[] = [];
let _deletedSelectedSwipe: number | null = null;

function replyTurnId(message: any): string {
    if (!message || message.is_user || !message.gen_finished) return '';
    const finished = new Date(message.gen_finished).getTime();
    // Stock ST copies extras into new swipes; only the original generation qualifies.
    return Number.isFinite(finished) && message.extra?.memu_turn_finished === finished
        ? String(message.extra?.memu_turn_id || '') : '';
}

function refreshChatSnapshot(): void {
    const ctx = st.getContext();
    const chat = Array.isArray(ctx?.chat) ? ctx.chat : [];
    _lastSelectedSwipes = chat.map(message => message.swipe_id ?? 0);
    _lastSelectedTurnId = replyTurnId(chat[chat.length - 1]);
    _lastReplyMessage = undefined;
    _lastReplyTurnId = '';
    for (let i = chat.length - 1; i >= 0; i--) {
        const variants = replyVariants(chat[i]).filter(variant => replyTurnId(variant))
            .sort((a, b) => new Date(b.gen_finished).getTime() - new Date(a.gen_finished).getTime());
        if (!variants.length) continue;
        _lastReplyMessage = chat[i];
        _lastReplyTurnId = replyTurnId(variants[0]);
        break;
    }
}

function replyVariants(message: any): any[] {
    return !message || message.is_user ? [] : [message, ...(message.swipe_info || [])];
}

async function waitForPendingUndo(): Promise<void> {
    const pending = _pendingUndo;
    if (!pending) return;
    try {
        await pending;
    } finally {
        if (_pendingUndo === pending) {
            _pendingUndo = null;
        }
    }
}

function queueConversationUndo(conversationId: string, userId: string, soulId: string, turnId: string): void {
    if (!turnId) return;
    _pendingUndo = (_pendingUndo || Promise.resolve())
        .then(() => conversationTurnUndo(conversationId, userId, soulId, turnId))
        .then(() => {}, error => {
            logError('Reply Undo failed', error);
            window.alert(`memU reply Undo failed: ${error instanceof Error ? error.message : String(error)}`);
        });
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
    refreshChatSnapshot();
}

export const onUserMessageSent = onMessageReceived;
export const onMessageEdited = onMessageReceived;

export async function onMessageDeleted(): Promise<void> {
    const scope = currentScope();
    const turnId = _lastReplyTurnId;
    const reply = _lastReplyMessage;
    try {
        if (!(await isMemuActive())) {
            if (currentScope() === scope) refreshChatSnapshot();
            return;
        }
        if (currentScope() !== scope) return;
        const ctx = st.getContext();
        const chat = Array.isArray(ctx?.chat) ? ctx.chat : [];
        const info = memuExtras.baseInfo;
        const removed = !chat.includes(reply) || !replyVariants(reply).some(variant => replyTurnId(variant) === turnId);
        if (removed && info) {
            queueConversationUndo(getChatIdSafe(), info.userId, info.characterId, turnId);
        }
        refreshChatSnapshot();
        await initChatExtraInfo(ctx);
        if (currentScope() !== scope) return;
        await ctx.saveChat();
        if (currentScope() !== scope) return;
        const source = bindSavedSource(ctx);
        await publishSavedSource(source, 'publish_only');
    } catch (error) {
        logError('Saved chat publication after deletion failed', error);
        if (currentScope() === scope) window.alert(`memU saved chat publication failed: ${error instanceof Error ? error.message : String(error)}`);
    }
}

export async function onMessageSwipeDeleted({ messageId, swipeId }: { messageId: number; swipeId: number }): Promise<void> {
    if (swipeId === _lastSelectedSwipes[messageId]) {
        // Stock ST replaces the displayed text in the following MESSAGE_SWIPED event.
        _deletedSelectedSwipe = messageId;
        return;
    }
    await onMessageDeleted();
}

export async function onMessageSwiped(msgIdAny: any): Promise<void> {
    if (_deletedSelectedSwipe === Number(msgIdAny)) {
        _deletedSelectedSwipe = null;
        await onMessageDeleted();
        return;
    }
    const scope = currentScope();
    const turnId = _lastSelectedTurnId;
    if (!(await isMemuActive())) {
        refreshChatSnapshot();
        return;
    }
    if (currentScope() !== scope) return;
    const ctx = st.getContext();
    const conversationId = getChatIdSafe();
    const info = memuExtras.baseInfo;
    const chat = Array.isArray(ctx?.chat) ? ctx.chat : [];
    const messageId = Number(msgIdAny);
    const message = chat[messageId];
    const isSyntheticRegeneration = messageId === chat.length - 1
        && message && !message.is_user
        && Array.isArray(message.swipes)
        && message.swipe_id === message.swipes.length;
    if (isSyntheticRegeneration && conversationId && info) {
        queueConversationUndo(conversationId, info.userId, info.characterId, turnId);
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
    const turnId = String(metadata.turn_id || '');
    if (!api && !model && !turnId) return;

    const chat = Array.isArray(ctx?.chat) ? ctx.chat : [];
    const message = chat[chat.length - 1];
    if (!message || message.is_user) return;

    message.extra = message.extra && typeof message.extra === 'object' ? message.extra : {};
    if (api) message.extra.api = api;
    if (model) message.extra.model = model;
    const finished = message.gen_finished ? new Date(message.gen_finished).getTime() : NaN;
    if (turnId && Number.isFinite(finished)) {
        message.extra.memu_turn_id = turnId;
        message.extra.memu_turn_finished = finished;
    }

    const swipeId = typeof message.swipe_id === 'number' ? message.swipe_id : 0;
    const swipeInfo = Array.isArray(message.swipe_info) ? message.swipe_info[swipeId] : null;
    if (swipeInfo && typeof swipeInfo === 'object') {
        swipeInfo.extra = swipeInfo.extra && typeof swipeInfo.extra === 'object' ? swipeInfo.extra : {};
        if (api) swipeInfo.extra.api = api;
        if (model) swipeInfo.extra.model = model;
        if (turnId && Number.isFinite(finished)) {
            swipeInfo.extra.memu_turn_id = turnId;
            swipeInfo.extra.memu_turn_finished = finished;
        }
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
    await waitForPendingUndo();
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
        const undoAbandonedReply = () => {
            const data = turnResult.savedSource?.data;
            if (data) queueConversationUndo(data.conversationId, data.userId, data.characterId,
                turnResult.generationMetadata?.turn_id || '');
        };
        if (currentScope() !== scope) {
            undoAbandonedReply();
            return;
        }
        savedSource = turnResult.savedSource;
        const reply = turnResult.reply;
        const ctx: any = st.getContext();
        if (reply && typeof ctx?.saveReply !== 'function') {
            throw new Error('SillyTavern context.saveReply is unavailable');
        }
        if (reply) {
            try {
                await ctx.saveReply({ type, getMessage: reply });
            } finally {
                if (currentScope() !== scope) undoAbandonedReply();
            }
            if (currentScope() !== scope) return;
            stampLatestSoulMessageGenerationMetadata(ctx, turnResult.generationMetadata);
            refreshChatSnapshot();
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
    refreshChatSnapshot();
    resetRetrievePipelineState();
    stopSummaryPolling();
    refreshMemuGate();
    _deletedSelectedSwipe = null;

    if (ctx.getCurrentChatId() === undefined) {
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
