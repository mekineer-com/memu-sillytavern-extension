import { CategoryResponse } from "memu-js";
import { IMPORT_LOREBOOKS, MENTAL_HEALTH_ADDON, memuExtras, st } from "utils/context-extra";
import { conversationRetrieve, conversationTurn, conversationTurnUndo, memorizeConversation, MemorizeIntent, retrieveDefaultCategories } from "utils/network";
import { ConversationData, ConversationMessage, MemuSummary, MemuTaskStatus } from "utils/types";
import { postJsonWithCsrf } from "utils/csrf";
import { createWorldInfoEntry, saveWorldInfo, updateWorldInfoList } from "@silly-tavern/scripts/world-info.js";
import { srmmRequest, cardText, currentScope, initChatExtraInfo, isMemuActive, refreshSoulCard } from "./utils";
import { warn, error as logError, onceWarn, onceError } from "utils/log";
import {
    getInspectData,
    stashInspectData,
    InspectData,
    seedInspectPromptTextarea,
} from "ui/inspect-panel";

type PendingRetrieveTurn = {
    createdAt: number;
    conversationId: string;
    userId: string;
    userName: string;
    scope: string;
    soulId: string;
    queryText: string;
    queryTsMs?: number;
    querySourceId: string;
    history: Array<Record<string, any>>;
    chatName: string;
    chatType: string;
    preparedPayload: Record<string, any> | null;
    savedSource: SavedSource;
};

type PromptInspectorApiResult = {
    status?: string;
    prompt?: string;
};

type PromptInspectorApi = {
    inspectPayloadJson?: (payloadJson: string) => Promise<PromptInspectorApiResult | null | undefined>;
};

export type ConversationTurnDispatchResult = {
    reply: string;
    generationMetadata?: {
        api?: string;
        model?: string;
        turn_id?: string;
    };
    savedSource?: SavedSource;
};

export type SavedSource = {
    scope: string;
    selector: { file_name: string; avatar_url: string };
    data: Omit<ConversationData, 'messages' | 'source_message_count'>;
};

let savedSourceChain: Promise<void> = Promise.resolve();

export function withSavedSourceQueue<T>(operation: () => Promise<T>): Promise<T> {
    const queued = savedSourceChain.then(operation);
    savedSourceChain = queued.then(() => {}, () => {});
    return queued;
}

export function bindSavedSource(ctx: any = st.getContext()): SavedSource {
    const scope = currentScope(ctx);
    const character = ctx.characters?.[ctx.characterId];
    const info = memuExtras.baseInfo;
    if (ctx.groupId || !ctx.chatId || !character?.avatar || !info) {
        throw new Error('Saved chat selector or memU scope is missing');
    }
    const source = {
        scope,
        selector: { file_name: ctx.chatId, avatar_url: character.avatar },
        data: {
            ...info,
            conversationId: getChatIdSafe(),
            chatName: info.characterName,
        },
    };
    return source;
}

export function publishSavedSource(source: SavedSource, intent: MemorizeIntent,
    opts: { force?: boolean; tail?: boolean } = {}): Promise<void> {
    opts = { ...opts };
    return withSavedSourceQueue(async () => {
        const saved = await postJsonWithCsrf('/api/chats/get', source.selector);
        if (!Array.isArray(saved) || saved.length === 0) {
            throw new Error('Saved chat is missing or unreadable');
        }
        const hasHeader = saved[0] && Object.hasOwn(saved[0], 'chat_metadata');
        if (hasHeader && saved[0].chat_metadata?.main_chat) return;
        const rows = hasHeader ? saved.slice(1) : saved;
        if (rows.some(row => !row || typeof row.mes !== 'string')) {
            throw new Error('Saved chat contains unreadable message rows');
        }
        const response = await memorizeConversation({
            ...source.data,
            messages: buildTurnHistory(rows, rows.length, source.data.userName, source.data.characterName),
            source_message_count: rows.length,
        }, { ...opts, intent });
        if (response.status !== 'accepted' && response.status !== 'started') return;
        if (!response.taskId) throw new Error('Accepted Memorize response missing taskId');
        if (currentScope() !== source.scope) return;
        memuExtras.summary = {
            summaryRange: [0, rows.length - 1],
            summaryTaskId: response.taskId,
            summaryTaskStatus: MemuTaskStatus.PENDING,
            force: opts.force === true,
            tail: opts.tail === true,
            failureCount: 0,
        };
        await st.saveChat();
        if (currentScope() === source.scope) await syncLorebooksNow('after-memorize-local-pending');
    });
}

let _pendingRetrieveTurn: PendingRetrieveTurn | null = null;
let _pendingRetrieveAbort: AbortController | null = null;
let _pendingRetrieveAbortReason: string | null = null;
const RETRIEVE_REQUEST_TIMEOUT_MS = 90_000;

function isAbortError(err: any): boolean {
    if (!err) return false;
    const name = String((err as any)?.name || '').trim();
    if (name === 'AbortError') return true;
    const msg = String((err as any)?.message || err);
    return /\babort(ed)?\b/i.test(msg);
}

function isStopButtonCancelReason(reason: string): boolean {
    return /\bstop button\b/i.test(String(reason || ''));
}

export function getChatIdSafe(): string {
    try {
        const ctx: any = st.getContext() as any;

        // Prefer SillyTavern's per-chat integrity UUID as a stable key.
        // Chat ids can differ across contexts (display id vs internal id),
        // which would break local cursor persistence.
        const integrity = ctx?.chatMetadata?.integrity ?? (ctx as any)?.chat_metadata?.integrity;
        if (typeof integrity === 'string' && integrity.trim()) {
            return `integrity:${integrity.trim()}`;
        }

        const id = (typeof ctx?.getCurrentChatId === 'function')
            ? ctx.getCurrentChatId()
            : (ctx?.chatId ?? ctx?.chat_id);
        return (typeof id === 'string' && id) ? `chat:${id}` : '';
    } catch {
        return '';
    }
}


