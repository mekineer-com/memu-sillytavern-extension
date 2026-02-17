import { CategoryResponse } from "memu-js";
import { API_KEY, PLUGIN_MODE, memuExtras, st, Message, MessageCollection, AUTO_SUMMARY_BY_CONTEXT_SIZE, SUMMARY_TURN } from "utils/context-extra";
import { memorizeConversation, retrieveDefaultCategories, getPluginPing } from "utils/network";
import { ConversationMessage, MemuSummary, MemuTaskStatus, STEventData } from "utils/types";
import { charUpdateAddAuxWorld, createWorldInfoEntry, saveWorldInfo } from "@silly-tavern/scripts/world-info.js";
import { sumTokens } from "./utils";

let isSummarying = false;

// Persist the last processed chat index in localStorage as a backstop.
// This prevents repeated memorize/retrieve on chat re-open if chat_metadata doesn't round-trip for any reason.
// Keyed by SillyTavern chatId.

type LocalCursorState = { to: number; bridgeSessionId?: string; updatedAt?: number };

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

function cursorStorageKey(chatId: string): string {
    const safe = encodeURIComponent(chatId || '');
    return `memu.cursor.${safe}`;
}

function getLegacyChatIdRaw(): string {
    try {
        const ctx: any = st.getContext() as any;
        const id = (typeof ctx?.getCurrentChatId === 'function')
            ? ctx.getCurrentChatId()
            : (ctx?.chatId ?? ctx?.chat_id);
        return (typeof id === 'string') ? id : '';
    } catch {
        return '';
    }
}

function loadLocalCursor(chatId: string): LocalCursorState | null {
    if (!chatId) return null;
    try {
        let raw = localStorage.getItem(cursorStorageKey(chatId));
        // Migration: older builds keyed cursor by raw chat id (no prefixes, no integrity id).
        if (!raw && chatId.startsWith('integrity:')) {
            const legacyRaw = getLegacyChatIdRaw();
            if (legacyRaw) {
                raw = localStorage.getItem(cursorStorageKey(legacyRaw))
                    || localStorage.getItem(cursorStorageKey(`chat:${legacyRaw}`));
                // If we found legacy state, we'll re-save it under the new key after parsing.
            }
        }
        if (!raw) return null;
        const obj = JSON.parse(raw);
        const to = Number(obj?.to);
        if (!Number.isFinite(to)) return null;
        const out: LocalCursorState = { to };
        if (obj?.bridgeSessionId) out.bridgeSessionId = String(obj.bridgeSessionId);
        if (obj?.updatedAt) out.updatedAt = Number(obj.updatedAt);

        // If we loaded a legacy cursor entry, persist it to the new key so future loads are fast.
        if (chatId.startsWith('integrity:')) {
            try {
                localStorage.setItem(cursorStorageKey(chatId), JSON.stringify(out));
            } catch {
                // ignore
            }
        }
        return out;
    } catch {
        return null;
    }
}

function saveLocalCursor(chatId: string, state: LocalCursorState): void {
    if (!chatId) return;
    try {
        localStorage.setItem(cursorStorageKey(chatId), JSON.stringify(state));
    } catch { }
}

export function clearLocalCursor(chatId?: string): void {
    const id = chatId ?? getChatIdSafe();
    if (!id) return;
    try { localStorage.removeItem(cursorStorageKey(id)); } catch { }
}

// --- World Info helpers (list/get/edit) ---

let _csrfCache: { token: string; at: number } | null = null;

async function getCsrfTokenCached(): Promise<string> {
    try {
        const now = Date.now();
        if (_csrfCache && (now - _csrfCache.at) < 60_000 && _csrfCache.token) return _csrfCache.token;
        const csrf = await fetch('/csrf-token');
        const csrfJson: any = await csrf.json().catch(() => ({} as any));
        const token = (csrfJson && csrfJson.token) ? String(csrfJson.token) : '';
        _csrfCache = { token, at: now };
        return token;
    } catch {
        return '';
    }
}

async function postJsonWithCsrf(url: string, body: any): Promise<any> {
    const token = await getCsrfTokenCached();
    const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-csrf-token': token },
        body: JSON.stringify(body ?? {}),
    });
    if (!resp.ok) {
        const txt = await resp.text().catch(() => '');
        throw new Error(`${url} failed (${resp.status}): ${txt}`);
    }
    return resp.json().catch(() => ({} as any));
}

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
    const character = (ctx?.characters && ctx?.characterId != null) ? (ctx.characters[ctx.characterId] ?? ctx.characters[0]) : null;
    return sanitizeWorldInfoName(String(character?.name || baseInfo?.characterName || baseInfo?.agentName || 'Character'));
}

function memuBookPrefixForCharacter(characterName: string): string {
    const c = sanitizeWorldInfoName(String(characterName || '')).trim();
    return `memU - ${c} - `;
}

