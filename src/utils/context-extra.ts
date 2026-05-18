import { event_types, eventSource, getMaxContextSize, saveChat } from "@silly-tavern/script.js";
import { debounce_timeout } from "@silly-tavern/scripts/constants.js";
import { getContext } from "@silly-tavern/scripts/st-context.js";
import { ToolManager } from '@silly-tavern/scripts/tool-calling.js';
import { debounce } from "@silly-tavern/scripts/utils.js";
import { appendFileContent } from '@silly-tavern/scripts/chats.js';
import { getRegexedString, regex_placement } from '@silly-tavern/scripts/extensions/regex/engine.js';
import { MEMU_LOCAL_STORAGE_SHOW_ADVANCED_MAPPING, MEMU_LOCAL_STORAGE_LOCAL_USER_ID, MEMU_LOCAL_STORAGE_OVERRIDE_SUMMARIZER, MEMU_LOCAL_STORAGE_IMPORT_LOREBOOKS, MEMU_LOCAL_STORAGE_MENTAL_HEALTH_ADDON } from "./consts";
import { MemuBaseInfo, MemuExtras, MemuRetrieve, MemuSummary } from "./types";

const originExtras: MemuExtras = {}

export const st = {
    getContext: () => getContext(),
    getChatMaxContextSize: () => getMaxContextSize(),

    saveChat: async () => await saveChat(),

    debounce: debounce,
    debounce_timeout: debounce_timeout,

    event_types: event_types,
    eventSource: eventSource,

    toolManager: ToolManager,

    getRegexedString: getRegexedString,
    regex_placement: regex_placement,
    appendFileContent: appendFileContent,
}

export const SHOW_ADVANCED_MAPPING = {
    get: () => localStorage.getItem(MEMU_LOCAL_STORAGE_SHOW_ADVANCED_MAPPING),
    set: (value: boolean) => localStorage.setItem(MEMU_LOCAL_STORAGE_SHOW_ADVANCED_MAPPING, value.toString()),
}

export const LOCAL_USER_ID = {
    get: () => localStorage.getItem(MEMU_LOCAL_STORAGE_LOCAL_USER_ID),
    set: (value: string) => localStorage.setItem(MEMU_LOCAL_STORAGE_LOCAL_USER_ID, value),
}

// Per-soul prefs: stored as a JSON map { "<characterName>": boolean, ... }
// under a single localStorage key. Reads fall back to the default when the
// character has no entry (or when no character is selected at all).
export function currentSelectedCharacterName(): string {
    try {
        const ctx: any = st.getContext?.();
        const character = (ctx?.characters && ctx?.characterId != null) ? ctx.characters[ctx.characterId] : null;
        return String(character?.name || '').trim();
    } catch {
        return '';
    }
}

function _readPerSoulMap(key: string): Record<string, boolean> {
    try {
        const raw = localStorage.getItem(key);
        if (!raw) return {};
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            return parsed as Record<string, boolean>;
        }
    } catch {}
    return {};
}

function _getPerSoulBool(key: string, defaultValue: boolean): boolean {
    const name = currentSelectedCharacterName();
    if (!name) return defaultValue;
    const map = _readPerSoulMap(key);
    return name in map ? Boolean(map[name]) : defaultValue;
}

function _setPerSoulBool(key: string, value: boolean): void {
    const name = currentSelectedCharacterName();
    if (!name) return;
    const map = _readPerSoulMap(key);
    map[name] = value;
    localStorage.setItem(key, JSON.stringify(map));
}

// Drop entries for characters that no longer exist in ST's character list.
// Called at extension startup; keeps the per-soul maps from growing forever
// after character renames/deletes. Safe when ST context isn't ready yet
// (bails silently; next startup retries).
export function pruneStalePerSoulEntries(keys: string[]): void {
    try {
        const ctx: any = st.getContext?.();
        const characters = ctx?.characters;
        if (!Array.isArray(characters) || characters.length === 0) return;
        const liveNames = new Set(
            characters.map((c: any) => String(c?.name || '').trim()).filter(Boolean),
        );
        for (const key of keys) {
            const map = _readPerSoulMap(key);
            const kept: Record<string, boolean> = {};
            for (const [name, value] of Object.entries(map)) {
                if (liveNames.has(name)) kept[name] = value;
            }
            if (Object.keys(kept).length !== Object.keys(map).length) {
                localStorage.setItem(key, JSON.stringify(kept));
            }
        }
    } catch {}
}

export const OVERRIDE_SUMMARIZER = {
    get: () => _getPerSoulBool(MEMU_LOCAL_STORAGE_OVERRIDE_SUMMARIZER, true),
    set: (value: boolean) => _setPerSoulBool(MEMU_LOCAL_STORAGE_OVERRIDE_SUMMARIZER, value),
}

export const IMPORT_LOREBOOKS = {
    get: () => _getPerSoulBool(MEMU_LOCAL_STORAGE_IMPORT_LOREBOOKS, true),
    set: (value: boolean) => _setPerSoulBool(MEMU_LOCAL_STORAGE_IMPORT_LOREBOOKS, value),
}

export const MENTAL_HEALTH_ADDON = {
    get: () => _getPerSoulBool(MEMU_LOCAL_STORAGE_MENTAL_HEALTH_ADDON, false),
    set: (value: boolean) => _setPerSoulBool(MEMU_LOCAL_STORAGE_MENTAL_HEALTH_ADDON, value),
}

export const memuExtras = new Proxy<MemuExtras>(originExtras, {
    get: (_, prop) => {
        checkAndInitChatMetadata();
        switch (prop) {
            case 'baseInfo':
                return (st.getContext().chatMetadata.memuExtras as MemuExtras).baseInfo;
            case 'retrieve':
                return (st.getContext().chatMetadata.memuExtras as MemuExtras).retrieve;
            case 'summary':
                return (st.getContext().chatMetadata.memuExtras as MemuExtras).summary;
            case 'serverInstanceId':
                return (st.getContext().chatMetadata.memuExtras as MemuExtras).serverInstanceId;
            default:
                throw new Error(`Unknown extra prop: ${String(prop)}`);
        }
    },
    set: (_, prop, value) => {
        checkAndInitChatMetadata();
        switch (prop) {
            case 'baseInfo':
                (st.getContext().chatMetadata.memuExtras as MemuExtras).baseInfo = value as MemuBaseInfo;
                return true;
            case 'retrieve':
                (st.getContext().chatMetadata.memuExtras as MemuExtras).retrieve = value as MemuRetrieve;
                return true;
            case 'summary':
                (st.getContext().chatMetadata.memuExtras as MemuExtras).summary = value as MemuSummary;
                return true;
            case 'serverInstanceId':
                (st.getContext().chatMetadata.memuExtras as MemuExtras).serverInstanceId = value as string;
                return true;
            default:
                throw new Error(`Unknown extra prop: ${String(prop)}`);
        }
    }
})

function checkAndInitChatMetadata() {
    if (!st.getContext().chatMetadata) {
        (st.getContext() as any).chatMetadata = {};
    }
    if (!(st.getContext().chatMetadata as any).memuExtras) {
        (st.getContext().chatMetadata as any).memuExtras = {} as MemuExtras;
    }
}