export async function doSummary(from: number, to: number, opts: { force?: boolean; tail?: boolean } = {}): Promise<void> {
    const scope = currentScope();
    if (!(await isMemuActive()) || currentScope() !== scope) return;
    await initChatExtraInfo(st.getContext());
    if (currentScope() !== scope) return;
    if (memuExtras.baseInfo == null) {
        warn("memorize skipped: no baseInfo in chat metadata");
        return;
    }
    try {
        const source = bindSavedSource();
        if (currentScope() !== scope) return;
        await st.saveChat();
        if (currentScope() !== scope) return;
        await publishSavedSource(source, 'manual', opts);
    } catch (error) {
        if (currentScope() !== scope) return;
        logError(`memorize failed (range=${from}-${to})`, error);
        window.alert(`memU Memorize failed: ${error instanceof Error ? error.message : String(error)}`);
    }
}

export async function memorizeNow(): Promise<void> {
    const scope = currentScope();
    if (!(await isMemuActive()) || currentScope() !== scope) return;
    await initChatExtraInfo(st.getContext());
    if (currentScope() !== scope) return;
    const chat = st.getContext().chat;
    await doSummary(0, chat.length - 1, { tail: true });
}



// One-shot: (re)create and populate memU World Info lorebooks right now.
// Useful when lorebooks were deleted, or when digest/retrieve is delayed.
export async function syncLorebooksNow(reason: string = "manual"): Promise<void> {
    if (!(await isMemuActive())) return;
    const scope = currentScope();
    await initChatExtraInfo(st.getContext());
    if (currentScope() !== scope) return;
    if (!IMPORT_LOREBOOKS.get()) return;
    try {
        if (!memuExtras.baseInfo) return;
        const resp = await retrieveDefaultCategories(memuExtras.baseInfo.userId, memuExtras.baseInfo.characterId);
        if (currentScope() !== scope) return;
        const categories = (resp as any)?.categories ?? [];
        if (Array.isArray(categories) && categories.length) {
            await syncCategoriesToWorldInfo(memuExtras.baseInfo, categories);
        }
    } catch (e) {
        onceError(`lorebooks-sync-failed:${reason}`, `lorebooks sync failed (${reason})`, e);
    }
}

// Delete every lorebook whose name starts with prefix, optionally keeping names in keepSet.
async function deleteLorebooksByPrefix(prefix: string, keepSet?: Set<string>): Promise<void> {
    if (!(await isMemuActive())) return;
    const scope = currentScope();
    const csrfResp = await fetch('/csrf-token');
    const csrfJson = await csrfResp.json().catch(() => ({} as any));
    const token = (csrfJson && csrfJson.token) ? String(csrfJson.token) : '';
    if (currentScope() !== scope) return;
    const listResp = await fetch('/api/worldinfo/list', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-csrf-token': token },
        body: JSON.stringify({}),
    });
    const list = await listResp.json().catch(() => []);
    const all = Array.isArray(list) ? list : [];
    const targets = all
        .map((x: any) => String(x?.file_id || x?.name || '').trim())
        .filter((n: string) => !!n && n.startsWith(prefix) && !(keepSet?.has(n)));
    for (const name of targets) {
        if (!(await isMemuActive()) || currentScope() !== scope) return;
        await fetch('/api/worldinfo/delete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-csrf-token': token },
            body: JSON.stringify({ name }),
        });
    }
}

// Delete every memU-managed lorebook for the current character.
// Called when the user unchecks Import Lorebooks so the ST World Info
// listing immediately reflects the new state.
export async function deleteMemuLorebooksForCurrentCharacter(): Promise<void> {
    if (!(await isMemuActive())) return;
    const scope = currentScope();
    await initChatExtraInfo(st.getContext());
    if (currentScope() !== scope) return;
    const info = memuExtras.baseInfo;
    if (!info) return;
    const sanitizedName = sanitizeWorldInfoName(String(info.characterName || '').trim());
    const prefix = `memU - ${sanitizedName} - `.slice(0, 120);
    if (prefix === 'memU -  - ') return;
    try {
        await deleteLorebooksByPrefix(prefix);
        await updateWorldInfoList();
        (st as any)?.eventSource?.emit?.((st as any)?.event_types?.SETTINGS_UPDATED);
    } catch (e) {
        onceError('lorebooks-delete-failed', 'lorebooks delete failed', e);
    }
}

export async function retrieveMemories(summary: MemuSummary): Promise<void> {
    if (!(await isMemuActive())) return;
    const scope = currentScope();
    await initChatExtraInfo(st.getContext());
    if (currentScope() !== scope) return;
    try {
        const response = await retrieveDefaultCategories(
            memuExtras.baseInfo.userId,
            memuExtras.baseInfo.characterId,
        );
        if (currentScope() !== scope || memuExtras.summary?.summaryTaskId !== summary.summaryTaskId) return;
        if (!response || typeof response !== 'object' || !Array.isArray((response as any).categories)) {
            throw new Error('retrieveDefaultCategories returned malformed payload: categories[] missing');
        }
        const categories = (response as any).categories as any[];
        const memuSummaryText = parseSummary(categories);

        // Put memU's retrieved summary into SillyTavern's built-in "Summarize/Memory" slot.
        // That extension stores the latest summary at chat[i].extra.memory (it ignores the last message),
        // so we write to the pre-last message to keep it visible + compatible.
        // Write memU categories into World Info lorebooks (one per category) so you can view them in the ST UI.
        try {
            await syncCategoriesToWorldInfo(memuExtras.baseInfo, categories);
        } catch (e) {
            onceWarn("worldinfo-sync-failed", "worldinfo sync failed");
        }

        if (currentScope() !== scope || memuExtras.summary?.summaryTaskId !== summary.summaryTaskId) return;
        const retrieve: any = memuExtras.retrieve ?? {
            history: [],
        };
        if (retrieve.nowRetrieve != null) {
            retrieve.history.push(retrieve.nowRetrieve);
        }
        retrieve.nowRetrieve = {
            summaryRange: summary.summaryRange,
            summaryTaskId: summary.summaryTaskId ?? "undefined",
            summary: memuSummaryText,
        };
        // Clear any prior failure for this taskId (avoid suppressing future retrieve attempts).
        if (retrieve.lastFailure?.summaryTaskId === summary.summaryTaskId) {
            delete retrieve.lastFailure;
        }
        memuExtras.retrieve = retrieve;
        await st.saveChat();
    } catch (error) {
        // Do not throw: if the backend is misconfigured (e.g., SQLModel list-type error),
        // throwing causes the poller to retry forever and spam logs.
        if (currentScope() !== scope || memuExtras.summary?.summaryTaskId !== summary.summaryTaskId) return;
        const retrieve: any = memuExtras.retrieve ?? { history: [] };
        const taskId = summary.summaryTaskId ?? 'undefined';
        const prev = retrieve.lastFailure?.summaryTaskId === taskId ? retrieve.lastFailure : null;
        const count = (prev?.failureCount ?? 0) + 1;
        retrieve.lastFailure = {
            summaryTaskId: taskId,
            failureCount: count,
            lastError: error instanceof Error ? error.message : String(error),
            lastFailureAt: Date.now(),
            lastAt: Date.now(),
        };
        memuExtras.retrieve = retrieve;
        await st.saveChat();
        if (count <= 2) {
            logError(`retrieve failed (taskId=${taskId}, attempts=${count})`, error);
        }
        return;
    }
}

