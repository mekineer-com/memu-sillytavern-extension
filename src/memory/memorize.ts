import { CategoryResponse } from "memu-js";
import { memuExtras, st } from "utils/context-extra";
import { conversationRetrieve, conversationTurn, memorizeConversation, retrieveDefaultCategories } from "utils/network";
import { ConversationMessage, MemuSummary, MemuTaskStatus } from "utils/types";
import { createWorldInfoEntry, saveWorldInfo, updateWorldInfoList } from "@silly-tavern/scripts/world-info.js";
import { getChatCompletionPreset } from "@silly-tavern/scripts/openai.js";
import { main_api } from "@silly-tavern/script.js";
import { initChatExtraInfo } from "./utils";
import { status, warn, error as logError, onceWarn } from "utils/log";
import {
    getInspectData,
    stashInspectData,
    InspectData,
    seedInspectPromptTextarea,
    readInspectPromptTextarea,
} from "ui/inspect-panel";

let isSummarying = false;

type PendingRetrieveTurn = {
    createdAt: number;
    conversationId: string;
    userId: string;
    soulId: string;
    queryText: string;
    history: Array<Record<string, any>>;
};

let _pendingRetrieveTurn: PendingRetrieveTurn | null = null;
let _cachedStWorldInfo: string = '';

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

// The actual SillyTavern chat *file name* (used for file-based storage).
// This is intentionally separate from getChatIdSafe(), which prefers integrity UUIDs.
export function getChatFileNameRaw(): string {
    try {
        const ctx: any = st.getContext() as any;
        const raw = (typeof ctx?.getCurrentChatId === 'function')
            ? ctx.getCurrentChatId()
            : (ctx?.chatId ?? ctx?.chat_id);
        const s = (typeof raw === 'string') ? raw.trim() : '';
        return s;
    } catch {
        return '';
    }
}

export async function summaryIfNeed(): Promise<void> {
    if (isSummarying) {
        return;
    }

    isSummarying = true;
    try {
        // Ensure per-chat baseInfo reflects the *current* character before we decide to digest.
        await initChatExtraInfo(st.getContext());

        const chatId = getChatIdSafe();
        if (!chatId) {
            // Chat not fully initialized yet (no stable chatId). Avoid a false "re-digest" on load.
            return;
        }

        const lastToFromSummary = memuExtras.summary?.summaryRange?.[1];
        const lastToFromRetrieve = memuExtras.retrieve?.nowRetrieve?.summaryRange?.[1];

        const lastTo = Math.max(
            Number.isFinite(lastToFromSummary as any) ? (lastToFromSummary as any as number) : -1,
            Number.isFinite(lastToFromRetrieve as any) ? (lastToFromRetrieve as any as number) : -1,
        );

        const from = lastTo + 1;
        const chat = st.getContext().chat;

        // Nothing new since last digest.
        if (from >= chat.length) {
            return;
        }

        // If a summary task is already running, let the poller handle it.
        if (memuExtras.summary && (memuExtras.summary.summaryTaskStatus === MemuTaskStatus.PENDING || memuExtras.summary.summaryTaskStatus === MemuTaskStatus.PROCESSING)) {
            return;
        }

        // Backoff (minimal): if we failed recently, pause auto-digest for a bit.
        const sf: any = memuExtras.summary;
        const nowMs = Date.now();
        const pauseUntilMs = Number(sf?.pauseUntilMs ?? 0);
        if (pauseUntilMs && nowMs < pauseUntilMs) {
            return;
        }
        if (sf && sf.summaryTaskStatus === MemuTaskStatus.FAILURE) {
            const fc = Number(sf.failureCount ?? 0);
            const pauseMs = (fc >= 3) ? (5 * 60_000) : 10_000;
            sf.pauseUntilMs = nowMs + pauseMs;
            return;
        }
        const chatLen = chat.length;
        status(chatLen, from);
        await doSummary(from, chat.length - 1);
    } finally {
        isSummarying = false;
    }
}

