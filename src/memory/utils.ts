import { memuExtras, st } from "utils/context-extra";
import { createOwner, createSoul, getOwner, getSoul, getSouls } from "utils/network";
import { power_user } from "@silly-tavern/scripts/power-user.js";
import { extension_settings, writeExtensionFieldBulk } from "@silly-tavern/scripts/extensions.js";
import { saveSettings } from "@silly-tavern/script.js";
import { postJsonWithCsrf } from "utils/csrf";

export const appReady = new Promise<void>(resolve => st.eventSource.once(st.event_types.APP_READY, resolve));
let discovery: { scope: string; promise: ReturnType<typeof getSouls> } | undefined;
// Loaded-instance tokens only; backend conversation IDs remain unchanged.
const loadedChats = new WeakMap<object, number>();
let loadedChatId = 0;
let soulCardChain: Promise<void> = Promise.resolve();

function soulCards(): Record<string, string> {
    return (extension_settings as any).memu?.soulCards ?? {};
}

function firstSoulCard(character: any): boolean {
    const name = String(character?.name || '').trim();
    const matches = st.getContext().characters.filter((card: any) => String(card.name || '').trim() === name);
    return !!name && !Object.hasOwn(soulCards(), name) && matches.length === 1 && matches[0].avatar === character.avatar;
}

function qualifiesSoulCard(character: any, explicit: boolean, first = false): boolean {
    const name = String(character?.name || '').trim();
    const avatar = character?.avatar;
    if (!name || !avatar) return false;
    const cards = soulCards();
    const owner = Object.hasOwn(cards, name) ? cards[name] : undefined;
    if (owner && owner !== avatar) return false;
    if (!explicit && ((!owner && Object.entries(cards).some(([soul, card]) => card === avatar && soul !== name))
        || (character.data?.extensions?.memu?.enabled_for != null && character.data.extensions.memu.enabled_for !== name))) return false;
    return owner === avatar || first || firstSoulCard(character);
}

export function canUseSoulCard(character: any, explicit = false): boolean {
    return qualifiesSoulCard(character, explicit);
}

function claimSoulCard(character: any, explicit = false, first = firstSoulCard(character)): Promise<void> {
    const name = String(character.name || '').trim();
    const avatar = character.avatar;
    const operation = soulCardChain.then(async () => {
        if (String(character.name || '').trim() !== name || character.avatar !== avatar || !qualifiesSoulCard(character, explicit, first)) {
            throw new Error('This Soul belongs to another SillyTavern card');
        }
        if (Object.hasOwn(soulCards(), name) && soulCards()[name] === avatar) return;
        const settings = (extension_settings as any).memu ??= {};
        settings.soulCards = { ...soulCards(), [name]: avatar };
        try {
            await saveSettings();
            const stored = await postJsonWithCsrf('/api/settings/get', {});
            const saved = JSON.parse(stored.settings).extension_settings?.memu?.soulCards;
            if (!saved || !Object.hasOwn(saved, name) || saved[name] !== avatar) {
                throw new Error('Failed to save the Soul card binding');
            }
        } catch (error) {
            if (Object.hasOwn(soulCards(), name) && soulCards()[name] === avatar) {
                const cards = { ...soulCards() };
                delete cards[name];
                settings.soulCards = cards;
            }
            throw error;
        }
    });
    soulCardChain = operation.catch(() => {});
    return operation;
}

export async function onCharacterDuplicated({ oldAvatar }: { oldAvatar: string }): Promise<void> {
    const source = st.getContext().characters.find((card: any) => card.avatar === oldAvatar);
    if (source && canUseSoulCard(source, true)) await claimSoulCard({ ...source }, true);
}

export async function onCharacterRenamed(oldAvatar: string, newAvatar: string): Promise<void> {
    const source = st.getContext().characters.find((card: any) => card.avatar === oldAvatar);
    if (!source) return;
    const renamed = { ...source, avatar: newAvatar };
    try {
        if (canUseSoulCard(source, true)) await claimSoulCard({ ...source }, true);
    } finally {
        await writeMemuDisabled(renamed, true);
    }
}