function setLiveRetrieveSummary(text: string): void {
    const retrieve: any = memuExtras.retrieve ?? { history: [] };
    retrieve.liveRetrieve = { summary: text };
    memuExtras.retrieve = retrieve;
}

function clearLiveRetrieveSummary(): void {
    const retrieve: any = memuExtras.retrieve;
    if (!retrieve || typeof retrieve !== 'object' || !retrieve.liveRetrieve) return;
    delete retrieve.liveRetrieve;
    memuExtras.retrieve = retrieve;
}

function parsePriorContext(raw: any): { summary: string; inspectText: string } {
    if (raw == null) return { summary: '', inspectText: '' };

    let obj: any = raw;
    let parsedJson = false;
    if (typeof raw === 'string') {
        const trimmed = raw.trim();
        if (!trimmed) return { summary: '', inspectText: '' };
        try {
            obj = JSON.parse(trimmed);
            parsedJson = true;
        } catch {
            const clipped = trimmed.length > 2500 ? `${trimmed.slice(0, 2500)}\n\n…(truncated)` : trimmed;
            return { summary: '', inspectText: clipped };
        }
    }

    // Prior context should not carry categories (RAG already injects them each turn).
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
        obj = { ...obj, categories: [] };
    }

    const summary = parseRetrieveResult(obj);
    if (summary) return { summary, inspectText: summary };

    if (parsedJson || (obj && typeof obj === 'object')) {
        return { summary: '', inspectText: '' };
    }

    const asText = String(raw);
    const clipped = asText.length > 2500 ? `${asText.slice(0, 2500)}\n\n…(truncated)` : asText;
    return { summary: '', inspectText: clipped };
}

function formatMemoryCacheForPrompt(raw: any): string {
    if (!Array.isArray(raw)) return '';
    const lines = raw
        .map((v: any) => String(v ?? '').trim())
        .filter(Boolean)
        .slice(0, 7);
    if (lines.length === 0) return '';
    return lines.map((line) => `- ${line}`).join('\n');
}

function resolveSoulCard(ctx: any): string {
    const char = ctx?.characters?.[ctx?.characterId];
    if (!char) return '';
    const name = String(char.name || '').trim();
    const text = cardText(char);
    const description = text.description.trim();
    const personality = text.personality.trim();
    const scenario = text.scenario.trim();
    const mes_example = text.mes_example.trim();
    if (typeof char.data?.extensions?.memu?.description_auto === 'string' && !personality && !scenario && !mes_example) return '';

    const parts: string[] = [];
    if (name) parts.push(name);
    if (description) parts.push(description);
    if (personality) parts.push(`Personality:\n${personality}`);
    if (scenario) parts.push(`Scenario:\n${scenario}`);
    if (mes_example) parts.push(`Example dialogue:\n${mes_example}`);
    return parts.join('\n\n');
}

function resolveMessageTsMs(row: any): number | undefined {
    const numeric = (v: any): number | undefined => {
        if (v == null || (typeof v === 'string' && !v.trim())) return undefined;
        const n = typeof v === 'number' ? v : Number(v);
        if (!Number.isFinite(n)) return undefined;
        return Math.trunc(n);
    };

    const fromTsMs = numeric(row?.ts_ms);
    if (fromTsMs !== undefined) return fromTsMs;

    const fromTimestamp = numeric(row?.timestamp);
    if (fromTimestamp !== undefined) return fromTimestamp;

    const raw: any = row?.send_date ?? row?.sendDate;
    if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
    if (typeof raw === 'string') {
        const ms = Date.parse(raw);
        return Number.isFinite(ms) ? ms : undefined;
    }
    return undefined;
}

export function messageRole(row: any, ownerName: string, soulName: string = memuExtras.baseInfo?.characterName): 'user' | 'soul' | 'unknown' {
    if (row?.is_user) return row.name === ownerName ? 'user' : 'unknown';
    return row?.extra?.type !== 'narrator' && row?.name === soulName ? 'soul' : 'unknown';
}

function buildTurnHistory(chat: any[], endIdx: number, ownerName: string = memuExtras.baseInfo.userName,
    soulName: string = memuExtras.baseInfo.characterName): ConversationMessage[] {
    if (!Array.isArray(chat) || endIdx < 0) return [];
    const out: ConversationMessage[] = [];
    for (let i = 0; i < endIdx && i < chat.length; i++) {
        const row: any = chat[i];
        if (row?.is_system) continue;
        const content = String(row?.mes ?? '').trim();
        if (!content) continue;
        const role = messageRole(row, ownerName, soulName);
        const item: ConversationMessage = {
            role,
            content,
            name: String(row?.name || ''),
            source_message_id: String(i),
            source_conversation_index: i,
        };
        const tsMs = resolveMessageTsMs(row);
        if (tsMs !== undefined) item.ts_ms = tsMs;
        out.push(item);
    }
    return out;
}

