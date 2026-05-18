import MemorizeProgress from 'component/MemorizeProgress';
import MemoryShowModal from 'component/MemoryShowModal';
import NarrativeSuggestion from 'component/NarrativeSuggestion';
import { ChangeEvent, CSSProperties, useEffect, useMemo, useRef, useState } from 'react';
import { deleteMemuLorebooksForCurrentCharacter, memorizeNow, syncLorebooksNow } from 'memory/memorize';
import EyeIcon from 'ui/icons';
import MemuLogo from 'ui/logo';
import {
  currentSelectedCharacterName,
  memuExtras,
  OVERRIDE_SUMMARIZER,
  IMPORT_LOREBOOKS,
  MENTAL_HEALTH_ADDON,
  SHOW_ADVANCED_MAPPING,
  st,
} from 'utils/context-extra';
import {
  createRelationship,
  deleteRelationship,
  getConnectionProfiles,
  getPluginConfig,
  listRelationships,
  getProfileModels,
  pingPlugin,
  serverStart,
  serverStatus,
  serverStop,
  setPluginConfig,
  updateRelationship,
  RelationshipRecord,
} from 'utils/network';
import { ConnectionProfileSummary, MemuPluginConfigV1, MemuStep } from 'utils/types';
import { postJsonWithCsrf } from 'utils/csrf';

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
  display: 'flex',
  alignItems: 'center',
  gap: 8,
};

function defaultCfg(): MemuPluginConfigV1 {
  return { version: 4, updatedAt: new Date().toISOString() };
}