export async function doSummary(from: number, to: number, force: boolean = false): Promise<void> {
    await initChatExtraInfo(st.getContext());
    if (memuExtras.baseInfo == null) {
        warn("memorize skipped: no baseInfo in chat metadata");
        return;
    }

    // Timezone hint for sleep-based daily resource splitting server-side.
    // Prefer IANA name; keep offset as fallback.
    let timeZone: string | undefined;
    try {
        timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    } catch { }
    const timeZoneOffsetMin = new Date().getTimezoneOffset();

    try {
        const conversationId = getChatIdSafe();
        const response = await memorizeConversation({
                messages: await prepareConversationData(from, to),
                userId: memuExtras.baseInfo.userId,
                userName: memuExtras.baseInfo.userName,
                characterId: memuExtras.baseInfo.characterId,
                characterName: memuExtras.baseInfo.characterName,
                conversationId: conversationId || undefined,
                chatFileName: getChatFileNameRaw(),
                timeZone,
                timeZoneOffsetMin,
            }, { force });
        // Local mode usually returns a task id and completes asynchronously.
        // Keep it pending so the poller drives retrieve/lorebook sync after success.
        {
            const localTaskId = (typeof (response as any)?.taskId === 'string' && (response as any).taskId.trim())
                ? (response as any).taskId.trim()
                : '';
            if (!localTaskId) throw new Error('memorizeConversation response missing taskId');

            memuExtras.summary = {
                summaryRange: [from, to],
                summaryTaskId: localTaskId,
                summaryTaskStatus: MemuTaskStatus.PENDING,
                isReady: false,
                force,
                failureCount: 0,
                lastError: undefined,
            };
            await st.saveChat();

            // One-shot: if categories already exist, ensure lorebooks can appear quickly.
            await syncLorebooksNow("after-memorize-local-pending");
            return;
        }
    } catch (error) {
        const prevRange = memuExtras.summary?.summaryRange ?? [-1, -1];
        memuExtras.summary = {
            // IMPORTANT: don't advance the cursor on failure.
            summaryRange: prevRange,
            summaryTaskId: null,
            summaryTaskStatus: MemuTaskStatus.FAILURE,
            isReady: false,
            force,
            failureCount: (memuExtras.summary?.failureCount ?? 0) + 1,
            lastError: error instanceof Error ? error.message : String(error),
            lastFailureAt: Date.now(),
        };
        await st.saveChat();
        logError(`memorize failed (range=${from}-${to})`, error);
    }
}

export async function memorizeNow(): Promise<void> {
    await initChatExtraInfo(st.getContext());
    const chat = st.getContext().chat;
    if (!Array.isArray(chat) || chat.length === 0) {
        warn("memorize now skipped: empty chat");
        return;
    }
    await doSummary(0, chat.length - 1, true);
}



// One-shot: (re)create and populate memU World Info lorebooks right now.
// Useful when lorebooks were deleted, or when digest/retrieve is delayed.
export async function syncLorebooksNow(reason: string = "manual"): Promise<void> {
    await initChatExtraInfo(st.getContext());
    try {
        if (!memuExtras.baseInfo) return;
        const resp = await retrieveDefaultCategories(memuExtras.baseInfo.userId, memuExtras.baseInfo.characterId);
        const categories = (resp as any)?.categories ?? [];
        if (Array.isArray(categories) && categories.length) {
            await syncCategoriesToWorldInfo(memuExtras.baseInfo, categories);
        }
    } catch (e) {
        onceWarn(`lorebooks-sync-failed:${reason}`, `lorebooks sync failed (${reason})`);
    }
}