function _chatContentText(raw: any): string {
    if (typeof raw === 'string') return raw.trim();
    if (Array.isArray(raw)) {
        return raw
            .map((part: any) => {
                if (typeof part === 'string') return part;
                if (part && typeof part === 'object' && typeof part.text === 'string') return part.text;
                return '';
            })
            .filter(Boolean)
            .join('\n')
            .trim();
    }
    if (raw && typeof raw === 'object' && typeof raw.text === 'string') {
        return raw.text.trim();
    }
    return '';
}

async function inspectPreparedTurnPayload(preparedPayload: Record<string, any>): Promise<string | null> {
    const api = (globalThis as any).memuPromptInspector as PromptInspectorApi | undefined;
    if (!api || typeof api.inspectPayloadJson !== 'function') {
        return null;
    }
    const payloadJson = JSON.stringify(preparedPayload, null, 2);
    const result = await api.inspectPayloadJson(payloadJson);
    if (!result || typeof result !== 'object') {
        throw new Error('Prompt Inspector returned invalid result — turn blocked.');
    }
    const status = String(result.status || '').trim().toLowerCase();
    if (status === 'cancelled') {
        throw new Error('Prompt Inspector cancelled generation — message not sent.');
    }
    if (status === 'disabled') {
        return null;
    }
    if (status === 'discarded') return null;
    if (status !== 'saved') return null;
    const prompt = String(result.prompt ?? '');
    return prompt.trim() ? prompt : null;
}

function applyPromptOverridePayload(
    basePayload: Record<string, any>,
    promptOverrideRaw: string,
): Record<string, any> {
    const trimmed = promptOverrideRaw.trim();
    if (!(trimmed.startsWith('{') || trimmed.startsWith('['))) {
        throw new Error('PI prompt must be JSON — message not sent.');
    }
    let parsed: any;
    let parseErr: string | null = null;
    for (const candidate of [trimmed, trimmed.replace(/,(\s*[}\]])/g, '$1')]) {
        try { parsed = JSON.parse(candidate); parseErr = null; break; } catch (e: any) { parseErr = e?.message || String(e); }
    }
    if (parseErr !== null) {
        throw new Error(`PI prompt invalid JSON — message not sent. Fix and retry. (${parseErr})`);
    }
    if (!parsed || typeof parsed !== 'object') {
        throw new Error('PI prompt must be a JSON object or message array — message not sent.');
    }
    const out: Record<string, any> = { ...basePayload };
    if (Array.isArray(parsed)) {
        // PI native format: [{role:'system',content:'...'},{role:'user',content:'...'}]
        const sys = parsed.find((m: any) => m?.role === 'system');
        const usr = [...parsed].reverse().find((m: any) => m?.role === 'user');
        if (!usr) throw new Error('PI message array has no user message — message not sent.');
        out.system_prompt = sys ? String(sys.content || '') : '';
        out.user_prompt = String(usr.content || '');
        return out;
    }
    const parsedObj = parsed as Record<string, any>;
    if (Object.prototype.hasOwnProperty.call(parsedObj, 'system_prompt')) {
        out.system_prompt = String(parsedObj.system_prompt || '');
    }
    if (Object.prototype.hasOwnProperty.call(parsedObj, 'user_prompt')) {
        out.user_prompt = String(parsedObj.user_prompt || '');
    }
    return out;
}


export function resetRetrievePipelineState(): void {
    _pendingRetrieveAbort = null;
    _pendingRetrieveTurn = null;
}

export function cancelPendingRetrieveRequest(reason: string = 'Retrieve cancelled'): boolean {
    const hadPending = _pendingRetrieveTurn != null || _pendingRetrieveAbort != null;
    if (!hadPending) return false;
    if (_pendingRetrieveAbort) {
        _pendingRetrieveAbortReason = reason;
        _pendingRetrieveAbort.abort(reason);
        _pendingRetrieveAbort = null;
    }
    _pendingRetrieveTurn = null;
    if (isStopButtonCancelReason(reason)) return true;
    const prev = getInspectData();
    stashInspectData({
        ...(prev || { timestamp: Date.now() }),
        timestamp: Date.now(),
        status: 'error',
        error: reason,
    });
    return true;
}

export function dropPendingTurnIfStopped(stoppedAtMs: number): boolean {
    if (!Number.isFinite(stoppedAtMs) || stoppedAtMs <= 0) return false;
    const turn = _pendingRetrieveTurn;
    if (!turn) return false;
    if (turn.createdAt <= stoppedAtMs) {
        if (_pendingRetrieveAbort) {
            _pendingRetrieveAbortReason = 'Generation stopped before retrieve finished';
            _pendingRetrieveAbort.abort(_pendingRetrieveAbortReason);
            _pendingRetrieveAbort = null;
        }
        _pendingRetrieveTurn = null;
        return true;
    }
    return false;
}

async function resolveRetrieveTurnForPrompt(): Promise<PendingRetrieveTurn | null> {
    const scope = currentScope();
    if (!(await isMemuActive()) || currentScope() !== scope) return null;
    await initChatExtraInfo(st.getContext());
    if (currentScope() !== scope) return;
    if (!memuExtras.baseInfo) return null;

    const ctx: any = st.getContext();
    const chat: any[] = Array.isArray(ctx?.chat) ? ctx.chat : [];
    let queryText = '';
    let queryIdx = -1;
    for (let i = chat.length - 1; i >= 0; i--) {
        const item: any = chat[i];
        const isUser = item?.is_user === true && !item?.is_system;
        if (!isUser) continue;
        const text = typeof item?.mes === 'string' ? item.mes.trim() : '';
        if (!text) continue;
        queryText = text;
        queryIdx = i;
        break;
    }
    if (!queryText) return null;

    const conversationId = getChatIdSafe();
    const userId = String(memuExtras.baseInfo.userId || '').trim();
    const soulId = String(memuExtras.baseInfo.characterId || '').trim();
    if (!conversationId || !userId || !soulId) return null;
    const chatName = String(memuExtras.baseInfo.characterName || soulId || '').trim();
    if (!chatName) {
        throw new Error('memu extension could not resolve chatName from characterName/soulId');
    }
    const chatType = 'dm';
    const history = buildTurnHistory(chat, queryIdx >= 0 ? queryIdx : (chat.length - 1));
    const queryRow = queryIdx >= 0 ? chat[queryIdx] : undefined;
    const savedSource = bindSavedSource(ctx);
    if (currentScope() !== scope) return null;

    return {
        createdAt: Date.now(),
        scope,
        conversationId,
        userId,
        soulId,
        userName: String(queryRow?.name || ''),
        queryText,
        queryTsMs: resolveMessageTsMs(queryRow),
        querySourceId: String(queryIdx),
        history,
        chatName,
        chatType,
        preparedPayload: null,
        savedSource,
    };
}

