const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require(path.resolve(__dirname, '../../../../../plugins/memu-plugin/node_modules/typescript'));
const jsx = require('react/jsx-runtime');

// Render real App JSX with isolated hooks; don't initialize ST or run effects.
const source = fs.readFileSync(`${__dirname}/../src/App.tsx`, 'utf8');
const states = [];
let cursor = 0;
const react = {
  useState(initial) {
    const index = cursor++;
    if (!(index in states)) states[index] = initial;
    return [states[index], value => { states[index] = typeof value === 'function' ? value(states[index]) : value; }];
  },
  useEffect() {}, useMemo: fn => fn(), useRef: value => ({ current: value }),
};
const context = {
  exports: {},
  require: name => name === 'react' ? react : name === 'react/jsx-runtime' ? jsx : { default: () => null, __esModule: true, st: {}, memuExtras: {} },
};
vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText, context);
states[0] = true;
states[1] = { version: 4, defaultProfileId: 'test-api', stepProfileId: { reflection: 'test-reflection' }, useClaudeCode: false };
states[2] = [{ id: 'test-api', name: 'Fictional API / test-model' }, { id: 'test-reflection', name: 'Fictional reflection' }];
const render = () => { cursor = 0; return context.exports.default(); };
function nodes(tree) {
  if (!tree || typeof tree !== 'object') return [];
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  return [tree, ...nodes(tree.props?.children)];
}
const find = (tree, id) => nodes(tree).find(node => node.props?.id === id);
const change = (tree, id, checked) => find(tree, id).props.onChange({ target: { checked } });
let tree = render();
assert.equal(find(tree, 'use_server_settings').props.checked, true);
assert.equal(find(tree, 'memu-runtime-overrides'), undefined);
const tooltip = find(tree, 'memu-agentic-settings-info');
assert.equal(tooltip.props.children.trim(), "The Soul's scheduled agentic turns use mcp-memu-server/config.json.");
assert.equal(tooltip.props.role, 'tooltip');
assert(nodes(tree).some(node => node.type === 'button' && node.props['aria-describedby'] === tooltip.props.id));
assert(source.includes('.memu-runtime-info:hover [role="tooltip"]'));
assert(source.includes('.memu-runtime-info:focus-within [role="tooltip"]'));
change(tree, 'use_server_settings', false);
tree = render();
assert(find(tree, 'memu-runtime-overrides'));
assert.equal(find(tree, 'use_claude_code').props.checked, false);
assert(nodes(tree).some(node => node.type === 'select' && node.props.value === 'test-api'));
assert(nodes(tree).some(node => node.type === 'option' && node.props.children === 'Fictional API / test-model'));
change(tree, 'use_claude_code', true);
tree = render();
assert.equal(find(tree, 'use_claude_code').props.checked, true);
change(tree, 'use_server_settings', true);
tree = render();
assert.equal(find(tree, 'use_claude_code'), undefined);
assert(find(tree, 'memu-agentic-settings-info'));
assert(find(tree, 'override_summarizer'));
change(tree, 'use_server_settings', false);
tree = render();
assert.equal(find(tree, 'use_claude_code').props.checked, true);
assert.equal(states[1].defaultProfileId, 'test-api');
assert.equal(states[1].stepProfileId.reflection, 'test-reflection');
change(tree, 'use_claude_code', false);
assert.equal(find(render(), 'use_claude_code').props.checked, false);
console.log('Isolated App render: defaults, collapse/restore, API label, Claude toggle and tooltip wiring pass (no browser/live test).');

// Character switch and copied-chat UI use the same panel, not a second settings store.
states[10] = 'TestSoul'; states[12] = true; states[13] = true;
states[14] = 'owner.png'; states[15] = true; states[16] = { 'owner.png': 'TestOwner' }; states[17] = false;
tree = render();
assert.equal(find(tree, 'memu_character_enabled').props.checked, false);
assert.equal(find(tree, 'memu_character_enabled').props.disabled, true);
assert.equal(find(tree, 'memu_soul_persona').props.disabled, true);
assert.equal(find(tree, 'memu-switch-info').props.children, 'memU is off in checkpoints and branches. Return to the main chat to talk with the Soul.');
states[13] = false; states[15] = false; states[14] = ''; states[12] = false;
assert.equal(find(render(), 'memu_character_enabled').props.disabled, true);
states[12] = true;
assert.equal(find(render(), 'memu_character_enabled').props.checked, true);
assert.equal(find(render(), 'memu_character_enabled').props.disabled, false); // missing binding must not prevent opt-out
states[14] = 'owner.png';
assert.equal(find(render(), 'memu_character_enabled').props.disabled, false);
states[15] = true; states[12] = false;
assert.equal(find(render(), 'memu_soul_persona').props.disabled, true);
states[0] = false;
assert(nodes(render()).some(node => node.type === 'style' && node.props.children.includes('.memu-runtime-info')));

