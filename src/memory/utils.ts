import { memuExtras, st } from "utils/context-extra";
import { createOwner, createSoul, getOwner, getSouls } from "utils/network";


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


let canonicalOwnerId = '';

function askSoulName(proposedSoul: string): string {
    const entered = window.prompt('What will your first Soul be called?', proposedSoul);
    const soulId = String(entered || '').trim();
    if (!soulId) throw new Error('OpenAlma Soul setup was cancelled');
    return soulId;
}

async function resolveOwner(defaultName: string | undefined, proposedSoul: string): Promise<string> {
    if (canonicalOwnerId) return canonicalOwnerId;
    const existing = await getOwner();
    const souls = await getSouls();
    if (existing.user_id) {
        if (souls.souls.length === 0) {
            const soulId = askSoulName(proposedSoul);
            if (!window.confirm(`Use "${soulId}" as your first OpenAlma Soul?`)) {
                throw new Error('OpenAlma Soul setup was cancelled');
            }
            await createSoul(soulId);
        }
        canonicalOwnerId = existing.user_id;
        return canonicalOwnerId;
    }
    const entered = window.prompt('What is your name?', String(defaultName || '').trim());
    const userId = String(entered || '').trim();
    if (!userId) throw new Error('OpenAlma owner setup was cancelled');
    const soulId = souls.souls.length === 0 ? askSoulName(proposedSoul) : '';
    const confirmation = soulId
        ? `Use "${userId}" as your OpenAlma name and "${soulId}" as your first Soul? Neither can be changed yet.`
        : `Use "${userId}" as your OpenAlma name? It cannot be changed yet.`;
    if (!window.confirm(confirmation)) {
        throw new Error('OpenAlma owner setup was cancelled');
    }
    const ownerId = (await createOwner(userId)).user_id;
    if (soulId) await createSoul(soulId);
    canonicalOwnerId = ownerId;
    return canonicalOwnerId;
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
    const userId = await resolveOwner(ctx?.name1, desiredCharacterName);
    const userName = (ctx?.name1 != null) ? String(ctx.name1) : (existing?.userName ?? '');

    // Update if missing or stale (chat switching can fire before ctx.characterId updates).
    if (!existing || existing.userId !== userId || existing.characterId !== desiredCharacterId || existing.characterName !== desiredCharacterName || existing.userName !== userName) {
        memuExtras.baseInfo = {
            characterId: desiredCharacterId,
            characterName: desiredCharacterName,
            userName,
            userId,
        };
        await st.saveChat();
    }
}