export async function addPendingRetrieveToPrompt(eventData: any, replaceSystem: boolean = true): Promise<void> {
    if (!(await isMemuActive())) return;
    const scope = currentScope();
    const turn = await resolveRetrieveTurnForPrompt();
    if (!turn) {
        addSummaryToPrompt(eventData, replaceSystem);
        return;
    }
    _pendingRetrieveTurn = turn;

    const retrieveCtx: any = st.getContext();
    await refreshSoulCard();
    if (currentScope() !== scope || _pendingRetrieveTurn !== turn) return;
    const retrieveSoulCard = resolveSoulCard(retrieveCtx);

    let resp: any;
    const retrieveAbort = new AbortController();
    const retrieveStartedAt = Date.now();
    const retrieveTimeoutHandle = window.setTimeout(() => {
        if (!retrieveAbort.signal.aborted) {
            _pendingRetrieveAbortReason = `Retrieve timed out after ${Math.round(RETRIEVE_REQUEST_TIMEOUT_MS / 1000)}s`;
            retrieveAbort.abort(_pendingRetrieveAbortReason);
        }
    }, RETRIEVE_REQUEST_TIMEOUT_MS);
    _pendingRetrieveAbort = retrieveAbort;
    _pendingRetrieveAbortReason = null;
    try {
        resp = await conversationRetrieve({
            userId: turn.userId,
            soulId: turn.soulId,
            conversationId: turn.conversationId,
            userName: turn.userName,
            chatName: turn.chatName,
            chatType: turn.chatType,
            method: 'rag',
            query: turn.queryText,
            history: turn.history,
            buildTurnPrompt: true,
            soul_card: retrieveSoulCard,
            mentalHealthAddon: MENTAL_HEALTH_ADDON.get(),
        }, { signal: retrieveAbort.signal });
    } catch (err: any) {
        if (currentScope() !== scope || _pendingRetrieveTurn !== turn) return;
        if (isAbortError(err)) {
            const reasonRaw = (retrieveAbort.signal as any)?.reason;
            const reason = typeof reasonRaw === 'string' && reasonRaw.trim()
                ? reasonRaw
                : (_pendingRetrieveAbortReason || 'Retrieve cancelled');
            if (isStopButtonCancelReason(reason)) {
                if (eventData && typeof eventData === 'object') {
                    (eventData as any).__memu_cancelled = true;
                }
                _pendingRetrieveTurn = null;
                return;
            }
            _pendingRetrieveTurn = null;
            stashInspectData({
                timestamp: Date.now(),
                query: turn.queryText,
                status: 'error',
                error: reason,
                userId: turn.userId,
                soulId: turn.soulId,
                method: 'rag',
                conversationId: turn.conversationId,
                retrieveMs: Date.now() - retrieveStartedAt,
            });
            throw new Error(reason);
        }
        _pendingRetrieveTurn = null;
        stashInspectData({
            timestamp: Date.now(),
            query: turn.queryText,
            status: 'error',
            error: err instanceof Error ? err.message : String(err),
            errorCode: err?.code,
            userId: turn.userId,
            soulId: turn.soulId,
            method: 'rag',
            conversationId: turn.conversationId,
        });
        throw err;
    } finally {
        window.clearTimeout(retrieveTimeoutHandle);
        if (_pendingRetrieveAbort === retrieveAbort) {
            _pendingRetrieveAbort = null;
        }
        if (_pendingRetrieveAbortReason != null) {
            _pendingRetrieveAbortReason = null;
        }
    }
    if (currentScope() !== scope || _pendingRetrieveTurn !== turn) return;
    const result = (resp as any)?.result ?? null;
    const ragSummary = parseRetrieveResult(result);
    const parsedPrior = parsePriorContext((resp as any)?.prior_context);
    const priorContextSummary = parsedPrior.summary;
    const memoryCacheRaw = Array.isArray((resp as any)?.memory_cache) ? (resp as any).memory_cache : [];
    const intentionItemsRaw = Array.isArray((resp as any)?.intentions_active) ? (resp as any).intentions_active : [];
    const intentions = intentionItemsRaw
        .map((row: any) => ({
            id: String(row?.id ?? '').trim(),
            text: String(row?.text ?? '').trim(),
        }))
        .filter((row: any) => row.id && row.text);
    const memoryCacheSummary = formatMemoryCacheForPrompt(memoryCacheRaw);
    const intentionSummary = intentions.map((row: any) => `- ${row.id}: ${row.text}`).join('\n');
    const turnSystemPrompt = typeof (resp as any)?.turn_system_prompt === 'string'
        ? (resp as any).turn_system_prompt.trim() : '';
    const turnUserPrompt = typeof (resp as any)?.turn_user_prompt === 'string'
        ? (resp as any).turn_user_prompt.trim() : '';
    const hasPriorPayload = (resp as any)?.prior_context != null && String((resp as any).prior_context).trim() !== '';
    if (!turnSystemPrompt) {
        _pendingRetrieveTurn = null;
        throw new Error('conversationRetrieve missing turn_system_prompt — turn blocked.');
    }
    if (!turnUserPrompt) {
        _pendingRetrieveTurn = null;
        throw new Error('conversationRetrieve missing turn_user_prompt — turn blocked.');
    }
    const preparedPayload: Record<string, any> = {
        system_prompt: turnSystemPrompt,
        user_prompt: turnUserPrompt,
        memory_cache: memoryCacheRaw
            .map((v: any) => String(v ?? '').trim())
            .filter(Boolean),
        retrieve_rag: (result && typeof result === 'object')
            ? result
            : { categories: [], items: [], resources: [] },
    };
    if (typeof (resp as any)?.retrieve_ms === 'number') {
        preparedPayload.retrieve_ms = (resp as any).retrieve_ms;
    }
    _pendingRetrieveTurn = { ...turn, preparedPayload };
    const turnPayloadInspect = (turnSystemPrompt && turnUserPrompt)
        ? [
            { role: 'system', content: turnSystemPrompt },
            { role: 'user', content: turnUserPrompt },
        ]
        : null;
    const turnPayloadJson = turnPayloadInspect ? JSON.stringify(turnPayloadInspect, null, 2) : undefined;
    stashInspectData({
        timestamp: Date.now(),
        query: turn.queryText,
        status: 'ok',
        priorContext: parsedPrior.inspectText || undefined,
        memoryCache: memoryCacheRaw
            .map((v: any) => String(v ?? '').trim())
            .filter(Boolean)
            .slice(0, 7),
        intentions,
        userId: turn.userId,
        soulId: turn.soulId,
        categories: Array.isArray(result?.categories) ? result.categories.map((c: any) => ({
            name: c.name || '?', score: c.score || 0, summary: c.summary,
        })) : [],
        items: Array.isArray(result?.items) ? result.items.map((i: any) => ({
            summary: i.summary || '', score: i.score || 0, memory_type: i.memory_type || '?', id: i.id,
        })) : [],
        resources: result?.resources,
        method: (resp as any)?.method,
        conversationId: (resp as any)?.conversation_id,
        retrieveMs: typeof (resp as any)?.retrieve_ms === 'number' ? (resp as any).retrieve_ms : undefined,
        queries: typeof (resp as any)?.queries === 'number' ? (resp as any).queries : undefined,
        needsRetrieval: typeof (result as any)?.needs_retrieval === 'boolean' ? (result as any).needs_retrieval : undefined,
        turnSystemPrompt: typeof (resp as any)?.turn_system_prompt === 'string'
            ? (resp as any).turn_system_prompt : undefined,
        turnPrompt: turnPayloadJson,
        turnStatus: ((resp as any)?.turn_system_prompt && (resp as any)?.turn_user_prompt)
            ? 'pending' : undefined,
    });

    const promptSections: string[] = [];
    if (hasPriorPayload) {
        promptSections.push(`[Prior context]\n${priorContextSummary || '(none)'}`);
    }
    if (memoryCacheSummary) {
        promptSections.push(`[Memory cache]\n${memoryCacheSummary}`);
    }
    if (intentionSummary) {
        promptSections.push(`[Intentions]\n${intentionSummary}`);
    }
    if (ragSummary) {
        promptSections.push(`[Current retrieval]\n${ragSummary}`);
    }
    const promptSummary = promptSections.join('\n\n\n').trim();
    if (promptSummary) {
        setLiveRetrieveSummary(promptSummary);
    }
    addSummaryToPrompt(eventData, replaceSystem, promptSummary);
    if (turnPayloadJson) {
        seedInspectPromptTextarea(turnPayloadJson);
        const prev = getInspectData();
        stashInspectData({
            ...(prev || { timestamp: Date.now() }),
            timestamp: Date.now(),
            turnPrompt: turnPayloadJson,
            turnStatus: 'pending',
        });
    }
}

