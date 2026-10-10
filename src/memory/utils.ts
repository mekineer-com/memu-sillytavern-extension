import { memuExtras, st } from "utils/context-extra";
import { createOwner, createSoul, getOwner, getSoul, getSouls } from "utils/network";
import { power_user } from "@silly-tavern/scripts/power-user.js";
import { writeExtensionFieldBulk } from "@silly-tavern/scripts/extensions.js";

export const appReady = new Promise<void>(resolve => st.eventSource.once(st.event_types.APP_READY, resolve));
let discovery: { scope: string; promise: ReturnType<typeof getSouls> } | undefined;
// Loaded-instance tokens only; backend conversation IDs remain unchanged.
const loadedChats = new WeakMap<object, number>();
let loadedChatId = 0;

export function currentScope(ctx: any = st.getContext()): string {
    if (ctx.chatMetadata && !loadedChats.has(ctx.chatMetadata)) loadedChats.set(ctx.chatMetadata, ++loadedChatId);
    return JSON.stringify([ctx.characters?.[ctx.characterId]?.avatar, ctx.getCurrentChatId?.(), loadedChats.get(ctx.chatMetadata)]);
}

export function refreshMemuGate(): void { discovery = undefined; }

function discoverSouls(): ReturnType<typeof getSouls> {
    const scope = currentScope();
    if (!discovery || discovery.scope !== scope) {
        const promise = getSouls().catch(error => {
            if (discovery?.promise === promise) discovery = undefined;
            throw error;
        });
        discovery = { scope, promise };
    }
    return discovery.promise;
}

export async function isMemuActive(): Promise<boolean> {
    const ctx: any = st.getContext();
    if (ctx.chatMetadata?.main_chat || ctx.groupId) return false;
    const character = ctx.characters?.[ctx.characterId];
    if (!character) return false;
    const disabled = character.data?.extensions?.memu?.disabled;
    if (typeof disabled === 'boolean') return !disabled;
    const scope = currentScope(ctx);
    const souls = await discoverSouls();
    return currentScope() === scope && souls.souls.includes(String(character.name || '').trim());
}

export async function soulPersonaName(soulId: string): Promise<string | null> {
    const scope = currentScope();
    if (!(await discoverSouls()).souls.includes(soulId)) return null;
    if (currentScope() !== scope) return null;
    const binding = await getSoul(soulId);
    if (!binding.user_name) throw new Error(`Soul ${soulId} has no user-name binding`);
    return binding.user_name;
}

export async function ensurePersona(personaName: string): Promise<string> {
    await appReady;
    const avatar = Object.keys(power_user.personas).find(key => power_user.personas[key] === personaName);
    if (avatar) return avatar;
    return await (st.getContext() as any).SlashCommandParser.commands['persona-create'].callback(
        { name: personaName, select: 'false' }, '',
    );
}

export async function writeMemuDisabled(character: any, disabled: boolean): Promise<void> {
    const avatar = character.avatar;
    const result = await writeExtensionFieldBulk([avatar], 'memu', { ...character.data?.extensions?.memu, disabled });
    if (!result.updated.includes(avatar)) throw new Error('Failed to save the character memU setting');
    refreshMemuGate();
}


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


async function resolveIdentity(defaultName: string | undefined, proposedSoul: string): Promise<{ userId: string; soulId: string; createSoul: boolean }> {
    const scope = currentScope();
    const existing = await getOwner();
    if (currentScope() !== scope) throw new Error('Chat changed during Soul setup');
    const souls = await discoverSouls();
    if (currentScope() !== scope) throw new Error('Chat changed during Soul setup');
    let userId = existing.user_id || '';
    if (!userId) {
        userId = String(defaultName || '').trim();
        if (!userId) throw new Error('Select a persona before enabling memU');
        assertDistinctNames(userId, proposedSoul);
        userId = (await createOwner(userId)).user_id;
    }
    return { userId, soulId: proposedSoul, createSoul: !souls.souls.includes(proposedSoul) };
}

export function assertDistinctNames(userName: string, soulId: string): void {
    if (userName.trim().toLowerCase() === soulId.trim().toLowerCase()) {
        throw new Error('The persona name must differ from the Soul name');
    }
}

async function selectSoulCharacter(ctx: any, soulId: string, shouldCreateSoul: boolean, userName: string): Promise<boolean> {
    const scope = currentScope(ctx);
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
    if (currentScope() !== scope) return false;
    if (shouldCreateSoul) {
        await createSoul(soulId, userName);
        refreshMemuGate();
    }
    if (currentScope() !== scope) return false;
    if (String(ctx.characters?.[ctx.characterId]?.name || '').trim() === soulId) return false;
    await ctx.selectCharacterById(target, { switchMenu: false });
    return true;
}

export async function initChatExtraInfo(ctx: any, selectedName?: string): Promise<void> {
    if (ctx.chatMetadata?.main_chat || ctx.groupId) return;
    if (!selectedName && !(await isMemuActive())) return;
    const scope = currentScope(ctx);
    await appReady;
    if (currentScope() !== scope) return;
    // IMPORTANT: never guess the character. If SillyTavern context isn"t ready yet, bail and try again later.
    const character = await waitForActiveCharacter(ctx);
    if (!character) {
        return;
    }

    // KISS: per-character scope is the character name.
    // If someone renames a character, they get a new DB/lorebooks. That's fine.
    const desiredCharacterName = String(character.name || '').trim();

    const existing = memuExtras.baseInfo;
    let userName = await soulPersonaName(desiredCharacterName) ?? selectedName;
    if (currentScope() !== scope) return;
    if (!userName) throw new Error('Select a persona before enabling memU');
    await ensurePersona(userName);
    if (currentScope() !== scope) return;
    const { userId, soulId, createSoul: shouldCreateSoul } = await resolveIdentity(userName, desiredCharacterName);
    if (currentScope() !== scope) return;
    if (await selectSoulCharacter(ctx, soulId, shouldCreateSoul, userName)) return;
    if (currentScope() !== scope) return;
    if (shouldCreateSoul) {
        userName = (await getSoul(soulId)).user_name;
        if (!userName) throw new Error(`Soul ${soulId} has no user-name binding`);
        if (currentScope() !== scope) return;
    }

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