/**
 * If we have a backstop cursor (localStorage) but *no* memU chat-state and *no* memU lorebooks on disk,
 * that cursor is almost certainly from an older buggy build. Clear it so a fresh memorize/retrieve can run.
 */
export async function healOrphanLocalCursorIfNeeded(): Promise<void> {
    const chatId = getChatIdSafe();
    if (!chatId) return;

    const localCursor = loadLocalCursor(chatId);
    if (!localCursor) return;

    const hasState = !!memuExtras.retrieve?.nowRetrieve?.summaryRange || !!memuExtras.summary?.summaryRange;
    if (hasState) return;

    // Only do the expensive check when we'd otherwise skip work.
    const chat: any[] = st.getContext().chat ?? [];
    const chatLen = Array.isArray(chat) ? chat.length : 0;
    if (localCursor.to < (chatLen - 1)) return;

    const characterName = getCurrentCharacterNameForWorldInfo(memuExtras.baseInfo);
    const prefix = memuBookPrefixForCharacter(characterName);

    let hasAnyMemuBooks = false;
    try {
        const list = await listWorldInfoBooks();
        hasAnyMemuBooks = list.some((x: any) => {
            const id = String(x?.file_id ?? '');
            const nm = String(x?.name ?? '');
            return id.startsWith(prefix) || nm.startsWith(prefix);
        });
    } catch {
        // If we can't list worlds, don't destroy cursor; fail safe.
        return;
    }

    if (!hasAnyMemuBooks) {
        clearLocalCursor(chatId);
        console.log('memu-ext: cleared orphan local cursor (no memU state + no memU lorebooks)');
    }
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
        console.log('memu-ext: migrated %d memU lorebooks to UI-only (disable=true, constant=false)', changedCount);
    }
}

export async function summaryIfNeed(): Promise<void> {
    if (isSummarying) {
        return;
    }

    isSummarying = true;

    const chatId = getChatIdSafe();
    if (!chatId) {
        // Chat not fully initialized yet (no stable chatId). Avoid a false "re-digest" on load.
        isSummarying = false;
        return;
    }
    const localCursor = loadLocalCursor(chatId);

    const lastToFromSummary = memuExtras.summary?.summaryRange?.[1];
    const lastToFromRetrieve = memuExtras.retrieve?.nowRetrieve?.summaryRange?.[1];
    const lastToFromLocal = localCursor?.to;

    const lastTo = Math.max(
        Number.isFinite(lastToFromSummary as any) ? (lastToFromSummary as any as number) : -1,
        Number.isFinite(lastToFromRetrieve as any) ? (lastToFromRetrieve as any as number) : -1,
        Number.isFinite(lastToFromLocal as any) ? (lastToFromLocal as any as number) : -1,
    );

    const from = lastTo + 1;
    const chat = st.getContext().chat;

    // Debug: helps diagnose repeated digest on chat re-open.
    console.debug('memu-ext: digest cursor', {
        chatId,
        chatLen: Array.isArray(chat) ? chat.length : -1,
        lastToFromSummary,
        lastToFromRetrieve,
        lastToFromLocal,
        lastTo,
        from,
    });

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

    if (AUTO_SUMMARY_BY_CONTEXT_SIZE.get()) {
        const total = await sumTokens(from);
        console.log('memu-ext: now token accumulated: %d, max context: %d', total, st.getChatMaxContextSize());
        if (total >= st.getChatMaxContextSize()) {
            await doSummary(from, chat.length - 1);
        }
    } else {
        const summaryTurn = parseInt(SUMMARY_TURN.get());
        const nowTurn = chat.length - from;
        console.log('memu-ext: now turn: %d, digest turn: %d', nowTurn, summaryTurn);
        if (nowTurn >= summaryTurn) {
            await doSummary(from, chat.length - 1);
        }
    }
    isSummarying = false;
}

export async function doSummary(from: number, to: number): Promise<void> {
    // Prefer plugin-reported mode. localStorage can be stale on first load.
    let mode = PLUGIN_MODE.get();
    let ping: any = null;
    try {
        ping = await getPluginPing();
        if (ping?.mode) {
            mode = ping.mode as any;
            try { PLUGIN_MODE.set(mode); } catch { }
        }
    } catch { }

    const chatId = getChatIdSafe();
    const apiKey = mode === 'local' ? '' : API_KEY.get();
    if (mode !== 'local' && apiKey == null) {
        console.log('memu-ext: missing API key');
        return;
    }
    if (memuExtras.baseInfo == null) {
        console.log('memu-ext: baseInfo not found');
        return;
    }
    console.log('memu-ext: trigger memorize digest');

    try {
        const response = await memorizeConversation(
            apiKey,
            {
                messages: await prepareConversationData(from, to),
                userId: memuExtras.baseInfo.userId,
                userName: memuExtras.baseInfo.userName,
                characterId: memuExtras.baseInfo.characterId,
                characterName: memuExtras.baseInfo.characterName,
            },
        );
                memuExtras.summary = {
            summaryRange: [from, to],
            summaryTaskId: response.taskId,
            summaryTaskStatus: MemuTaskStatus.PENDING,
            isReady: false,
            failureCount: 0,
            lastError: undefined,
        };
        await st.saveChat();
        // IMPORTANT: do NOT advance the local cursor on memorize start.
        // Persist the cursor only after a successful retrieve.
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
        };
        await st.saveChat();
        console.error('memu-ext: memorize failed', error);
    }
}

