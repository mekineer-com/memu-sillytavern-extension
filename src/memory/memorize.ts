import { CategoryResponse } from "memu-js";
import { memuExtras, st, Message, MessageCollection } from "utils/context-extra";
import { conversationRetrieve, memorizeConversation, retrieveDefaultCategories } from "utils/network";
import { ConversationMessage, MemuSummary, MemuTaskStatus } from "utils/types";
import { createWorldInfoEntry, saveWorldInfo, updateWorldInfoList } from "@silly-tavern/scripts/world-info.js";
import { initChatExtraInfo } from "./utils";
import { status, warn, error as logError, onceWarn } from "utils/log";
import { stashInspectData } from "ui/inspect-panel";

let isSummarying = false;

type PendingRetrieveTurn = {
    conversationId: string;
    userId: string;
    soulId: string;
    queryText: string;
};

type PendingAPImw = {
    conversationId: string;
    promise: Promise<void>;
};

let _pendingRetrieveTurn: PendingRetrieveTurn | null = null;
let _pendingAPImw: PendingAPImw | null = null;

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

    // Ensure per-chat baseInfo reflects the *current* character before we decide to digest.
    try { await initChatExtraInfo(st.getContext()); } catch { }

    const chatId = getChatIdSafe();
    if (!chatId) {
        // Chat not fully initialized yet (no stable chatId). Avoid a false "re-digest" on load.
        isSummarying = false;
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
        isSummarying = false;
        return;
    }

    // If a summary task is already running, let the poller handle it.
    if (memuExtras.summary && (memuExtras.summary.summaryTaskStatus === MemuTaskStatus.PENDING || memuExtras.summary.summaryTaskStatus === MemuTaskStatus.PROCESSING)) {
        isSummarying = false;
        return;
    }

    // Backoff (minimal): if we failed recently, pause auto-digest for a bit.
    const sf: any = memuExtras.summary;
    const nowMs = Date.now();
    const pauseUntilMs = Number(sf?.pauseUntilMs ?? 0);
    if (pauseUntilMs && nowMs < pauseUntilMs) {
        isSummarying = false;
        return;
    }
    if (sf && sf.summaryTaskStatus === MemuTaskStatus.FAILURE) {
        const fc = Number(sf.failureCount ?? 0);
        const pauseMs = (fc >= 3) ? (5 * 60_000) : 10_000;
        sf.pauseUntilMs = nowMs + pauseMs;
        isSummarying = false;
        return;
    }
    const chatLen = chat.length;
    status(chatLen, from);
    await doSummary(from, chat.length - 1);
    isSummarying = false;
}

