import MemorizeProgress from 'component/MemorizeProgress';
import MemoryShowModal from 'component/MemoryShowModal';
import NarrativeSuggestion from 'component/NarrativeSuggestion';
import { ChangeEvent, CSSProperties, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { deleteMemuLorebooksForCurrentCharacter, memorizeNow, sanitizeWorldInfoName, syncLorebooksNow } from 'memory/memorize';
import EyeIcon from 'ui/icons';
import MemuLogo from 'ui/logo';
import {
  currentSelectedCharacterName,
  memuExtras,
  OVERRIDE_SUMMARIZER,
  IMPORT_LOREBOOKS,
  MENTAL_HEALTH_ADDON,
  st,
} from 'utils/context-extra';
import {
  createRelationship,
  deleteRelationship,
  getModelMappings,
  getPluginConfig,
  listRelationships,
  serverStart,
  serverStatus,
  serverStop,
  setPluginConfig,
  setModelMappings,
  updateRelationship,
  RelationshipRecord,
} from 'utils/network';
import { MemuPluginConfigV1, MemuTaskStatus, ModelMappings, ModelSelection, ModelMappingPatch, SrmmChoice, StepChoice } from 'utils/types';
import { saveSettings } from '@silly-tavern/script.js';
import { extension_settings } from '@silly-tavern/scripts/extensions.js';
import { postJsonWithCsrf } from 'utils/csrf';
import { power_user } from '@silly-tavern/scripts/power-user.js';
import { nativeModelSelection, srmmChoice, srmmRequest, appReady, canUseSoulCard, currentScope, ensurePersona, initChatExtraInfo, isMemuActive, refreshSoulCard, soulPersonaName, writeMemuDisabled } from 'memory/utils';
import { onChatChanged } from 'memory/exports';

const buttonStyle: CSSProperties = {
  height: '100%',
  borderRadius: 8,
  width: 36,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 6,
};

const sectionStyle: CSSProperties = {
  border: '1px solid rgba(128,128,128,0.35)',
  borderRadius: 10,
  padding: '10px 12px',
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
};

const sectionTitleStyle: CSSProperties = {
  margin: 0,
  marginBottom: '0.33lh',
  display: 'flex',
  alignItems: 'center',
  gap: 8,
};

function defaultCfg(): MemuPluginConfigV1 {
  return { version: 4, updatedAt: new Date().toISOString() };
}

type RelationshipEditorState = {
  scope: string;
  mode: 'add' | 'edit';
  speakerId?: string;
  name: string;
  relationship: string;
};

const RELATIONSHIP_SUGGESTIONS = [
  'parent',
  'sibling',
  'child',
  'partner',
  'friend',
  'coworker',
  'neighbor',
  'pet',
  'place',
  'other',
];

export default function App() {
  const [pluginOk, setPluginOk] = useState<boolean | null>(null);
  const [pluginConfig, setPluginConfigState] = useState<MemuPluginConfigV1 | null>(null);
  const [mappings, setMappings] = useState<ModelMappings | null>(null);
  const [configStatus, setConfigStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');

  const [serverCtl, setServerCtl] = useState<any | null>(null);
  const [serverCtlBusy, setServerCtlBusy] = useState<'idle' | 'working' | 'error'>('idle');

  const [overrideSummarizer, setOverrideSummarizer] = useState<boolean>(true);
  const [importLorebooks, setImportLorebooks] = useState<boolean>(false);
  const [currentCharacter, setCurrentCharacter] = useState<string>('');
  const [currentUserId, setCurrentUserId] = useState<string>('');
  const [memuActive, setMemuActive] = useState(false);
  const [copiedChat, setCopiedChat] = useState(false);
  const [persona, setPersona] = useState('');
  const [personaLocked, setPersonaLocked] = useState(false);
  const [personas, setPersonas] = useState<Record<string, string>>({});
  const [switchBusy, setSwitchBusy] = useState(true);
  const [switchError, setSwitchError] = useState('');

  async function reloadCharacter(): Promise<void> {
    setSwitchBusy(true);
    setRelationships([]);
    setMemuActive(false);
    setPersona('');
    setPersonaLocked(false);
    setSwitchError('');
    const scope = currentScope();
    try {
      await appReady;
      if (currentScope() !== scope) return;
      const ctx: any = st.getContext();
      setCurrentCharacter(currentSelectedCharacterName());
      const copy = !!ctx.chatMetadata?.main_chat;
      setCopiedChat(copy);
      setPersonas({ ...power_user.personas });
      if (copy) {
        const name = memuExtras.baseInfo?.userName;
        setPersona(Object.keys(power_user.personas).find(key => power_user.personas[key] === name) || '');
        setPersonaLocked(!!name);
        return;
      }
      const character = ctx.characters?.[ctx.characterId];
      if (!character || ctx.groupId) return;
      if (!canUseSoulCard(character, true)) {
        setSwitchError('This Soul belongs to its first ST card. Give this card a different name.');
        return;
      }
      const active = await isMemuActive();
      if (currentScope() !== scope) return;
      setMemuActive(active);
      if (active) await refreshSoulCard();
      if (currentScope() !== scope) return;
      const name = await soulPersonaName(String(character.name || '').trim());
      if (currentScope() !== scope) return;
      const avatar = name ? await ensurePersona(name) : '';
      if (currentScope() !== scope) return;
      setPersonas({ ...power_user.personas });
      setPersona(avatar);
      setPersonaLocked(!!name);
      setCurrentUserId(String(memuExtras.baseInfo?.userId || ''));
    } catch (error) {
      if (currentScope() === scope) setSwitchError(String(error));
    } finally {
      if (currentScope() === scope) setSwitchBusy(false);
    }
  }

  useEffect(() => {
    const reload = () => { void reloadCharacter(); };
    reload();
    st.eventSource.on(st.event_types.CHAT_CHANGED, reload);
    st.eventSource.on(st.event_types.CHARACTER_EDITED, reload);
    st.eventSource.on(st.event_types.CHARACTER_EDITOR_OPENED, reload);
    const personaEvents = [st.event_types.PERSONA_CREATED, st.event_types.PERSONA_UPDATED, st.event_types.PERSONA_DELETED];
    const reloadPersonas = () => setPersonas({ ...power_user.personas });
    for (const event of personaEvents) st.eventSource.on(event, reloadPersonas);
    window.addEventListener('memu:server-ready', reload);
    return () => {
      st.eventSource.removeListener(st.event_types.CHAT_CHANGED, reload);
      st.eventSource.removeListener(st.event_types.CHARACTER_EDITED, reload);
      st.eventSource.removeListener(st.event_types.CHARACTER_EDITOR_OPENED, reload);
      for (const event of personaEvents) st.eventSource.removeListener(event, reloadPersonas);
      window.removeEventListener('memu:server-ready', reload);
    };
  }, []);

  async function changeMemu(enabled: boolean): Promise<void> {
    const ctx: any = st.getContext();
    const character = ctx.characters?.[ctx.characterId];
    if (!character || ctx.chatMetadata?.main_chat || switchBusy || (enabled && !power_user.personas[persona])) return;
    const scope = currentScope(ctx);
    setSwitchBusy(true);
    setSwitchError('');
    try {
      if (enabled && !canUseSoulCard(character, true)) {
        throw new Error('This Soul belongs to its first ST card. Give this card a different name.');
      }
      if (enabled && !personaLocked) {
        await writeMemuDisabled(character, true);
        if (currentScope() !== scope) return;
      }
      if (enabled) await initChatExtraInfo(ctx, power_user.personas[persona]);
      if (currentScope() !== scope) return;
      await writeMemuDisabled(character, !enabled);
      if (currentScope() !== scope) return;
      onChatChanged();
      await reloadCharacter();
    } catch (error) {
      if (currentScope() === scope) {
        await reloadCharacter();
        if (currentScope() === scope) setSwitchError(String(error));
      }
    } finally {
      if (currentScope() === scope) setSwitchBusy(false);
    }
  }

  function selectPersona(avatar: string): void {
    const ctx: any = st.getContext();
    if (ctx.chatMetadata?.main_chat || ctx.groupId || personaLocked) return;
    setPersona(avatar);
    setSwitchError('');
  }
  const [memorizeNowBusy, setMemorizeNowBusy] = useState<boolean>(false);
  const [memorizeRunning, setMemorizeRunning] = useState<boolean>(false);
  const [relationships, setRelationships] = useState<RelationshipRecord[]>([]);
  const [relationshipsStatus, setRelationshipsStatus] = useState<'idle' | 'loading' | 'saving' | 'error'>('idle');
  const [relationshipsMessage, setRelationshipsMessage] = useState<string>('');
  const [relationshipEditor, setRelationshipEditor] = useState<RelationshipEditorState | null>(null);

  const [showMemoryModal, setShowMemoryModal] = useState<boolean>(false);
  const [memoryText, setMemoryText] = useState<string>('');
  const [eyeHover, setEyeHover] = useState<boolean>(false);
  const skipNextAutosaveRef = useRef<boolean>(true);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [srmm, setSrmm] = useState<SrmmChoice>(srmmChoice);
  const [nativeSelection, setNativeSelection] = useState<ModelSelection | null>(nativeModelSelection);
  const [mentalHealthAddon, setMentalHealthAddon] = useState<boolean>(false);
  const pendingMappings = useRef<ModelMappingPatch>({});
  const mappingSave = useRef<Promise<void>>(Promise.resolve());
  const mappingState = useRef(mappings);

  useEffect(() => {
    const onChatChanged = () => {
      setMemoryText(memuExtras.retrieve?.liveRetrieve?.summary ?? memuExtras.retrieve?.nowRetrieve?.summary ?? '');
    };
    st.eventSource.on(st.event_types.CHAT_CHANGED, onChatChanged);
    return () => {
      try { st.eventSource?.removeListener?.(st.event_types.CHAT_CHANGED, onChatChanged); } catch { }
    };
  }, []);

  useEffect(() => {
    const h = () => void serverStatus().then(setServerCtl).catch(() => {});
    window.addEventListener('memu:server-ready', h);
    return () => window.removeEventListener('memu:server-ready', h);
  }, []);

  useEffect(() => {
    const id = setInterval(() => {
      const status = memuExtras.summary?.summaryTaskStatus;
      setMemorizeRunning(status === MemuTaskStatus.PENDING || status === MemuTaskStatus.PROCESSING);
    }, 2000);
    return () => clearInterval(id);
  }, []);

  // init
  useEffect(() => {
    (async () => {
      try {
        // Plugin reachability should not depend on mcp-memu-server health.
        const cfg = await getPluginConfig();
        setPluginOk(true);
        setPluginConfigState(cfg);

      } catch {
        setPluginOk(false);
      }
    })();
  }, []);

  useEffect(() => {
    void loadModelMappings();
  }, []);

  async function loadModelMappings() {
    if (configStatus === 'saving') return;
    try {
      const result = await getModelMappings();
      mappingState.current = result;
      setMappings(result);
      setAdvancedOpen(false);
    } catch (error) { setConfigStatus('error'); setSwitchError(String(error)); }
  }

  async function refreshProfiles(): Promise<void> {
    const current = mappingState.current;
    if (!current || Object.keys(pendingMappings.current).length) return;
    try {
      const result = await getModelMappings();
      if (mappingState.current !== current || Object.keys(pendingMappings.current).length) return;
      mappingState.current = result; setMappings(result);
    } catch {
      // A background catalog refresh must not clear usable choices while offline.
    }
  }

  function changeModelMappings(patch: ModelMappingPatch) {
    if (!mappingState.current) return;
    const merge = (base: ModelMappingPatch, update: ModelMappingPatch): ModelMappingPatch => ({ ...base, ...update,
      ...(base.step_models || update.step_models ? { step_models: { ...base.step_models, ...update.step_models } } : {}) });
    const pending = pendingMappings.current = merge(pendingMappings.current, patch);
    const display = () => setMappings({ ...mappingState.current!,
      ...(pendingMappings.current.claude_code !== undefined ? { claude_code: pendingMappings.current.claude_code } : {}) });
    display();
    setConfigStatus('saving');
    mappingSave.current = mappingSave.current.catch(() => {}).then(async () => {
      try {
        if (patch.step_models) await saveSettings();
        const result = await setModelMappings(patch);
        mappingState.current = result;
        if (pendingMappings.current === pending) pendingMappings.current = {};
        display();
        setConfigStatus(Object.keys(pendingMappings.current).length ? 'saving' : 'saved');
      } catch (error) {
        if (pendingMappings.current === pending) pendingMappings.current = {};
        display(); setConfigStatus('error'); setSwitchError(String(error));
      }
    });
    return mappingSave.current;
  }

  function relationshipIdentityCurrent(): boolean {
    return !switchBusy && !!currentCharacter && !!currentUserId
      && currentCharacter === currentSelectedCharacterName()
      && currentCharacter === memuExtras.baseInfo?.characterName
      && currentUserId === memuExtras.baseInfo?.userId;
  }

  async function refreshRelationships(): Promise<void> {
    const scope = currentScope();
    if (!pluginOk || !memuActive || !relationshipIdentityCurrent()) {
      setRelationships([]);
      setRelationshipsStatus('idle');
      setRelationshipsMessage('');
      return;
    }
    try {
      if (!(await isMemuActive()) || currentScope() !== scope || !relationshipIdentityCurrent()) return;
      setRelationshipsStatus('loading');
      setRelationshipsMessage('');
      const resp = await listRelationships(currentUserId, currentCharacter);
      if (!(await isMemuActive()) || currentScope() !== scope || !relationshipIdentityCurrent()) return;
      const rows = Array.isArray(resp?.relationships) ? resp.relationships : [];
      setRelationships(rows);
      setRelationshipsStatus('idle');
    } catch (e: any) {
      if (currentScope() !== scope || !relationshipIdentityCurrent()) return;
      setRelationships([]);
      setRelationshipsStatus('error');
      setRelationshipsMessage(e?.message || 'Failed to load relationships');
    }
  }

  useEffect(() => {
    void refreshRelationships();
  }, [pluginOk, currentCharacter, currentUserId, memuActive, switchBusy]);

  // memory ui prefs — per-soul, so re-read whenever the active chat changes.
  useEffect(() => {
    function reload() {
      setCurrentCharacter(currentSelectedCharacterName());
      setCurrentUserId(String(memuExtras.baseInfo?.userId || '').trim());
      setOverrideSummarizer(OVERRIDE_SUMMARIZER.get());
      setImportLorebooks(IMPORT_LOREBOOKS.get());
      setMentalHealthAddon(MENTAL_HEALTH_ADDON.get());
    }
    reload();
    try {
      st.eventSource?.on?.(st.event_types.CHAT_CHANGED, reload);
    } catch { }
    return () => {
      try { st.eventSource?.removeListener?.(st.event_types.CHAT_CHANGED, reload); } catch { }
    };
  }, []);

  async function refreshServerCtl() {
    try {
      if (!pluginOk) return;
      const s = await serverStatus();
      setServerCtl(s);
      setServerCtlBusy('idle');
    } catch {
      setServerCtl({ ok: false, running: false, healthy: false });
      setServerCtlBusy('error');
    }
  }

  useEffect(() => {
    if (!pluginOk) return;
    void refreshServerCtl();
  }, [pluginOk, (pluginConfig as any)?.serverPath]);

  useEffect(() => {
    const events = [st.event_types.MAIN_API_CHANGED, st.event_types.CHATCOMPLETION_SOURCE_CHANGED, st.event_types.CHATCOMPLETION_MODEL_CHANGED, st.event_types.CONNECTION_PROFILE_LOADED, st.event_types.OAI_PRESET_CHANGED_AFTER, st.event_types.PRESET_CHANGED, st.event_types.SETTINGS_UPDATED];
    const changed = () => {
      const selection = nativeModelSelection();
      setNativeSelection(selection);
    };
    const refresh = () => { void refreshProfiles(); };
    const visible = () => { if (document.visibilityState === 'visible') refresh(); };
    for (const event of events) st.eventSource.on(event, changed);
    st.eventSource.on(st.event_types.SETTINGS_UPDATED, refresh);
    st.eventSource.on(st.event_types.CONNECTION_PROFILE_LOADED, refresh);
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', visible);
    if (mappings) changed();
    return () => {
      for (const event of events) st.eventSource.removeListener(event, changed);
      st.eventSource.removeListener(st.event_types.SETTINGS_UPDATED, refresh);
      st.eventSource.removeListener(st.event_types.CONNECTION_PROFILE_LOADED, refresh);
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [!!mappings]);

  async function doServerStart() {
    setServerCtlBusy('working');
    setSwitchError('');
    try {
      const r = await serverStart();
      setServerCtl(r?.status ?? r);
      if (!r?.ok) throw new Error(r?.message || 'memU Server could not start.');
      const current = await getModelMappings();
      mappingState.current = current;
      setMappings(current);
      setServerCtlBusy('idle');
    } catch (error) {
      setServerCtlBusy('error');
      setSwitchError(String(error));
    }
  }

  async function doServerStop() {
    setServerCtlBusy('working');
    setSwitchError('');
    try {
      let r = await serverStop();
      if (r?.confirmationRequired) {
        if (!window.confirm(r.message)) { setServerCtlBusy('idle'); return; }
        r = await serverStop(true);
      }
      setServerCtl(r?.status ?? r);
      if (!r?.ok) throw new Error(r?.message || 'memU Server could not stop.');
      setServerCtlBusy('idle');
    } catch (error) {
      setServerCtlBusy('error');
      setSwitchError(String(error));
    }
  }

  function updatePluginConfig(patch: Partial<MemuPluginConfigV1>) {
    setPluginConfigState((prev) => {
      const base = prev ?? defaultCfg();
      const next: any = { ...base, ...patch };

      next.version = 4;
      next.updatedAt = new Date().toISOString();
      return next;
    });
    setConfigStatus('idle');
  }

  useEffect(() => {
    if (!pluginOk || !pluginConfig) return;
    if (skipNextAutosaveRef.current) {
      skipNextAutosaveRef.current = false;
      return;
    }

    let cancelled = false;
    setConfigStatus('saving');
    const timer = window.setTimeout(async () => {
      try {
        await setPluginConfig(pluginConfig);
        if (!cancelled) setConfigStatus('saved');
      } catch {
        if (!cancelled) setConfigStatus('error');
      }
      if (!cancelled) {
        window.setTimeout(() => {
          if (!cancelled) setConfigStatus('idle');
        }, 800);
      }
    }, 350);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [pluginConfig, pluginOk]);


  const activeSteps = { ...mappings?.step_models, ...pendingMappings.current.step_models };
  const hasAdvancedMapping = Object.values(activeSteps).some(value => !!value);

  function choiceForConnection(value: string | ModelMappings['base_model'] | undefined): StepChoice | undefined {
    if (!value) return { source: 'config' };
    if (typeof value === 'string') return { model: value };
    return value.profile_id ? { source: 'configured', profile_id: value.profile_id } : undefined;
  }

  function stepRequest(choice: StepChoice): NonNullable<ModelMappingPatch['step_models']>[string] {
    if (!('source' in choice)) return choice;
    if (choice.source === 'srmm') return { source: 'srmm', srmm: srmmRequest() };
    const resolved = { ...choice, native: nativeModelSelection() };
    return resolved.source === 'config' ? null : resolved;
  }

  async function toggleAdvancedMapping(enabled: boolean) {
    if (!mappings) return;
    if (!enabled && hasAdvancedMapping
      && !window.confirm('Remove Advanced Mapping settings from config.json, including any hand edits?')) return;
    try {
      extension_settings.memu ??= {};
      if (enabled) {
        const retained: Record<string, StepChoice> = extension_settings.memu.advancedMapping || {};
        const rows = Object.fromEntries(Object.entries(retained).map(([step, choice]) => [step, stepRequest(choice)]));
        setAdvancedOpen(true);
        if (Object.keys(rows).length) changeModelMappings({ step_models: rows });
      } else {
        if (hasAdvancedMapping) {
          const retained = { ...extension_settings.memu.advancedMapping };
          for (const [step, value] of Object.entries(mappings.step_models)) {
            if (step in (pendingMappings.current.step_models || {})) continue;
            const choice = choiceForConnection(value);
            if (choice) retained[step] = choice; else delete retained[step];
          }
          extension_settings.memu.advancedMapping = retained;
          await changeModelMappings({ step_models: Object.fromEntries(Object.keys(activeSteps).map(step => [step, null])) });
        }
        setAdvancedOpen(false);
      }
    } catch (error) { setConfigStatus('error'); setSwitchError(String(error)); }
  }

  function renderModelPicker(role: string) {
    const active = role === 'srmm' ? undefined : role === 'other_apps' ? mappings?.base_model : mappings?.step_models[role];
    const pending = role === 'other_apps' ? pendingMappings.current.base_model
      : role in (pendingMappings.current.step_models || {}) ? extension_settings.memu?.advancedMapping?.[role] : undefined;
    const current = role === 'srmm'
      ? srmm.source === 'configured' && mappings && !mappings.providers.some(profile => profile.profile_id === srmm.profile_id)
        ? { source: 'st_native' } : srmm
      : pending ? 'source' in pending ? { source: pending.source, ...('profile_id' in pending ? { profile_id: pending.profile_id } : {}) } : pending
      : choiceForConnection(active) ?? (role === 'other_apps' ? { source: 'config' } : undefined);
    const value = current ? JSON.stringify(current) : 'hand-configured';
    const choices = [{ value: JSON.stringify({ source: 'config' }), label: `default (config.json: ${mappings?.base_model?.chat_model || 'unconfigured'})`, disabled: false }];
    if (!['srmm', 'other_apps'].includes(role)) choices.push({ value: JSON.stringify({ source: 'srmm' }), label: 'default (SRMM)', disabled: false });
    const native = nativeSelection;
    choices.push({ value: JSON.stringify({ source: 'st_native' }), label: `default (SillyTavern selected: ${native?.provider || 'none'} ${native?.model || ''})`, disabled: !native });
    for (const provider of mappings?.providers || []) {
      if (provider.profile_id.startsWith('native:')) continue;
      const model = provider.models[0]?.model;
      choices.push({ value: JSON.stringify({ source: 'configured', profile_id: provider.profile_id }),
        label: `${provider.label}: ${model || 'Choose a model in ST'}${provider.supported ? '' : ` (unavailable: ${provider.reason})`}`, disabled: !provider.supported || !model });
    }
    if (!choices.some(choice => choice.value === value)) choices.push({ value,
      label: typeof active === 'object' ? `config.json: ${active.chat_model}`
        : `config.json: ${typeof active === 'string' ? active : current && ('model' in current ? current.model : ('profile_id' in current && current.profile_id) || current.source)}`, disabled: !current });
    return <select id={`memu-model-${role}`} className="text_pole" style={{ colorScheme: 'dark', backgroundColor: 'var(--SmartThemeBlurTintColor)' }} value={value} disabled={!mappings} onChange={async event => {
      const choice: StepChoice = JSON.parse(event.target.value);
      try {
        extension_settings.memu ??= {};
        if (role === 'srmm') {
          extension_settings.memu.srmm = choice;
          setSrmm(choice as SrmmChoice);
          await saveSettings();
        } else if (role === 'other_apps') {
          if ('source' in choice && choice.source !== 'srmm') changeModelMappings({ base_model: { ...choice, native: nativeModelSelection() } });
        } else {
          extension_settings.memu.advancedMapping ??= {};
          extension_settings.memu.advancedMapping[role] = choice;
          await changeModelMappings({ step_models: { [role]: stepRequest(choice) } });
        }
      } catch (error) { setConfigStatus('error'); setSwitchError(String(error)); }
    }}>{choices.map(choice => <option key={choice.value} value={choice.value} disabled={choice.disabled}>{choice.label}</option>)}</select>;
  }

  function cardMatchesSelection(): boolean {
    const ctx: any = st.getContext();
    const avatar = ctx.characters?.[ctx.characterId]?.avatar;
    return !!avatar && typeof document !== 'undefined' && !ctx.groupId
      && document.getElementById('form_create')?.getAttribute('actiontype') === 'editcharacter'
      && (document.getElementById('avatar_url_pole') as HTMLInputElement)?.value === avatar;
  }

  function renderMemuSwitch(id: string, onCard = false) {
    return <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0, whiteSpace: 'nowrap', marginBottom: onCard ? 0 : '0.33lh' }}>
      {onCard && <span>Enable memU:</span>}
      <button id={id} type="button" role="switch" className="memu-toggle" aria-label="memU"
        aria-checked={memuActive && !copiedChat}
        disabled={switchBusy || copiedChat || !currentCharacter || (!memuActive && !personas[persona]) || (onCard && !cardMatchesSelection())}
        onClick={() => { if (!onCard || cardMatchesSelection()) void changeMemu(!memuActive); }}><span /></button>
      {!onCard && <span>memU</span>}
      {!onCard && <i id={`${id}-info`} className="fa-solid fa-info-circle" style={{ opacity: 0.8 }} title={copiedChat ? 'memU is off in checkpoints and branches. Return to the main chat to talk with the Soul.' : 'Enable memory for this character. Turning it off keeps the Soul and its memories.'} />}
    </div>;
  }

  function openMemuPanel() {
    const drawer = document.querySelector('#extensions-settings-button > .drawer-content');
    if (!drawer?.classList.contains('openDrawer')) (document.querySelector('#extensions-settings-button > .drawer-toggle') as HTMLElement)?.click();
    const section = document.querySelector('.memu-ext-settings > .inline-drawer');
    const content = section?.querySelector('.inline-drawer-content');
    if (content && getComputedStyle(content).display === 'none') (section?.querySelector('.inline-drawer-toggle') as HTMLElement)?.click();
    section?.scrollIntoView({ block: 'nearest' });
  }


  const stepLabels: Array<{ step: string; label: string; hint: string }> = [
    { step: 'preprocess', label: 'Preprocess', hint: 'Raw multimodal → concise text' },
    { step: 'memory_extract', label: 'Memory Extract', hint: 'Text → memory items' },
    { step: 'category_update', label: 'Category Update', hint: 'Update category summary' },
    { step: 'reflection', label: 'Reflection', hint: 'Decide what to retrieve / reflect' },
    { step: 'consolidation', label: 'Consolidation', hint: 'Weekly reflection — edges, intentions, diary' },
  ];

  function handleOverrideSummarizerChange(e: ChangeEvent<HTMLInputElement>) {
    if (!memuActive || copiedChat) return;
    setOverrideSummarizer(e.target.checked);
    OVERRIDE_SUMMARIZER.set(e.target.checked);
  }

  function handleImportLorebooksChange(e: ChangeEvent<HTMLInputElement>) {
    if (!memuActive || copiedChat) return;
    const next = e.target.checked;
    setImportLorebooks(next);
    IMPORT_LOREBOOKS.set(next);
    if (next) {
      void syncLorebooksNow('import-lorebooks-enabled');
    } else {
      void deleteMemuLorebooksForCurrentCharacter();
    }
  }

  function handleMentalHealthAddonChange(e: ChangeEvent<HTMLInputElement>) {
    if (!currentCharacter || !memuActive || copiedChat) return;
    setMentalHealthAddon(e.target.checked);
    MENTAL_HEALTH_ADDON.set(e.target.checked);
  }

  async function handleMemorizeNow(): Promise<void> {
    setMemorizeNowBusy(true);
    try {
      await memorizeNow();
    } finally {
      setMemorizeNowBusy(false);
    }
  }

  function openAddRelationshipEditor(): void {
    if (!relationshipIdentityCurrent()) return;
    setRelationshipEditor({
      scope: currentScope(),
      mode: 'add',
      name: '',
      relationship: '',
    });
  }

  function openEditRelationshipEditor(row: RelationshipRecord): void {
    if (!relationshipIdentityCurrent()) return;
    setRelationshipEditor({
      scope: currentScope(),
      mode: 'edit',
      speakerId: row.speaker_id,
      name: String(row.name || ''),
      relationship: String(row.relationship || ''),
    });
  }

  async function saveRelationshipEditor(): Promise<void> {
    const scope = currentScope();
    if (!relationshipEditor || relationshipEditor.scope !== scope || !relationshipIdentityCurrent()) return;
    const name = String(relationshipEditor.name || '').trim();
    const relationship = String(relationshipEditor.relationship || '').trim();
    if (!name) return;
    try {
      if (!(await isMemuActive()) || currentScope() !== scope || !relationshipIdentityCurrent()) return;
      setRelationshipsStatus('saving');
      setRelationshipsMessage('');
      if (relationshipEditor.mode === 'add') {
        await createRelationship(currentUserId, currentCharacter, name, relationship);
      } else if (relationshipEditor.speakerId) {
        await updateRelationship(currentUserId, currentCharacter, relationshipEditor.speakerId, {
          name,
          relationship,
        });
      }
      if (currentScope() !== scope || !relationshipIdentityCurrent()) return;
      setRelationshipEditor(null);
      await refreshRelationships();
      if (currentScope() !== scope || !relationshipIdentityCurrent()) return;
      setRelationshipsStatus('idle');
    } catch (e: any) {
      if (currentScope() !== scope || !relationshipIdentityCurrent()) return;
      setRelationshipsStatus('error');
      setRelationshipsMessage(e?.message || 'Failed to save relationship');
    }
  }

  async function removeRelationship(speakerId: string): Promise<void> {
    const scope = currentScope();
    if (!speakerId || !relationshipIdentityCurrent()) return;
    try {
      if (!(await isMemuActive()) || currentScope() !== scope || !relationshipIdentityCurrent()) return;
      if (!window.confirm('Remove this relationship?')) return;
      setRelationshipsStatus('saving');
      setRelationshipsMessage('');
      await deleteRelationship(currentUserId, currentCharacter, speakerId);
      if (currentScope() !== scope || !relationshipIdentityCurrent()) return;
      await refreshRelationships();
      if (currentScope() !== scope || !relationshipIdentityCurrent()) return;
      setRelationshipsStatus('idle');
    } catch (e: any) {
      if (currentScope() !== scope || !relationshipIdentityCurrent()) return;
      setRelationshipsStatus('error');
      setRelationshipsMessage(e?.message || 'Failed to delete relationship');
    }
  }

  function getCurrentCharacterLorebookPrefix(): string {
    try {
      const ctx: any = st.getContext() as any;
      const character = (ctx?.characters && ctx?.characterId != null) ? (ctx.characters[ctx.characterId] ?? null) : null;
      const raw = String(character?.name || memuExtras.baseInfo?.characterName || '').trim();
      if (!raw) return 'memU - ';
      return `memU - ${sanitizeWorldInfoName(raw)} - `.slice(0, 120);
    } catch {
      return 'memU - ';
    }
  }

  function formatLorebookEntries(bookName: string, data: any): string {
    const entriesObj = data?.entries && typeof data.entries === 'object' ? data.entries : {};
    const entries = Object.values(entriesObj) as any[];
    if (!entries.length) return `### ${bookName}\n(empty)`;

    const lines: string[] = [`### ${bookName}`];
    for (const e of entries) {
      const content = String(e?.content || '').trim();
      if (!content) continue;
      lines.push(content);
    }
    return lines.join('\n\n');
  }

  async function loadRecentLorebookMemories(): Promise<string> {
    const list = await postJsonWithCsrf<any[]>('/api/worldinfo/list', {});
    const all = Array.isArray(list) ? list : [];
    const prefix = getCurrentCharacterLorebookPrefix().toLowerCase();

    const matching = all
      .map((x) => String((x as any)?.file_id || (x as any)?.name || '').trim())
      .filter((n) => !!n && n.toLowerCase().startsWith(prefix));

    if (!matching.length) {
      return 'No memU lorebooks found for the current character.';
    }

    const blocks: string[] = [];
    for (const name of matching) {
      try {
        const data = await postJsonWithCsrf<any>('/api/worldinfo/get', { name });
        blocks.push(formatLorebookEntries(name, data));
      } catch {
        blocks.push(`### ${name}\n(failed to read lorebook)`);
      }
    }

    const out = blocks.join('\n\n---\n\n').trim();
    const MAX_CHARS = 18000;
    return out.length > MAX_CHARS ? `${out.slice(0, MAX_CHARS)}\n\n...(truncated)` : out;
  }

  async function openMemoryModal(): Promise<void> {
    if (!(await isMemuActive())) return;
    const scope = currentScope();
    setShowMemoryModal(true);
    setMemoryText('Loading latest memU lorebooks...');
    try {
      const txt = await loadRecentLorebookMemories();
      if (currentScope() !== scope) return;
      setMemoryText(txt || 'No content');
    } catch (e: any) {
      setMemoryText(`Failed to load lorebooks: ${e?.message || String(e)}`);
    }
  }

  const cardHost = typeof document !== 'undefined' ? document.getElementById('avatar-and-name-block') : null;
  return (
    <>
                <style>{`
                  .memu-toggle { width: 44px; height: 24px; padding: 3px; border: 0; border-radius: 20px; background: #52616c; cursor: pointer; }
                  .memu-toggle span { display: block; width: 18px; height: 18px; border-radius: 50%; background: #eef8ff; }
                  .memu-toggle[aria-checked="true"] { background: #7dcaf7; }
                  .memu-toggle[aria-checked="true"] span { transform: translateX(20px); }
                  .memu-toggle:disabled { opacity: .5; cursor: default; }
                  #form_create:not([actiontype="editcharacter"]) .memu-card-controls { display: none !important; }
                `}</style>
      {cardHost && createPortal(<div className="memu-card-controls" style={{ display: cardMatchesSelection() ? 'flex' : 'none', alignItems: 'center', gap: 6, minWidth: 0 }}>
        <button id="memu_card_panel" type="button" className="menu_button" style={{ flexShrink: 0 }} aria-label="Open memU panel" onClick={openMemuPanel}><MemuLogo width={58} height={20} /></button>
        <select id="memu_soul_persona" aria-label="Soul persona" className="text_pole" style={{ flex: 1, minWidth: 0 }} value={persona} disabled={switchBusy || copiedChat || personaLocked || !currentCharacter || !cardMatchesSelection()}
          onChange={e => { if (cardMatchesSelection()) selectPersona(e.target.value); }}>
          <option value="">Select a persona</option>
          {Object.entries(personas).map(([avatar, name]) => <option key={avatar} value={avatar}>{name}</option>)}
        </select>
        <i id="memu-persona-info" className="fa-solid fa-info-circle" title="For memU, only one persona is allowed." style={{ opacity: 0.8, flexShrink: 0 }} />
        {renderMemuSwitch('memu_card_enabled', true)}
      </div>, cardHost)}
      <div className="memu-ext-settings" style={{ marginBottom: 16 }}>
        <div className="inline-drawer">
          <div className="inline-drawer-toggle inline-drawer-header" onClick={() => void loadModelMappings()}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <MemuLogo width={58} height={20} />
              <button
                className="menu_button"
                style={{
                  ...buttonStyle,
                  width: 30,
                  transition: 'box-shadow 0.15s ease, border-color 0.15s ease',
                  boxShadow: eyeHover ? '0 0 0 2px rgba(125,202,247,0.55)' : 'none',
                }}
                onPointerDown={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                }}
                onMouseDown={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                }}
                onMouseEnter={() => setEyeHover(true)}
                onMouseLeave={() => setEyeHover(false)}
                onClick={(e) => {
                  e.stopPropagation();
                  void openMemoryModal();
                }}
                title="View latest memU lorebooks"
              >
                <EyeIcon width={16} height={16} />
              </button>
            </div>
            <div className="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
          </div>

          <div className="inline-drawer-content" style={{ display: 'flex', flexDirection: 'column', gap: 10, paddingBottom: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <div style={{ opacity: 0.85 }}>
                Plugin: {pluginOk === null ? 'checking…' : pluginOk ? 'reachable' : 'not reachable'}
              </div>
              <div style={{ marginLeft: 'auto', opacity: 0.75, fontSize: 12 }}>
                {configStatus === 'saving' ? 'saving…' : configStatus === 'saved' ? 'saved' : configStatus === 'error' ? 'save failed' : ''}
              </div>
            </div>

            {/* Server controls */}
            {pluginOk && (
              <div style={sectionStyle}>
                <h4 style={sectionTitleStyle}>
                  <MemuLogo width={58} height={20} />
                  <span>Backend</span>
                </h4>

                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'nowrap' }}>
                  <button
                    className="menu_button"
                    style={{ ...buttonStyle, width: 'auto', padding: '6px 10px' } as any}
                    onClick={(e) => {
                      e.preventDefault();
                      void doServerStart();
                    }}
                    disabled={serverCtlBusy === 'working'}
                  >
                    Start
                  </button>
                  <button
                    className="menu_button"
                    style={{ ...buttonStyle, width: 'auto', padding: '6px 10px' } as any}
                    onClick={(e) => {
                      e.preventDefault();
                      void doServerStop();
                    }}
                    disabled={serverCtlBusy === 'working'}
                  >
                    Stop
                  </button>
                    <label className="checkbox_label expander" htmlFor="auto_start_server" style={{ margin: 0 }}>
                      <input id="auto_start_server" type="checkbox" className="checkbox"
                        checked={pluginConfig?.autoStartWithSillyTavern === true}
                        onChange={event => updatePluginConfig({ autoStartWithSillyTavern: event.target.checked })} />
                      <span>Auto Start</span>
                    </label>
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <label>Server path</label>
                  <input
                    className="text_pole"
                    value={String((pluginConfig as any)?.serverPath || '')}
                    onChange={(e) => updatePluginConfig({ serverPath: e.target.value as any })}
                    placeholder="Path to mcp-memu-server"
                  />
                </div>

                {(() => {
                  const healthy = !!serverCtl?.healthy;
                  const running = !!serverCtl?.running;
                  const baseUrl = serverCtl?.baseUrl;
                  const statusText = !serverCtl ? 'checking…' : !serverCtl.ok ? 'unavailable'
                    : serverCtl.shutdown?.draining || serverCtl.shutdown?.stopping ? 'stopping…' : healthy
                    ? 'running'
                    : running
                      ? 'starting…'
                      : 'stopped';

                  return (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', justifyContent: 'space-between' }}>
                      <span style={{ opacity: 0.85 }}>
                        Server: <b>{statusText}</b>
                        {baseUrl ? ` @ ${baseUrl}` : ''}
                      </span>
                    </div>
                  );
                })()}

                <small style={{ opacity: 0.8, alignSelf: 'flex-end' }}>
                  <a href="/api/plugins/memu/troubleshooting" target="_blank" rel="noopener noreferrer">
                    Troubleshooting
                  </a>
                </small>
              </div>
            )}

            {/* Model mapping */}
            {pluginOk && (
              <div style={sectionStyle}>
                <h4 style={sectionTitleStyle}>Model Mapping</h4>


                <label className="checkbox_label expander" htmlFor="use_claude_code">
                  <input id="use_claude_code" type="checkbox" className="checkbox" checked={mappings?.claude_code === true} disabled={!mappings} onChange={event => changeModelMappings({ claude_code: event.target.checked })} />
                  <span>Use Claude Code</span>
                  <i id="memu-agentic-settings-info" className="fa-solid fa-info-circle" title="The Soul's scheduled agentic turns use mcp-memu-server/config.json." style={{ opacity: 0.8 }} />
                </label>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <label>SillyTavern Replies (<span style={{ color: '#7dcaf7' }}>SRMM</span>)</label>
                  {renderModelPicker('srmm')}
                </div>
                {!mappings?.claude_code && <>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <label style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 6, whiteSpace: 'nowrap' }}>Other OpenAlma App Replies <i id="memu-iris-model-info" className="fa-solid fa-info-circle" title="Except the Iris voice model" style={{ opacity: 0.8 }} />
                    {mappings?.base_model.chat_model && !mappings.base_model.profile_id && <i id="memu-other-apps-config-info" className="fa-solid fa-info-circle" title="Hand configured config.json" style={{ opacity: 0.8, color: '#ef4444' }} />}
                  </label>
                  {renderModelPicker('other_apps')}
                  </div>
                  <label className="checkbox_label expander" style={{ marginTop: '0.5lh', marginBottom: '0.5lh' }}><input id="advanced_mapping" type="checkbox" className="checkbox" checked={hasAdvancedMapping || advancedOpen} disabled={!mappings} onChange={event => void toggleAdvancedMapping(event.target.checked)} /><span>Advanced Mapping</span></label>
                  {(hasAdvancedMapping || advancedOpen) && <div id="memu-advanced-mapping" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {stepLabels.map(s => (
                      <div key={s.step} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                        <label>{s.label} <span style={{ opacity: 0.7 }}>— {s.hint}</span></label>
                        {renderModelPicker(s.step)}
                      </div>
                    ))}
                  </div>}
                </>}
              </div>
            )}

            {/* Memory */}
            <div style={sectionStyle}>
              <h4 style={sectionTitleStyle}>Memory</h4>
              {renderMemuSwitch("memu_character_enabled")}
              {switchError && <small role="alert">{switchError}</small>}

              {!currentCharacter && (
                <div style={{ opacity: 0.7, fontSize: '12px', marginBottom: 6 }}>
                  Select a character to enable per-soul settings.
                </div>
              )}

              <label
                className="checkbox_label expander"
                htmlFor="override_summarizer"
                style={{ opacity: currentCharacter ? 1 : 0.5 }}
              >
                <input
                  id="override_summarizer"
                  type="checkbox"
                  className="checkbox"
                  checked={overrideSummarizer}
                  onChange={handleOverrideSummarizerChange}
                  disabled={!currentCharacter || !memuActive || copiedChat}
                />
                <span>Override Summarizer</span>
                <i
                  className="fa-solid fa-info-circle"
                  title="Per character. If checked: replace SillyTavern's summary message with memU's summary. If unchecked: add memU summary alongside it."
                  style={{ opacity: 0.8 }}
                />
              </label>

              <label
                className="checkbox_label expander"
                htmlFor="import_lorebooks"
                style={{ opacity: currentCharacter ? 1 : 0.5 }}
              >
                <input
                  id="import_lorebooks"
                  type="checkbox"
                  className="checkbox"
                  checked={importLorebooks}
                  onChange={handleImportLorebooksChange}
                  disabled={!currentCharacter || !memuActive || copiedChat}
                />
                <span>Import Lorebooks</span>
                <i
                  className="fa-solid fa-info-circle"
                  title="Per character. Publish memU category summaries as SillyTavern lorebooks (named memU - <Character> - <Category>) so you can browse them in the World Info panel. Unchecking deletes the memU-managed lorebooks for this character."
                  style={{ opacity: 0.8 }}
                />
              </label>

              <label
                className="checkbox_label expander"
                htmlFor="mental_health_addon"
                style={{ opacity: currentCharacter ? 1 : 0.5 }}
              >
                <input
                  id="mental_health_addon"
                  type="checkbox"
                  className="checkbox"
                  checked={mentalHealthAddon}
                  onChange={handleMentalHealthAddonChange}
                  disabled={!currentCharacter || !memuActive || copiedChat}
                />
                <span>Mental Health Addon</span>
                <i
                  className="fa-solid fa-info-circle"
                  title="Per character. Enable the mental-health sidecar: when the soul's retrieval router detects an MH theme, it pulls from a curated procedural-memory store alongside regular memories."
                  style={{ opacity: 0.8 }}
                />
              </label>

              <div style={{ opacity: currentCharacter && currentUserId ? 1 : 0.5, display: 'flex', flexDirection: 'column', gap: 8, paddingLeft: 24 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <strong>Relationships</strong>
                  <button
                    type="button"
                    className="menu_button"
                    onClick={() => openAddRelationshipEditor()}
                    disabled={!memuActive || copiedChat || !currentCharacter || !currentUserId || relationshipsStatus === 'saving'}
                    style={{ padding: '4px 8px' } as any}
                  >
                    + Add
                  </button>
                </div>
                {relationships.length > 20 && (
                  <small style={{ opacity: 0.85, color: 'var(--SmartThemeWarnColor, #e6a817)' }}>
                    Getting busy — consider whether some are acquaintance rather than named.
                  </small>
                )}
                {relationshipsStatus === 'loading' && <small style={{ opacity: 0.75 }}>Loading relationships…</small>}
                {relationshipsMessage && <small style={{ opacity: 0.85 }}>{relationshipsMessage}</small>}
                {!relationships.length && relationshipsStatus !== 'loading' && (
                  <small style={{ opacity: 0.75 }}>
                    {currentCharacter && currentUserId ? 'No relationships yet.' : 'Select a character to enable relationships.'}
                  </small>
                )}
                {relationships.map((row) => (
                  <div
                    key={row.speaker_id}
                    style={{
                      display: 'grid',
                      gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr) auto auto',
                      gap: 6,
                      alignItems: 'center',
                    }}
                  >
                    <span title={row.speaker_id} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {row.name}
                    </span>
                    <span style={{ opacity: 0.85, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {row.relationship || '—'}
                    </span>
                    <button
                      type="button"
                      className="menu_button"
                      onClick={() => openEditRelationshipEditor(row)}
                      disabled={!memuActive || copiedChat || !currentCharacter || !currentUserId || relationshipsStatus === 'saving'}
                      style={{ padding: '2px 8px' } as any}
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      className="menu_button"
                      onClick={() => void removeRelationship(row.speaker_id)}
                      disabled={!memuActive || copiedChat || !currentCharacter || !currentUserId || relationshipsStatus === 'saving'}
                      style={{ padding: '2px 8px' } as any}
                    >
                      Delete
                    </button>
                  </div>
                ))}
              </div>

              <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 6, paddingLeft: 24 }}>
                <button
                  type="button"
                  className="menu_button"
                  onClick={() => void handleMemorizeNow()}
                  disabled={!memuActive || copiedChat || memorizeNowBusy || !currentCharacter || memorizeRunning}
                >
                  {memorizeNowBusy ? 'Memorizing...' : 'Memorize Now'}
                </button>
                <i
                  className="fa-solid fa-info-circle"
                  title="Force extraction of the current accumulated chat even if no sleep gap has been detected yet."
                  style={{ opacity: 0.8 }}
                />
              </div>
            </div>

            <div style={sectionStyle}>
              <h4 style={sectionTitleStyle}>Narrative Suggestion</h4>
              <NarrativeSuggestion enabled={memuActive && !copiedChat} />
            </div>
          </div>
        </div>
      </div>

      {relationshipEditor && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            backgroundColor: 'rgba(0,0,0,0.45)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 2000,
          }}
          onClick={() => setRelationshipEditor(null)}
        >
          <div
            style={{
              width: 'min(520px, calc(100vw - 32px))',
              background: 'var(--SmartThemeBlurTintColor, #1c1c1c)',
              border: '1px solid rgba(128,128,128,0.35)',
              borderRadius: 10,
              padding: 12,
              display: 'flex',
              flexDirection: 'column',
              gap: 10,
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <h4 style={{ margin: 0 }}>{relationshipEditor.mode === 'add' ? 'Add Relationship' : 'Edit Relationship'}</h4>
            <label>Name</label>
            <input
              type="text"
              maxLength={50}
              className="text_pole"
              value={relationshipEditor.name}
              onChange={(e) => setRelationshipEditor((prev) => (prev ? { ...prev, name: e.target.value } : prev))}
              placeholder="e.g. Brother"
            />

            <label>Relationship</label>
            <input
              type="text"
              maxLength={50}
              className="text_pole"
              value={relationshipEditor.relationship}
              onChange={(e) => setRelationshipEditor((prev) => (prev ? { ...prev, relationship: e.target.value } : prev))}
              placeholder="e.g. sibling"
            />
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {RELATIONSHIP_SUGGESTIONS.map((item) => (
                <button
                  key={item}
                  type="button"
                  className="menu_button"
                  style={{ padding: '2px 8px' } as any}
                  onClick={() => setRelationshipEditor((prev) => (prev ? { ...prev, relationship: item } : prev))}
                >
                  {item}
                </button>
              ))}
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button type="button" className="menu_button" onClick={() => setRelationshipEditor(null)}>
                Cancel
              </button>
              <button
                type="button"
                className="menu_button"
                onClick={() => void saveRelationshipEditor()}
                disabled={!String(relationshipEditor.name || '').trim() || relationshipsStatus === 'saving'
                  || relationshipEditor.scope !== currentScope() || !relationshipIdentityCurrent()}
              >
                {relationshipsStatus === 'saving' ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}

      <MemoryShowModal open={showMemoryModal} text={memoryText} onClose={() => setShowMemoryModal(false)} />
      <MemorizeProgress />
    </>
  );
}