export async function retrieveMemories(summary: MemuSummary): Promise<void> {
    const chatId = getChatIdSafe();
    let mode = PLUGIN_MODE.get();
    try {
        const ping = await getPluginPing();
        if (ping?.mode) {
            mode = ping.mode as any;
            try { PLUGIN_MODE.set(mode); } catch { }
        }
    } catch { }

    const apiKey = mode === 'local' ? '' : API_KEY.get();
    if (mode !== 'local' && apiKey == null) {
        console.log('memu-ext: missing API key');
        return;
    }
    console.log('memu-ext: trigger retrieve memories');
    try {
        const response = await retrieveDefaultCategories(
            apiKey,
            memuExtras.baseInfo.userId,
            memuExtras.baseInfo.characterId,
        );
        const memuSummaryText = parseSummary(response.categories);
        try { writeToStSummarizeMemory(memuSummaryText); } catch { }

        // Put memU's retrieved summary into SillyTavern's built-in "Summarize/Memory" slot.
        // That extension stores the latest summary at chat[i].extra.memory (it ignores the last message),
        // so we write to the pre-last message to keep it visible + compatible.
        // Write memU categories into World Info lorebooks (one per category) so you can view them in the ST UI.
        try {
            await syncCategoriesToWorldInfo(memuExtras.baseInfo, response.categories);
        } catch (e) {
            console.warn('memu-ext: world info sync failed', e);
        }

                const retrieve = memuExtras.retrieve ?? {
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
        memuExtras.retrieve = retrieve;
                await st.saveChat();
        // Backstop cursor persistence (localStorage)
        saveLocalCursor(chatId || getChatIdSafe(), { to: summary.summaryRange[1], updatedAt: Date.now() });
        console.log('memu-ext: retrieve OK (%d categories)', Array.isArray(response.categories) ? response.categories.length : 0);
    } catch (error) {
        console.error('memu-ext: retrieve memories failed', error);
        throw error;
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
    const character = (ctx?.characters && ctx?.characterId != null) ? (ctx.characters[ctx.characterId] ?? ctx.characters[0]) : null;
    const characterName = sanitizeWorldInfoName(String(character?.name || baseInfo?.characterName || baseInfo?.agentName || 'Character'));
    const avatarKey = character?.avatar;

    const createdBooks: string[] = [];
    const attachBooks: string[] = [];

    for (const cat of categories) {
        const catName = sanitizeWorldInfoName(String((cat as any)?.name || 'category'));
        const bookName = sanitizeWorldInfoName(`memU - ${characterName} - ${catName}`);

        const raw = String((cat as any)?.summary ?? (cat as any)?.description ?? '');
        const cleaned = cleanCategorySummary(raw);
        const content = isNullishCategorySummary(cleaned)
            ? `(No stored memories in this category yet.)`
            : cleaned;
        const finalContent = filterCategoryForCharacter(catName, content, characterName, baseInfo?.userName);

        const t = (finalContent || '').trim();
        const looksRich = !!t && (
            t.startsWith('#') ||
            /\n\s*##?\s+\S/.test(t) ||
            /\n\s*[-*]\s+\S/.test(t) ||
            t.length >= 220
        );

        await upsertWorldInfoLorebook(bookName, buildWorldInfoFileData(bookName, catName, finalContent));
        createdBooks.push(bookName);
        if (looksRich) attachBooks.push(bookName);
    }

    // Attach created lorebooks to the current character so they show up under Character → Lorebooks.
    if (avatarKey && attachBooks.length > 0) {
        try {
            await charUpdateAddAuxWorld(String(avatarKey), attachBooks);
        } catch (e) {
            console.warn('memu-ext: failed to attach world info lorebooks to character', e);
        }
    }

    console.log('memu-ext: world info synced (%d lorebooks)', createdBooks.length);
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

// function prepareConversationData(): ConversationMessage[] {
//     const chat = st.getContext().chat;
//     const chatInfo = memuExtras.baseInfo;
//     if (!chatInfo) {
//         throw new Error('memu-ext: chatInfo not found');
//     }

//     const messages: ConversationMessage[] = [];
//     for (const message of chat) {
//         messages.push({
//             role: message.is_user ? message.name === chatInfo.userName ? 'user' : 'participant' : 'assistant',
//             name: message.is_user && message.name !== chatInfo.userName ? message.name : undefined,
//             content: message.mes,
//         });
//     }
//     return messages;
// }

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
        } as ConversationMessage;
    }));

    return messages;
}
