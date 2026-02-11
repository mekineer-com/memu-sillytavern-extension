import MemoryShowModal from "component/MemoryShowModal";
import { onChatChanged, onChatCompletionPromptReady, onMessageEdited, onMessageReceived, onMessageSwiped } from "memory/exports";
import { ChangeEvent, CSSProperties, useEffect, useState } from "react";
import EyeIcon from "ui/icons";
import MemuLogo from "ui/logo";
import { FailIcon, LoadingIcon, SuccessIcon } from "ui/status";
import { API_KEY, AUTO_SUMMARY_BY_CONTEXT_SIZE, memuExtras, OVERRIDE_SUMMARIZER, PLUGIN_MODE, SHOW_ADVANCED_MAPPING, st, SUMMARY_TURN } from "utils/context-extra";
import { getConnectionProfiles, getPluginConfig, getProfileModels, pingPlugin, setPluginConfig } from "utils/network";
import { delay } from "utils/utils";
import { ConnectionProfileSummary, MemuMode, MemuPluginConfigV1, MemuStep } from "utils/types";

const buttonStyle: CSSProperties = {
    height: '100%',
    borderRadius: 8,
    width: 36,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
}

function App() {
    const [apiKey, setApiKey] = useState<string>('');
    const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');

    // --- memU plugin/server-side config (Best UX, not too complex) ---
    const [pluginOk, setPluginOk] = useState<boolean | null>(null);
    const [pluginConfig, setPluginConfigState] = useState<MemuPluginConfigV1 | null>(null);
    const [profiles, setProfiles] = useState<ConnectionProfileSummary[]>([]);
    const [configStatus, setConfigStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
    const [showAdvancedMapping, setShowAdvancedMapping] = useState<boolean>(false);
    const [embedModels, setEmbedModels] = useState<string[]>([]);
    const [embedModelsStatus, setEmbedModelsStatus] = useState<'idle' | 'loading' | 'error'>('idle');
    const [embedModelsMessage, setEmbedModelsMessage] = useState<string>('');
    const [embedManualExpanded, setEmbedManualExpanded] = useState<boolean>(false);
    const [overrideSummarizer, setOverrideSummarizer] = useState<boolean>(false);
    const [autoSummaryByContextSize, setAutoSummaryByContextSize] = useState<boolean>(false);
    const [summaryTurn, setSummaryTurn] = useState<number>(10);
    const [showMemoryModal, setShowMemoryModal] = useState<boolean>(false);
    const [memoryText, setMemoryText] = useState<string>('');

    useEffect(() => {
        st.eventSource.on(st.event_types.CHAT_COMPLETION_PROMPT_READY, onChatCompletionPromptReady);
        st.eventSource.on(st.event_types.CHAT_CHANGED, onChatChanged);
        st.eventSource.on(st.event_types.CHARACTER_MESSAGE_RENDERED, onMessageReceived);
        st.eventSource.on(st.event_types.MESSAGE_EDITED, onMessageEdited);
        st.eventSource.on(st.event_types.MESSAGE_SWIPED, onMessageSwiped);

        st.eventSource.on(st.event_types.CHAT_CHANGED, () => {
            setMemoryText(memuExtras.retrieve?.nowRetrieve?.summary ?? '');
        });
    }, []);

    useEffect(() => {
        try {
            const saved = API_KEY.get();
            if (saved !== null) setApiKey(saved);
        } catch { }
    }, []);

    // Load plugin health + saved config + best-effort connection profiles
    useEffect(() => {
        async function initPluginUi() {
            try {
                const ok = await pingPlugin();
                setPluginOk(ok);
                if (!ok) return;

                const cfg = await getPluginConfig();
                setPluginConfigState(cfg);
                // Sync runtime mode with plugin mode
                try { if ((cfg as any)?.mode) PLUGIN_MODE.set((cfg as any).mode as any); } catch { /* ignore */ }

                // Remember the UI collapse state for Advanced mapping.
// If the user never chose, default to "open only if overrides exist".
                try {
                    const pref = SHOW_ADVANCED_MAPPING.get();
                    if (pref !== null) {
                        setShowAdvancedMapping(pref === 'true');
                    } else {
                        const m = (cfg as any)?.stepProfileId;
                        const hasOverrides = m && typeof m === 'object' && Object.keys(m).some((k) => k !== 'all' && String(m[k] ?? '').trim().length > 0);
                        if (hasOverrides) setShowAdvancedMapping(true);
                    }
                } catch { }

                const prof = await getConnectionProfiles();
                if (Array.isArray(prof?.profiles)) {
                    setProfiles(prof.profiles);
                }
            } catch {
                setPluginOk(false);
            }
        }
        void initPluginUi();
    }, []);

    // When local mode is active, load embedding model list from the selected embeddings profile (best-effort).
    async function loadEmbeddingModels(force: boolean = false) {
        try {
            if (!pluginOk) return;
            if ((pluginConfig?.mode ?? 'cloud') !== 'local') return;

            const embedProfileId = (pluginConfig?.stepProfileId?.embeddings || pluginConfig?.defaultProfileId || '').trim();
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
                // keep manual collapsed unless user opened it
            } else {
                setEmbedModels([]);
                setEmbedModelsStatus('error');
                setEmbedModelsMessage(resp?.message || 'Failed to load models from provider.');
                setEmbedManualExpanded(true);
            }
        } catch (e: any) {
            setEmbedModels([]);
            setEmbedModelsStatus('error');
            setEmbedModelsMessage(e?.message || 'Failed to load models from provider.');
            setEmbedManualExpanded(true);
        }
    }

    useEffect(() => {
        void loadEmbeddingModels(false);
    }, [pluginOk, pluginConfig?.mode, pluginConfig?.defaultProfileId, pluginConfig?.stepProfileId?.embeddings]);

    useEffect(() => {
        const saved = OVERRIDE_SUMMARIZER.get();
        if (saved !== null) setOverrideSummarizer(saved);
        const savedAutoSummaryByContextSize = AUTO_SUMMARY_BY_CONTEXT_SIZE.get();
        if (savedAutoSummaryByContextSize !== null) setAutoSummaryByContextSize(savedAutoSummaryByContextSize);
        const savedSummaryTurn = SUMMARY_TURN.get();
        if (savedSummaryTurn !== null) setSummaryTurn(parseInt(savedSummaryTurn));
    }, []);

    function handleChange(e: ChangeEvent<HTMLInputElement>) {
        setApiKey(e.target.value);
        setStatus('idle');
    }

    // todo: check available
    async function handleSave() {
        setStatus('saving');
        await delay(1500);
        try {
            API_KEY.set(apiKey);
            setStatus('saved');
            await delay(1500);
            setStatus('idle');
        } catch {
            setStatus('error');
            await delay(1500);
            setStatus('idle');
        }
    }

    function updatePluginConfig(patch: Partial<MemuPluginConfigV1>) {
        // Keep extension runtime mode in sync with server/plugin config
        if (Object.prototype.hasOwnProperty.call(patch, 'mode') && (patch as any).mode) {
            try { PLUGIN_MODE.set((patch as any).mode as any); } catch { /* ignore */ }
        }
        setPluginConfigState(prev => {
            const base: MemuPluginConfigV1 = prev ?? {
                version: 1,
                mode: 'cloud',
                updatedAt: new Date().toISOString(),
            };

            const next: any = { ...base, ...patch };

            // Normalize/derive embedding model fields (UX: dropdown overrides manual).
            const selected = typeof next.embeddingModelSelected === 'string' ? next.embeddingModelSelected.trim() : '';
            const manual = typeof next.embeddingModelManual === 'string' ? next.embeddingModelManual.trim() : '';
            const legacy = typeof next.embeddingModel === 'string' ? next.embeddingModel.trim() : '';
            const effective = selected || manual || legacy;

            if (selected) next.embeddingModelSelected = selected; else delete next.embeddingModelSelected;
            if (manual) next.embeddingModelManual = manual; else delete next.embeddingModelManual;
            if (effective) next.embeddingModel = effective; else delete next.embeddingModel;

            return next as MemuPluginConfigV1;
        });
    }

    async function savePluginConfig() {
        if (!pluginConfig) return;
        setConfigStatus('saving');
        try {
            const resp = await setPluginConfig(pluginConfig);
            if (resp?.ok && resp?.config) {
                setPluginConfigState(resp.config);
                setConfigStatus('saved');
            } else {
                setConfigStatus('error');
            }
        } catch {
            setConfigStatus('error');
        }
        await delay(1200);
        setConfigStatus('idle');
    }

    function cleanProfileName(s: string): string {
        const v = String(s || '').trim();
        return v.length > 80 ? v.slice(0, 77) + '…' : v;
    }

    function renderProfilePicker(
        value: string | undefined,
        onChange: (v: string) => void,
        placeholder: string,
    ) {
        if (profiles.length > 0) {
            return (
                <select
                    className="text_pole"
                    value={value ?? ''}
                    onChange={(e) => onChange(e.target.value)}
                >
                    <option value="">— inherit default —</option>
                    {profiles.map(p => (
                        <option key={p.id} value={p.id}>{cleanProfileName(p.name)}</option>
                    ))}
                </select>
            );
        }
        return (
            <input
                type="text"
                value={value ?? ''}
                onChange={(e) => onChange(e.target.value)}
                className="text_pole"
                placeholder={placeholder}
            />
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

    function handleAutoSummaryByContextSizeChange(e: ChangeEvent<HTMLInputElement>) {
        setAutoSummaryByContextSize(e.target.checked);
        AUTO_SUMMARY_BY_CONTEXT_SIZE.set(e.target.checked);
    }

    function handleSummaryTurnChange(e: ChangeEvent<HTMLInputElement>) {
        setSummaryTurn(parseInt(e.target.value));
        SUMMARY_TURN.set(parseInt(e.target.value));
    }

    const mode: MemuMode = (pluginConfig?.mode ?? 'cloud') as MemuMode;

    return (
        <>
            <div className="memu-ext-settings">
                <div className="inline-drawer">
                    <div className="inline-drawer-toggle inline-drawer-header">
                        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                            <MemuLogo width={58} height={20} />
                            <button
                                className="menu_button"
                                style={{ ...buttonStyle, width: 30 }}
                                disabled={memoryText === ''}
                                onClick={(e) => { e.stopPropagation(); setShowMemoryModal(true); }}
                            >
                                <EyeIcon width={16} height={16} />
                            </button>
                        </div>
                        <div className="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                    </div>
                    <div className="inline-drawer-content" style={{ display: 'flex', flexDirection: 'column' }}>

                        {/* ---- Best UX config: Local mode mapping (server-side) ---- */}
                        <div style={{ display: 'flex', flexDirection: 'column', padding: '0 4px' }}>
                            <h4>Backend</h4>
                            <small>
                                <span>
                                    Plugin: {pluginOk === null ? 'checking…' : pluginOk ? 'ok' : 'not reachable'}
                                </span>
                            </small>
                        </div>

                        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                            <label style={{ minWidth: 80 }}>Mode:</label>
                            <select
                                className="text_pole"
                                value={pluginConfig?.mode ?? 'cloud'}
                                onChange={(e) => updatePluginConfig({ mode: e.target.value as MemuMode })}
                                disabled={!pluginOk}
                            >
                                <option value="cloud">Cloud (memu.so)</option>
                                <option value="local">Local (Python memU)</option>
                            </select>

                            <button
                                onClick={savePluginConfig}
                                className="menu_button"
                                style={buttonStyle}
                                disabled={!pluginOk || !pluginConfig || configStatus === 'saving'}
                                aria-busy={configStatus === 'saving'}
                                title={configStatus === 'saving' ? 'Saving' : configStatus === 'saved' ? 'Saved' : 'Save'}
                            >
                                {configStatus === 'saving' ? <LoadingIcon width={20} height={20} /> :
                                    configStatus === 'saved' ? <SuccessIcon width={20} height={20} /> :
                                        <i className="fa-fw fa-solid fa-save" style={{ fontSize: 20 }} />}
                            </button>
                            {configStatus === 'error' && (
                                <FailIcon width={20} height={20} />
                            )}
                        </div>

                        {pluginOk && (pluginConfig?.mode ?? 'cloud') === 'local' && (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '8px 4px' }}>
                                <h4>Model Mapping</h4>
                                <small>
                                    <span>
                                        Pick a SillyTavern Connection Profile per memU step. (If no dropdown appears, your ST version probably stores profiles elsewhere — you can still type an ID.)
                                    </span>
                                </small>

                                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                                    <label>Default profile (all steps)</label>
                                    {renderProfilePicker(
                                        pluginConfig?.defaultProfileId,
                                        (v) => updatePluginConfig({ defaultProfileId: v || undefined }),
                                        'connection-profile-id'
                                    )}
                                </div>

                                <label className="checkbox_label expander" htmlFor="advanced_mapping" title="Advanced mapping">
                                    <input
                                        id="advanced_mapping"
                                        type="checkbox"
                                        className="checkbox"
                                        checked={showAdvancedMapping}
                                        onChange={(e) => { const v = e.target.checked; setShowAdvancedMapping(v); try { SHOW_ADVANCED_MAPPING.set(v); } catch { } }}
                                    />
                                    <span>Advanced per-step overrides</span>
                                </label>

                                {showAdvancedMapping && (
                                    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, paddingLeft: 8, paddingRight: 8 }}>
                                        {stepLabels.map(({ step, label, hint }) => (
                                            <div key={step} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                                                <label>{label} <small style={{ opacity: 0.7 }}>— {hint}</small></label>
                                                {renderProfilePicker(
                                                    pluginConfig?.stepProfileId?.[step],
                                                    (v) => {
                                                        const next = { ...(pluginConfig?.stepProfileId ?? {}) } as any;
                                                        if (v) next[step] = v; else delete next[step];
                                                        updatePluginConfig({ stepProfileId: next });
                                                    },
                                                    `override profile id for ${step}`
                                                )}
                                            </div>
                                        ))}
                                    </div>
                                )}

                                <div style={{ display: 'flex', flexDirection: 'column', gap: 10, paddingTop: 10 }}>
                                    <h4 style={{ margin: 0 }}>Embeddings agent</h4>
                                    <small style={{ opacity: 0.85 }}>
                                        Profiles must be OpenAI-compatible. Model list is fetched from the embeddings profile’s <code>/v1/models</code> (or provider-equivalent) when available.
                                    </small>

                                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                                        <label>Embeddings profile <small style={{ opacity: 0.7 }}>— optional override</small></label>
                                        {renderProfilePicker(
                                            pluginConfig?.stepProfileId?.embeddings,
                                            (v) => {
                                                const next = { ...(pluginConfig?.stepProfileId ?? {}) } as any;
                                                if (v) next.embeddings = v; else delete next.embeddings;
                                                updatePluginConfig({ stepProfileId: next });
                                            },
                                            'override profile id for embeddings'
                                        )}
                                    </div>

                                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                                        <label>Embedding model <small style={{ opacity: 0.7 }}>— used for vector embeddings</small></label>

                                        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                                            <select
                                                className="text_pole"
                                                value={pluginConfig?.embeddingModelSelected ?? ''}
                                                onChange={(e) => {
                                                    const v = e.target.value;
                                                    updatePluginConfig({ embeddingModelSelected: v || undefined });
                                                    if (v) setEmbedManualExpanded(false);
                                                }}
                                                disabled={embedModelsStatus === 'loading'}
                                            >
                                                <option value="">— automatic / manual —</option>
                                                {embedModels.map(m => (
                                                    <option key={m} value={m}>{m}</option>
                                                ))}
                                            </select>

                                            <button
                                                className="menu_button"
                                                style={{ ...buttonStyle, width: 40 }}
                                                title="Refresh embedding model list"
                                                onClick={() => void loadEmbeddingModels(true)}
                                                disabled={embedModelsStatus === 'loading'}
                                            >
                                                <i className="fa-fw fa-solid fa-rotate" style={{ fontSize: 16 }} />
                                            </button>
                                        </div>

                                        {embedModelsStatus === 'loading' && (
                                            <small style={{ opacity: 0.85 }}>Loading models…</small>
                                        )}
                                        {embedModelsStatus === 'error' && embedModelsMessage && (
                                            <small style={{ opacity: 0.85 }}>Model list unavailable: {embedModelsMessage}</small>
                                        )}

                                        {!embedManualExpanded ? (
                                            <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                                                <button
                                                    className="menu_button"
                                                    style={{ height: 28, borderRadius: 8, padding: '0 10px' } as any}
                                                    onClick={() => setEmbedManualExpanded(true)}
                                                >
                                                    {pluginConfig?.embeddingModelManual ? 'Edit manual model' : 'Enter manual model'}
                                                </button>
                                                {pluginConfig?.embeddingModelManual && (
                                                    <small style={{ opacity: 0.85 }}>Manual: <code>{pluginConfig.embeddingModelManual}</code></small>
                                                )}
                                            </div>
                                        ) : (
                                            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                                                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                                                    <input
                                                        type="text"
                                                        value={pluginConfig?.embeddingModelManual ?? ''}
                                                        onChange={(e) => updatePluginConfig({ embeddingModelManual: e.target.value || undefined })}
                                                        className="text_pole"
                                                        placeholder="text-embedding-3-small"
                                                        disabled={!!(pluginConfig?.embeddingModelSelected && pluginConfig.embeddingModelSelected.trim())}
                                                    />
                                                    <button
                                                        className="menu_button"
                                                        style={{ height: 28, borderRadius: 8, padding: '0 10px' } as any}
                                                        onClick={() => setEmbedManualExpanded(false)}
                                                    >
                                                        Hide
                                                    </button>
                                                </div>
                                                <small style={{ opacity: 0.85 }}>
                                                    Used only when the dropdown is set to “automatic / manual”.
                                                </small>
                                            </div>
                                        )}
                                    </div>
                                </div>

                            </div>
                        )}

                        {mode === 'cloud' ? (
                            <>
                                <div style={{ display: 'flex', flexDirection: 'column', padding: '0 4px' }}>
                                    <h4>API Key</h4>
                                    <small>
                                        <span>Cloud (memu.so) key: <a href="https://app.memu.so/api-key" target="_blank" rel="noopener noreferrer">app.memu.so/api-key</a></span>
                                    </small>
                                </div>
                                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                                    <input
                                        type="text"
                                        value={apiKey}
                                        onChange={handleChange}
                                        className="text_pole"
                                        placeholder="memu-api-key"
                                    />
                                    <button
                                        onClick={handleSave}
                                        className="menu_button"
                                        style={buttonStyle}
                                        disabled={status === 'saving'}
                                        aria-busy={status === 'saving'}
                                        title={status === 'saving' ? 'Saving' : status === 'saved' ? 'Saved' : 'Save'}
                                    >
                                        {status === 'saving' ? <LoadingIcon width={20} height={20} /> :
                                            status === 'saved' ? <SuccessIcon width={20} height={20} /> :
                                                <i className="fa-fw fa-solid fa-save" style={{ fontSize: 20 }} />}
                                    </button>
                                    {status === 'error' && (
                                        <FailIcon width={20} height={20} />
                                    )}
                                </div>
                            </>
                        ) : (
                            <div style={{ padding: '8px 4px', opacity: 0.85 }}>
                                <small>
                                    <span>
                                        Local (Python memU) mode is selected. The cloud API key is not expected to be needed once the plugin is switched to a local backend.
                                    </span>
                                </small>
                            </div>
                        )}
                        <hr />
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                            <h4>Memory</h4>
                            <label className="checkbox_label expander" htmlFor="override_summarizer" title="Override Summarizer">
                                <input id="override_summarizer" type="checkbox" className="checkbox" checked={overrideSummarizer} onChange={handleOverrideSummarizerChange} />
                                <span>Override Summarizer</span>
                                <i className="fa-solid fa-info-circle" title="Override the summarizer with MemU's summarizer. Extremely recommend to be checked."></i>
                            </label>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                                <label className="checkbox_label expander" htmlFor="auto_summary_turn" title="Auto Summary Turn">
                                    <input id="auto_summary_turn" type="checkbox" className="checkbox" checked={autoSummaryByContextSize} onChange={handleAutoSummaryByContextSizeChange} />
                                    <span>Summary by Context Size</span>
                                    {/* <i className="fa-solid fa-info-circle" title="Checked for auto summary by context size."></i> */}
                                </label>
                                <div style={{ display: 'flex', flexDirection: 'column', gap: 8, paddingLeft: 8, paddingRight: 8 }}>
                                    <label style={{ opacity: autoSummaryByContextSize ? 0.5 : 1 }}>
                                        Summary Turn:
                                        <span id="summary_turn_output">
                                            {' ' + (autoSummaryByContextSize ? 'auto' : summaryTurn)}
                                        </span>
                                    </label>
                                    <input
                                        type="range"
                                        disabled={autoSummaryByContextSize}
                                        value={summaryTurn}
                                        min="5"
                                        max="1000" step="5"
                                        onChange={handleSummaryTurnChange}>
                                    </input>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
            <MemoryShowModal open={showMemoryModal} text={memoryText} onClose={() => setShowMemoryModal(false)} />
        </>
    );
}

export default App;