type RelationshipEditorState = {
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
  const EMBED_CUSTOM = '__custom__';
  const [pluginOk, setPluginOk] = useState<boolean | null>(null);
  const [pluginConfig, setPluginConfigState] = useState<MemuPluginConfigV1 | null>(null);
  const [profiles, setProfiles] = useState<ConnectionProfileSummary[]>([]);
  const [configStatus, setConfigStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');

  const [serverCtl, setServerCtl] = useState<any | null>(null);
  const [serverCtlBusy, setServerCtlBusy] = useState<'idle' | 'working' | 'error'>('idle');

  const [showAdvancedMapping, setShowAdvancedMapping] = useState<boolean>(false);

  const [embedModels, setEmbedModels] = useState<string[]>([]);
  const [embedModelsStatus, setEmbedModelsStatus] = useState<'idle' | 'loading' | 'error'>('idle');
  const [embedModelsMessage, setEmbedModelsMessage] = useState<string>('');
  const [embedCustomMode, setEmbedCustomMode] = useState<boolean>(false);

  const [overrideSummarizer, setOverrideSummarizer] = useState<boolean>(true);
  const [importLorebooks, setImportLorebooks] = useState<boolean>(false);
  const [mentalHealthAddon, setMentalHealthAddon] = useState<boolean>(false);
  const [currentCharacter, setCurrentCharacter] = useState<string>('');
  const [currentUserId, setCurrentUserId] = useState<string>('');
  const [memorizeNowBusy, setMemorizeNowBusy] = useState<boolean>(false);
  const [relationships, setRelationships] = useState<RelationshipRecord[]>([]);
  const [relationshipsStatus, setRelationshipsStatus] = useState<'idle' | 'loading' | 'saving' | 'error'>('idle');
  const [relationshipsMessage, setRelationshipsMessage] = useState<string>('');
  const [relationshipEditor, setRelationshipEditor] = useState<RelationshipEditorState | null>(null);

  const [showMemoryModal, setShowMemoryModal] = useState<boolean>(false);
  const [memoryText, setMemoryText] = useState<string>('');
  const [eyeHover, setEyeHover] = useState<boolean>(false);
  const skipNextAutosaveRef = useRef<boolean>(true);
  const profilesSigRef = useRef<string>('');
  const prevDefaultIsHordeRef = useRef<boolean>(false);

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

  // init
  useEffect(() => {
    (async () => {
      try {
        const ok = await pingPlugin();
        setPluginOk(ok);
        if (!ok) return;

        const cfg = await getPluginConfig();
        setPluginConfigState(cfg);

        try {
          const pref = SHOW_ADVANCED_MAPPING.get();
          if (pref !== null) {
            setShowAdvancedMapping(pref === 'true');
          } else {
            const m = (cfg as any)?.stepProfileId;
            const hasOverrides = m && typeof m === 'object' && Object.keys(m).some((k) => k !== 'all' && String(m[k] ?? '').trim().length > 0);
            if (hasOverrides) setShowAdvancedMapping(true);
          }
        } catch {
          // ignore
        }

        const prof = await getConnectionProfiles();
        if (Array.isArray(prof?.profiles)) {
          const sig = JSON.stringify(prof.profiles);
          profilesSigRef.current = sig;
          setProfiles(prof.profiles);
        }
      } catch {
        setPluginOk(false);
      }
    })();
  }, []);

  async function refreshProfiles(): Promise<void> {
    try {
      if (!pluginOk) return;
      const prof = await getConnectionProfiles();
      if (!Array.isArray(prof?.profiles)) return;
      const sig = JSON.stringify(prof.profiles);
      if (sig === profilesSigRef.current) return;
      profilesSigRef.current = sig;
      setProfiles(prof.profiles);
    } catch {
      // ignore
    }
  }

  async function refreshRelationships(): Promise<void> {
    if (!pluginOk || !currentCharacter || !currentUserId) {
      setRelationships([]);
      setRelationshipsStatus('idle');
      setRelationshipsMessage('');
      return;
    }
    setRelationshipsStatus('loading');
    setRelationshipsMessage('');
    try {
      const resp = await listRelationships(currentUserId, currentCharacter);
      const rows = Array.isArray(resp?.relationships) ? resp.relationships : [];
      setRelationships(rows);
      setRelationshipsStatus('idle');
    } catch (e: any) {
      setRelationships([]);
      setRelationshipsStatus('error');
      setRelationshipsMessage(e?.message || 'Failed to load relationships');
    }
  }

  useEffect(() => {
    void refreshRelationships();
  }, [pluginOk, currentCharacter, currentUserId]);

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
  }, [pluginOk, (pluginConfig as any)?.serverPath, (pluginConfig as any)?.autoStartServer]);

  useEffect(() => {
    if (!pluginOk) return;
    const t = window.setInterval(() => {
      void refreshProfiles();
    }, 30_000);

    const onFocus = () => { void refreshProfiles(); };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') void refreshProfiles();
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibility);

    const settingsUpdatedEvent = (st as any)?.event_types?.SETTINGS_UPDATED;
    const eventSourceAny = (st as any)?.eventSource;
    const onSettingsUpdated = () => { void refreshProfiles(); };
    if (settingsUpdatedEvent && eventSourceAny?.on) {
      eventSourceAny.on(settingsUpdatedEvent, onSettingsUpdated);
    }

    return () => {
      window.clearInterval(t);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibility);
      if (settingsUpdatedEvent && eventSourceAny?.removeListener) {
        eventSourceAny.removeListener(settingsUpdatedEvent, onSettingsUpdated);
      }
    };
  }, [pluginOk]);

  async function doServerStart() {
    setServerCtlBusy('working');
    try {
      const r = await serverStart();
      setServerCtl(r?.status ?? r);
      setServerCtlBusy('idle');
    } catch {
      setServerCtlBusy('error');
    }
  }

  async function doServerStop() {
    setServerCtlBusy('working');
    try {
      const r = await serverStop();
      setServerCtl(r?.status ?? r);
      setServerCtlBusy('idle');
    } catch {
      setServerCtlBusy('error');
    }
  }

  function updatePluginConfig(patch: Partial<MemuPluginConfigV1>) {
    setPluginConfigState((prev) => {
      const base = prev ?? defaultCfg();
      const next: any = { ...base, ...patch };

      // embedding model: dropdown overrides manual
      const selected = typeof next.embeddingModelSelected === 'string' ? next.embeddingModelSelected.trim() : '';
      const manual = typeof next.embeddingModelManual === 'string' ? next.embeddingModelManual.trim() : '';
      if (selected) next.embeddingModelSelected = selected;
      else delete next.embeddingModelSelected;

      if (manual) next.embeddingModelManual = manual;
      else delete next.embeddingModelManual;

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

  const embedProfileId = useMemo(() => {
    const cfg = pluginConfig;
    const sid = (cfg?.stepProfileId?.embeddings || cfg?.defaultProfileId || '').trim();
    return sid;
  }, [pluginConfig?.defaultProfileId, pluginConfig?.stepProfileId?.embeddings]);

  const defaultAlias = useMemo(
    () => profiles.find((p) => String(p.id || '').trim() === 'default'),
    [profiles],
  );
  const defaultProfileId = useMemo(
    () => String(pluginConfig?.defaultProfileId || 'default').trim() || 'default',
    [pluginConfig?.defaultProfileId],
  );
  const effectiveDefaultProvider = useMemo(() => {
    if (defaultProfileId === 'default') {
      return String(defaultAlias?.provider || '').trim().toLowerCase();
    }
    const p = profiles.find((x) => String(x.id || '').trim() === defaultProfileId);
    return String(p?.provider || '').trim().toLowerCase();
  }, [defaultAlias, defaultProfileId, profiles]);
  const defaultIsHorde = effectiveDefaultProvider === 'horde';
  const providerByProfileId = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of profiles) {
      const id = String(p.id || '').trim();
      if (!id) continue;
      m.set(id, String(p.provider || '').trim().toLowerCase());
    }
    return m;
  }, [profiles]);
  const providerForProfileId = (id: string): string => {
    const s = String(id || '').trim();
    if (!s) return '';
    if (s === 'default') return effectiveDefaultProvider;
    return providerByProfileId.get(s) || '';
  };

  useEffect(() => {
    if (!defaultIsHorde) return;
    if (showAdvancedMapping) return;
    setShowAdvancedMapping(true);
  }, [defaultIsHorde, showAdvancedMapping]);

  useEffect(() => {
    const prev = prevDefaultIsHordeRef.current;
    prevDefaultIsHordeRef.current = defaultIsHorde;
    if (!prev || defaultIsHorde) return;

    const advancedSteps: MemuStep[] = ['preprocess', 'memory_extract', 'category_update', 'reflection', 'ranking'];
    const stepMap = (pluginConfig as any)?.stepProfileId;
    const hasExplicitOverrides = !!(
      stepMap &&
      typeof stepMap === 'object' &&
      advancedSteps.some((k) => {
        const v = (stepMap as any)?.[k];
        const s = String(v ?? '').trim();
        return !!s && s !== 'default';
      })
    );
    if (hasExplicitOverrides) return;

    setShowAdvancedMapping(false);
    try {
      SHOW_ADVANCED_MAPPING.set(false);
    } catch {
      // ignore
    }
  }, [defaultIsHorde, pluginConfig?.stepProfileId]);

  useEffect(() => {
    const selected = String(pluginConfig?.embeddingModelSelected || '').trim();
    const manual = String(pluginConfig?.embeddingModelManual || '').trim();
    if (selected) {
      setEmbedCustomMode(false);
      return;
    }
    if (manual) {
      setEmbedCustomMode(true);
    }
  }, [pluginConfig?.embeddingModelSelected, pluginConfig?.embeddingModelManual]);

  const embedModelPickerValue = useMemo(() => {
    const selected = String(pluginConfig?.embeddingModelSelected || '').trim();
    if (selected) return selected;
    const manual = String(pluginConfig?.embeddingModelManual || '').trim();
    if (embedCustomMode || manual) return EMBED_CUSTOM;
    return '';
  }, [pluginConfig?.embeddingModelSelected, pluginConfig?.embeddingModelManual, embedCustomMode]);

  function onEmbeddingModelChange(v: string): void {
    if (!v) {
      setEmbedCustomMode(false);
      updatePluginConfig({
        embeddingModelSelected: undefined,
        embeddingModelManual: undefined,
      } as any);
      return;
    }
    if (v === EMBED_CUSTOM) {
      setEmbedCustomMode(true);
      updatePluginConfig({
        embeddingModelSelected: undefined,
      } as any);
      return;
    }
    setEmbedCustomMode(false);
    updatePluginConfig({
      embeddingModelSelected: v,
      embeddingModelManual: undefined,
    } as any);
  }

  async function loadEmbeddingModels(force: boolean = false) {
    try {
      if (!pluginOk) return;
      if (!embedProfileId) {
        setEmbedModels([]);
        setEmbedModelsStatus('idle');
        return;
      }
      setEmbedModelsStatus('loading');
      setEmbedModelsMessage('');
      const resp = await getProfileModels(embedProfileId, { kind: 'embedding', force });
      if (resp?.ok && Array.isArray(resp.models)) {
        setEmbedModels(resp.models);
        setEmbedModelsStatus('idle');
      } else {
        setEmbedModels([]);
        setEmbedModelsStatus('error');
        setEmbedModelsMessage(resp?.message || 'Failed to load models');
      }
    } catch (e: any) {
      setEmbedModels([]);
      setEmbedModelsStatus('error');
      setEmbedModelsMessage(e?.message || 'Failed to load models');
    }
  }

  useEffect(() => {
    void loadEmbeddingModels(false);
  }, [pluginOk, embedProfileId]);

  function renderProfilePicker(
    value: string | undefined,
    onChange: (v: string) => void,
    opts?: { allowModelDefault?: boolean; includeDefaultAlias?: boolean; forceBlank?: boolean; blankLabel?: string; excludeProviders?: string[] },
  ) {
    const allowModelDefault = opts?.allowModelDefault === true;
    const includeDefaultAlias = opts?.includeDefaultAlias !== false;
    const forceBlank = opts?.forceBlank === true;
    if (!profiles.length) {
      return (
        <input
          className="text_pole"
          value={value ?? ''}
          onChange={(e) => onChange(e.target.value)}
          placeholder="profile id"
        />
      );
    }

    const banned = new Set((opts?.excludeProviders || []).map((x) => String(x || '').trim().toLowerCase()).filter(Boolean));
    const options = (includeDefaultAlias ? profiles : profiles.filter((p) => String(p.id || '').trim() !== 'default'))
      .filter((p) => !banned.has(String(p.provider || '').trim().toLowerCase()));
    let v = (value ?? (allowModelDefault ? '' : 'default')).trim();
    if (forceBlank && (v === '' || v === 'default')) v = '';
    if (v && !options.some((p) => String(p.id || '').trim() === v)) v = '';

    return (
      <select className="text_pole" value={v} onChange={(e) => onChange(e.target.value)}>
        {(allowModelDefault || forceBlank) && <option value="">{forceBlank ? (opts?.blankLabel || '!') : 'default (Model Mapping)'}</option>}
        {options.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
    );
  }

  const stepLabels: Array<{ step: MemuStep; label: string; hint: string }> = [
    { step: 'preprocess', label: 'Preprocess', hint: 'Raw multimodal → concise text' },
    { step: 'memory_extract', label: 'Memory Extract', hint: 'Text → memory items' },
    { step: 'category_update', label: 'Category Update', hint: 'Update category summary' },
    { step: 'reflection', label: 'Reflection', hint: 'Decide what to retrieve / reflect' },
    { step: 'ranking', label: 'Ranking', hint: 'Rerank candidates' },
    { step: 'consolidation', label: 'Consolidation', hint: 'Weekly reflection — edges, intentions, diary' },
  ];

  function handleOverrideSummarizerChange(e: ChangeEvent<HTMLInputElement>) {
    setOverrideSummarizer(e.target.checked);
    OVERRIDE_SUMMARIZER.set(e.target.checked);
  }

  function handleImportLorebooksChange(e: ChangeEvent<HTMLInputElement>) {
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
    setRelationshipEditor({
      mode: 'add',
      name: '',
      relationship: '',
    });
  }

  function openEditRelationshipEditor(row: RelationshipRecord): void {
    setRelationshipEditor({
      mode: 'edit',
      speakerId: row.speaker_id,
      name: String(row.name || ''),
      relationship: String(row.relationship || ''),
    });
  }

  async function saveRelationshipEditor(): Promise<void> {
    if (!relationshipEditor || !currentCharacter || !currentUserId) return;
    const name = String(relationshipEditor.name || '').trim();
    const relationship = String(relationshipEditor.relationship || '').trim();
    if (!name) return;
    setRelationshipsStatus('saving');
    setRelationshipsMessage('');
    try {
      if (relationshipEditor.mode === 'add') {
        await createRelationship(currentUserId, currentCharacter, name, relationship);
      } else if (relationshipEditor.speakerId) {
        await updateRelationship(currentUserId, currentCharacter, relationshipEditor.speakerId, {
          name,
          relationship,
        });
      }
      setRelationshipEditor(null);
      await refreshRelationships();
      setRelationshipsStatus('idle');
    } catch (e: any) {
      setRelationshipsStatus('error');
      setRelationshipsMessage(e?.message || 'Failed to save relationship');
    }
  }

  async function removeRelationship(speakerId: string): Promise<void> {
    if (!speakerId || !currentCharacter || !currentUserId) return;
    if (!window.confirm('Remove this relationship?')) return;
    setRelationshipsStatus('saving');
    setRelationshipsMessage('');
    try {
      await deleteRelationship(currentUserId, currentCharacter, speakerId);
      await refreshRelationships();
      setRelationshipsStatus('idle');
    } catch (e: any) {
      setRelationshipsStatus('error');
      setRelationshipsMessage(e?.message || 'Failed to delete relationship');
    }
  }

  function sanitizeLorebookName(name: string): string {
    return String(name || '')
      .replace(/[\/:*?"<>|]/g, '-')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function getCurrentCharacterLorebookPrefix(): string {
    try {
      const ctx: any = st.getContext() as any;
      const character = (ctx?.characters && ctx?.characterId != null) ? (ctx.characters[ctx.characterId] ?? null) : null;
      const raw = String(character?.name || memuExtras.baseInfo?.characterName || '').trim();
      if (!raw) return 'memU - ';
      return `memU - ${sanitizeLorebookName(raw)} - `;
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
    setShowMemoryModal(true);
    setMemoryText('Loading latest memU lorebooks...');
    try {
      const txt = await loadRecentLorebookMemories();
      setMemoryText(txt || 'No content');
    } catch (e: any) {
      setMemoryText(`Failed to load lorebooks: ${e?.message || String(e)}`);
    }
  }

  return (
    <>
      <div className="memu-ext-settings" style={{ marginBottom: 16 }}>
        <div className="inline-drawer">
          <div className="inline-drawer-toggle inline-drawer-header">
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
                    <input
                      id="auto_start_server"
                      type="checkbox"
                      className="checkbox"
                      checked={(pluginConfig as any)?.autoStartServer !== false}
                      onChange={(e) => updatePluginConfig({ autoStartServer: e.target.checked } as any)}
                    />
                    <span>Auto Start</span>
                  </label>
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <label>Server path</label>
                  <input
                    className="text_pole"
                    value={String((pluginConfig as any)?.serverPath || '~/apps/mcp-memu-server')}
                    onChange={(e) => updatePluginConfig({ serverPath: e.target.value as any })}
                    placeholder="~/apps/mcp-memu-server"
                  />
                </div>

                {(() => {
                  const healthy = !!serverCtl?.healthy;
                  const running = !!serverCtl?.running;
                  const baseUrl = serverCtl?.baseUrl;
                  const autoStart = (pluginConfig as any)?.autoStartServer !== false;
                  const statusText = healthy
                    ? 'running'
                    : running
                      ? 'starting…'
                      : (autoStart ? 'stopped' : 'stopped (auto-start off)');

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

                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {renderProfilePicker(
                    pluginConfig?.defaultProfileId,
                    (v) => updatePluginConfig({ defaultProfileId: (v || 'default') as any }),
                    { allowModelDefault: false },
                  )}
                </div>

                {!defaultIsHorde && (
                  <label className="checkbox_label expander" htmlFor="advanced_mapping">
                    <input
                      id="advanced_mapping"
                      type="checkbox"
                      className="checkbox"
                      checked={showAdvancedMapping}
                      onChange={(e) => {
                        const v = e.target.checked;
                        setShowAdvancedMapping(v);
                        try {
                          SHOW_ADVANCED_MAPPING.set(v);
                        } catch {
                          // ignore
                        }
                      }}
                    />
                    <span>Advanced Mapping</span>
                  </label>
                )}

                {(showAdvancedMapping || defaultIsHorde) && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {stepLabels.map((s) => (
                      <div key={s.step} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                        {(() => {
                          const removeInheritance = defaultIsHorde;
                          const raw = String(pluginConfig?.stepProfileId?.[s.step] || '').trim();
                          const rawProvider = providerForProfileId(raw);
                          const missing = removeInheritance && (!raw || raw === 'default' || rawProvider === 'horde');
                          return (
                            <label>
                              {s.label} <span style={{ opacity: 0.7 }}>— {s.hint}</span>{missing ? <span title="Select a provider profile for this step" style={{ marginLeft: 6, opacity: 0.9 }}>!</span> : null}
                            </label>
                          );
                        })()}
                        {renderProfilePicker(
                          pluginConfig?.stepProfileId?.[s.step],
                          (v) => updatePluginConfig({ stepProfileId: { ...(pluginConfig?.stepProfileId ?? {}), [s.step]: v || undefined } as any }),
                          defaultIsHorde
                            ? { allowModelDefault: false, includeDefaultAlias: false, forceBlank: true, blankLabel: '!', excludeProviders: ['horde'] }
                            : { allowModelDefault: true, includeDefaultAlias: true, excludeProviders: ['horde'] },
                        )}
                      </div>
                    ))}
                  </div>
                )}

                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <label>Embedding provider profile</label>
                  {renderProfilePicker(
                    pluginConfig?.stepProfileId?.embeddings,
                    (v) => updatePluginConfig({ stepProfileId: { ...(pluginConfig?.stepProfileId ?? {}), embeddings: v || undefined } as any }),
                    { allowModelDefault: true },
                  )}
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <label>Embedding model</label>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <select
                      className="text_pole"
                      style={{ flex: 1 }}
                      value={embedModelPickerValue}
                      onChange={(e) => onEmbeddingModelChange(e.target.value)}
                      disabled={embedModelsStatus === 'loading'}
                    >
                      <option value="">provider default model</option>
                      <option value={EMBED_CUSTOM}>custom</option>
                      {embedModels.map((m) => (
                        <option key={m} value={m}>
                          {m}
                        </option>
                      ))}
                    </select>
                    <button
                      className="menu_button"
                      style={{ ...buttonStyle, width: 34 } as any}
                      onClick={() => void loadEmbeddingModels(true)}
                      disabled={embedModelsStatus === 'loading'}
                      title="Refresh embedding model list"
                    >
                      <i className="fa-solid fa-rotate-right" />
                    </button>
                  </div>

                  {embedModelsStatus === 'error' && <small style={{ opacity: 0.8 }}>{embedModelsMessage}</small>}

                  {embedCustomMode && (
                    <input
                      type="text"
                      className="text_pole"
                      value={pluginConfig?.embeddingModelManual ?? ''}
                      onChange={(e) => {
                        setEmbedCustomMode(true);
                        updatePluginConfig({ embeddingModelManual: e.target.value || undefined });
                      }}
                      placeholder="text-embedding-3-small"
                    />
                  )}
                </div>
              </div>
            )}

            {/* Memory */}
            <div style={sectionStyle}>
              <h4 style={sectionTitleStyle}>Memory</h4>

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
                  disabled={!currentCharacter}
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
                  disabled={!currentCharacter}
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
                  disabled={!currentCharacter}
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
                    disabled={!currentCharacter || !currentUserId || relationshipsStatus === 'saving'}
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
                      disabled={!currentCharacter || !currentUserId || relationshipsStatus === 'saving'}
                      style={{ padding: '2px 8px' } as any}
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      className="menu_button"
                      onClick={() => void removeRelationship(row.speaker_id)}
                      disabled={!currentCharacter || !currentUserId || relationshipsStatus === 'saving'}
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
                  disabled={memorizeNowBusy || !currentCharacter}
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
              <NarrativeSuggestion />
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
                disabled={!String(relationshipEditor.name || '').trim() || relationshipsStatus === 'saving'}
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
