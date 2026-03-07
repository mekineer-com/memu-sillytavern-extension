import { CategoryResponse } from "memu-js";
import { memuExtras, st, Message, MessageCollection, AUTO_SUMMARY_BY_CONTEXT_SIZE, SUMMARY_TURN } from "utils/context-extra";
import { memorizeConversation, retrieveDefaultCategories } from "utils/network";
import { ConversationMessage, MemuSummary, MemuTaskStatus, STEventData } from "utils/types";
import { charUpdateAddAuxWorld, createWorldInfoEntry, saveWorldInfo, updateWorldInfoList } from "@silly-tavern/scripts/world-info.js";
import { sumTokens, initChatExtraInfo } from "./utils";
import { postJsonWithCsrf } from "utils/csrf";
import { status, info, warn, error as logError, onceWarn } from "utils/log";

let isSummarying = false;

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

// --- World Info helpers (list/get/edit) ---

type WorldInfoListItem = { file_id?: string; name?: string };

async function listWorldInfoBooks(): Promise<WorldInfoListItem[]> {
    const data = await postJsonWithCsrf('/api/worldinfo/list', {});
    return Array.isArray(data) ? data : [];
}

async function getWorldInfoBook(name: string): Promise<any> {
    return await postJsonWithCsrf('/api/worldinfo/get', { name });
}

function getCurrentCharacterNameForWorldInfo(baseInfo?: any): string {
    const ctx: any = st.getContext();
    const character = (ctx?.characters && ctx?.characterId != null) ? (ctx.characters[ctx.characterId] ?? null) : null;
    return sanitizeWorldInfoName(String(character?.name || baseInfo?.characterName || baseInfo?.agentName || 'Character'));
}

function memuBookPrefixForCharacter(characterName: string): string {
    const c = sanitizeWorldInfoName(String(characterName || '')).trim();
    return `memU - ${c} - `;
}

/**
 * Keep memU lorebooks UI-only: disable/constant=false so they don't get injected into prompts (token cost).
 * This also "heals" older builds that created constant=true entries.
 */
export async function ensureMemULorebooksUiOnly(): Promise<void> {
    const characterName = getCurrentCharacterNameForWorldInfo(memuExtras.baseInfo);
    const prefix = memuBookPrefixForCharacter(characterName);

    let list: WorldInfoListItem[] = [];
    try {
        list = await listWorldInfoBooks();
    } catch {
        return;
    }

    const targets = list
        .map(x => String((x as any)?.file_id || (x as any)?.name || ''))
        .filter(n => n && n.startsWith(prefix));

    if (targets.length === 0) return;

    let changedCount = 0;

    for (const name of targets) {
        let data: any;
        try {
            data = await getWorldInfoBook(name);
        } catch {
            continue;
        }
        if (!data || typeof data !== 'object' || !data.entries || typeof data.entries !== 'object') continue;

        let changed = false;
        for (const k of Object.keys(data.entries)) {
            const e = data.entries[k];
            if (!e || typeof e !== 'object') continue;
            if (e.constant !== false) { e.constant = false; changed = true; }
            if (e.disable !== true) { e.disable = true; changed = true; }
        }

        if (!changed) continue;

        try {
            await upsertWorldInfoLorebook(name, data);
            changedCount += 1;
        } catch {
            // ignore
        }
    }

    if (changedCount > 0) {
        info(`lorebooks set to ui-only (${changedCount} updated)`);
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
    let summaryTurn = parseInt(String(SUMMARY_TURN.get() ?? ''));
    if (!Number.isFinite(summaryTurn) || summaryTurn < 5) summaryTurn = 10;
    if (summaryTurn > 200) summaryTurn = 200;
    const chatLen = chat.length;
    status(chatLen, from);

    const nowTurn = chat.length - from;

    if (AUTO_SUMMARY_BY_CONTEXT_SIZE.get()) {
        const total = await sumTokens(from);
        if (total >= st.getChatMaxContextSize()) {
            await doSummary(from, chat.length - 1);
        }
    } else {
        if (nowTurn >= summaryTurn) {
            await doSummary(from, chat.length - 1);
        }
    }
    isSummarying = false;
}

export async function doSummary(from: number, to: number): Promise<void> {
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
            });
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
            failureCount: (memuExtras.summary?.failureCount ?? 0) + 1,
            lastError: error instanceof Error ? error.message : String(error),
            lastFailureAt: Date.now(),
        };
        await st.saveChat();
        logError(`memorize failed (range=${from}-${to})`, error);
    }
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

    const t = (content || '').trim();
    const looksRich = !!t && (
        t.startsWith('#') ||
        /\n\s*##?\s+\S/.test(t) ||
        /\n\s*[-*]\s+\S/.test(t) ||
        t.length >= 220
    );

    // Keep memU lorebooks as *UI-only* by default.
    // memU already injects its retrieved summary into the prompt via `addSummaryToPrompt()`.
    // If these lorebook entries are also enabled/constant, they get injected *again*, wasting tokens
    // and cluttering prompt logs. Users can manually enable an entry if they really want WI injection.
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
    const avatarKey = character?.avatar;

    const createdBooks: string[] = [];

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
        createdBooks.push(bookName);
    }

    // Attach created lorebooks to the current character so they show up under Character → Lorebooks.
    // IMPORTANT: attach *all* created books. Entries are disabled (UI-only) by default, so attaching
    // does not inject them into prompts; it just makes them visible for debugging and manual enabling.
    if (avatarKey && createdBooks.length > 0) {
        try {
            await charUpdateAddAuxWorld(String(avatarKey), createdBooks);
        } catch (e) {
            onceWarn("lorebooks-attach-failed", "lorebooks attach failed");
        }
    } else if (!avatarKey && createdBooks.length > 0) {
        onceWarn("lorebooks-no-avatar", "lorebooks not attached (no avatar)");
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

export function addSummaryToPrompt(eventData: STEventData, replaceSystem: boolean = true): void {
    const memuSummary = memuExtras.retrieve?.nowRetrieve?.summary;
    if (!memuSummary) {
                return;
    }
    if (replaceSystem) {
        const summary = findSystemSummary(st.promptManager.messages);
        if (summary) {
                        replaceSystemSummary(summary, memuSummary, eventData);
            return;
        }
    }
    addSummary(memuSummary, eventData);
}

function replaceSystemSummary(summary: string, memuSummary: string, eventData: STEventData): void {
    eventData.chat.forEach(msg => {
        if (msg.content === summary) {
                        msg.content = memuSummary;
            return;
        }
    });
}

function addSummary(memuSummary: string, eventData: STEventData): void {
    eventData.chat.unshift({
        role: 'system',
        content: memuSummary,
    });
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