export async function retrieveMemories(summary: MemuSummary): Promise<void> {
    await initChatExtraInfo(st.getContext());
    try {
        const response = await retrieveDefaultCategories(
            memuExtras.baseInfo.userId,
            memuExtras.baseInfo.characterId,
        );
        const categories = Array.isArray((response as any)?.categories) ? (response as any).categories : [];
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

function formatIntentionsForPrompt(raw: any): string {
    if (!raw || typeof raw !== 'object') return '';
    const items = Array.isArray((raw as any).items) ? (raw as any).items : [];
    if (items.length === 0) return '';
    const lines: string[] = [];
    for (const row of items) {
        if (!row || typeof row !== 'object') continue;
        if ((row as any).active === false) continue;
        const text = String((row as any).text ?? '').trim();
        if (!text) continue;
        const priority = Number((row as any).priority);
        const p = Number.isFinite(priority) ? ` (p=${priority.toFixed(1)})` : '';
        lines.push(`- ${text}${p}`);
    }
    return lines.join('\n');
}

const _ST_LORE_IDS = new Set(['worldInfoBefore', 'worldInfoAfter', 'authorsNote', 'charPersonality', 'scenario']);

function extractStWorldInfo(chat: any[]): string {
    return chat
        .filter((m: any) => _ST_LORE_IDS.has(String(m?.identifier || '')))
        .map((m: any) => String(m?.content || '').trim())
        .filter(Boolean)
        .join('\n\n');
}

function buildSoulCard(charDesc: string, worldInfo: string): string | undefined {
    return [charDesc, worldInfo].filter(Boolean).join('\n\n') || undefined;
}

function buildTurnHistory(chat: any[], endIdx: number, userName: string): Array<Record<string, any>> {
    if (!Array.isArray(chat) || endIdx < 0) return [];
    const start = Math.max(0, endIdx - 39);
    const out: Array<Record<string, any>> = [];
    for (let i = start; i < endIdx && i < chat.length; i++) {
        const row: any = chat[i];
        const content = String(row?.mes ?? '').trim();
        if (!content) continue;
        const role = row?.is_user ? 'user' : 'assistant';
        const item: Record<string, any> = { role, content };
        if (row?.is_user && String(row?.name || '') !== String(userName || '')) {
            item.name = String(row?.name || '');
        }
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


export function resetRetrievePipelineState(): void {
    _pendingRetrieveTurn = null;
}

export function dropPendingTurnIfStopped(stoppedAtMs: number): boolean {
    if (!Number.isFinite(stoppedAtMs) || stoppedAtMs <= 0) return false;
    const turn = _pendingRetrieveTurn;
    if (!turn) return false;
    if (turn.createdAt <= stoppedAtMs) {
        _pendingRetrieveTurn = null;
        return true;
    }
    return false;
}

async function resolveRetrieveTurnForPrompt(): Promise<PendingRetrieveTurn | null> {
    await initChatExtraInfo(st.getContext());
    if (!memuExtras.baseInfo) return null;

    const ctx: any = st.getContext();
    const chat: any[] = Array.isArray(ctx?.chat) ? ctx.chat : [];
    let queryText = '';
    let queryIdx = -1;
    for (let i = chat.length - 1; i >= 0; i--) {
        const item: any = chat[i];
        const isUser = item?.is_user === true || (ctx?.name1 != null && String(item?.name || '') === String(ctx.name1));
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
    const history = buildTurnHistory(chat, queryIdx >= 0 ? queryIdx : (chat.length - 1), String(ctx?.name1 || ''));

    return { createdAt: Date.now(), conversationId, userId, soulId, queryText, history };
}

export async function addPendingRetrieveToPrompt(eventData: any, replaceSystem: boolean = true): Promise<void> {
    const turn = await resolveRetrieveTurnForPrompt();
    if (!turn) {
        addSummaryToPrompt(eventData, replaceSystem);
        return;
    }
    if (!_pendingRetrieveTurn) {
        _pendingRetrieveTurn = turn;
    }

    const retrieveCtx: any = st.getContext();
    const retrieveCharDesc = String(retrieveCtx.characters?.[retrieveCtx.characterId]?.description || '').trim();
    _cachedStWorldInfo = Array.isArray(eventData?.chat) ? extractStWorldInfo(eventData.chat) : '';
    const retrieveSoulCard = buildSoulCard(retrieveCharDesc, _cachedStWorldInfo);

    let resp: any;
    try {
        resp = await conversationRetrieve({
            userId: turn.userId,
            soulId: turn.soulId,
            conversationId: turn.conversationId,
            method: 'rag',
            query: turn.queryText,
            history: turn.history,
            buildTurnPrompt: true,
            soul_card: retrieveSoulCard,
        });
    } catch (err: any) {
        _pendingRetrieveTurn = null;
        stashInspectData({
            timestamp: Date.now(),
            query: turn.queryText,
            status: 'error',
            error: err instanceof Error ? err.message : String(err),
            userId: turn.userId,
            soulId: turn.soulId,
            method: 'rag',
            conversationId: turn.conversationId,
        });
        throw err;
    }
    const result = (resp as any)?.result ?? null;
    const ragSummary = parseRetrieveResult(result);
    const parsedPrior = parsePriorContext((resp as any)?.prior_context);
    const priorContextSummary = parsedPrior.summary;
    const memoryCacheRaw = Array.isArray((resp as any)?.memory_cache) ? (resp as any).memory_cache : [];
    const intentionItemsRaw = Array.isArray((resp as any)?.intentions_active?.items) ? (resp as any).intentions_active.items : [];
    const memoryCacheSummary = formatMemoryCacheForPrompt(memoryCacheRaw);
    const intentionSummary = formatIntentionsForPrompt((resp as any)?.intentions_active);
    const turnSystemPrompt = typeof (resp as any)?.turn_system_prompt === 'string'
        ? (resp as any).turn_system_prompt.trim() : '';
    const turnUserPrompt = typeof (resp as any)?.turn_user_prompt === 'string'
        ? (resp as any).turn_user_prompt.trim() : '';
    const turnPayload = (turnSystemPrompt && turnUserPrompt)
        ? {
            system_prompt: turnSystemPrompt,
            user_prompt: turnUserPrompt,
        }
        : null;
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
        intentions: intentionItemsRaw
            .map((row: any) => ({
                text: String(row?.text ?? '').trim(),
                priority: Number(row?.priority),
                active: row?.active !== false,
                ephemeral: row?.ephemeral === true,
            }))
            .filter((row: any) => row.text),
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
        turnSystemPrompt: typeof (resp as any)?.turn_system_prompt === 'string'
            ? (resp as any).turn_system_prompt : undefined,
        turnPrompt: turnPayloadJson,
        turnStatus: ((resp as any)?.turn_system_prompt && (resp as any)?.turn_user_prompt)
            ? 'pending' : undefined,
    });

    const hasPriorPayload = (resp as any)?.prior_context != null && String((resp as any).prior_context).trim() !== '';
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
    if (turnPayload && turnPayloadJson) {
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

export async function dispatchConversationTurn(
    generateData: any,
    opts: { debug?: boolean; applyTurnMaintenance?: boolean } = {},
): Promise<void> {
    const turn = _pendingRetrieveTurn;
    if (!turn) return;
    _pendingRetrieveTurn = null;

    const includeDebug = opts.debug === true;
    const applyTurnMaintenance = opts.applyTurnMaintenance !== false;
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

    const turnCtx: any = st.getContext();
    const turnCharDesc = String(turnCtx.characters?.[turnCtx.characterId]?.description || '').trim();
    const turnSoulCard = buildSoulCard(turnCharDesc, _cachedStWorldInfo);
    const promptOverrideRaw = readInspectPromptTextarea();
    let promptOverridePayload: Record<string, any> | undefined;
    if (promptOverrideRaw) {
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
        if (Array.isArray(parsed)) {
            // PI native format: [{role:'system',content:'...'},{role:'user',content:'...'}]
            const sys = parsed.find((m: any) => m?.role === 'system');
            const usr = [...parsed].reverse().find((m: any) => m?.role === 'user');
            if (!usr) throw new Error('PI message array has no user message — message not sent.');
            promptOverridePayload = {
                system_prompt: sys ? String(sys.content || '') : '',
                user_prompt: String(usr.content || ''),
            };
        } else {
            promptOverridePayload = parsed as Record<string, any>;
        }
    }

    const stGenParams: Record<string, number> = {};
    if (main_api === 'openai') {
        const preset = getChatCompletionPreset();
        if (typeof preset?.temperature === 'number') stGenParams.temperature = preset.temperature;
        if (typeof preset?.openai_max_tokens === 'number') stGenParams.maxTokens = preset.openai_max_tokens;
    }

    const resp = await conversationTurn({
        userId: turn.userId,
        soulId: turn.soulId,
        conversationId: turn.conversationId,
        message: turn.queryText,
        history: turn.history,
        applyTurnMaintenance,
        debug: includeDebug,
        soul_card: turnSoulCard,
        ...stGenParams,
        ...(promptOverridePayload ? { promptOverridePayload } : {}),
    });

    const reply = String(resp?.response ?? '').trim();
    if (!reply) {
        throw new Error("conversationTurn returned empty response");
    }
    (generateData as any).__memu_direct_reply = reply;

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
        const finalTurnPrompt =
            finalTurnPayload && typeof finalTurnPayload === 'object'
                ? JSON.stringify(finalTurnPayload, null, 2)
                : (typeof (resp as any)?.final_turn_prompt === 'string'
                    ? (resp as any).final_turn_prompt
                    : (typeof resp?.turn_user_prompt === 'string' ? resp.turn_user_prompt : undefined));
        turnUpdate.query = turn.queryText;
        turnUpdate.userId = turn.userId;
        turnUpdate.soulId = turn.soulId;
        turnUpdate.method = 'turn';
        turnUpdate.conversationId = turn.conversationId;
        turnUpdate.turnContract = resp?.turn_contract;
        turnUpdate.turnPrompt = finalTurnPrompt;
        turnUpdate.turnSystemPrompt = typeof resp?.turn_system_prompt === 'string' ? resp.turn_system_prompt : undefined;
    }
    stashInspectData(turnUpdate);
}

// --- World Info sync (view memU memories inside ST) ---

function sanitizeWorldInfoName(name: string): string {
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
    // Prefer ST helper so its in-memory cache updates immediately.
    try {
        if (typeof (saveWorldInfo as any) === 'function') {
            await (saveWorldInfo as any)(name, data, true);
            return;
        }
    } catch {
        // fall through to direct write
    }

    // Fallback: direct write (updates disk, but ST prompt cache may not refresh until reload).
    const csrf = await fetch('/csrf-token');
    const csrfJson = await csrf.json().catch(() => ({} as any));
    const token = (csrfJson && csrfJson.token) ? String(csrfJson.token) : '';
    const resp = await fetch('/api/worldinfo/edit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-csrf-token': token },
        body: JSON.stringify({ name, data }),
    });
    if (!resp.ok) {
        const txt = await resp.text().catch(() => '');
        throw new Error(`worldinfo/edit failed (${resp.status}): ${txt}`);
    }
}

async function syncCategoriesToWorldInfo(baseInfo: any, categories: Array<{ name: string; summary: string }>): Promise<void> {
    if (!Array.isArray(categories) || categories.length === 0) return;

    const ctx: any = st.getContext();
    const character = (ctx?.characters && ctx?.characterId != null) ? (ctx.characters[ctx.characterId] ?? null) : null;
    const characterName = sanitizeWorldInfoName(String(character?.name || baseInfo?.characterName || baseInfo?.agentName || 'Character'));

    for (const cat of categories) {
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
    }


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
        return;
    }
    if (typeof eventData?.prompt === 'string') {
        const cleaned = stripLegacySummaryBlock(eventData.prompt);
        if (cleaned.includes(memuSummary)) {
            eventData.prompt = cleaned;
            return;
        }
        eventData.prompt = `${memuSummary}\n\n${cleaned}`;
    }
}

function stripLegacySummaryBlock(prompt: string): string {
    const text = String(prompt || '');
    if (!text.includes('[Summary:') || !text.includes('[Prior context]')) return text;
    return text.replace(/\[Summary:\s*\[Prior context][\s\S]*?(?=\n\*{3}\n|$)/g, '').trim();
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


async function prepareConversationData(from: number, to: number): Promise<ConversationMessage[]> {
    const chat = st.getContext().chat;
    const chatInfo = memuExtras.baseInfo;
    if (!chatInfo) {
        throw new Error('memu-ext: chatInfo not found');
    }

    const canUseTools = st.toolManager.isToolCallingSupported();
    const coreChat = chat.slice(from, to + 1).filter(x => !x.is_system || (canUseTools && Array.isArray(x.extra?.tool_invocations)));

    // IMPORTANT: preserve message order (Promise resolution order can differ)
    const messages = await Promise.all(coreChat.map(async (chatItem, index) => {
        let message = chatItem.mes;
        const regexType = chatItem.is_user ? st.regex_placement.USER_INPUT : st.regex_placement.AI_OUTPUT;
        const options = { isPrompt: true, depth: (coreChat.length - index - 1) };

        let regexedMessage = st.getRegexedString(message, regexType, options);
        regexedMessage = await st.appendFileContent(chatItem, regexedMessage);

        if (chatItem?.extra?.append_title && chatItem?.extra?.title) {
            regexedMessage = `${regexedMessage}\n\n${chatItem.extra.title}`;
        }

        return {
            role: chatItem.is_user
                ? (chatItem.name === memuExtras.baseInfo.userName ? 'user' : 'participant')
                : 'assistant',
            name: chatItem.is_user && chatItem.name !== memuExtras.baseInfo.userName ? chatItem.name : undefined,
            content: regexedMessage,
            // Preserve timestamp if available (ST chat.jsonl uses ISO send_date).
            ts_ms: (() => {
                const raw: any = (chatItem as any).send_date ?? (chatItem as any).sendDate;
                if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
                if (typeof raw === 'string') {
                    const ms = Date.parse(raw);
                    return Number.isFinite(ms) ? ms : undefined;
                }
                return undefined;
            })(),
        } as ConversationMessage;
    }));

    return messages;
}
