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


function askSoulName(proposedSoul: string): string {
    const entered = window.prompt('What will your first Soul be called?', proposedSoul);
    const soulId = String(entered || '').trim();
    if (!soulId) throw new Error('OpenAlma Soul setup was cancelled');
    return soulId;
}

async function resolveIdentity(defaultName: string | undefined, proposedSoul: string): Promise<{ userId: string; soulId: string; createSoul: boolean }> {
    const existing = await getOwner();
    const souls = await getSouls();
    let userId = existing.user_id || '';
    if (!userId) {
        const entered = window.prompt('What is your name?', String(defaultName || '').trim());
        userId = String(entered || '').trim();
        if (!userId) throw new Error('OpenAlma owner setup was cancelled');
        const soulId = souls.souls.length === 0 ? askSoulName(proposedSoul) : '';
        const confirmation = soulId
            ? `Use "${userId}" as your OpenAlma name and "${soulId}" as your first Soul? Neither can be changed yet.`
            : `Use "${userId}" as your OpenAlma name? It cannot be changed yet.`;
        if (!window.confirm(confirmation)) throw new Error('OpenAlma owner setup was cancelled');
        userId = (await createOwner(userId)).user_id;
        if (soulId) {
            return { userId, soulId, createSoul: true };
        }
    }

    if (souls.souls.length === 0) {
        const soulId = askSoulName(proposedSoul);
        if (!window.confirm(`Use "${soulId}" as your first OpenAlma Soul?`)) {
            throw new Error('OpenAlma Soul setup was cancelled');
        }
        return { userId, soulId, createSoul: true };
    }
    if (!souls.souls.includes(proposedSoul)) {
        if (!window.confirm(`Create "${proposedSoul}" as a new OpenAlma Soul?`)) {
            throw new Error('OpenAlma Soul setup was cancelled');
        }
        return { userId, soulId: proposedSoul, createSoul: true };
    }
    return { userId, soulId: proposedSoul, createSoul: false };
}

async function selectSoulCharacter(ctx: any, soulId: string, shouldCreateSoul: boolean): Promise<boolean> {
    let target = ctx.characters.findIndex((candidate: any) => String(candidate?.name || '').trim() === soulId);
    if (target < 0) {
        const response = await fetch('/api/characters/create', {
            method: 'POST',
            headers: ctx.getRequestHeaders(),
            body: JSON.stringify({ ch_name: soulId }),
        });
        if (!response.ok) throw new Error(`Failed to create SillyTavern character (${response.status})`);
        const avatar = await response.text();
        await ctx.getCharacters();
        ctx = st.getContext();
        target = ctx.characters.findIndex((candidate: any) => candidate?.avatar === avatar);
        if (target < 0) throw new Error('Created SillyTavern character was not found');
    }
    if (shouldCreateSoul) await createSoul(soulId);
    if (String(ctx.characters?.[ctx.characterId]?.name || '').trim() === soulId) return false;
    await ctx.selectCharacterById(target, { switchMenu: false });
    return true;
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

    const existing = memuExtras.baseInfo;
    const { userId, soulId, createSoul: shouldCreateSoul } = await resolveIdentity(ctx?.name1, desiredCharacterName);
    if (await selectSoulCharacter(ctx, soulId, shouldCreateSoul)) return;
    const userName = (ctx?.name1 != null) ? String(ctx.name1) : (existing?.userName ?? '');

    // Update if missing or stale (chat switching can fire before ctx.characterId updates).
    if (!existing || existing.userId !== userId || existing.characterId !== soulId || existing.characterName !== soulId || existing.userName !== userName) {
        memuExtras.baseInfo = {
            characterId: soulId,
            characterName: soulId,
            userName,
            userId,
        };
        await st.saveChat();
    }
}
