import MemoryShowModal from 'component/MemoryShowModal';
import { ChangeEvent, CSSProperties, useEffect, useMemo, useRef, useState } from 'react';
import { memorizeNow } from 'memory/memorize';
import EyeIcon from 'ui/icons';
import MemuLogo from 'ui/logo';
import {
  memuExtras,
  OVERRIDE_SUMMARIZER,
  SHOW_ADVANCED_MAPPING,
  st,
} from 'utils/context-extra';
import {
  getConnectionProfiles,
  getPluginConfig,
  getProfileModels,
  pingPlugin,
  serverStart,
  serverStatus,
  serverStop,
  setPluginConfig,
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

export default function App() {
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

  const [overrideSummarizer, setOverrideSummarizer] = useState<boolean>(true);
  const [memorizeNowBusy, setMemorizeNowBusy] = useState<boolean>(false);

  const [showMemoryModal, setShowMemoryModal] = useState<boolean>(false);
  const [memoryText, setMemoryText] = useState<string>('');
  const [eyeHover, setEyeHover] = useState<boolean>(false);
  const skipNextAutosaveRef = useRef<boolean>(true);

  useEffect(() => {
    st.eventSource.on(st.event_types.CHAT_CHANGED, () => {
      setMemoryText(memuExtras.retrieve?.liveRetrieve?.summary ?? memuExtras.retrieve?.nowRetrieve?.summary ?? '');
    });
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
        if (Array.isArray(prof?.profiles)) setProfiles(prof.profiles);
      } catch {
        setPluginOk(false);
      }
    })();
  }, []);

  // memory ui prefs
  useEffect(() => {
    const savedOverride = OVERRIDE_SUMMARIZER.get();
    if (savedOverride !== null) setOverrideSummarizer(savedOverride);
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

      // embedding model: dropdown overrides manual overrides legacy
      const selected = typeof next.embeddingModelSelected === 'string' ? next.embeddingModelSelected.trim() : '';
      const manual = typeof next.embeddingModelManual === 'string' ? next.embeddingModelManual.trim() : '';
      const legacy = typeof next.embeddingModel === 'string' ? next.embeddingModel.trim() : '';
      const effective = selected || manual || legacy;

      if (selected) next.embeddingModelSelected = selected;
      else delete next.embeddingModelSelected;

      if (manual) next.embeddingModelManual = manual;
      else delete next.embeddingModelManual;

      if (effective) next.embeddingModel = effective;
      else delete next.embeddingModel;

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

  function renderProfilePicker(value: string | undefined, onChange: (v: string) => void) {
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

    const v = (value ?? '').trim();

    return (
      <select className="text_pole" value={v} onChange={(e) => onChange(e.target.value)}>
        <option value="">(use default)</option>
        {profiles.map((p) => (
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
  ];

  function handleOverrideSummarizerChange(e: ChangeEvent<HTMLInputElement>) {
    setOverrideSummarizer(e.target.checked);
    OVERRIDE_SUMMARIZER.set(e.target.checked);
  }

  async function handleMemorizeNow(): Promise<void> {
    setMemorizeNowBusy(true);
    try {
      await memorizeNow();
    } finally {
      setMemorizeNowBusy(false);
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
      const raw = String(character?.name || memuExtras.baseInfo?.characterName || memuExtras.baseInfo?.agentName || '').trim();
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
                  {renderProfilePicker(pluginConfig?.defaultProfileId, (v) => updatePluginConfig({ defaultProfileId: v || undefined }))}
                </div>

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
                  <span>Advanced mapping</span>
                </label>

                {showAdvancedMapping && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {stepLabels.map((s) => (
                      <div key={s.step} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                        <label>
                          {s.label} <span style={{ opacity: 0.7 }}>— {s.hint}</span>
                        </label>
                        {renderProfilePicker(pluginConfig?.stepProfileId?.[s.step], (v) =>
                          updatePluginConfig({ stepProfileId: { ...(pluginConfig?.stepProfileId ?? {}), [s.step]: v || undefined } as any }),
                        )}
                      </div>
                    ))}
                  </div>
                )}

                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <label>Embedding model</label>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <select
                      className="text_pole"
                      style={{ flex: 1 }}
                      value={pluginConfig?.embeddingModelSelected ?? ''}
                      onChange={(e) => updatePluginConfig({ embeddingModelSelected: e.target.value || undefined })}
                      disabled={embedModelsStatus === 'loading'}
                    >
                      <option value="">profile default / custom</option>
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

                  {!pluginConfig?.embeddingModelSelected?.trim() && (
                    <input
                      type="text"
                      className="text_pole"
                      value={pluginConfig?.embeddingModelManual ?? ''}
                      onChange={(e) => updatePluginConfig({ embeddingModelManual: e.target.value || undefined })}
                      placeholder="text-embedding-3-small"
                    />
                  )}
                </div>
              </div>
            )}

            {/* Memory */}
            <div style={sectionStyle}>
              <h4 style={sectionTitleStyle}>Memory</h4>

              <label className="checkbox_label expander" htmlFor="override_summarizer">
                <input
                  id="override_summarizer"
                  type="checkbox"
                  className="checkbox"
                  checked={overrideSummarizer}
                  onChange={handleOverrideSummarizerChange}
                />
                <span>Override Summarizer</span>
                <i
                  className="fa-solid fa-info-circle"
                  title="If checked: replace SillyTavern's summary message with memU's summary. If unchecked: add memU summary alongside it."
                  style={{ opacity: 0.8 }}
                />
              </label>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, paddingLeft: 24 }}>
                <button
                  type="button"
                  className="menu_button"
                  onClick={() => void handleMemorizeNow()}
                  disabled={memorizeNowBusy}
                >
                  {memorizeNowBusy ? 'Memorizing...' : 'Memorize Now'}
                </button>
                <small style={{ opacity: 0.85 }}>
                  Force extraction of the current accumulated chat even if no sleep gap has been detected yet.
                </small>
              </div>
            </div>
          </div>
        </div>
      </div>

      <MemoryShowModal open={showMemoryModal} text={memoryText} onClose={() => setShowMemoryModal(false)} />
    </>
  );
}