const personaCallbacks = new Map();
let seenPersonas, cleanup;
const personaEffect = {
  useEffect: callback => { cleanup = callback(); }, reloadCharacter: async () => {},
    st: { event_types: { CHAT_CHANGED: 'chat', CHARACTER_EDITED: 'edited-card', PERSONA_CREATED: 'created', PERSONA_UPDATED: 'updated', PERSONA_DELETED: 'deleted' },
    eventSource: { on: (event, callback) => personaCallbacks.set(event, callback), removeListener: event => personaCallbacks.delete(event) } },
  power_user: { personas: {} }, setPersonas: value => { seenPersonas = value; },
  window: { addEventListener() {}, removeEventListener() {} },
};
const effectStart = source.indexOf('  useEffect(() => {\n    const reload');
vm.runInNewContext(ts.transpileModule(source.slice(effectStart, source.indexOf('  async function changeMemu(', effectStart)), {
  compilerOptions: { module: ts.ModuleKind.CommonJS },
}).outputText, personaEffect);
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
  const cardFiles = new Map(), cardUpdates = [];
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
    getSouls: async () => { reads++; if (failDiscovery) throw Error('discovery refused'); if (pendingDiscovery) return pendingDiscovery; return { souls }; },
    getSoul: async id => { reads++; if (!names[id]) throw Error('missing binding'); return { soul_id: id, user_name: names[id] }; },
    getOwner: async () => ({ user_id: owner }),
    createOwner: async id => { owner = id; return { user_id: id }; },
    createSoul: async (id, name) => { assert(owner); creates++; names[id] = name; souls.push(id); return { soul_id: id, created: true }; },
  };
  const utils = loadModule('memory/utils.ts', {
    'utils/context-extra': { st, memuExtras: extras }, 'utils/network': network,
    '@silly-tavern/scripts/power-user.js': native,
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
  });
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
    'memu-js': {}, 'utils/context-extra': { st, memuExtras: extras, MENTAL_HEALTH_ADDON: { get: () => false } }, 'utils/network': network,
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
  network.conversationRetrieve = (_, options) => {
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
  const poller = loadModule('memory/summary-poller.ts', {
    'utils/consts': { MEMU_DEFAULT_TIMEOUT: 3000 }, 'utils/context-extra': { st, memuExtras: extras },
    'utils/network': { getTaskStatus: () => new Promise(resolve => { resolvePoll = resolve; }) },
    'utils/types': { MemuTaskStatus: { PROCESSING: 'PROCESSING', PENDING: 'PENDING', SUCCESS: 'SUCCESS' } },
    './memorize': memory, './utils': utils, 'utils/log': log,
  }, { setTimeout: () => 1, clearTimeout() {} });
  names.OtherSoul = 'OtherOwner'; saves = 0;
  poller.startSummaryPolling(); await new Promise(resolve => setImmediate(resolve));
  const inherited = { ...extras.summary };
  ctx.getCurrentChatId = () => 'copy'; ctx.chatMetadata = { main_chat: 'main', integrity: 'shared' }; extras.summary = inherited;
  resolvePoll({ status: 'SUCCESS' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(extras.summary, inherited); assert.equal(saves, 0);
  for (const entry of ['memorizeNow', 'syncLorebooksNow', 'deleteMemuLorebooksForCurrentCharacter', 'retrieveMemories', 'doSummary', 'addPendingRetrieveToPrompt']) await producer[entry]();
  assert.equal(saves, 0);

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
  await utils.onCharacterDuplicated({ oldAvatar: 'event.png' });
  assert.equal(extensionSettings.memu.soulCards.EventSoul, 'event.png');
  const copy = JSON.parse(originalText); copy.avatar = 'event-copy.png';
  ctx.characterId = ctx.characters.push(copy) - 1;
  resolveDiscovery({ souls }); assert.equal(await firstGate, false);
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
    assert.equal(await utils.isMemuActive(), true);
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
