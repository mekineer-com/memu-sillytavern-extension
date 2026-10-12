import { memuExtras, st } from "utils/context-extra";
import { createOwner, createSoul, getOwner, getSoul, getSouls } from "utils/network";
import { power_user } from "@silly-tavern/scripts/power-user.js";
import { extension_settings, writeExtensionFieldBulk } from "@silly-tavern/scripts/extensions.js";
import { saveSettings } from "@silly-tavern/script.js";
import { getCsrfTokenCached, postJsonWithCsrf } from "utils/csrf";

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
    if (!source || !canUseSoulCard(source, true)) return;
    const original = { ...source };
    const first = firstSoulCard(original);
    const name = String(original.name || '').trim();
    try {
        if (Object.hasOwn(soulCards(), name) || (await getSouls()).souls.includes(name)) {
            await claimSoulCard(original, true, first);
        }
    } catch (error) {
        window.alert(String(error));
        throw error;
    }
}

export async function onCharacterRenamed(oldAvatar: string, newAvatar: string): Promise<void> {
    const source = st.getContext().characters.find((card: any) => card.avatar === oldAvatar);
    if (!source) return;
    const original = { ...source };
    const first = firstSoulCard(original);
    const name = String(original.name || '').trim();
    const renamed = { ...source, avatar: newAvatar };
    try {
        try {
            if (canUseSoulCard(original, true)
                && (Object.hasOwn(soulCards(), name) || (await getSouls()).souls.includes(name))) {
                await claimSoulCard(original, true, first);
            }
        } finally {
            await writeMemuDisabled(renamed, true);
        }
    } catch (error) {
        window.alert(String(error));
        throw error;
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
    const operation = soulCardChain.then(async () => {
        const current = st.getContext().characters.find((card: any) => card.avatar === avatar) ?? character;
        const existing = current.data?.extensions?.memu;
        if (existing?.disabled === disabled && (disabled || existing?.enabled_for === name)) return;
        const text = cardText(current);
        const reset = !disabled && existing?.enabled_for !== name && existing?.description_auto !== undefined
            ? { description_auto: text.description.trim() ? null : '', card_text: text } : {};
        const result = await writeExtensionFieldBulk([avatar], 'memu', {
            ...existing, ...reset, disabled, ...(!disabled ? { enabled_for: name } : {}),
        });
        if (!result.updated.includes(avatar)) throw new Error('Failed to save the character memU setting');
        refreshMemuGate();
    });
    soulCardChain = operation.catch(() => {});
    await operation;
}

const cardInputs = {
    description: 'description_textarea', personality: 'personality_textarea',
    scenario: 'scenario_pole', mes_example: 'mes_example_textarea',
};

export function cardText(character: any): Record<string, string> {
    const editor = typeof document !== 'undefined' && document.getElementById('avatar_url_pole') as HTMLInputElement;
    return Object.fromEntries(Object.entries(cardInputs).map(([field, id]) => {
        const input = editor?.value === character.avatar ? document.getElementById(id) as HTMLInputElement : null;
        return [field, String(input ? input.value : character[field] ?? '')];
    }));
}

export async function reconcileSoulCard(character: any, editedField?: string): Promise<boolean> {
    if (!character || !canUseSoulCard(character)) return false;
    const text = cardText(character);
    const previous = character.data?.extensions?.memu ?? {};
    let auto = previous.description_auto;
    let baseline = previous.card_text;
    const cleared = !text.description.trim() && (editedField === 'description'
        || (!editedField && (auto === undefined || String(baseline?.description ?? '').trim())));
    if (editedField && auto === null && !cleared
        && !!text.description.trim() === !!String(baseline?.description ?? '').trim()) return false;
    if (cleared) {
        auto = ''; baseline = text;
    } else if (editedField || auto === undefined
        || (typeof auto === 'string' && Object.keys(cardInputs).some(field => text[field] !== baseline?.[field]))) {
        auto = null; baseline = text;
    }
    if (auto !== previous.description_auto || JSON.stringify(baseline) !== JSON.stringify(previous.card_text)) {
        const metadata = {
            ...previous, description_auto: auto, card_text: baseline,
        };
        character.data.extensions.memu = metadata;
        const avatar = character.avatar;
        const operation = soulCardChain.then(async () => {
            const current = st.getContext().characters.find((card: any) => card.avatar === avatar) ?? character;
            const result = await writeExtensionFieldBulk([avatar], 'memu', {
                ...current.data.extensions.memu, description_auto: auto, card_text: baseline,
            });
            if (!result.updated.includes(avatar)) throw new Error('Failed to save the card following setting');
        });
        soulCardChain = operation.catch(() => {});
        await operation;
    }
    return typeof character.data?.extensions?.memu?.description_auto === 'string';
}

async function writeDescriptionToCard(characterName: string, narrativeSelf: string, displayedAvatar: string, displayedText: Record<string, string>): Promise<void> {
    const scope = currentScope();
    const operation = soulCardChain.then(async () => {
        const csrfToken = await getCsrfTokenCached();
        const ctx: any = st.getContext();
        const character = ctx.characters?.[ctx.characterId];
        if (currentScope() !== scope || character?.avatar !== displayedAvatar || character.name.trim() !== characterName
            || !canUseSoulCard(character) || character.data?.extensions?.memu?.disabled === true
            || character.data?.extensions?.memu?.description_auto === null
            || JSON.stringify(cardText(character)) !== JSON.stringify(displayedText)) return;
        const metadata = { ...character.data.extensions.memu, description_auto: narrativeSelf,
            card_text: { ...displayedText, description: narrativeSelf } };
        const resp = await fetch('/api/characters/merge-attributes', {
            method: 'POST', headers: { 'Content-Type': 'application/json', 'x-csrf-token': csrfToken },
            body: JSON.stringify({ avatars: [displayedAvatar], data: {
                description: narrativeSelf, data: { description: narrativeSelf, extensions: { memu: metadata } },
            } }),
        });
        if (!resp.ok || !(await resp.json()).updated.includes(displayedAvatar)) throw new Error('Failed to save the automatic Description');
        const editedWhileWriting = character.data.extensions.memu.description_auto === null
            || JSON.stringify(cardText(character)) !== JSON.stringify(displayedText);
        const resetWhileWriting = character.data.extensions.memu.description_auto === ''
            && !cardText(character).description.trim()
            && JSON.stringify(character.data.extensions.memu.card_text) === JSON.stringify(cardText(character));
        await ctx.getOneCharacter(displayedAvatar);
        if (currentScope() !== scope) return;
        const current = st.getContext() as any;
        const refreshed = current.characters[current.characterId];
        if (editedWhileWriting || refreshed.data?.extensions?.memu?.description_auto === null
            || JSON.stringify(cardText(character)) !== JSON.stringify(displayedText)) {
            return { character: refreshed, reset: resetWhileWriting };
        }
        if (refreshed.description !== narrativeSelf || refreshed.data?.extensions?.memu?.description_auto !== narrativeSelf) {
            throw new Error('Could not confirm the automatic Description');
        }
        const editor = typeof document !== 'undefined' && document.getElementById('avatar_url_pole') as HTMLInputElement;
        if (editor?.value === displayedAvatar) {
            const description = document.getElementById(cardInputs.description) as HTMLInputElement;
            if (description?.value === displayedText.description) description.value = narrativeSelf;
            const json = document.getElementById('character_json_data') as HTMLInputElement;
            if (json) json.value = refreshed.json_data;
        }
    });
    soulCardChain = operation.catch(() => {});
    const edited = await operation;
    if (edited) await reconcileSoulCard(edited.character, edited.reset ? 'description' : 'manual');
}

export async function refreshSoulCard(): Promise<void> {
    const scope = currentScope();
    if (!(await isMemuActive()) || currentScope() !== scope) return;
    const ctx: any = st.getContext();
    const character = ctx.characters[ctx.characterId];
    if (!(await reconcileSoulCard(character)) || currentScope() !== scope) return;
    const text = cardText(character);
    const live = await getSoul(character.name.trim(), true);
    if (currentScope() !== scope || !(await reconcileSoulCard(character))) return;
    if (typeof live.narrative_self !== 'string') throw new Error('Soul narrative read did not return narrative_self');
    if (text.description !== live.narrative_self) {
        await writeDescriptionToCard(character.name.trim(), live.narrative_self, character.avatar, text);
    }
}

export function onSoulCardInput(event: Event): void {
    const target = event.target as HTMLInputElement;
    const field = Object.entries(cardInputs).find(([, id]) => id === target?.id)?.[0];
    if (!field) return;
    const ctx: any = st.getContext();
    const character = ctx.characters?.[ctx.characterId];
    const editor = document.getElementById('avatar_url_pole') as HTMLInputElement;
    if (editor?.value !== character?.avatar) return;
    void reconcileSoulCard(character, field).catch(error => window.alert(String(error)));
}

export async function onSoulCardEdited(event: any): Promise<void> {
    await reconcileSoulCard(event.detail?.character);
    await refreshSoulCard();
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
    const character = ctx.characters?.[ctx.characterId];
    if (!qualifiesSoulCard(character, !!selectedName, first)) throw new Error('This Soul belongs to another SillyTavern card');
    const desiredCharacterName = String(character.name || '').trim();

    if (selectedName) refreshMemuGate();
    const existing = memuExtras.baseInfo;
    let userName = await resolveSoulPersonaName(desiredCharacterName, !!selectedName, first) ?? selectedName;
    if (currentScope() !== scope) return;
    if (!userName) throw new Error('Select a persona before enabling memU');
    await ensurePersona(userName);
    if (currentScope() !== scope) return;
    const { userId, soulId, createSoul: shouldCreateSoul } = await resolveIdentity(userName, desiredCharacterName);
    if (currentScope() !== scope) return;
    if (shouldCreateSoul) {
        await createSoul(soulId, userName);
        refreshMemuGate();
    }
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
