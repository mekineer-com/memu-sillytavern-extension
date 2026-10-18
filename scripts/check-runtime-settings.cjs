const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require(path.resolve(__dirname, '../../../../../plugins/memu-plugin/node_modules/typescript'));
const jsx = require('react/jsx-runtime');

// Render real App JSX with isolated hooks; don't initialize ST or run effects.
const source = fs.readFileSync(process.env.MEMU_APP_SOURCE || `${__dirname}/../src/App.tsx`, 'utf8');
{
  const prefsSource = fs.readFileSync(`${__dirname}/../src/utils/context-extra.ts`, 'utf8');
  const constants = fs.readFileSync(`${__dirname}/../src/utils/consts.ts`, 'utf8');
  const saved = new Map();
  const ctx = { characters: [{ name: 'TestSoul' }, { name: 'OtherSoul' }], characterId: 0 };
  const prefs = { exports: {}, st: { getContext: () => ctx }, localStorage: {
    getItem: key => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value),
  } };
  const code = constants + prefsSource.slice(prefsSource.indexOf('export function currentSelectedCharacterName('), prefsSource.indexOf('export const memuExtras'));
  vm.runInNewContext(ts.transpileModule(code, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, prefs);
  const toggle = prefs.exports.MENTAL_HEALTH_ADDON;
  toggle.set(true);
  assert.equal(toggle.get(), true);
  ctx.characterId = 1;
  assert.equal(toggle.get(), false, 'Another Soul must not inherit the first Soul preference');
  toggle.set(false);
  ctx.characterId = undefined;
  const before = JSON.stringify([...saved]);
  toggle.set(true);
  assert.equal(JSON.stringify([...saved]), before, 'No Soul means no preference write');
  assert.equal(toggle.get(), false);
  ctx.characterId = 0;
  assert.equal(toggle.get(), true, 'Switching back must recover the Soul preference');
}
const states = [];
let cursor = 0;
const react = {
  useState(initial) {
    const index = cursor++;
    if (!(index in states)) states[index] = typeof initial === 'function' ? initial() : initial;
    return [states[index], value => { states[index] = typeof value === 'function' ? value(states[index]) : value; }];
  },
  useEffect() {}, useMemo: fn => fn(), useRef: value => ({ current: value }),
};
let formMode = 'editcharacter';
const uiCtx = { characters: [{ name: 'TestSoul', avatar: 'test.png' }], characterId: 0 };
const editor = { value: 'test.png' };
const cardHost = {};
const extensionSettingsForUi = {};
const mentalHealthWrites = [];
const context = {
  exports: {}, localStorage: { getItem: () => null, setItem() {} }, window: { setTimeout: () => 1, clearTimeout() {} },
  document: { getElementById: id => ({ 'avatar-and-name-block': cardHost, avatar_url_pole: editor,
    form_create: { getAttribute: () => formMode } })[id] },
  require: name => name === 'react' ? react : name === 'react/jsx-runtime' ? jsx
    : name === 'react-dom' ? { createPortal: (children, target) => ({ type: 'portal', props: { children, target } }) }
    : { default: () => null, __esModule: true, extension_settings: extensionSettingsForUi, saveSettings: async () => {}, nativeModelSelection: () => null, srmmChoice: () => ({ source: 'config' }), srmmRequest: () => ({ source: 'config', native: null }), st: { getContext: () => uiCtx }, memuExtras: {}, MENTAL_HEALTH_ADDON: { get: () => false, set: value => mentalHealthWrites.push(value) }, SHOW_ADVANCED_MAPPING: { get: () => null, set() {} } },
};
vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText, context);
states[0] = true;
states[1] = { version: 4, serverPath: '/fictional/server' };
states[2] = { claude_code: false, step_models: { memory_extract: 'hand-entered-model' },
  base_model: { provider: 'openai', chat_model: 'custom-outside-catalog' }, providers: [
    { profile_id: 'test-api', provider: 'openai', label: 'Fictional API', supported: true, models: [{ model: 'test-model' }] },
    { profile_id: 'native:cc:openai', provider: 'openai', label: 'openai', supported: true, models: [{ model: 'native-selection-only' }] },
    { profile_id: 'unsupported', provider: 'claude', label: 'Native Claude', supported: false, reason: 'Unsupported transport', models: [{ model: 'native-model' }] },
  ] };
const render = () => { cursor = 0; return context.exports.default(); };
function nodes(tree) { if (!tree || typeof tree !== 'object') return []; if (Array.isArray(tree)) return tree.flatMap(nodes); return [tree, ...nodes(tree.props?.children)]; }
const find = (tree, id) => nodes(tree).find(node => node.props?.id === id);
let tree = render();
const serverButtons = tree => nodes(tree).filter(node => node.type === 'button' && ['Start', 'Stop'].includes(node.props?.children));
assert.equal(serverButtons(tree).length, 2);
assert(nodes(tree).some(node => node.type === 'b' && node.props.children === 'checking…'));
assert.equal(find(tree, 'auto_start_server').props.disabled, undefined);
states[4] = { ok: false };
tree = render();
assert.equal(serverButtons(tree).length, 2);
assert(nodes(tree).some(node => node.type === 'b' && node.props.children === 'unavailable'));
states[4] = { ok: true, managedByLauncher: false, healthy: false };
tree = render();
assert.equal(serverButtons(tree).length, 2);
assert.equal(find(tree, 'auto_start_server').props.checked, false);
assert.equal(find(tree, 'auto_start_server').props.disabled, undefined);
find(tree, 'auto_start_server').props.onChange({ target: { checked: true } });
assert.equal(states[1].autoStartWithSillyTavern, true);
states[1].autoStartWithSillyTavern = false;
tree = render();
assert(nodes(tree).some(node => node.type === 'b' && node.props.children === 'stopped'));
states[4] = { ok: true, healthy: true, shutdown: { draining: true } };
assert(nodes(render()).some(node => node.type === 'b' && node.props.children === 'stopping…'));
states[4] = { ok: true, managedByLauncher: true, healthy: false };
tree = render();
assert.equal(serverButtons(tree).length, 2);
assert.equal(find(tree, 'auto_start_server').props.disabled, undefined);
assert(nodes(tree).some(node => node.type === 'b' && node.props.children === 'stopped'));
assert.equal(states[1].autoStartWithSillyTavern, false);
states[4] = null;
tree = render();
const serverPathInput = tree => nodes(tree).find(node => node.props?.placeholder === 'Path to mcp-memu-server');
assert.equal(serverPathInput(tree).props.value, '/fictional/server');
states[1] = { version: 4 };
assert.equal(serverPathInput(render()).props.value, '');
serverPathInput(render()).props.onChange({ target: { value: '/fictional/manual/server' } });
assert.equal(serverPathInput(render()).props.value, '/fictional/manual/server');
states[1] = { version: 4, serverPath: '/fictional/server' };
assert.equal(find(tree, 'use_server_settings'), undefined);
assert.equal(find(tree, 'use_claude_code').props.checked, false);
assert.equal(find(tree, 'mental_health_addon').props.disabled, true, 'Per-Soul setting requires an active Soul');
find(tree, 'mental_health_addon').props.onChange({ target: { checked: true } });
assert.equal(mentalHealthWrites.length, 0);
states[8] = 'TestSoul'; states[10] = true;
find(render(), 'mental_health_addon').props.onChange({ target: { checked: true } });
assert.equal(find(render(), 'mental_health_addon').props.checked, true);
assert.deepEqual(mentalHealthWrites, [true]);
assert.equal(states[2].mental_health_query, undefined, 'Per-Soul preference must not write shared model mappings');
states[11] = true;
assert.equal(find(render(), 'mental_health_addon').props.disabled, true);
find(render(), 'mental_health_addon').props.onChange({ target: { checked: false } });
assert.deepEqual(mentalHealthWrites, [true]);
states[8] = ''; states[10] = false; states[11] = false;
assert(find(tree, 'memu-model-srmm')); assert(find(tree, 'memu-model-other_apps'));
const picker = find(tree, 'memu-model-srmm');
assert.equal(picker.props.style.colorScheme, 'dark');
assert.equal(picker.props.style.backgroundColor, 'var(--SmartThemeBlurTintColor)');
assert(!source.includes('select2'), 'Keep the native model dropdown');
assert.equal(picker.props.onFocus, undefined, 'Opening a picker must not request provider catalogs');
const configuredChoices = nodes(picker).filter(node => node.type === 'option')
  .map(node => JSON.parse(node.props.value)).filter(choice => choice.source === 'configured');