export async function doSummary(from: number, to: number, force: boolean = false): Promise<void> {
    try { await initChatExtraInfo(st.getContext()); } catch { }
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
                : null;

            memuExtras.summary = {
                summaryRange: [from, to],
                summaryTaskId: localTaskId,
                summaryTaskStatus: localTaskId ? MemuTaskStatus.PENDING : MemuTaskStatus.SUCCESS,
                isReady: localTaskId ? false : true,
                force,
                failureCount: 0,
                lastError: undefined,
            };
            await st.saveChat();

            // Legacy/sync fallback: no task id means we should retrieve immediately.
            if (!localTaskId) {
                await retrieveMemories(memuExtras.summary);
                return;
            }

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
    try { await initChatExtraInfo(st.getContext()); } catch { }
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
    try { await initChatExtraInfo(st.getContext()); } catch { }
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
    try { await initChatExtraInfo(st.getContext()); } catch { }
    try {
        const response = await retrieveDefaultCategories(
            memuExtras.baseInfo.userId,
            memuExtras.baseInfo.characterId,
        );
        const categories = Array.isArray((response as any)?.categories) ? (response as any).categories : [];
        const memuSummaryText = parseSummary(categories);
        try { writeToStSummarizeMemory(memuSummaryText); } catch { }

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

function trackPendingAPImw(conversationId: string, promise: Promise<any>): void {
    const wrapped: Promise<void> = promise.finally(() => {
        if (_pendingAPImw?.promise === wrapped) {
            _pendingAPImw = null;
        }
    });
    _pendingAPImw = { conversationId, promise: wrapped };
}

async function failIfPendingAPImw(conversationId: string): Promise<void> {
    const pending = _pendingAPImw;
    if (!pending || pending.conversationId !== conversationId) return;
    const message = `memu: previous APImw still running for ${conversationId}; continuing RAG and skipping duplicate APImw`;
    (window as any).toastr?.warning?.(message);
}

export function resetRetrievePipelineState(): void {
    _pendingRetrieveTurn = null;
}

export function retrieveForLatestUserMessage(messageIdAny: any): void {
    void (async () => {
        try { await initChatExtraInfo(st.getContext()); } catch { }
        if (!memuExtras.baseInfo) return;

        const ctx: any = st.getContext();
        const chat: any[] = Array.isArray(ctx?.chat) ? ctx.chat : [];
        const messageId = Number(messageIdAny);
        const idx = Number.isFinite(messageId) ? messageId : (chat.length - 1);
        if (idx < 0 || idx >= chat.length) return;

        const chatItem: any = chat[idx];
        const rawText = typeof chatItem?.mes === 'string' ? chatItem.mes : '';
        const queryText = rawText.trim();
        if (!queryText) return;

        const conversationId = getChatIdSafe();
        const userId = String(memuExtras.baseInfo.userId || '').trim();
        const soulId = String(memuExtras.baseInfo.characterId || '').trim();
        if (!conversationId || !userId || !soulId) return;
        clearLiveRetrieveSummary();
        _pendingRetrieveTurn = {
            conversationId,
            userId,
            soulId,
            queryText,
        };
        stashInspectData({
            timestamp: Date.now(),
            query: queryText,
            status: 'pending',
            userId,
            soulId,
            method: 'rag',
            conversationId,
        });
    })();
}

async function resolveRetrieveTurnForPrompt(): Promise<PendingRetrieveTurn | null> {
    if (_pendingRetrieveTurn) return _pendingRetrieveTurn;

    try { await initChatExtraInfo(st.getContext()); } catch { }
    if (!memuExtras.baseInfo) return null;

    const ctx: any = st.getContext();
    const chat: any[] = Array.isArray(ctx?.chat) ? ctx.chat : [];
    let queryText = '';
    for (let i = chat.length - 1; i >= 0; i--) {
        const item: any = chat[i];
        const isUser = item?.is_user === true || (ctx?.name1 != null && String(item?.name || '') === String(ctx.name1));
        if (!isUser) continue;
        const text = typeof item?.mes === 'string' ? item.mes.trim() : '';
        if (!text) continue;
        queryText = text;
        break;
    }
    if (!queryText) return null;

    const conversationId = getChatIdSafe();
    const userId = String(memuExtras.baseInfo.userId || '').trim();
    const soulId = String(memuExtras.baseInfo.characterId || '').trim();
    if (!conversationId || !userId || !soulId) return null;

    return { conversationId, userId, soulId, queryText };
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

    await failIfPendingAPImw(turn.conversationId);
    let resp: any;
    try {
        resp = await conversationRetrieve({
            userId: turn.userId,
            soulId: turn.soulId,
            conversationId: turn.conversationId,
            method: 'rag',
            query: turn.queryText,
        });
    } catch (err: any) {
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
    const workingNoteSummary = parsedPrior.summary;
    const memoryCacheSummary = formatMemoryCacheForPrompt((resp as any)?.memory_cache);
    const intentionSummary = formatIntentionsForPrompt((resp as any)?.active_intentions);
    stashInspectData({
        timestamp: Date.now(),
        query: turn.queryText,
        status: 'ok',
        workingNote: parsedPrior.inspectText || undefined,
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
    });
    const hasPriorPayload = (resp as any)?.prior_context != null && String((resp as any).prior_context).trim() !== '';
    const promptSections: string[] = [];
    if (hasPriorPayload) {
        promptSections.push(`[Prior context]\n${workingNoteSummary || '(none)'}`);
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
        writeToStSummarizeMemory(promptSummary);
    }
    addSummaryToPrompt(eventData, replaceSystem, promptSummary);
}

export function dispatchPendingAPImw(generateData: any): void {
    const turn = _pendingRetrieveTurn;
    if (!turn) return;
    if (_pendingAPImw?.conversationId === turn.conversationId) {
        _pendingRetrieveTurn = null;
        return;
    }
    _pendingRetrieveTurn = null;
    void generateData;
    trackPendingAPImw(turn.conversationId, conversationRetrieve({
        userId: turn.userId,
        soulId: turn.soulId,
        conversationId: turn.conversationId,
        method: 'llm',
        query: turn.queryText,
    }));
}

function writeToStSummarizeMemory(text: string): void {
    const ctx = st.getContext();
    const chat: any[] = (ctx as any)?.chat ?? [];
    if (!Array.isArray(chat) || chat.length === 0) return;

    // Summarize/Memory extension ignores the last message when searching for extra.memory,
    // so we write to the pre-last message (or 0 if chat is too short).
    const idx = Math.max(0, chat.length - 2);
    const mes = chat[idx];
    if (!mes) return;
    if (!mes.extra) mes.extra = {};

    // Keep it readable: avoid megabyte-sized blocks if a backend returns huge summaries.
    const MAX_CHARS = 6000;
    mes.extra.memory = (text && text.length > MAX_CHARS)
        ? `${text.slice(0, MAX_CHARS)}\n\n…(truncated)`
        : text;
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
    try {
        await updateWorldInfoList();
    } catch { }
    try {
        (st as any)?.eventSource?.emit?.((st as any)?.event_types?.SETTINGS_UPDATED);
    } catch { }
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
    if (hasSummaryAlready(eventData, memuSummary)) {
        return;
    }
    if (replaceSystem && Array.isArray(eventData?.chat)) {
        const summary = findSystemSummary(st.promptManager.messages);
        if (summary) {
            replaceSystemSummary(summary, memuSummary, eventData);
            return;
        }
    }
    addSummary(memuSummary, eventData);
}

function hasSummaryAlready(eventData: any, memuSummary: string): boolean {
    if (Array.isArray(eventData?.chat)) {
        return eventData.chat.some((msg: any) => {
            const content = typeof msg?.content === 'string' ? msg.content : '';
            return content === memuSummary || content.includes(memuSummary);
        });
    }
    if (typeof eventData?.prompt === 'string') {
        return eventData.prompt.includes(memuSummary);
    }
    return false;
}

function replaceSystemSummary(summary: string, memuSummary: string, eventData: any): void {
    if (!Array.isArray(eventData?.chat)) return;
    eventData.chat.forEach((msg: any) => {
        if (msg.content === summary) {
                        msg.content = memuSummary;
            return;
        }
    });
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
        eventData.prompt = `${memuSummary}\n\n${eventData.prompt}`;
    }
}

/**
 * @copy from @silly-tavern/scripts/openai.js
 *
 * Retrieves the chat as a flattened array of messages.
 * @returns {Array} The chat messages.
 */
function findSystemSummary(messages: MessageCollection): string {
    for (let item of messages.collection) {
        if (item instanceof MessageCollection) {
            const summary = findSystemSummary(item);
            if (summary) {
                return summary;
            }
        } else if (item instanceof Message && item.content) {
            if (item.identifier === 'summary') {
                return item.content;
            }
        }
    }
    return null;
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
