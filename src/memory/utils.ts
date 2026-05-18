import { LOCAL_USER_ID, memuExtras, st } from "utils/context-extra";


async function waitForActiveCharacter(initialCtx: any, attempts: number = 8, delayMs: number = 120): Promise<any | null> {
    let ctx = initialCtx;
    for (let i = 0; i < attempts; i++) {
        const character = ctx?.characters?.[ctx?.characterId];
        if (character) return character;
        if (i < attempts - 1) {
            await new Promise((resolve) => setTimeout(resolve, delayMs));
            ctx = st.getContext();
        }
    }
    return null;
}


function getStableLocalUserId(fallback: string | undefined): string {
    try {
        const existing = LOCAL_USER_ID.get();
        const seed = (fallback || '').trim();
        if (existing && existing.trim()) {
            const current = existing.trim();
            // If the only difference is casing, keep it aligned with the visible ST username.
            if (seed && current.toLowerCase() === seed.toLowerCase() && current !== seed) {
                LOCAL_USER_ID.set(seed);
                return seed;
            }
            return current;
        }
        if (seed) {
            LOCAL_USER_ID.set(seed);
            return seed;
        }
        const id = (globalThis.crypto && 'randomUUID' in globalThis.crypto) ? (globalThis.crypto as any).randomUUID() : `memu_${Date.now()}_${Math.random().toString(16).slice(2)}`;
        LOCAL_USER_ID.set(id);
        return id;
    } catch {
        return (fallback || '').trim() || `memu_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    }
}

export async function initChatExtraInfo(ctx: any): Promise<void> {
    // IMPORTANT: never guess the character. If SillyTavern context isn"t ready yet, bail and try again later.
    const character = await waitForActiveCharacter(ctx);
    if (!character) {
        return;
    }

    // KISS: per-character scope is the character name.
    // If someone renames a character, they get a new DB/lorebooks. That's fine.
    const desiredCharacterName = String(character.name || '').trim();
    const desiredCharacterId = desiredCharacterName;

    const existing = memuExtras.baseInfo;
    const userId = (existing?.userId && String(existing.userId).trim()) ? String(existing.userId).trim() : getStableLocalUserId(ctx?.name1);
    const userName = (ctx?.name1 != null) ? String(ctx.name1) : (existing?.userName ?? '');

    // Update if missing or stale (chat switching can fire before ctx.characterId updates).
    if (!existing || existing.characterId !== desiredCharacterId || existing.characterName !== desiredCharacterName || existing.userName !== userName) {
        memuExtras.baseInfo = {
            characterId: desiredCharacterId,
            characterName: desiredCharacterName,
            userName,
            userId,
        };
        await st.saveChat();
    }
}