assert.deepEqual(configuredChoices.map(choice => choice.profile_id), ['test-api', 'unsupported']);
assert(!nodes(picker).some(node => node.type === 'option' && /native-selection-only/.test(node.props.children)));
assert.equal(find(tree, 'memu-iris-model-info'), undefined);
assert.equal(find(tree, 'memu-srmm-config-info').props.title, 'No effect on config.json');
assert.deepEqual(JSON.parse(find(tree, 'memu-model-other_apps').props.value), { source: 'config' });
assert.equal(find(tree, 'memu-other-apps-config-info').props.title, 'Hand configured config.json');
assert(!nodes(find(tree, 'memu-model-other_apps')).some(node => node.type === 'option' && /hand.configured/i.test(node.props.children)));
const otherAppsHeading = nodes(tree).find(node => node.type === 'label' && node.props.children?.includes?.('Other OpenAlma App Replies'));
const infoIcons = nodes(otherAppsHeading).filter(node => node.type === 'i');
assert.equal(infoIcons.length, 1);
assert.equal(infoIcons[0].props.id, 'memu-other-apps-config-info');
assert.equal(infoIcons[0].props.style.color, '#ef4444');
states[2].base_model.profile_ids = ['test-api'];
assert(find(render(), 'memu-other-apps-config-info'), 'A matching profile without its marker is still config-owned');
extensionSettingsForUi.memu = { ...extensionSettingsForUi.memu, base_model: { source: 'configured', profile_id: 'test-api' } };
assert.equal(find(render(), 'memu-other-apps-config-info'), undefined);
assert.equal(JSON.parse(find(render(), 'memu-model-other_apps').props.value).profile_id, 'test-api');
extensionSettingsForUi.memu.base_model = { source: 'config' };
extensionSettingsForUi.memu.advancedMapping = { memory_extract: { source: 'config' } };
assert.equal(find(render(), 'memu-other-apps-config-info'), undefined, 'Explicit config source is silent');
assert.equal(find(render(), 'memu-memory_extract-config-info'), undefined);
states[2].base_model.chat_model = 'hand-changed-config-source';
assert.equal(find(render(), 'memu-other-apps-config-info'), undefined, 'Config followers accept hand edits silently');
extensionSettingsForUi.memu.base_model.hand_edited = true;
assert(find(render(), 'memu-other-apps-config-info'), 'Detected edits to ST-owned values retain the red icon');
extensionSettingsForUi.memu.advancedMapping.memory_extract.hand_edited = true;
assert(find(render(), 'memu-memory_extract-config-info'));
delete extensionSettingsForUi.memu.advancedMapping;
delete states[2].base_model.profile_ids;
delete extensionSettingsForUi.memu.base_model;
assert(nodes(tree).some(node => node.type === 'option' && /custom-outside-catalog/.test(node.props.children)));
assert(nodes(tree).some(node => node.type === 'option' && /Native Claude/.test(node.props.children) && node.props.disabled));
assert.equal(find(tree, 'memu-agentic-settings-info').props.title, 'Agentic turns more limited without Claude Code');
assert(!source.includes('memu-runtime-info'));
assert(!nodes(tree).some(node => node.props?.role === 'tooltip'));
const originalInfo = nodes(tree).find(node => node.type === 'i' && node.props.title?.startsWith('Per character. If checked:'));
for (const id of ['memu-srmm-config-info', 'memu-other-apps-config-info', 'memu-agentic-settings-info', 'memu_character_enabled-info', 'memu-persona-info']) {
  const icon = find(tree, id);
  assert.equal(icon.type, originalInfo.type);
  assert.equal(icon.props.className, originalInfo.props.className);
  assert.equal(icon.props.style.opacity, originalInfo.props.style.opacity);
}
const beforeRows = JSON.stringify(states[2].step_models);
const advancedRow = nodes(tree).find(node => node.type === 'div' && node.props.className === 'checkbox_label expander' && find(node, 'advanced_mapping'));
assert.equal(advancedRow.type, 'div', 'Clicking the row or text must not toggle AMM');
assert.equal(advancedRow.props.onClick, undefined);
assert.equal(find(tree, 'advanced_mapping').props['aria-label'], 'Advanced Mapping');
for (const checkbox of nodes(tree).filter(node => node.type === 'input' && node.props.type === 'checkbox')) {
  const target = nodes(tree).find(node => node.props?.children === checkbox);
  assert.equal(target.type, 'label');
  assert.equal(target.props.className, 'memu-checkbox-target');
  const row = nodes(tree).find(node => node.props?.children?.includes?.(target));
  assert(row && row.type !== 'label', `${checkbox.props.id}: the padded box, not the row, toggles the setting`);
  assert.equal(row.props.onClick, undefined);
  assert(checkbox.props['aria-label'], `${checkbox.props.id}: retain an accessible name`);
}
find(tree, 'advanced_mapping').props.onChange({ target: { checked: true } });
tree = render(); assert(find(tree, 'memu-model-memory_extract')); assert.equal(JSON.stringify(states[2].step_models), beforeRows);
assert.equal(find(tree, 'memu-advanced-mapping').props.style.gap, 8);
for (const label of ['multimodal memory', 'memory atom', 'category dossiers', 'memory retrieval', 'weekly reflection']) {
  assert(nodes(tree).some(node => node.type === 'label' && node.props.children?.includes?.(label)));
}
assert(!source.includes('Steps may follow '));
find(tree, 'use_claude_code').props.onChange({ target: { checked: true } });
tree = render(); assert(find(tree, 'memu-model-srmm')); assert.equal(find(tree, 'memu-model-other_apps'), undefined); assert.equal(find(tree, 'advanced_mapping'), undefined);
assert.equal(JSON.stringify(states[2].step_models), beforeRows);
find(tree, 'use_claude_code').props.onChange({ target: { checked: false } });
assert(find(render(), 'memu-model-memory_extract'));
assert.equal(find(render(), 'advanced_mapping').props.checked, true, 'Hand-entered rows are active');
states[3] = 'saving';
assert.equal(find(render(), 'advanced_mapping').props.disabled, false, 'Ordered saves allow disabling without losing pending choices');
states[3] = 'idle';
const srmmIndex = states.findIndex(value => value?.source === 'config');
assert(srmmIndex >= 0);
states[srmmIndex] = { source: 'configured', profile_id: 'deleted-profile' };
assert.equal(JSON.parse(find(render(), 'memu-model-srmm').props.value).source, 'st_native');
assert.equal(states[srmmIndex].profile_id, 'deleted-profile', 'Fallback display must not rewrite retained settings');
states[srmmIndex] = { source: 'configured', profile_id: 'unsupported' };
assert.equal(JSON.parse(find(render(), 'memu-model-srmm').props.value).profile_id, 'unsupported');
states[srmmIndex] = { source: 'config' };
const originalStep = states[2].step_models.memory_extract;
states[2].step_models.memory_extract = { provider: 'openai', base_url: 'https://hand.invalid/v1', chat_model: 'hand-only' };
assert.deepEqual(JSON.parse(find(render(), 'memu-model-memory_extract').props.value), { source: 'config' });
assert(nodes(find(render(), 'memu-model-memory_extract')).some(node => node.type === 'option' && /default \(config.json: hand-only/.test(node.props.children)));
assert.equal(find(render(), 'memu-memory_extract-config-info').props.title, 'Hand configured config.json');
assert.equal(find(render(), 'advanced_mapping').props.checked, true);
states[2].step_models.memory_extract = originalStep;
console.log('Ordinary defaults, hand edits, configured catalog, unsupported transport and CLI collapse pass.');

const utilsSource = fs.readFileSync(`${__dirname}/../src/memory/utils.ts`, 'utf8');
const native = { exports: {}, main_api: 'textgenerationwebui', textgenerationwebui_settings: { type: 'ollama' },
  getTextGenModel: () => assert.fail('Unconfigured Ollama must not call the throwing native getter'),
  extension_settings: {}, model_list: [], oai_settings: {}, getChatCompletionModel: () => 'fictional-model' };
vm.runInNewContext(ts.transpileModule(utilsSource.slice(utilsSource.indexOf('export function nativeModelSelection('), utilsSource.indexOf('export function srmmChoice(')), {
  compilerOptions: { module: ts.ModuleKind.CommonJS },
}).outputText, native);
assert.equal(native.exports.nativeModelSelection(), null);
native.main_api = 'openai';
native.oai_settings = { chat_completion_source: 'openrouter', reverse_proxy: 'https://proxy.invalid/v1' };
assert.equal(native.exports.nativeModelSelection().base_url, undefined);
native.oai_settings.chat_completion_source = 'openai';
assert.equal(native.exports.nativeModelSelection().base_url, 'https://proxy.invalid/v1');
assert(source.includes('st.event_types.SETTINGS_UPDATED'));

(async () => {
  let starts = 0, reads = 0, loaded, busy;
  const ready = { mappingState: { current: null }, extension_settings: {}, nativeModelSelection: () => null, srmmChoice: () => ({ source: 'config' }), serverStart: async () => { starts++; return { ok: true, status: { healthy: true } }; },
    nativeTransition: { current: false }, pendingMappings: { current: {} }, setAdvancedOpen() {}, setConfigStatus() {},
    getModelMappings: async () => { reads++; return { claude_code: false, step_models: {}, providers: [] }; },
    setServerCtl() {}, setServerCtlBusy: value => { busy = value; }, setMappings: value => { loaded = value; }, setSwitchError: value => { if (value) assert.fail(value); } };
  loadFunctions(source, ['loadModelMappings', 'applyLoadedMappings'], ready);
  vm.runInNewContext(ts.transpileModule(source.slice(source.indexOf('  async function doServerStart('), source.indexOf('  async function doServerStop(')), {
    compilerOptions: { module: ts.ModuleKind.CommonJS },
  }).outputText, ready);
  await ready.doServerStart(); assert.equal(starts, 1); assert.equal(reads, 1); assert.equal(busy, 'idle'); assert.equal(ready.mappingState.current, loaded);
  let reported;
  ready.serverStart = async () => ({ ok: false, message: 'Fictional startup error', status: { ok: false } });
  ready.setSwitchError = value => { reported = value; };
  await ready.doServerStart(); assert.match(reported, /Fictional startup error/); assert.equal(reads, 1);
  let confirm = false, stopCalls = [], stopError, stopBusy;
  const stopping = { window: { confirm: () => confirm },
    serverStop: async (confirmed = false) => { stopCalls.push(confirmed); return confirmed
      ? { ok: true, status: { ok: true } } : { ok: false, confirmationRequired: true, message: 'Unknown Iris activity' }; },
    setServerCtl() {}, setServerCtlBusy: value => { stopBusy = value; }, setSwitchError: value => { stopError = value; } };
  vm.runInNewContext(ts.transpileModule(source.slice(source.indexOf('  async function doServerStop('), source.indexOf('  function updatePluginConfig(')), {
    compilerOptions: { module: ts.ModuleKind.CommonJS },
  }).outputText, stopping);
  await stopping.doServerStop(); assert.deepEqual(stopCalls, [false]); assert.equal(stopBusy, 'idle');
  confirm = true; stopCalls = [];
  await stopping.doServerStop(); assert.deepEqual(stopCalls, [false, true]); assert.equal(stopBusy, 'idle');
  stopping.serverStop = async () => ({ ok: false, message: 'Stop the Iris conversation first.' });
  await stopping.doServerStop(); assert.match(stopError, /Iris conversation/); assert.equal(stopBusy, 'error');
})().catch(error => { console.error(error); process.exitCode = 1; });

// Character switch and copied-chat UI use the same panel, not a second settings store.
states[8] = 'TestSoul'; states[10] = true; states[11] = true;
states[12] = 'owner.png'; states[13] = true; states[14] = { 'owner.png': 'TestOwner' }; states[15] = false;
tree = render();
assert.equal(find(tree, 'memu_character_enabled').props['aria-checked'], false);
assert.equal(find(tree, 'memu_character_enabled').props.disabled, true);
assert.equal(find(tree, 'memu_soul_persona').props.disabled, true);
assert.equal(find(tree, 'memu_character_enabled-info').props.title, 'memU is off in checkpoints and branches. Return to the main chat to talk with the Soul.');
states[11] = false; states[13] = false; states[12] = ''; states[10] = false;
assert.equal(find(render(), 'memu_character_enabled').props.disabled, true);
states[10] = true;
assert.equal(find(render(), 'memu_character_enabled').props['aria-checked'], true);
assert.equal(find(render(), 'memu_character_enabled').props.disabled, false); // missing binding must not prevent opt-out
states[12] = 'owner.png';
assert.equal(find(render(), 'memu_character_enabled').props.disabled, false);
states[13] = true; states[10] = false;
assert.equal(find(render(), 'memu_soul_persona').props.disabled, true);
assert.equal(find(render(), 'memu-persona-info').props.title, 'For memU, only one persona is allowed.');
assert.equal(find(render(), 'memu_soul_persona').props.name, undefined);
const portal = nodes(render()).find(node => node.type === 'portal');
assert.equal(portal.props.target, cardHost);
const row = portal.props.children;
assert.equal(row.props.style.minWidth, 0);
assert.equal(row.props.children[0].props.id, 'memu_card_panel');
assert.equal(row.props.children[1].props.id, 'memu_soul_persona');
assert.equal(row.props.children[2].props.className, 'fa-solid fa-info-circle');
assert.equal(row.props.children[3].props.children[0].props.children, 'Enable memU:');
assert.equal(find(render(), 'memu_soul_persona').props.style.minWidth, 0);
assert.equal(find(render(), 'memu_card_enabled').props.type, 'button');
assert.equal(find(render(), 'memu_card_enabled').props.role, 'switch');
assert.equal(find(render(), 'memu_card_enabled').props['aria-checked'], find(render(), 'memu_character_enabled').props['aria-checked']);
formMode = 'createcharacter';
assert.equal(nodes(render()).find(node => node.type === 'portal').props.children.props.style.display, 'none');
assert.equal(find(render(), 'memu_card_enabled').props.disabled, true);
find(render(), 'memu_card_enabled').props.onClick(); // must not touch the previously selected Soul
formMode = 'editcharacter'; editor.value = 'other-card.png';
assert.equal(find(render(), 'memu_soul_persona').props.disabled, true);
find(render(), 'memu_soul_persona').props.onChange({ target: { value: 'another-persona' } });
editor.value = 'test.png';
uiCtx.characterId = undefined;
assert.equal(find(render(), 'memu_card_enabled').props.disabled, true);
uiCtx.characterId = 0;
const switchContext = { exports: {}, memuActive: false, copiedChat: false, switchBusy: false, currentCharacter: 'TestSoul',
  personas: { 'owner.png': 'TestOwner' }, persona: 'owner.png', cardMatchesSelection: () => true,
  require: () => jsx, changeMemu: value => { switchContext.memuActive = value; } };
vm.runInNewContext(ts.transpileModule(source.slice(source.indexOf('  function renderMemuSwitch('), source.indexOf('  function openMemuPanel(')), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText, switchContext);
find(switchContext.renderMemuSwitch('card', true), 'card').props.onClick();
assert.equal(find(switchContext.renderMemuSwitch('panel'), 'panel').props['aria-checked'], true);
find(switchContext.renderMemuSwitch('panel'), 'panel').props.onClick();
assert.equal(find(switchContext.renderMemuSwitch('card', true), 'card').props['aria-checked'], false);
let drawerOpen = false, expanded = false, opened = 0, scrolled = 0;
const section = { querySelector: selector => selector === '.inline-drawer-content' ? {} : { click: () => { expanded = true; } },
  scrollIntoView: () => { scrolled++; } };
const opening = { document: { querySelector: selector => selector.endsWith(' > .drawer-content')
  ? { classList: { contains: () => drawerOpen } }
  : selector.endsWith(' > .drawer-toggle') ? { click: () => { drawerOpen = true; opened++; } } : section },
  getComputedStyle: () => ({ display: expanded ? 'flex' : 'none' }) };
vm.runInNewContext(ts.transpileModule(source.slice(source.indexOf('  function openMemuPanel('), source.indexOf('  function handleOverrideSummarizerChange(')), {
  compilerOptions: { module: ts.ModuleKind.CommonJS },
}).outputText, opening);
opening.openMemuPanel(); opening.openMemuPanel();
assert.equal(opened, 1); assert.equal(expanded, true); assert.equal(scrolled, 2);
states[0] = false;
assert(nodes(render()).some(node => node.type === 'style' && node.props.children.includes('.memu-toggle')));

const personaCallbacks = new Map();
let seenPersonas, cleanup;
const personaEffect = {
  useEffect: callback => { cleanup = callback(); }, reloadCharacter: async () => {},
    st: { event_types: { CHAT_CHANGED: 'chat', CHARACTER_EDITED: 'edited-card', CHARACTER_EDITOR_OPENED: 'editor-opened', PERSONA_CREATED: 'created', PERSONA_UPDATED: 'updated', PERSONA_DELETED: 'deleted' },
    eventSource: { on: (event, callback) => personaCallbacks.set(event, callback), removeListener: event => personaCallbacks.delete(event) } },
  power_user: { personas: {} }, setPersonas: value => { seenPersonas = value; },
  window: { addEventListener() {}, removeEventListener() {} },
};
const effectStart = source.indexOf('  useEffect(() => {\n    const reload');
vm.runInNewContext(ts.transpileModule(source.slice(effectStart, source.indexOf('  async function changeMemu(', effectStart)), {
  compilerOptions: { module: ts.ModuleKind.CommonJS },
}).outputText, personaEffect);
assert.equal(typeof personaCallbacks.get('editor-opened'), 'function');
for (const event of ['created', 'updated', 'deleted']) {
  personaEffect.power_user.personas = event === 'deleted' ? {} : { avatar: event };
  personaCallbacks.get(event)();
  assert.deepEqual(JSON.parse(JSON.stringify(seenPersonas)), personaEffect.power_user.personas);
}
cleanup(); assert.equal(personaCallbacks.size, 0);

function loadModule(file, imports, extra = {}) {
  const sandbox = { exports: {}, require: name => {
    assert(name in imports, `Unexpected import ${name}`);
    return imports[name];
  }, ...extra };
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.resolve(__dirname, '../src', file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ESNext },
  }).outputText, sandbox);
  if (file === 'memory/memorize.ts') {
    vm.runInNewContext('exports.query = resolveRetrieveTurnForPrompt;', sandbox);
  }
  return sandbox.exports;
}
(async () => {
  const networkSource = fs.readFileSync(path.resolve(__dirname, '../src/utils/network.ts'), 'utf8');
  const creationSource = networkSource.slice(networkSource.indexOf('export async function createSoul('), networkSource.indexOf('export async function getSoul('));
  const creation = { exports: {}, request: async (route, payload) => ({ route, payload }) };
  vm.runInNewContext(ts.transpileModule(creationSource, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, creation);
  assert.deepEqual(JSON.parse(JSON.stringify(await creation.exports.createSoul('Fable', 'Rowan'))), {
    route: '/souls', payload: { soul_id: 'Fable', use_existing: false, user_name: 'Rowan' },
  });
  const declaration = ts.createSourceFile('creation.ts', creationSource, ts.ScriptTarget.Latest).statements[0];
  assert.equal(declaration.parameters[1].questionToken, undefined);
  let ctx = { chatId: 'main', characters: [{ name: 'TestSoul', avatar: 'test.png', data: { extensions: { memu: { retained: 7 } } } }], characterId: 0, chatMetadata: {}, getCurrentChatId: () => 'main' };
  const extras = {};
  let saves = 0, reads = 0, creates = 0, alerts = 0, owner = null, nativeCreates = 0;
  const names = { TestSoul: 'TestOwner', OtherSoul: 'OtherOwner' };
  let souls = ['TestSoul'];
  let failDiscovery = false, updated, pendingDiscovery;
  const extensionSettings = { memu: { soulCards: {} } };
  let storedSettings = JSON.stringify({ extension_settings: extensionSettings });
  let settingsWrites = 0, settingsReads = 0, saveMode = 'ok', readMode = 'ok', pendingSettings;
  const cardFiles = new Map(), cardUpdates = [], hookAlerts = [];
  let ready;
  const native = { power_user: { personas: { 'owner.png': 'TestOwner' } } };
  ctx.SlashCommandParser = { commands: { 'persona-create': { callback: async (args, value) => {
    nativeCreates++; assert.equal(args.select, 'false'); assert.equal(value, '');
    native.power_user.personas['created.png'] = args.name;
    return 'created.png';
  } } } };
  const st = { getContext: () => ctx, event_types: { APP_READY: 'ready' }, eventSource: { once: (_, cb) => { ready = cb; } }, saveChat: async () => { saves++; } };
  const network = {
    captureRuntimeSettings: () => ({ version: 4, useServerSettings: true }),
    getPluginPing: async () => ({ ok: true }),
    scopeStorageProbe: async () => ({ ok: true }),
    getSouls: async () => { reads++; if (failDiscovery) throw Error('discovery refused'); if (pendingDiscovery) return pendingDiscovery; return { souls: [...souls] }; },
    getSoul: async id => { reads++; if (!names[id]) throw Error('missing binding'); return { soul_id: id, user_name: names[id], narrative_self: '' }; },
    getOwner: async () => ({ user_id: owner }),
    createOwner: async id => { owner = id; return { user_id: id }; },
    createSoul: async (id, name) => { assert(owner); creates++; names[id] = name; souls.push(id); return { soul_id: id, created: true }; },
  };
  const utils = loadModule('memory/utils.ts', {
    'utils/context-extra': { st, memuExtras: extras }, 'utils/network': network,
    '@silly-tavern/scripts/power-user.js': native,
    '@silly-tavern/scripts/openai.js': {}, '@silly-tavern/scripts/textgen-settings.js': {},
    '@silly-tavern/script.js': { saveSettings: async () => {
      settingsWrites++;
      if (pendingSettings) await pendingSettings;
      if (saveMode === 'throw') throw Error('settings write refused');
      if (saveMode !== 'swallow') storedSettings = JSON.stringify({ extension_settings: extensionSettings });
    } },
    'utils/csrf': { postJsonWithCsrf: async (url, body) => {
      assert.equal(url, '/api/settings/get'); assert.equal(Object.keys(body).length, 0);
      settingsReads++;
      if (readMode === 'throw') throw Error('settings read refused');
      const stored = JSON.parse(storedSettings);
      if (readMode === 'mismatch') stored.extension_settings.memu.soulCards[ctx.characters[ctx.characterId].name] = 'wrong-card.png';
      return { settings: JSON.stringify(stored) };
    } },
    '@silly-tavern/scripts/extensions.js': { extension_settings: extensionSettings, writeExtensionFieldBulk: async (avatars, key, fields) => {
      assert.equal(avatars.length, 1); assert.equal(key, 'memu'); assert.equal(fields.retained, 7);
      cardUpdates.push({ avatar: avatars[0], fields: JSON.parse(JSON.stringify(fields)) });
      const result = updated ?? avatars;
      if (result.includes(avatars[0])) {
        const card = ctx.characters.find(candidate => candidate.avatar === avatars[0]) ?? cardFiles.get(avatars[0]);
        assert(card, `Missing disposable card ${avatars[0]}`);
        card.data.extensions.memu = fields;
      }
      return { updated: result };
    } },
  }, { window: { alert: message => hookAlerts.push(message) } });
  const log = { onceError() {}, onceWarn() {}, info() {} };
  let retrieveCalls = 0;
  const memory = { resetRetrievePipelineState() {}, getChatIdSafe: () => 'integrity:shared', preparePendingRetrieveTurnForInterceptor: async () => { retrieveCalls++; return true; }, dispatchConversationTurn: async () => ({ reply: '' }), dropPendingTurnIfStopped: () => false };
  const hooks = loadModule('memory/exports.ts', {
    'utils/context-extra': { st, memuExtras: extras, OVERRIDE_SUMMARIZER: { get: () => true } },
    './memorize': memory, './utils': utils, './summary-poller': { setIsTerminated() {}, startSummaryPolling() {}, stopSummaryPolling() {} },
    'utils/network': network, 'utils/log': log, 'ui/inspect-panel': { getInspectData: () => null, stashInspectData() {} },
  }, { window: { alert: () => { alerts++; }, dispatchEvent() {} }, Event: class {} });
  // Use the real native dispatcher: it catches interceptor exceptions.
  const nativeSource = fs.readFileSync(path.resolve(__dirname, '../../../../../public/scripts/extensions.js'), 'utf8');
  const dispatcher = nativeSource.slice(nativeSource.indexOf('export async function runGenerationInterceptors('), nativeSource.indexOf('\n/**', nativeSource.indexOf('export async function runGenerationInterceptors(')));
  const dispatch = { manifests: { memu: { generate_interceptor: 'memu' } }, sortManifestsByOrder: () => 0, globalThis: { memu: hooks.memuGenerationInterceptor }, console: { error() {} } };
  vm.runInNewContext(ts.transpileModule(dispatcher, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, { exports: dispatch, ...dispatch });
  assert.equal(await utils.isMemuActive(), true);
  assert.equal(await utils.isMemuActive(), true); assert.equal(reads, 1);
  assert.equal(extensionSettings.memu.soulCards.TestSoul, 'test.png');
  assert.equal(settingsWrites, 1); assert.equal(settingsReads, 1);
  assert.equal(cardUpdates.length, 0); // a default-on query claims ownership, not activation
  ctx.characters[0].data.extensions.memu.disabled = true;
  assert.equal(await utils.isMemuActive(), false);
  assert.equal(await dispatch.runGenerationInterceptors([], 0, 'continue'), false);
  ctx.characters[0].data.extensions.memu.disabled = false;
  assert.equal(await utils.isMemuActive(), true);
  ctx.chatMetadata = { main_chat: 'main', integrity: 'shared', memuExtras: { summary: { summaryTaskId: 'inherited' } } };
  reads = 0;
  assert.equal(await utils.isMemuActive(), false);
  await utils.initChatExtraInfo(ctx);
  await hooks.onMessageDeleted(); await hooks.onMessageSwiped(0);
  assert.equal(await dispatch.runGenerationInterceptors([], 0, 'normal'), false);
  assert.equal(await dispatch.runGenerationInterceptors([], 0, 'continue'), false);
  assert.equal(reads, 0); assert.equal(creates, 0); assert.equal(saves, 0); assert.equal(retrieveCalls, 0);
  ctx.chatMetadata = {};
  delete ctx.characters[0].data.extensions.memu.disabled;
  utils.refreshMemuGate(); failDiscovery = true;
  assert.equal(await dispatch.runGenerationInterceptors([], 0, 'normal'), true);
  assert.equal(alerts, 1);
  failDiscovery = false;
  assert.equal(await utils.isMemuActive(), true); // failed discovery was not cached as off
  const beforeOff = reads;
  ctx.characters[0].data.extensions.memu.disabled = true; utils.refreshMemuGate();
  assert.equal(await dispatch.runGenerationInterceptors([], 0, 'normal'), false);
  assert.equal(reads, beforeOff);
  delete ctx.characters[0].data.extensions.memu.disabled;
  let resolveDiscovery;
  pendingDiscovery = new Promise(resolve => { resolveDiscovery = resolve; });
  utils.refreshMemuGate();
  const oldGeneration = dispatch.runGenerationInterceptors([], 0, 'normal');
  await new Promise(resolve => setImmediate(resolve));
  ctx.getCurrentChatId = () => 'copy'; ctx.chatMetadata = { main_chat: 'main', integrity: 'shared' };
  resolveDiscovery({ souls });
  assert.equal(await oldGeneration, true); // stale false is not consent to native generation
  assert.equal(retrieveCalls, 0);
  pendingDiscovery = null; ctx.getCurrentChatId = () => 'main'; ctx.chatMetadata = {};
  utils.refreshMemuGate();
  updated = [];
  await assert.rejects(utils.writeMemuDisabled(ctx.characters[0], true), /Failed to save/);
  assert.equal(ctx.characters[0].data.extensions.memu.disabled, undefined);
  updated = ['test.png'];
  await utils.writeMemuDisabled(ctx.characters[0], true);
  assert.equal(ctx.characters[0].data.extensions.memu.disabled, true);
  let personaFinished = false;
  const pendingPersona = utils.ensurePersona('OtherOwner').then(value => { personaFinished = true; return value; });
  await Promise.resolve(); assert.equal(personaFinished, false); assert.equal(nativeCreates, 0);
  ready(); assert.equal(await pendingPersona, 'created.png'); assert.equal(nativeCreates, 1);
  assert.equal(await utils.ensurePersona('TestOwner'), 'owner.png'); assert.equal(nativeCreates, 1);
  ctx.characters.push({ name: 'testsoul', avatar: 'lower.png', data: { extensions: { memu: { retained: 7 } } } });
  ctx.characterId = 1; souls = []; utils.refreshMemuGate();
  let selectedPersona;
  const selection = {
    st, personaLocked: false, personas: { picked: 'TestSoul' }, currentScope: utils.currentScope,
    assertDistinctNames: utils.assertDistinctNames, getOwner: network.getOwner, createOwner: network.createOwner,
    setPersona: value => { selectedPersona = value; }, setSwitchBusy() {}, setSwitchError(value) { this.error = value; },
  };
  selection.setSwitchError = selection.setSwitchError.bind(selection);
  vm.runInNewContext(ts.transpileModule(source.slice(source.indexOf('  function selectPersona('), source.indexOf('  const [memorizeNowBusy')), {
    compilerOptions: { module: ts.ModuleKind.CommonJS },
  }).outputText, selection);
  await selection.selectPersona('picked');
  assert.equal(selectedPersona, 'picked'); assert.equal(owner, null);
  await selection.selectPersona('another');
  assert.equal(selectedPersona, 'another'); assert.equal(owner, null);
  await assert.rejects(utils.initChatExtraInfo(ctx, 'TestSoul'), /must differ/);
  assert.equal(owner, null); assert.equal(creates, 0);
  ctx.characterId = 0; souls = ['TestSoul']; utils.refreshMemuGate();
  ctx.characters[0].data.extensions.memu.disabled = false;
  await utils.initChatExtraInfo(ctx, 'IgnoredName');
  assert.equal(extras.baseInfo.userName, 'TestOwner'); assert.equal(owner, 'TestOwner');
  ctx.characters.push({ name: 'NewSoul', avatar: 'new.png', data: { extensions: { memu: { retained: 7 } } } });
  ctx.characterId = 2; utils.refreshMemuGate();
  await utils.initChatExtraInfo(ctx, 'OtherOwner');
  assert.equal(creates, 1); assert.equal(owner, 'TestOwner'); assert.equal(extras.baseInfo.userName, 'OtherOwner');
  ctx.characters.push({ name: 'OtherSoul', avatar: 'other.png', data: { extensions: { memu: { retained: 7 } } } });
  ctx.characterId = 3; souls.push('OtherSoul'); utils.refreshMemuGate();
  await utils.initChatExtraInfo(ctx);
  assert.equal(extras.baseInfo.userName, 'OtherOwner');
  names.OtherSoul = ''; await assert.rejects(utils.initChatExtraInfo(ctx), /missing binding/);

  ctx.characters.push({ name: 'FailedToggleSoul', avatar: 'failed.png', data: { extensions: { memu: { retained: 7 } } } });
  ctx.characterId = 4; utils.refreshMemuGate();
  let cardWrites = 0, switchError;
  const change = {
    st, switchBusy: false, persona: 'created.png', personaLocked: false,
    power_user: native.power_user, currentScope: utils.currentScope, canUseSoulCard: utils.canUseSoulCard,
    initChatExtraInfo: utils.initChatExtraInfo,
    async writeMemuDisabled(character, disabled) {
      updated = ++cardWrites === 2 ? [] : [character.avatar];
      await utils.writeMemuDisabled(character, disabled);
    },
    setSwitchBusy() {}, setSwitchError: value => { switchError = value; },
    onChatChanged() {}, reloadCharacter: async () => {},
  };
  vm.runInNewContext(ts.transpileModule(source.slice(source.indexOf('  async function changeMemu('), source.indexOf('  function selectPersona(')), {
    compilerOptions: { module: ts.ModuleKind.CommonJS },
  }).outputText, change);
  await change.changeMemu(true);
  assert.match(switchError, /Failed to save/);
  assert.equal(names.FailedToggleSoul, 'OtherOwner');
  assert.equal(ctx.characters[4].data.extensions.memu.disabled, true);
  assert.equal(await utils.isMemuActive(), false);
  const previousCreates = creates, previousWrites = cardWrites;
  change.persona = 'deleted-persona';
  await change.changeMemu(true);
  assert.equal(creates, previousCreates); assert.equal(cardWrites, previousWrites);
  updated = undefined; ctx.characterId = 3;
  await utils.writeMemuDisabled(ctx.characters[3], false);
  names.OtherSoul = 'OtherOwner'; utils.refreshMemuGate();

  let resolveOldReply, replyWrites = 0;
  ctx.saveReply = async () => { replyWrites++; };
  memory.dispatchConversationTurn = () => new Promise(resolve => { resolveOldReply = resolve; });
  const oldTurn = dispatch.runGenerationInterceptors([], 0, 'normal');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(typeof resolveOldReply, 'function');
  ctx.getCurrentChatId = () => 'copy'; ctx.chatMetadata = { main_chat: 'main' };
  hooks.onChatChanged();
  ctx.getCurrentChatId = () => 'main'; ctx.chatMetadata = {};
  hooks.onChatChanged();
  resolveOldReply({ reply: 'Obsolete response' });
  assert.equal(await oldTurn, true);
  assert.equal(replyWrites, 0);
  await new Promise(resolve => setImmediate(resolve));
  memory.dispatchConversationTurn = async () => ({ reply: '' }); retrieveCalls = 0;

  const producer = loadModule('memory/memorize.ts', {
    'memu-js': {}, 'utils/context-extra': { st, memuExtras: extras, MENTAL_HEALTH_ADDON: { get: () => true } }, 'utils/network': network,
    'utils/types': {}, 'utils/csrf': {}, '@silly-tavern/scripts/world-info.js': {}, './utils': utils, 'utils/log': log, 'ui/inspect-panel': {},
  }, { window: { setTimeout: () => 1, clearTimeout() {} }, AbortController });
  assert.equal(producer.messageRole({ is_user: true, name: 'OtherOwner' }, 'OtherOwner'), 'user');
  assert.equal(producer.messageRole({ is_user: true, name: 'Renamed' }, 'OtherOwner'), 'unknown');
  assert.equal(producer.messageRole({ is_user: true, name: 'TestOwner' }, 'OtherOwner'), 'unknown');
  names.OtherSoul = 'OtherOwner';
  ctx.name1 = 'UnrelatedActivePersona';
  ctx.chat = [{ is_user: true, name: 'OtherOwner', mes: 'Owner row' }, { is_user: true, name: 'Renamed', mes: 'Latest human row' },
    { is_user: true, name: 'Renamed', mes: 'Hidden latest row', is_system: true }];
  const query = await producer.query();
  assert.equal(query.userName, 'Renamed'); assert.equal(query.queryText, 'Latest human row');
  assert.equal(query.history[0].role, 'user');
  assert.equal(await dispatch.runGenerationInterceptors([], 0, 'continue'), true);
  assert.equal(retrieveCalls, 0);
  let resolveRetrieve, signal;
  network.conversationRetrieve = (body, options) => {
    assert.equal(body.mentalHealthAddon, true);
    signal = options.signal;
    return new Promise(resolve => { resolveRetrieve = resolve; });
  };
  const retrieving = producer.addPendingRetrieveToPrompt({});
  await new Promise(resolve => setImmediate(resolve));
  producer.resetRetrievePipelineState();
  assert.equal(signal.aborted, false); // switch/reset abandons local work, not the running request
  resolveRetrieve({}); await retrieving;
  let resolvePoll;
  extras.summary = { summaryTaskId: 'parent-task', summaryTaskStatus: 'PROCESSING', summaryRange: [0, 2] };
  let firstPoll;
  const poller = loadModule('memory/summary-poller.ts', {
    'utils/consts': { MEMU_DEFAULT_TIMEOUT: 3000 }, 'utils/context-extra': { st, memuExtras: extras },
    'utils/network': { getTaskStatus: () => new Promise(resolve => { resolvePoll = resolve; }) },
    'utils/types': { MemuTaskStatus: { PROCESSING: 'PROCESSING', PENDING: 'PENDING', SUCCESS: 'SUCCESS' } },
    './memorize': memory, './utils': utils, 'utils/log': log,
  }, { setTimeout: callback => { firstPoll = callback; return 1; }, clearTimeout() {} });
  names.OtherSoul = 'OtherOwner'; saves = 0;
  poller.startSummaryPolling(); firstPoll(); await new Promise(resolve => setImmediate(resolve));
  const inherited = { ...extras.summary };
  ctx.getCurrentChatId = () => 'copy'; ctx.chatMetadata = { main_chat: 'main', integrity: 'shared' }; extras.summary = inherited;
  resolvePoll({ status: 'SUCCESS' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(extras.summary, inherited); assert.equal(saves, 0);
  for (const entry of ['memorizeNow', 'syncLorebooksNow', 'deleteMemuLorebooksForCurrentCharacter', 'retrieveMemories', 'doSummary', 'addPendingRetrieveToPrompt']) await producer[entry]();
  assert.equal(saves, 0);

  // Ordinary cards must not reserve nonexistent Souls, even after the original is deleted.
  ctx.chatMetadata = {}; ctx.getCurrentChatId = () => 'main';
  const ordinary = { name: 'OrdinaryCard', avatar: 'ordinary.png', data: { extensions: { memu: { retained: 7 } } } };
  ctx.characterId = ctx.characters.push(ordinary) - 1;
  const beforeOrdinary = [settingsWrites, settingsReads, cardUpdates.length];
  await utils.onCharacterDuplicated({ oldAvatar: ordinary.avatar });
  assert.deepEqual([settingsWrites, settingsReads, cardUpdates.length], beforeOrdinary);
  assert.equal(Object.hasOwn(extensionSettings.memu.soulCards, ordinary.name), false);
  const ordinaryCopy = JSON.parse(JSON.stringify(ordinary)); ordinaryCopy.avatar = 'ordinary-copy.png';
  ctx.characters = ctx.characters.filter(card => card !== ordinary);
  ctx.characterId = ctx.characters.push(ordinaryCopy) - 1;
  await utils.initChatExtraInfo(ctx, 'TestOwner');
  await utils.writeMemuDisabled(ordinaryCopy, false);
  assert.equal(extensionSettings.memu.soulCards[ordinary.name], ordinaryCopy.avatar);

  const plain = { name: 'PlainRename', avatar: 'plain.png', data: { extensions: { memu: { retained: 7 } } } };
  ctx.characterId = ctx.characters.push(plain) - 1;
  const plainRenamed = JSON.parse(JSON.stringify(plain)); plainRenamed.name = 'PlainRenamed'; plainRenamed.avatar = 'plain-renamed.png';
  cardFiles.set(plainRenamed.avatar, plainRenamed);
  const beforePlain = [settingsWrites, settingsReads, creates];
  await utils.onCharacterRenamed(plain.avatar, plainRenamed.avatar);
  assert.deepEqual([settingsWrites, settingsReads, creates], beforePlain);
  assert.equal(Object.hasOwn(extensionSettings.memu.soulCards, plain.name), false);
  assert.equal(Object.hasOwn(extensionSettings.memu.soulCards, plainRenamed.name), false);
  assert.equal(plainRenamed.data.extensions.memu.disabled, true);

  const external = { name: 'ExternalSoul', avatar: 'external.png', data: { extensions: { memu: { retained: 7 } } } };
  ctx.characterId = ctx.characters.push(external) - 1; utils.refreshMemuGate();
  assert.equal(await utils.isMemuActive(), false); // cache predates creation elsewhere
  names[external.name] = 'TestOwner'; souls.push(external.name);
  await utils.onCharacterDuplicated({ oldAvatar: external.avatar });
  assert.equal(extensionSettings.memu.soulCards[external.name], external.avatar);
  const beforeLinked = [reads, settingsWrites, settingsReads];
  failDiscovery = true;
  await utils.onCharacterDuplicated({ oldAvatar: external.avatar });
  assert.deepEqual([reads, settingsWrites, settingsReads], beforeLinked);
  failDiscovery = false;
  const beforeExternalSetupCreates = creates;
  await utils.initChatExtraInfo(ctx, 'TestOwner');
  assert.equal(creates, beforeExternalSetupCreates);
  assert.equal(extras.baseInfo.characterName, 'ExternalSoul');

  // Native Duplicate identifies its subject before reloading the card list.
  ctx.chatMetadata = {}; ctx.getCurrentChatId = () => 'main';
  change.persona = 'created.png';
  const original = { name: 'EventSoul', avatar: 'event.png', data: { extensions: { memu: { retained: 7 } } } };
  names.EventSoul = 'TestOwner'; souls.push('EventSoul');
  ctx.characterId = ctx.characters.push(original) - 1;
  const originalText = JSON.stringify(original);
  pendingDiscovery = new Promise(resolve => { resolveDiscovery = resolve; });
  utils.refreshMemuGate();
  const firstGate = utils.isMemuActive();
  await new Promise(resolve => setImmediate(resolve));
  ctx.characterId = ctx.characters.findIndex(card => card.avatar === 'other.png');
  const duplicating = utils.onCharacterDuplicated({ oldAvatar: 'event.png' });
  await new Promise(resolve => setImmediate(resolve));
  const copy = JSON.parse(originalText); copy.avatar = 'event-copy.png';
  ctx.characterId = ctx.characters.push(copy) - 1;
  resolveDiscovery({ souls }); assert.equal(await firstGate, false);
  await duplicating;
  assert.equal(extensionSettings.memu.soulCards.EventSoul, 'event.png');
  pendingDiscovery = null;
  for (const fields of [{ retained: 7 }, { retained: 7, disabled: false, enabled_for: 'EventSoul' }]) {
    copy.data.extensions.memu = fields;
    utils.refreshMemuGate();
    const before = [creates, nativeCreates, owner, saves, cardUpdates.length, settingsWrites, settingsReads];
    assert.equal(utils.canUseSoulCard(copy, true), false);
    assert.equal(await utils.isMemuActive(), false);
    assert.equal(await utils.soulPersonaName('EventSoul'), null);
    await assert.rejects(utils.initChatExtraInfo(ctx, 'TestOwner'), /belongs to another/);
    await assert.rejects(utils.writeMemuDisabled(copy, false), /belongs to another/);
    await change.changeMemu(true);
    assert.match(switchError, /first ST card/);
    assert.deepEqual([creates, nativeCreates, owner, saves, cardUpdates.length, settingsWrites, settingsReads], before);
    assert.equal(await dispatch.runGenerationInterceptors([], 0, 'normal'), false);
  }
  assert.equal(JSON.stringify(original), originalText);
  ctx.characters = ctx.characters.filter(card => card !== original);
  ctx.characterId = ctx.characters.indexOf(copy);
  assert.equal(await utils.isMemuActive(), false);
  assert.equal(utils.canUseSoulCard(copy, true), false);
  assert.equal(extensionSettings.memu.soulCards.EventSoul, 'event.png'); // deletion never promotes a copy

  const awaitingOriginal = { name: 'AwaitingOriginalSoul', avatar: 'awaiting-original.png', data: { extensions: { memu: { retained: 7 } } } };
  names.AwaitingOriginalSoul = 'TestOwner'; souls.push('AwaitingOriginalSoul');
  ctx.characterId = ctx.characters.push(awaitingOriginal) - 1; utils.refreshMemuGate();
  pendingDiscovery = new Promise(resolve => { resolveDiscovery = resolve; });
  const awaitingOriginalGate = utils.isMemuActive();
  await new Promise(resolve => setImmediate(resolve));
  const arrivingCopy = JSON.parse(JSON.stringify(awaitingOriginal)); arrivingCopy.avatar = 'awaiting-copy.png';
  ctx.characters.push(arrivingCopy); // the original remains selected; no native Duplicate event supplies proof
  resolveDiscovery({ souls });
  assert.equal(await awaitingOriginalGate, true);
  pendingDiscovery = null;
  assert.equal(extensionSettings.memu.soulCards.AwaitingOriginalSoul, awaitingOriginal.avatar);
  assert.equal(await utils.isMemuActive(), true);
  ctx.characterId = ctx.characters.indexOf(arrivingCopy);
  assert.equal(await utils.isMemuActive(), false);
  await assert.rejects(utils.initChatExtraInfo(ctx, 'TestOwner'), /belongs to another/);

  const ambiguous = { name: 'AmbiguousSoul', avatar: 'ambiguous.png', data: { extensions: { memu: { retained: 7 } } } };
  names.AmbiguousSoul = 'TestOwner'; souls.push('AmbiguousSoul');
  ctx.characters.push(ambiguous, { ...ambiguous, avatar: 'ambiguous-copy.png' });
  ctx.characterId = ctx.characters.length - 1; utils.refreshMemuGate();
  const beforeAmbiguous = settingsWrites;
  assert.equal(await utils.isMemuActive(), false);
  await utils.onCharacterDuplicated({ oldAvatar: ambiguous.avatar });
  await assert.rejects(utils.initChatExtraInfo(ctx, 'TestOwner'), /belongs to another/);
  assert.equal(Object.hasOwn(extensionSettings.memu.soulCards, 'AmbiguousSoul'), false);
  assert.equal(settingsWrites, beforeAmbiguous);

  const renamedSource = { name: 'BeforeDuplicateRename', avatar: 'rename-duplicate.png', data: { extensions: { memu: { retained: 7 } } } };
  names[renamedSource.name] = 'TestOwner'; souls.push(renamedSource.name);
  ctx.characterId = ctx.characters.push(renamedSource) - 1; utils.refreshMemuGate();
  assert.equal(await utils.isMemuActive(), true);
  await utils.writeMemuDisabled(renamedSource, false);
  await utils.writeMemuDisabled(renamedSource, true);
  renamedSource.name = 'AfterDuplicateRename';
  await utils.onCharacterDuplicated({ oldAvatar: renamedSource.avatar });
  assert.equal(Object.hasOwn(extensionSettings.memu.soulCards, renamedSource.name), false);
  assert.equal(extensionSettings.memu.soulCards.BeforeDuplicateRename, renamedSource.avatar);
  names[renamedSource.name] = 'TestOwner'; souls.push(renamedSource.name);
  const beforeDuplicateFields = JSON.stringify(renamedSource.data.extensions.memu);
  assert.equal(await utils.isMemuActive(), false);
  await utils.onCharacterDuplicated({ oldAvatar: renamedSource.avatar });
  assert.equal(extensionSettings.memu.soulCards.AfterDuplicateRename, renamedSource.avatar);
  assert.equal(extensionSettings.memu.soulCards.BeforeDuplicateRename, renamedSource.avatar);
  assert.equal(JSON.stringify(renamedSource.data.extensions.memu), beforeDuplicateFields);
  assert.equal(await utils.isMemuActive(), false);
  const renamedCopy = JSON.parse(JSON.stringify(renamedSource)); renamedCopy.avatar = 'rename-duplicate-copy.png';
  ctx.characterId = ctx.characters.push(renamedCopy) - 1;
  await assert.rejects(utils.initChatExtraInfo(ctx, 'TestOwner'), /belongs to another/);
  const beforeCopyDuplicate = settingsWrites;
  await utils.onCharacterDuplicated({ oldAvatar: renamedCopy.avatar });
  assert.equal(settingsWrites, beforeCopyDuplicate);
  assert.equal(extensionSettings.memu.soulCards.AfterDuplicateRename, renamedSource.avatar);
  ctx.characterId = ctx.characters.indexOf(renamedSource);
  await utils.initChatExtraInfo(ctx, 'TestOwner');
  await utils.writeMemuDisabled(renamedSource, false);
  assert.equal(renamedSource.data.extensions.memu.enabled_for, 'AfterDuplicateRename');
  assert.equal(await utils.isMemuActive(), true);
  assert.equal(extensionSettings.memu.soulCards.BeforeDuplicateRename, renamedSource.avatar);
  ctx.characterId = ctx.characters.indexOf(renamedCopy);
  assert.equal(await utils.isMemuActive(), false);

  // Rename writes to the new disk avatar while ST still exposes the old list.
  for (const newName of ['FreshRenamedSoul', 'OtherSoul']) {
    const old = { name: `Before${newName}`, avatar: `before-${newName}.png`, data: { extensions: { memu: { retained: 7 } } } };
    names[old.name] = 'TestOwner'; souls.push(old.name);
    ctx.characterId = ctx.characters.push(old) - 1; utils.refreshMemuGate();
    if (newName === 'OtherSoul') assert.equal(await utils.isMemuActive(), true);
    const renamed = JSON.parse(JSON.stringify(old)); renamed.name = newName; renamed.avatar = `renamed-${newName}.png`;
    cardFiles.set(renamed.avatar, renamed);
    const oldSoulCount = creates;
    await utils.onCharacterRenamed(old.avatar, renamed.avatar);
    assert.equal(renamed.data.extensions.memu.disabled, true);
    assert.equal(extensionSettings.memu.soulCards[old.name], old.avatar);
    ctx.characters[ctx.characterId] = renamed; utils.refreshMemuGate();
    assert.equal(await utils.isMemuActive(), false);
    assert.equal(creates, oldSoulCount);
    if (newName === 'OtherSoul') {
      await assert.rejects(utils.initChatExtraInfo(ctx, 'TestOwner'), /belongs to another/);
    } else {
      await utils.initChatExtraInfo(ctx, 'TestOwner');
      await utils.writeMemuDisabled(renamed, false);
      assert.equal(renamed.data.extensions.memu.enabled_for, newName);
      assert.equal(extensionSettings.memu.soulCards[newName], renamed.avatar);
      assert.equal(extensionSettings.memu.soulCards[old.name], old.avatar);
      assert.equal(names[old.name], 'TestOwner');
      assert.equal(await utils.isMemuActive(), true);
      const previousScope = utils.currentScope();
      renamed.name = 'OtherSoul';
      assert.notEqual(utils.currentScope(), previousScope);
      assert.equal(await utils.isMemuActive(), false);
      renamed.name = 'InPlaceFreshSoul';
      assert.equal(await utils.isMemuActive(), false);
    }
  }

  // Hook failures are visible, and failed claims still roll back; Rename still disables its disk card.
  for (const hook of ['duplicate', 'rename']) {
    for (const mode of ['swallow', 'throw', 'read-failure', 'mismatch', 'discovery']) {
      const name = `Hook-${hook}-${mode}`;
      const card = { name, avatar: `${name}.png`, data: { extensions: { memu: { retained: 7 } } } };
      ctx.characterId = ctx.characters.push(card) - 1;
      names[name] = 'TestOwner'; souls.push(name);
      const renamed = JSON.parse(JSON.stringify(card)); renamed.avatar = `${name}-renamed.png`;
      cardFiles.set(renamed.avatar, renamed);
      saveMode = mode === 'swallow' || mode === 'throw' ? mode : 'ok';
      readMode = mode === 'read-failure' ? 'throw' : mode === 'mismatch' ? 'mismatch' : 'ok';
      failDiscovery = mode === 'discovery';
      const beforeAlerts = hookAlerts.length;
      await assert.rejects(hook === 'duplicate'
        ? utils.onCharacterDuplicated({ oldAvatar: card.avatar })
        : utils.onCharacterRenamed(card.avatar, renamed.avatar), /refused|Failed to save/);
      assert.equal(hookAlerts.length, beforeAlerts + 1);
      assert.match(hookAlerts.at(-1), /refused|Failed to save/);
      assert.equal(Object.hasOwn(extensionSettings.memu.soulCards, name), false);
      if (hook === 'rename') assert.equal(renamed.data.extensions.memu.disabled, true);
      saveMode = readMode = 'ok'; failDiscovery = false;
    }
  }
  const emitter = { exports: {}, localStorage: { getItem: () => null }, console: { debug() {}, error() {}, trace() {} } };
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.resolve(__dirname, '../../../../../public/lib/eventemitter.js'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS },
  }).outputText, emitter);
  const events = new emitter.exports.EventEmitter();
  events.on('rename', utils.onCharacterRenamed);
  const failedRename = ctx.characters[ctx.characterId];
  updated = [];
  const beforeRenameAlerts = hookAlerts.length;
  await events.emit('rename', failedRename.avatar, `${failedRename.name}-renamed.png`);
  assert.equal(hookAlerts.length, beforeRenameAlerts + 1);
  assert.match(hookAlerts.at(-1), /Failed to save the character memU setting/);
  assert.equal(extensionSettings.memu.soulCards[failedRename.name], failedRename.avatar);
  updated = undefined;

  // A claim is usable only after stock-save readback confirms this exact field.
  for (const mode of ['swallow', 'throw', 'read-failure', 'mismatch']) {
    const name = `Failure-${mode}`;
    ctx.characterId = ctx.characters.push({ name, avatar: `${name}.png`, data: { extensions: { memu: { retained: 7 } } } }) - 1;
    names[name] = 'TestOwner'; souls.push(name); utils.refreshMemuGate();
    saveMode = mode === 'read-failure' || mode === 'mismatch' ? 'ok' : mode;
    readMode = mode === 'read-failure' ? 'throw' : mode === 'mismatch' ? 'mismatch' : 'ok';
    const before = [creates, nativeCreates, owner, saves, cardUpdates.length];
    await assert.rejects(utils.isMemuActive(), /refused|Failed to save/);
    assert.equal(Object.hasOwn(extensionSettings.memu.soulCards, name), false);
    assert.deepEqual([creates, nativeCreates, owner, saves, cardUpdates.length], before);
    saveMode = readMode = 'ok';
    assert.equal(await utils.isMemuActive(), true);
    assert.equal(JSON.parse(storedSettings).extension_settings.memu.soulCards[name], `${name}.png`);
  }
  ctx.characterId = ctx.characters.push({ name: 'ConcurrentSoul', avatar: 'concurrent.png', data: { extensions: { memu: { retained: 7 } } } }) - 1;
  names.ConcurrentSoul = 'TestOwner'; souls.push('ConcurrentSoul'); utils.refreshMemuGate();
  let releaseSettings;
  pendingSettings = new Promise(resolve => { releaseSettings = resolve; });
  const beforeConcurrent = [settingsWrites, settingsReads, creates, nativeCreates, saves, cardUpdates.length];
  let completedClaims = 0;
  const concurrentClaims = [utils.isMemuActive(), utils.isMemuActive()].map(promise => promise.then(value => { completedClaims++; return value; }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(completedClaims, 0);
  assert.equal(settingsWrites, beforeConcurrent[0] + 1);
  ctx.characters[ctx.characterId].data.extensions.memu.disabled = true;
  releaseSettings(); assert.deepEqual(await Promise.all(concurrentClaims), [false, false]);
  pendingSettings = null;
  assert.deepEqual([settingsWrites, settingsReads, creates, nativeCreates, saves, cardUpdates.length],
    [beforeConcurrent[0] + 1, beforeConcurrent[1] + 1, ...beforeConcurrent.slice(2)]);
  delete ctx.characters[ctx.characterId].data.extensions.memu.disabled;
  assert.equal(await utils.isMemuActive(), true);

  for (const name of ['__proto__', 'constructor', 'toString']) {
    ctx.characterId = ctx.characters.push({ name, avatar: `${name}.png`, data: { extensions: { memu: { retained: 7 } } } }) - 1;
    Object.defineProperty(names, name, { value: 'TestOwner', configurable: true });
    souls.push(name); utils.refreshMemuGate();
    assert.equal(await utils.isMemuActive(), true);
    assert.equal(Object.hasOwn(extensionSettings.memu.soulCards, name), true);
    assert.equal(extensionSettings.memu.soulCards[name], `${name}.png`);
    assert.equal(Object.hasOwn(JSON.parse(storedSettings).extension_settings.memu.soulCards, name), true);
  }

  const pendingCard = { name: 'PendingNameSoul', avatar: 'pending-name.png', data: { extensions: { memu: { retained: 7 } } } };
  ctx.characterId = ctx.characters.push(pendingCard) - 1;
  names.PendingNameSoul = 'TestOwner'; souls.push('PendingNameSoul'); utils.refreshMemuGate();
  pendingDiscovery = new Promise(resolve => { resolveDiscovery = resolve; });
  const pendingScope = utils.currentScope(), beforeNameEdit = settingsWrites;
  const pendingGate = utils.isMemuActive();
  await new Promise(resolve => setImmediate(resolve));
  pendingCard.name = 'EditedWhileDiscovering';
  assert.notEqual(utils.currentScope(), pendingScope);
  resolveDiscovery({ souls }); assert.equal(await pendingGate, false);
  pendingDiscovery = null;
  assert.equal(settingsWrites, beforeNameEdit);
  assert.equal(Object.hasOwn(extensionSettings.memu.soulCards, 'PendingNameSoul'), false);
  assert.equal(Object.hasOwn(extensionSettings.memu.soulCards, pendingCard.name), false);
  console.log('Character gate, canonical cards, native rename/duplicate, confirmed claims, persona binding, producer roles and branch polling pass.');
})().catch(error => { console.error(error); process.exitCode = 1; });

// Execute the real panel handlers without a live ST session.
function loadFunctions(text, names, env) {
  const file = ts.createSourceFile('checks.tsx', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const functions = [];
  function visit(node) {
    if (ts.isFunctionDeclaration(node) && names.includes(node.name?.text)) functions.push(node.getText(file));
    ts.forEachChild(node, visit);
  }
  visit(file);
  vm.runInNewContext(ts.transpileModule(functions.join('\n'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, env);
}
const flushPanel = () => new Promise(resolve => setImmediate(resolve));
const panelCheckTimeout = setTimeout(() => { console.error('Panel checks did not finish'); process.exitCode = 1; }, 10000);
(async () => {
  function panel() {
    const live = { scope: 'card-a/main', name: 'TestSoul' }, writes = [], updates = [];
    const env = {
      live, writes, updates, exports: {}, switchBusy: false, pluginOk: true, memuActive: true,
      currentCharacter: 'TestSoul', currentUserId: 'TestOwner',
      currentScope: () => live.scope, currentSelectedCharacterName: () => live.name,
      memuExtras: { baseInfo: { characterName: 'TestSoul', userId: 'TestOwner' } },
      relationshipEditor: { scope: live.scope, mode: 'add', name: 'Fictional Peer', relationship: 'friend' },
      isMemuActive: async () => true, window: { confirm: () => true },
      listRelationships: async () => ({ relationships: [] }),
      createRelationship: async (...args) => writes.push(['add', ...args]),
      updateRelationship: async (...args) => writes.push(['edit', ...args]),
      deleteRelationship: async (...args) => writes.push(['delete', ...args]),
      setRelationshipEditor: value => { env.relationshipEditor = value; updates.push(['editor', value]); },
      setRelationships: value => updates.push(['rows', value]),
      setRelationshipsStatus: value => updates.push(['status', value]),
      setRelationshipsMessage: value => updates.push(['message', value]),
    };
    loadFunctions(source, ['relationshipIdentityCurrent', 'refreshRelationships', 'openAddRelationshipEditor',
      'openEditRelationshipEditor', 'saveRelationshipEditor', 'removeRelationship'], env);
    return env;
  }
  for (const mode of ['add', 'edit', 'delete']) {
    const run = env => mode === 'delete' ? env.removeRelationship('fictional-entity') : env.saveRelationshipEditor();
    function prepare(env) { env.relationshipEditor.mode = mode; env.relationshipEditor.speakerId = 'fictional-entity'; }
    const normal = panel(); prepare(normal); await run(normal);
    assert.equal(normal.writes.length, 1); assert.equal(normal.writes[0][0], mode);
    assert.deepEqual(normal.writes[0].slice(1, 3), ['TestOwner', 'TestSoul']);
    for (const change of ['scope', 'stale-render', 'stale-owner']) {
      const env = panel(); prepare(env);
      if (change === 'stale-render') env.live.name = 'OtherSoul';
      if (change === 'stale-owner') env.memuExtras.baseInfo.userId = 'OtherOwner';
      let release;
      const gate = new Promise(resolve => { release = resolve; });
      env.isMemuActive = () => gate;
      const pending = run(env); await flushPanel();
      if (change === 'scope') env.live.scope = 'card-b/main';
      if (release) release(true);
      await pending; assert.equal(env.writes.length, 0, `${mode}/${change} must not mutate an old destination`);
    }
    for (const outcome of ['success', 'failure', 'refresh']) {
      const late = panel(); prepare(late); let finish;
      const target = outcome === 'refresh' ? 'listRelationships'
        : mode === 'delete' ? 'deleteRelationship' : mode === 'edit' ? 'updateRelationship' : 'createRelationship';
      late[target] = () => new Promise((resolve, reject) => {
        finish = () => outcome === 'failure' ? reject(new Error('Old-card failure')) : resolve({ relationships: [] });
      });
      const pending = run(late); await flushPanel();
      late.live.scope = 'card-b/main'; const before = late.updates.length;
      finish(); await pending;
      assert.equal(late.updates.length, before, `Late ${outcome} must not change the new panel`);
    }
  }
  const draft = panel(); draft.live.scope = 'card-a/new-chat';
  await draft.saveRelationshipEditor(); assert.equal(draft.writes.length, 0);
  const ready = panel(); ready.switchBusy = true;
  await ready.saveRelationshipEditor(); assert.equal(ready.writes.length, 0);
  ready.switchBusy = false; ready.memuExtras.baseInfo.characterName = 'OldSoul';
  await ready.saveRelationshipEditor(); assert.equal(ready.writes.length, 0);
  ready.memuExtras.baseInfo.characterName = ready.currentCharacter;
  await ready.saveRelationshipEditor(); assert.equal(ready.writes.length, 1);
  const reload = panel(), retainedDraft = reload.relationshipEditor;
  reload.appReady = Promise.reject(new Error('Fictional reload failure'));
  for (const setter of ['setSwitchBusy', 'setMemuActive', 'setPersona', 'setPersonaLocked', 'setSwitchError']) reload[setter] = () => {};
  loadFunctions(source, ['reloadCharacter'], reload);
  await reload.reloadCharacter();
  assert.equal(reload.relationshipEditor, retainedDraft, 'Reload must preserve a human draft');
  assert(reload.updates.some(([key, value]) => key === 'rows' && value.length === 0));
  const refreshing = panel(); let release;
  const refreshGate = new Promise(resolve => { release = resolve; });
  refreshing.isMemuActive = () => refreshGate;
  const refresh = refreshing.refreshRelationships(); await flushPanel();
  refreshing.live.scope = 'card-b/main'; release(true); await refresh;
  assert.equal(refreshing.updates.length, 0, 'Old refresh must not repopulate rows');
  assert(source.includes('memuActive, switchBusy]'));

  const memory = fs.readFileSync(process.env.MEMU_MEMORY_SOURCE || `${__dirname}/../src/memory/memorize.ts`, 'utf8');
  const namingSource = process.env.MEMU_NAMING_SOURCE ? fs.readFileSync(process.env.MEMU_NAMING_SOURCE, 'utf8') : source;
  for (const length of [100, 110, 111, 120, 150]) {
    const character = 'Fictional / Soul '.repeat(12).slice(0, length);
    const prefixes = [], books = [];
    const env = { exports: {}, currentScope: () => 'stable', isMemuActive: async () => true,
      initChatExtraInfo: async () => {}, st: { getContext: () => ({ characterId: 0, characters: [{ name: character }] }) },
      memuExtras: { baseInfo: { characterName: character } }, IMPORT_LOREBOOKS: { get: () => true },
      deleteLorebooksByPrefix: async prefix => prefixes.push(prefix), updateWorldInfoList: async () => {}, onceError: assert.fail,
      cleanCategorySummary: text => text, isNullishCategorySummary: () => false,
      filterCategoryForCharacter: (_category, text) => text, buildWorldInfoFileData: () => ({}),
      upsertWorldInfoLorebook: async name => books.push(name),
    };
    loadFunctions(memory, ['sanitizeWorldInfoName', 'deleteMemuLorebooksForCurrentCharacter', 'syncCategoriesToWorldInfo'], env);
    const panelFunctions = ['getCurrentCharacterLorebookPrefix'];
    if (namingSource.includes('function sanitizeLorebookName(')) panelFunctions.push('sanitizeLorebookName');
    loadFunctions(namingSource, panelFunctions, env);
    await env.syncCategoriesToWorldInfo(env.memuExtras.baseInfo, [{ name: 'Category', summary: 'Fictional memory.' }]);
    await env.deleteMemuLorebooksForCurrentCharacter();
    const prefix = env.getCurrentCharacterLorebookPrefix();
    assert.equal(books.length, 1);
    assert(books[0].startsWith(prefix), `Panel prefix must match writer at ${length} characters`);
    assert.deepEqual(prefixes, [prefix, prefix], 'Pruning and explicit deletion must use the panel prefix');
  }
  console.log('Relationship scope/identity, retained draft, stale response, and writer/panel/delete/pruning naming checks pass.');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => clearTimeout(panelCheckTimeout));

(async () => {
  const clone = value => JSON.parse(JSON.stringify(value));
  const calls = [], order = [];
  const env = {
    exports: {}, mappings: { step_models: { reflection: 'hand-model', memory_extract: {
      provider: 'openai', base_url: 'https://fake.invalid/v1', chat_model: 'same-name', profile_ids: ['chosen'] } },
      providers: [{ profile_id: 'chosen', base_url: 'https://fake.invalid/v1', models: [{ model: 'same-name' }] }] },
    hasAdvancedMapping: true, extension_settings: { memu: { advancedMapping: { memory_extract: { source: 'configured', profile_id: 'chosen' } } } },
    pendingMappings: { current: {} },
    window: { confirm: text => { assert.equal(text, 'Remove Advanced Mapping settings from config.json, including any hand edits?'); return false; } },
    saveSettings: async () => order.push('retain'),
    setAdvancedOpen: value => { env.open = value; },
    changeModelMappings: async patch => { await env.saveSettings(); order.push('patch'); calls.push(clone(patch)); },
    nativeModelSelection: () => ({ profile_id: 'native:cc:custom', provider: 'custom', model: 'current-native' }),
    srmmRequest: () => ({ source: 'configured', profile_id: 'chosen', native: null }),
    setConfigStatus: () => {}, setSwitchError: error => assert.fail(error),
  };
  Object.defineProperty(env, 'activeSteps', { get: () => ({ ...env.mappings.step_models, ...env.pendingMappings.current.step_models }) });
  loadFunctions(source, ['mappingChoice', 'stepRequest', 'toggleAdvancedMapping'], env);
  const before = JSON.stringify(env.extension_settings);
  await env.toggleAdvancedMapping(false);
  assert.equal(calls.length, 0); assert.equal(order.length, 0);
  assert.equal(JSON.stringify(env.extension_settings), before);
  env.window.confirm = () => true;
  await env.toggleAdvancedMapping(false);
  assert.deepEqual(order, ['retain', 'patch']);
  assert.deepEqual(calls.pop(), { step_models: { reflection: null, memory_extract: null } });
  assert.deepEqual(clone(env.extension_settings.memu.advancedMapping), {
    reflection: { source: 'config' }, memory_extract: { source: 'configured', profile_id: 'chosen' } });
  assert(!JSON.stringify(env.extension_settings).includes('api_key'));
  env.mappings.step_models = {}; env.hasAdvancedMapping = false;
  await env.toggleAdvancedMapping(true);
  assert.deepEqual(calls.pop(), { step_models: {
    memory_extract: { source: 'configured', profile_id: 'chosen', native: env.nativeModelSelection() } } });
  const copy = clone(env.stepRequest({ source: 'srmm' }));
  env.srmmRequest = () => ({ source: 'config', native: null });
  assert.equal(copy.srmm.profile_id, 'chosen');
  assert.deepEqual(clone(env.stepRequest({ source: 'srmm' })), { source: 'srmm', srmm: { source: 'config', native: null } });
  assert.equal(env.stepRequest({ source: 'config' }), undefined);
  assert.equal(calls.length, 0, 'Building a request does not itself write settings');

  const effectStart = source.indexOf('  useEffect(() => {\n    const events = [st.event_types.MAIN_API_CHANGED');
  const events = new Map(); let modelReads = 0, onNativeChange;
  const eventEnv = { useEffect: fn => fn(), mappings: {}, mappingState: { current: {} }, nativeTransition: { current: false },
    st: { event_types: { MAIN_API_CHANGED: 'api', SETTINGS_UPDATED: 'settings' },
      eventSource: { on: (event, fn) => events.set(event, fn), removeListener() {} } },
    nativeModelSelection: () => { modelReads++; return null; }, setNativeSelection() {},
    refreshProfiles: async () => {},
    window: { addEventListener() {}, removeEventListener() {}, setTimeout: fn => { onNativeChange = fn; return 1; }, clearTimeout() {} },
    document: { addEventListener() {}, removeEventListener() {} },
    changeModelMappings: () => assert.fail('Native events must never write mappings'),
  };
  vm.runInNewContext(ts.transpileModule(source.slice(effectStart, source.indexOf('  }, [!!mappings]);', effectStart) + '  }, [!!mappings]);'.length), {
    compilerOptions: { module: ts.ModuleKind.CommonJS },
  }).outputText, eventEnv);
  events.get('settings')();
  onNativeChange();
  assert(modelReads > 1);
  const utilsEnv = { exports: {}, extension_settings: { memu: { srmm: { source: 'configured', profile_id: 'chosen' } } },
    nativeModelSelection: () => ({ model: 'live-native', provider: 'custom', profile_id: 'native:cc:custom' }) };
  loadFunctions(utilsSource, ['srmmChoice', 'srmmRequest'], utilsEnv);
  assert.equal(utilsEnv.exports.srmmRequest().native.model, 'live-native');
  assert(!JSON.stringify(utilsEnv.exports.srmmRequest()).includes('api_key'));
  assert(/srmm: srmmRequest\(\)/.test(fs.readFileSync(`${__dirname}/../src/memory/memorize.ts`, 'utf8')));
  console.log('Advanced confirmation cancel/accept, retain-before-delete, marker-only config and re-enable transfer pass.');
})().catch(error => { console.error(error); process.exitCode = 1; });

(async () => {
  const copy = value => JSON.parse(JSON.stringify(value));
  let native = { profile_id: 'native:cc:custom', provider: 'custom', model: 'model-a', base_url: 'https://native.invalid/v1' };
  const patches = [], events = new Map(), timers = new Map();
  let timerId = 0, cleanup;
  const connection = { provider: 'openai', base_url: native.base_url, chat_model: native.model, native_match: true };
  const env = {
    exports: {}, require: () => jsx, mappings: {}, nativeSelection: native,
    nativeTransition: { current: false }, mappingState: { current: { base_model: { ...connection }, step_models: {
      reflection: { ...connection }, memory_extract: { ...connection }, category_update: { ...connection, native_match: false },
    } } }, pendingMappings: { current: {} },
    extension_settings: { memu: { base_model: { source: 'st_native' }, advancedMapping: {
      reflection: { source: 'st_native' }, memory_extract: { source: 'configured', profile_id: 'fixed' },
      category_update: { source: 'st_native' }, preprocess: { source: 'st_native' },
    } } },
    nativeModelSelection: () => native, srmmChoice: () => env.extension_settings.memu.srmm || { source: 'config' },
    changeModelMappings: patch => { patches.push(copy(patch)); return Promise.resolve(); },
    setNativeSelection: value => { env.nativeSelection = value; }, refreshProfiles: async () => {},
    setMappings: value => { env.mappings = value; }, getModelMappings: async () => copy(env.mappingState.current),
    useEffect: fn => { cleanup = fn(); },
    st: { event_types: { MAIN_API_CHANGED: 'api', SETTINGS_UPDATED: 'settings', CONNECTION_PROFILE_LOADED: 'profile' },
      eventSource: { on: (event, fn) => events.set(event, fn), removeListener() {} } },
    window: { addEventListener() {}, removeEventListener() {}, setTimeout: fn => { timers.set(++timerId, fn); return timerId; }, clearTimeout: id => timers.delete(id), confirm: () => true },
    document: { addEventListener() {}, removeEventListener() {} }, setAdvancedOpen() {}, setConfigStatus() {}, setSwitchError: assert.fail,
  };
  loadFunctions(source, ['mappingChoice', 'syncModelMappings', 'stepRequest', 'toggleAdvancedMapping', 'loadModelMappings', 'applyLoadedMappings'], env);
  const start = source.indexOf('  useEffect(() => {\n    const events = [st.event_types.MAIN_API_CHANGED');
  const end = source.indexOf('  }, [!!mappings]);', start) + '  }, [!!mappings]);'.length;
  vm.runInNewContext(ts.transpileModule(source.slice(start, end), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, env);
  assert.equal(patches.length, 0, 'Mount must not write ST choices over config');
  const flush = () => { const queued = [...timers.values()]; timers.clear(); for (const fn of queued) fn(); };
  events.get('settings')(); flush();
  assert.equal(patches.length, 0, 'Settings-save feedback is not a model change');
  native = { ...native, model: 'intermediate' }; events.get('api')();
  native = { ...native, model: 'model-b' }; events.get('profile')();
  assert.equal(timers.size, 1, 'A profile-application burst is coalesced'); flush();
  assert.equal(patches.length, 1);
  assert.equal(patches[0].base_model.native.model, 'model-b');
  assert.deepEqual(Object.keys(patches[0].step_models), ['reflection'], 'Fixed, hand-edited and disabled rows stay untouched');
  assert.equal(patches[0].step_models.reflection.native.model, 'model-b');
  events.get('settings')(); flush(); assert.equal(patches.length, 1);
  env.mappingState.current.base_model.native_match = false;
  env.mappingState.current.step_models.reflection.native_match = false;
  native = { ...native, model: 'model-c' }; events.get('settings')(); flush();
  assert.equal(patches.length, 1, 'Loaded hand edits disarm native synchronization');
  env.mappingState.current.step_models.reflection.native_match = true;
  env.pendingMappings.current.step_models = { reflection: null };
  native = { ...native, model: 'model-d' }; events.get('profile')(); flush();
  assert.equal(patches.length, 1, 'A pending disable must not be overwritten by a native change');
  env.pendingMappings.current = {};
  assert.deepEqual(copy(env.mappingChoice('reflection', { ...connection })), { source: 'st_native' });
  assert.equal(env.mappingChoice('reflection', { ...connection, native_match: false }).source, 'config');
  env.extension_settings.memu.advancedMapping.memory_extract.profile_id = 'second';
  assert.deepEqual(copy(env.mappingChoice('memory_extract', { ...connection, profile_id: 'first', profile_ids: ['first', 'second'] })),
    { source: 'configured', profile_id: 'second' }, 'Identical connections must preserve the explicitly chosen profile ID');
  env.mappings = env.mappingState.current;
  env.mappings.step_models = { reflection: { ...connection } };
  env.hasAdvancedMapping = true;
  Object.defineProperty(env, 'activeSteps', { get: () => ({ ...env.mappings.step_models, ...env.pendingMappings.current.step_models }) });
  await env.toggleAdvancedMapping(false);
  assert.deepEqual(copy(env.extension_settings.memu.advancedMapping.reflection), { source: 'st_native' });
  env.mappings.step_models = {}; env.hasAdvancedMapping = false;
  delete env.extension_settings.memu.advancedMapping.memory_extract;
  delete env.extension_settings.memu.advancedMapping.category_update;
  delete env.extension_settings.memu.advancedMapping.preprocess;
  await env.toggleAdvancedMapping(true);
  assert.equal(patches.at(-1).step_models.reflection.native.model, 'model-d', 'Re-enable uses today\'s ST model, not an old copy');
  env.mappings.step_models = { reflection: { ...connection } };
  const beforeGet = env.mappingState.current;
  let finishGet;
  env.getModelMappings = () => new Promise(resolve => { finishGet = resolve; });
  const reading = env.loadModelMappings();
  native = { ...native, model: 'model-e' }; events.get('profile')();
  finishGet({ base_model: {}, step_models: { reflection: { ...connection, native_match: false } } });
  await reading;
  assert.equal(env.mappingState.current, beforeGet, 'A GET started before an ST change must not disarm that change during coalescing');
  flush();
  assert.equal(patches.at(-1).step_models.reflection.native.model, 'model-e');
  assert(!JSON.stringify(env.extension_settings).includes('api_key'));
  cleanup(); assert.equal(timers.size, 0);
  console.log('ST-selected changes follow through the existing save path; mount, hand edits, disabled rows, feedback, profile identity and re-enable pass.');
})().catch(error => { console.error(error); process.exitCode = 1; });

(async () => {
  const copy = value => JSON.parse(JSON.stringify(value));
  let releaseRetain, retainCalls = 0, catalogReads = 0;
  const retainGate = new Promise(resolve => { releaseRetain = resolve; });
  const requests = [], order = [];
  const env = {
    exports: {}, require: () => jsx,
    mappings: { step_models: { memory_extract: 'old-model' }, providers: [{
      profile_id: 'new-profile', provider: 'openai', label: 'New profile', supported: true,
      models: [{ model: 'new-model' }],
    }], base_model: { provider: 'openai', chat_model: 'base-model' } },
    pendingMappings: { current: {} }, mappingSave: { current: Promise.resolve() }, mappingState: { current: null }, nativeTransition: { current: false },
    extension_settings: { memu: { advancedMapping: {} } }, srmm: { source: 'config' }, nativeSelection: null,
    nativeModelSelection: () => null, srmmChoice: () => ({ source: 'config' }),
    window: { confirm: () => true },
    setMappings: value => { env.mappings = value; }, setAdvancedOpen: value => { env.open = value; }, setConfigStatus() {}, setSwitchError: assert.fail,
    saveSettings: async () => { order.push('retain'); if (++retainCalls === 1) await retainGate; },
    setModelMappings: async patch => {
      order.push('patch'); requests.push(copy(patch));
      const steps = { ...env.mappings.step_models };
      for (const [step, value] of Object.entries(patch.step_models || {})) {
        if (value === null) delete steps[step];
        else steps[step] = { provider: 'openai', base_url: 'https://new.invalid/v1', chat_model: 'new-model', profile_ids: [value.profile_id] };
      }
      return { ...env.mappings, step_models: steps };
    },
    getModelMappings: async () => {
      catalogReads++;
      const fresh = copy(env.mappingState.current);
      delete fresh.step_models.memory_extract.profile_ids;
      fresh.providers = [{ profile_id: 'new-profile', provider: 'openai', label: 'Edited profile', supported: true,
        models: [{ model: 'profile-edited-model' }] }];
      return fresh;
    },
  };
  env.mappingState.current = env.mappings;
  Object.defineProperty(env, 'activeSteps', { get: () => ({ ...env.mappings.step_models, ...env.pendingMappings.current.step_models }) });
  Object.defineProperty(env, 'hasAdvancedMapping', { get: () => Object.values(env.activeSteps).some(Boolean) });
  loadFunctions(source, ['changeModelMappings', 'mappingChoice', 'stepRequest', 'toggleAdvancedMapping', 'renderModelPicker', 'refreshProfiles', 'applyLoadedMappings'], env);
  const choice = { source: 'configured', profile_id: 'new-profile' };
  const changing = env.renderModelPicker('memory_extract').props.onChange({ target: { value: JSON.stringify(choice) } });
  assert.deepEqual(JSON.parse(env.renderModelPicker('memory_extract').props.value), choice, 'Selection displays immediately');
  await env.refreshProfiles();
  assert.equal(catalogReads, 0, 'Catalog refresh must not overwrite pending mapping work');
  const disabling = env.toggleAdvancedMapping(false);
  assert.deepEqual(copy(env.extension_settings.memu.advancedMapping.memory_extract), choice, 'Disable retains newest choice, not old file state');
  releaseRetain();
  await Promise.all([changing, disabling]);
  assert.deepEqual(order, ['retain', 'patch', 'retain', 'patch']);
  assert.equal(requests[0].step_models.memory_extract.profile_id, 'new-profile');
  assert.equal(requests[1].step_models.memory_extract, null);
  assert.deepEqual(Object.keys(env.mappings.step_models), []);
  assert.deepEqual(Object.keys(env.pendingMappings.current), []);
  await env.toggleAdvancedMapping(true);
  await env.mappingSave.current;
  assert.equal(requests[2].step_models.memory_extract.profile_id, 'new-profile', 'Re-enable restores the newest retained profile');
  const active = copy(env.mappings.step_models.memory_extract);
  await env.refreshProfiles();
  assert.equal(catalogReads, 1);
  assert.equal(env.mappings.step_models.memory_extract.chat_model, active.chat_model);
  assert.equal(env.mappings.step_models.memory_extract.profile_ids, undefined, 'Changed config must not keep a stale profile marker');
  assert.deepEqual(JSON.parse(env.renderModelPicker('memory_extract').props.value), { source: 'config' });
  assert.equal(env.mappings.providers[0].models[0].model, 'profile-edited-model');

  const saving = env.setModelMappings;
  let failures = 0;
  env.setSwitchError = value => { env.error = value; };
  env.setModelMappings = async patch => {
    if (patch.step_models?.memory_extract === null || patch.claude_code !== undefined) { failures++; throw Error('Fictional save refused'); }
    return saving(patch);
  };
  env.mappings = env.mappingState.current = { ...env.mappings, claude_code: false, step_models: { memory_extract: 'before-failure' } };
  const selectedAgain = env.renderModelPicker('memory_extract').props.onChange({ target: { value: JSON.stringify(choice) } });
  const failedDisable = env.toggleAdvancedMapping(false);
  await Promise.all([selectedAgain, failedDisable]);
  assert.match(env.error, /Fictional save refused/);
  assert.equal(env.hasAdvancedMapping, true, 'Failed disable must keep active overrides visible');
  assert.equal(env.mappings.step_models.memory_extract.chat_model, 'new-model', 'Earlier acknowledged save must not be lost on later failure');
  assert.deepEqual(Object.keys(env.pendingMappings.current), []);
  await env.refreshProfiles();
  assert.equal(catalogReads, 2, 'Failed work must not block later reads');
  await env.toggleAdvancedMapping(false);
  assert.equal(failures, 2, 'The user can retry a failed disable');
  await env.changeModelMappings({ claude_code: true });
  assert.equal(env.mappings.claude_code, false, 'Failed Boolean save must show the last confirmed setting');
  console.log('Immediate picker state, ordered saves, failed-disable truthfulness, copied-profile labels and read-only refresh pass.');
})().catch(error => { console.error(error); process.exitCode = 1; });

(async () => {
  const patches = [], settings = { memu: { advancedMapping: { reflection: { source: 'configured', profile_id: 'old-profile' } } } };
  const hand = { provider: 'openai', base_url: 'https://hand.invalid/v1', chat_model: 'hand-only' };
  const env = { exports: {}, mappings: { step_models: { reflection: hand } }, hasAdvancedMapping: true,
    pendingMappings: { current: {} },
    extension_settings: settings, window: { confirm: () => true }, saveSettings: async () => {},
    setAdvancedOpen() {}, changeModelMappings: patch => patches.push(JSON.parse(JSON.stringify(patch))),
    setConfigStatus() {}, setSwitchError: assert.fail,
  };
  Object.defineProperty(env, 'activeSteps', { get: () => ({ ...env.mappings.step_models, ...env.pendingMappings.current.step_models }) });
  loadFunctions(source, ['mappingChoice', 'stepRequest', 'toggleAdvancedMapping'], env);
  assert.equal(env.mappingChoice('reflection', hand).source, 'config', 'Browser must not guess a profile from URL/model');
  await env.toggleAdvancedMapping(false);
  assert.equal(settings.memu.advancedMapping.reflection.source, 'config');
  assert.deepEqual(patches.pop(), { step_models: { reflection: null } });
  env.mappings.step_models = {}; env.hasAdvancedMapping = false;
  await env.toggleAdvancedMapping(true);
  assert.equal(patches.length, 0, 'Unmatched independent connection must not turn into a base-model choice');
  env.configStatus = 'idle'; env.mappingState = { current: null };
  env.nativeTransition = { current: false };
  env.nativeModelSelection = () => null;
  env.srmmChoice = () => ({ source: 'config' });
  env.getModelMappings = async () => ({ step_models: { reflection: hand } });
  env.setMappings = value => { env.loaded = value; };
  loadFunctions(source, ['loadModelMappings', 'applyLoadedMappings'], env);
  await env.loadModelMappings();
  assert.equal(env.loaded.step_models.reflection, hand);
  assert.equal(patches.length, 0, 'Loading hand edits must never echo a save');
  console.log('Hand-configured objects keep their values and use config markers without guessed profiles.');
})().catch(error => { console.error(error); process.exitCode = 1; });

(async () => {
  const copy = value => JSON.parse(JSON.stringify(value));
  function fixture() {
    const requests = [], events = new Map(); let saved = 0, cleanup;
    const native = { profile_id: 'live', provider: 'custom', model: 'live-model', base_url: 'https://live.invalid/v1' };
    const connection = () => ({ provider: 'openai', base_url: 'https://fixed.invalid/v1', chat_model: 'fixed-model', profile_ids: ['fixed'], native_match: true, srmm_match: true });
    const settings = { memu: { srmm: { source: 'configured', profile_id: 'fixed' }, base_model: { source: 'configured', profile_id: 'fixed' }, advancedMapping: {
      reflection: { source: 'st_native' }, memory_extract: { source: 'configured', profile_id: 'fixed' },
      category_update: { source: 'srmm' }, consolidation: { source: 'config' },
    } } };
    const current = { base_model: connection(), step_models: Object.fromEntries(['reflection', 'memory_extract', 'category_update', 'consolidation'].map(step => [step, connection()])),
      providers: ['fixed', 'other', 'live'].map(id => ({ profile_id: id, label: id, supported: true, models: [{ model: id + '-model' }] })) };
    const env = {
      exports: {}, require: () => jsx, extension_settings: settings, mappings: current, mappingState: { current }, pendingMappings: { current: {} }, nativeTransition: { current: false },
      srmm: settings.memu.srmm, nativeSelection: native, nativeModelSelection: () => native,
      srmmChoice: () => settings.memu.srmm, srmmRequest: () => ({ ...settings.memu.srmm, native }),
      saveSettings: async () => { saved++; }, changeModelMappings: async patch => { requests.push(copy(patch)); await env.saveSettings(); },
      setMappings: value => { env.mappings = value; }, setSrmm: value => { env.srmm = value; }, setNativeSelection() {}, setSwitchError: assert.fail, setConfigStatus() {},
      refreshProfiles: async () => {}, loadModelMappings: async () => {}, useEffect: fn => { cleanup = fn(); },
      st: { event_types: { MAIN_API_CHANGED: 'api', SETTINGS_UPDATED: 'settings', CONNECTION_PROFILE_UPDATED: 'updated', CONNECTION_PROFILE_DELETED: 'deleted',
        SECRET_WRITTEN: 'key-write', SECRET_EDITED: 'key-edit', SECRET_ROTATED: 'key-rotate', SECRET_DELETED: 'key-delete' },
        eventSource: { on: (event, fn) => events.set(event, fn), removeListener() {} } },
      window: { setTimeout: () => 1, clearTimeout() {}, addEventListener() {}, removeEventListener() {} }, document: { addEventListener() {}, removeEventListener() {} },
    };
    loadFunctions(source, ['mappingChoice', 'syncModelMappings', 'stepRequest', 'renderModelPicker', 'applyLoadedMappings'], env);
    const start = source.indexOf('  useEffect(() => {\n    const events = [st.event_types.MAIN_API_CHANGED');
    const end = source.indexOf('  }, [!!mappings]);', start) + '  }, [!!mappings]);'.length;
    vm.runInNewContext(ts.transpileModule(source.slice(start, end), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, env);
    return { env, settings, current, requests, events, saved: () => saved, cleanup: () => cleanup() };
  }
  const select = (f, role, choice) => f.env.renderModelPicker(role).props.onChange({ target: { value: JSON.stringify(choice) } });
  const manual = fixture(), unchanged = JSON.stringify(manual.current);
  await select(manual, 'other_apps', { source: 'config' });
  await select(manual, 'memory_extract', { source: 'config' });
  assert.equal(manual.requests.length, 0, 'Config selection is marker-only in both OOAR and AMM');
  assert.equal(JSON.stringify(manual.current), unchanged);
  assert.equal(manual.settings.memu.base_model.source, 'config');
  assert.equal(manual.settings.memu.advancedMapping.memory_extract.source, 'config');
  assert(nodes(manual.env.renderModelPicker('other_apps')).some(node => node.type === 'option' && node.props.value === JSON.stringify({ source: 'srmm' })));
  assert(!nodes(manual.env.renderModelPicker('srmm')).some(node => node.type === 'option' && node.props.value === JSON.stringify({ source: 'srmm' })));

  const named = fixture();
  named.events.get('updated')({}, { id: 'fixed' });
  assert.equal(named.requests[0].base_model.profile_id, 'fixed');
  assert.deepEqual(Object.keys(named.requests[0].step_models).sort(), ['category_update', 'memory_extract']);
  assert.equal(named.requests[0].step_models.category_update.srmm.profile_id, 'fixed');
  named.requests.length = 0; named.env.syncModelMappings('st_native');
  assert.equal(named.requests[0].base_model, undefined, 'ST-selected changes do not switch a named OOAR profile');
  assert.equal(named.requests[0].step_models.memory_extract, undefined, 'Named AMM profiles remain static relative to other sources');
  named.requests.length = 0; named.events.get('key-rotate')();
  assert(named.requests[0].base_model, 'Same-model credential changes use the shared explicit-event path');

  const srmmOnly = fixture(); srmmOnly.settings.memu.base_model = { source: 'config' }; srmmOnly.settings.memu.advancedMapping = {};
  await select(srmmOnly, 'srmm', { source: 'configured', profile_id: 'other' });
  assert.equal(srmmOnly.requests.length, 0, 'SRMM itself is ST-only');
  const followers = fixture(); followers.settings.memu.base_model = { source: 'srmm' };
  await select(followers, 'srmm', { source: 'configured', profile_id: 'other' });
  assert.equal(followers.requests[0].base_model.source, 'srmm');
  assert.equal(followers.requests[0].base_model.srmm.profile_id, 'other');
  assert.deepEqual(Object.keys(followers.requests[0].step_models), ['category_update']);

  const base = fixture(); base.settings.memu.srmm = { source: 'config' };
  await select(base, 'other_apps', { source: 'configured', profile_id: 'other' });
  assert.equal(base.requests.length, 1);
  assert.equal(base.requests[0].base_model.profile_id, 'other');
  assert.equal(base.requests[0].step_models.category_update.srmm.source, 'config', 'Config-backed SRMM dependents share the same base-change request');
  const follow = fixture(); await select(follow, 'other_apps', { source: 'srmm' });
  assert.equal(follow.requests[0].base_model.srmm.profile_id, 'fixed');
  for (const source of ['config', 'st_native', 'configured']) {
    follow.settings.memu.srmm = { source, ...(source === 'configured' ? { profile_id: 'fixed' } : {}) };
    await select(follow, 'preprocess', { source: 'srmm' });
    const loaded = copy(follow.current);
    loaded.step_models.preprocess = { ...loaded.base_model, srmm_match: true };
    follow.env.applyLoadedMappings(loaded);
    const picker = follow.env.renderModelPicker('preprocess');
    assert.equal(picker.props.value, JSON.stringify({ source: 'srmm' }), 'The selector keeps SRMM, not SRMM\'s resolved source');
    assert.equal(nodes(picker).find(node => node.type === 'option' && node.props.value === picker.props.value).props.children, 'default (SRMM)');
    assert.equal(follow.settings.memu.advancedMapping.preprocess.source, 'srmm');
  }

  const hand = fixture(), loaded = copy(hand.current);
  for (const value of [loaded.base_model, loaded.step_models.memory_extract]) Object.assign(value, { chat_model: 'hand-model', profile_ids: [], native_match: false, srmm_match: false });
  hand.env.applyLoadedMappings(loaded);
  assert.equal(hand.requests.length, 0, 'Loading hand changes never writes config');
  assert.equal(hand.settings.memu.base_model.source, 'config');
  assert.equal(hand.settings.memu.advancedMapping.memory_extract.source, 'config');
  assert.equal(hand.settings.memu.base_model.hand_edited, true);
  assert.equal(hand.settings.memu.advancedMapping.memory_extract.hand_edited, true);
  assert.equal(JSON.parse(hand.env.renderModelPicker('other_apps').props.value).source, 'config');
  await select(hand, 'other_apps', { source: 'config' });
  await select(hand, 'memory_extract', { source: 'config' });
  assert.equal(hand.settings.memu.base_model.hand_edited, undefined);
  assert.equal(hand.settings.memu.advancedMapping.memory_extract.hand_edited, undefined);
  assert.equal(hand.requests.length, 0, 'Accepting config ownership only changes the marker');

  const deleted = fixture(), beforeDelete = JSON.stringify(deleted.current);
  await deleted.events.get('deleted')({ id: 'fixed' });
  assert.equal(deleted.settings.memu.srmm.source, 'st_native');
  assert.equal(deleted.settings.memu.base_model.source, 'config');
  assert.equal(JSON.stringify(deleted.current), beforeDelete, 'Deleting profiles keeps existing direct config values');
  assert.equal(deleted.requests[0].base_model, undefined);
  assert.equal(deleted.requests[0].step_models.category_update.srmm.source, 'st_native');
  for (const f of [manual, named, srmmOnly, followers, base, follow, hand, deleted]) {
    assert(!JSON.stringify(f.settings).includes('api_key')); f.cleanup();
  }
  console.log('Complete selector matrix passes: OOAR/SRMM/AMM, static named profiles, source followers, config-only markers, hand edits, credentials and deletion.');
})().catch(error => { console.error(error); process.exitCode = 1; });