export async function preparePendingRetrieveTurnForInterceptor(replaceSystem: boolean = true): Promise<boolean> {
    const probeEventData: any = {};
    await addPendingRetrieveToPrompt(probeEventData, replaceSystem);
    return _pendingRetrieveTurn != null;
}

export async function dispatchConversationTurn(
    opts: { debug?: boolean } = {},
): Promise<ConversationTurnDispatchResult> {
    if (!(await isMemuActive())) throw new Error('memU is off');
    const turn = _pendingRetrieveTurn;
    if (!turn || turn.scope !== currentScope()) {
        throw new Error('memU pending retrieve is missing — retrieve must complete before turn.');
    }
    _pendingRetrieveTurn = null;

    const includeDebug = opts.debug === true;
    if (includeDebug) {
        const prev = getInspectData();
        stashInspectData({
            ...(prev || { timestamp: Date.now() }),
            timestamp: Date.now(),
            query: turn.queryText,
            userId: turn.userId,
            soulId: turn.soulId,
            method: 'turn',
            conversationId: turn.conversationId,
            turnStatus: 'pending',
        });
    }

    const preparedPayload = turn.preparedPayload;
    if (!preparedPayload || typeof preparedPayload !== 'object') {
        throw new Error('memU prepared payload is missing — retrieve must complete before turn.');
    }
    let promptOverridePayload: Record<string, any> = { ...preparedPayload };
    const promptOverrideRaw = await inspectPreparedTurnPayload(preparedPayload);
    if (promptOverrideRaw) {
        promptOverridePayload = applyPromptOverridePayload(promptOverridePayload, promptOverrideRaw);
    }
    if (!String(promptOverridePayload.user_prompt || '').trim()) {
        throw new Error('memU prepared payload has empty user_prompt — message not sent.');
    }
    if (!(await isMemuActive()) || currentScope() !== turn.scope) return { reply: '' };

    const resp = await conversationTurn({
      srmm: srmmRequest(),
        userId: turn.userId,
        soulId: turn.soulId,
        conversationId: turn.conversationId,
        userName: turn.userName,
        chatName: turn.chatName,
        chatType: turn.chatType,
        message: turn.queryText,
        messageTsMs: turn.queryTsMs,
        messageSourceId: turn.querySourceId,
        history: turn.history,
        debug: includeDebug,
        promptOverridePayload,
    });

    if (currentScope() !== turn.scope) {
        const turnId = resp?.generation_metadata?.turn_id;
        if (turnId) {
            try {
                await conversationTurnUndo(turn.conversationId, turn.userId, turn.soulId, turnId);
            } catch (error) {
                logError('Abandoned reply Undo failed', error);
                window.alert(`memU reply Undo failed: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
        return { reply: '' };
    }
    const responseTarget = String((resp as any)?.response_target ?? '').trim().toLowerCase();
    const shouldRespond = typeof (resp as any)?.should_respond === 'boolean'
        ? Boolean((resp as any).should_respond)
        : undefined;
    const reply = String(resp?.response ?? '').trim();
    if (!reply) {
        const explicitListen = responseTarget === 'listen' || shouldRespond === false;
        if (!explicitListen) {
            throw new Error("conversationTurn returned empty response");
        }
        const prevListen = getInspectData();
        const listenUpdate: InspectData = {
            ...(prevListen || { timestamp: Date.now() }),
            timestamp: Date.now(),
            turnStatus: 'ok',
            apimwStatus: typeof resp?.apimw === 'string' ? resp.apimw : undefined,
            turnMs: typeof (resp as any)?.turn_ms === 'number' ? (resp as any).turn_ms : undefined,
            replyCh: 0,
        };
        if (includeDebug) {
            const finalTurnPayload = (resp as any)?.final_turn_payload;
            const finalTurnPrompt = finalTurnPayload && typeof finalTurnPayload === 'object'
                ? JSON.stringify(finalTurnPayload, null, 2)
                : undefined;
            listenUpdate.query = turn.queryText;
            listenUpdate.userId = turn.userId;
            listenUpdate.soulId = turn.soulId;
            listenUpdate.method = 'turn';
            listenUpdate.conversationId = turn.conversationId;
            listenUpdate.turnContract = resp?.turn_contract;
            listenUpdate.turnPrompt = finalTurnPrompt;
            listenUpdate.turnSystemPrompt = typeof finalTurnPayload?.system_prompt === 'string'
                ? finalTurnPayload.system_prompt
                : undefined;
        }
        stashInspectData(listenUpdate);
        void syncLorebooksNow("after-turn");
        return { reply: '', savedSource: turn.savedSource };
    }

    const prev2 = getInspectData();
    const turnUpdate: InspectData = {
        ...(prev2 || { timestamp: Date.now() }),
        timestamp: Date.now(),
        turnStatus: 'ok',
        apimwStatus: typeof resp?.apimw === 'string' ? resp.apimw : undefined,
        turnMs: typeof (resp as any)?.turn_ms === 'number' ? (resp as any).turn_ms : undefined,
        replyCh: reply.length,
    };
    if (includeDebug) {
        const finalTurnPayload = (resp as any)?.final_turn_payload;
        const finalTurnPrompt = finalTurnPayload && typeof finalTurnPayload === 'object'
            ? JSON.stringify(finalTurnPayload, null, 2)
            : undefined;
        turnUpdate.query = turn.queryText;
        turnUpdate.userId = turn.userId;
        turnUpdate.soulId = turn.soulId;
        turnUpdate.method = 'turn';
        turnUpdate.conversationId = turn.conversationId;
        turnUpdate.turnContract = resp?.turn_contract;
        turnUpdate.turnPrompt = finalTurnPrompt;
        turnUpdate.turnSystemPrompt = typeof finalTurnPayload?.system_prompt === 'string'
            ? finalTurnPayload.system_prompt
            : undefined;
    }
    stashInspectData(turnUpdate);

    // Coalesced work has no local task; keep existing lorebooks visible on turns.
    void syncLorebooksNow("after-turn");
    const generationMetadata = (resp as any)?.generation_metadata;
    return {
        reply,
        savedSource: turn.savedSource,
        generationMetadata: generationMetadata && typeof generationMetadata === 'object'
            ? generationMetadata
            : undefined,
    };
}

// --- World Info sync (view memU memories inside ST) ---

export function sanitizeWorldInfoName(name: string): string {
    return (name || "")
        .replace(/[\/:*?"<>|]/g, '-')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 120);
}

function cleanCategorySummary(summary: string): string {
    const s = (summary || '').trim();
    if (!s) return s;

    // Be robust against minifiers: avoid multiple const declarations that could be mangled
    // into the same identifier in one function scope.
    let tmp: any = s.indexOf('### Output');
    if (typeof tmp === 'number' && tmp >= 0) {
        const tail = s.slice(tmp + '### Output'.length);
        tmp = tail.indexOf('#');
        if (typeof tmp === 'number' && tmp >= 0) return tail.slice(tmp).trim();
        return tail.trim();
    }

    tmp = s.match(/(^|\n)#[^#]/);
    if (tmp && tmp.index !== undefined) {
        return s.slice(tmp.index + (tmp[1] ? tmp[1].length : 0)).trim();
    }

    return s;
}

function isNullishCategorySummary(text: string): boolean {
    const t = (text || '').trim();
    if (!t) return true;
    const low = t.toLowerCase();
    if (low === 'null' || low === 'none' || low === 'undefined' || low === 'n/a' || low === 'na') return true;
    if (/^\[[^\]]+\]\s*null$/i.test(t)) return true;
    return false;
}

function filterCategoryForCharacter(categoryName: string, content: string, characterName: string, userName?: string): string {
    const cat = (categoryName || '').trim().toLowerCase();
    if (cat !== 'relationships') return content;

    const char = (characterName || '').trim().toLowerCase();
    if (!char) return content;

    const keepHeads = new Set<string>([char, 'user']);
    const u = (userName || '').trim().toLowerCase();
    if (u) keepHeads.add(u);

    const lines = String(content || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
    const out: string[] = [];
    let keep = true;
    let sawRelevant = false;

    for (const line of lines) {
        const m = /^##\s+(.+?)\s*$/.exec(line);
        if (m) {
            const head = (m[1] || '').trim().toLowerCase();
            keep = keepHeads.has(head);
            if (keep) sawRelevant = true;
        }
        if (keep) out.push(line);
    }

    const joined = out.join('\n').trim();
    if (!joined || !sawRelevant) return content;
    return joined;
}

function buildWorldInfoFileData(bookName: string, categoryName: string, content: string) {
    const data: any = { entries: {} };
    // Use SillyTavern's canonical entry template so future ST fields won't break rendering.
    const entry: any = createWorldInfoEntry(bookName, data);
    entry.key = [`memu:${categoryName}`];
    entry.keysecondary = [];
    entry.comment = `memU category: ${categoryName}`;
    entry.content = content;

    // Keep memU lorebooks as UI-only.
    // memU injects retrieval directly; ST World Info injection is stripped before send.
    entry.constant = false;
    entry.disable = true;

    entry.order = 100;
    entry.position = 0;
    return data;
}

async function upsertWorldInfoLorebook(name: string, data: any): Promise<void> {
    await saveWorldInfo(name, data, true);
}

async function syncCategoriesToWorldInfo(baseInfo: any, categories: Array<{ name: string; summary: string }>): Promise<void> {
    if (!(await isMemuActive())) return;
    const scope = currentScope();
    if (!IMPORT_LOREBOOKS.get()) return;

    const ctx: any = st.getContext();
    const character = (ctx?.characters && ctx?.characterId != null) ? (ctx.characters[ctx.characterId] ?? null) : null;
    const characterName = sanitizeWorldInfoName(String(character?.name || baseInfo?.characterName || 'Character'));
    const prefix = `memU - ${characterName} - `.slice(0, 120);

    const written = new Set<string>();
    for (const cat of categories) {
        if (!(await isMemuActive()) || currentScope() !== scope) return;
        const catName = sanitizeWorldInfoName(String((cat as any)?.name || 'category'));
        const bookName = sanitizeWorldInfoName(`memU - ${characterName} - ${catName}`);

        // Only use actual memory summaries — never fall back to the category description.
        // Descriptions are metadata for the extraction LLM, not memory content.
        const raw = String((cat as any)?.summary || '');
        const cleaned = cleanCategorySummary(raw);

        // Minimal + correct: do not create lorebooks for empty categories.
        if (isNullishCategorySummary(cleaned)) {
            continue;
        }

        const finalContent = filterCategoryForCharacter(catName, cleaned, characterName, baseInfo?.userName);

        await upsertWorldInfoLorebook(bookName, buildWorldInfoFileData(bookName, catName, finalContent));
        written.add(bookName);
    }

    // Prune stale books: any memU book for this character that wasn't written this run
    // (renamed/deleted category, or category that became empty) must be removed.
    if (!(await isMemuActive()) || currentScope() !== scope) return;
    await deleteLorebooksByPrefix(prefix, written);

    // ST UI doesn't always refresh the World Info lists immediately when aux books change.
    // Force a lightweight refresh so the lorebooks appear without a full page reload.
    await updateWorldInfoList();
    (st as any)?.eventSource?.emit?.((st as any)?.event_types?.SETTINGS_UPDATED);
}

export function addSummaryToPrompt(
    eventData: any,
    replaceSystem: boolean = true,
    summaryOverride?: string | null,
): void {
    const memuSummary = summaryOverride !== undefined
        ? String(summaryOverride || '')
        : (memuExtras.retrieve?.liveRetrieve?.summary || memuExtras.retrieve?.nowRetrieve?.summary || '');
    if (!memuSummary) {
        return;
    }
    if (replaceSystem && Array.isArray(eventData?.chat)) {
        eventData.chat = eventData.chat.filter((msg: any) => String(msg?.identifier || '') !== 'summary');
        addSummary(memuSummary, eventData);
        return;
    }
    addSummary(memuSummary, eventData);
}

function addSummary(memuSummary: string, eventData: any): void {
    if (Array.isArray(eventData?.chat)) {
        eventData.chat.unshift({
            role: 'system',
            content: memuSummary,
        });
    }
}

function parseSummary(categories: CategoryResponse[]): string {
    return categories
        .map(category => ({
            name: category.name,
            summary: cleanCategorySummary(String((category as any).summary ?? '')),
        }))
        .filter(x => !isNullishCategorySummary(x.summary))
        .map(x => `[${x.name}] ${x.summary}`)
        .join('\n\n\n');
}

function parseRetrieveResult(result: any): string {
    if (!result || typeof result !== 'object') return '';

    const categories = Array.isArray((result as any).categories) ? (result as any).categories : [];
    const items = Array.isArray((result as any).items) ? (result as any).items : [];
    const resources = Array.isArray((result as any).resources) ? (result as any).resources : [];

    const blocks: string[] = [];
    const categoryText = parseSummary(categories);
    if (categoryText) blocks.push(`[Categories]\n${categoryText}`);

    const dedupeKey = (text: string): string =>
        String(text || '')
            .toLowerCase()
            .replace(/[^a-z0-9\s]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    const catKey = dedupeKey(categoryText);
    const seenItemKeys = new Set<string>();
    const itemLines = items
        .map((item: any) => {
            const summary = String(item?.summary ?? '').trim();
            if (!summary) return '';
            const key = dedupeKey(summary);
            if (!key) return '';
            if (seenItemKeys.has(key)) return '';
            // If item summary is already captured in category summaries, skip to avoid token duplication.
            if (catKey && key.length >= 24 && catKey.includes(key)) return '';
            seenItemKeys.add(key);
            const memoryType = String(item?.memory_type ?? item?.memoryType ?? 'memory').trim();
            return `[${memoryType}] ${summary}`;
        })
        .filter(Boolean);
    if (itemLines.length > 0) blocks.push(`[Items]\n${itemLines.join('\n\n')}`);

    const seenResourceKeys = new Set<string>();
    const resourceLines = resources
        .map((resource: any) => {
            const caption = String(resource?.caption ?? '').trim();
            const url = String(resource?.url ?? '').trim();
            const value = caption || url;
            if (!value) return '';
            const key = dedupeKey(value);
            if (!key || seenResourceKeys.has(key)) return '';
            if (catKey && key.length >= 24 && catKey.includes(key)) return '';
            seenResourceKeys.add(key);
            return value;
        })
        .filter(Boolean);
    if (resourceLines.length > 0) blocks.push(`[Resources]\n${resourceLines.join('\n\n')}`);

    return blocks.join('\n\n\n').trim();
}