export function currentScope(ctx: any = st.getContext()): string {
    if (ctx.chatMetadata && !loadedChats.has(ctx.chatMetadata)) loadedChats.set(ctx.chatMetadata, ++loadedChatId);
    return JSON.stringify([ctx.characters?.[ctx.characterId]?.avatar, ctx.characters?.[ctx.characterId]?.name, ctx.getCurrentChatId?.(), loadedChats.get(ctx.chatMetadata)]);
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
    if (!character || !canUseSoulCard(character)) return false;
    const disabled = character.data?.extensions?.memu?.disabled;
    if (disabled === true) return false;
    const first = firstSoulCard(character);
    const scope = currentScope(ctx);
    const souls = await discoverSouls();
    if (currentScope() !== scope || !souls.souls.includes(String(character.name || '').trim())) return false;
    await claimSoulCard(character, false, first);
    return currentScope() === scope && character.data?.extensions?.memu?.disabled !== true && canUseSoulCard(character);
}

export async function soulPersonaName(soulId: string, explicit = false): Promise<string | null> {
    const ctx: any = st.getContext();
    return resolveSoulPersonaName(soulId, explicit, firstSoulCard(ctx.characters?.[ctx.characterId]));
}

async function resolveSoulPersonaName(soulId: string, explicit: boolean, first: boolean): Promise<string | null> {
    const scope = currentScope();
    const ctx: any = st.getContext();
    const character = ctx.characters?.[ctx.characterId];
    await soulCardChain;
    if (currentScope() !== scope) return null;
    if (String(character?.name || '').trim() !== soulId || !qualifiesSoulCard(character, explicit, first)) return null;
    if (!(await discoverSouls()).souls.includes(soulId)) return null;
    if (currentScope() !== scope) return null;
    await claimSoulCard(character, explicit, first);
    if (currentScope() !== scope) return null;
    const binding = await getSoul(soulId);
    if (currentScope() !== scope) return null;
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
    const name = String(character.name || '').trim();
    const first = firstSoulCard(character);
    await soulCardChain;
    if (character.avatar !== avatar || String(character.name || '').trim() !== name) throw new Error('Character changed while saving the memU setting');
    if (!disabled) {
        await claimSoulCard(character, true, first);
        if (character.avatar !== avatar || String(character.name || '').trim() !== name) throw new Error('Character changed while enabling memU');
    }
    const existing = character.data?.extensions?.memu;
    if (existing?.disabled === disabled && (disabled || existing?.enabled_for === name)) return;
    const result = await writeExtensionFieldBulk([avatar], 'memu', { ...existing, disabled, ...(!disabled ? { enabled_for: name } : {}) });
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
    const scope = currentScope(ctx);
    const first = firstSoulCard(ctx.characters?.[ctx.characterId]);
    await soulCardChain;
    if (currentScope() !== scope) return;
    if (selectedName && !qualifiesSoulCard(ctx.characters?.[ctx.characterId], true, first)) throw new Error('This Soul belongs to another SillyTavern card');
    if (!selectedName && !(await isMemuActive())) return;
    await appReady;
    if (currentScope() !== scope) return;
    // IMPORTANT: never guess the character. If SillyTavern context isn"t ready yet, bail and try again later.
    const character = await waitForActiveCharacter(ctx);
    if (!character) {
        return;
    }

    if (!qualifiesSoulCard(character, !!selectedName, first)) throw new Error('This Soul belongs to another SillyTavern card');
    const desiredCharacterName = String(character.name || '').trim();

    const existing = memuExtras.baseInfo;
    let userName = await resolveSoulPersonaName(desiredCharacterName, !!selectedName, first) ?? selectedName;
    if (currentScope() !== scope) return;
    if (!userName) throw new Error('Select a persona before enabling memU');
    await ensurePersona(userName);
    if (currentScope() !== scope) return;
    const { userId, soulId, createSoul: shouldCreateSoul } = await resolveIdentity(userName, desiredCharacterName);
    if (currentScope() !== scope) return;
    if (await selectSoulCharacter(ctx, soulId, shouldCreateSoul, userName)) return;
    if (currentScope() !== scope) return;
    await claimSoulCard(character, !!selectedName, first);
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
