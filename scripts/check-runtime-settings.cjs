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
  st: { event_types: { CHAT_CHANGED: 'chat', PERSONA_CREATED: 'created', PERSONA_UPDATED: 'updated', PERSONA_DELETED: 'deleted' },
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
    compilerOptions: { module: ts.ModuleKind.CommonJS },
  }).outputText, sandbox);
  if (file === 'memory/memorize.ts') {
    vm.runInNewContext('exports.query = resolveRetrieveTurnForPrompt; exports.saved = prepareConversationData;', sandbox);
  }
  return sandbox.exports;
}
(async () => {
  let ctx = { characters: [{ name: 'TestSoul', avatar: 'test.png', data: { extensions: { memu: { retained: 7 } } } }], characterId: 0, chatMetadata: {}, getCurrentChatId: () => 'main' };
  const extras = {};
  let saves = 0, reads = 0, creates = 0, alerts = 0, owner = null, nativeCreates = 0;
  const names = { TestSoul: 'TestOwner', OtherSoul: 'OtherOwner' };
  let souls = ['TestSoul'];
  let failDiscovery = false, updated = ['test.png'], pendingDiscovery;
  let ready;
  const native = { power_user: { personas: { 'owner.png': 'TestOwner' } } };
  ctx.SlashCommandParser = { commands: { 'persona-create': { callback: async (args, value) => {
    nativeCreates++; assert.equal(args.select, 'false'); assert.equal(value, '');
    native.power_user.personas['created.png'] = args.name;
    return 'created.png';
  } } } };
  const st = { getContext: () => ctx, event_types: { APP_READY: 'ready' }, eventSource: { once: (_, cb) => { ready = cb; } }, saveChat: async () => { saves++; } };
  const network = {
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
    '@silly-tavern/scripts/extensions.js': { writeExtensionFieldBulk: async (avatars, key, fields) => {
      assert.equal(avatars.length, 1); assert.equal(avatars[0], 'test.png'); assert.equal(key, 'memu'); assert.equal(fields.retained, 7);
      if (updated.length) ctx.characters[0].data.extensions.memu = fields;
      return { updated };
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
  ctx.characters[0].name = 'testsoul'; souls = []; utils.refreshMemuGate();
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
  ctx.characters[0].name = 'TestSoul'; souls = ['TestSoul']; utils.refreshMemuGate();
  ctx.characters[0].data.extensions.memu.disabled = false;
  await utils.initChatExtraInfo(ctx, 'IgnoredName');
  assert.equal(extras.baseInfo.userName, 'TestOwner'); assert.equal(owner, 'TestOwner');
  ctx.characters[0].name = 'NewSoul'; utils.refreshMemuGate();
  await utils.initChatExtraInfo(ctx, 'OtherOwner');
  assert.equal(creates, 1); assert.equal(owner, 'TestOwner'); assert.equal(extras.baseInfo.userName, 'OtherOwner');
  ctx.characters[0].name = 'OtherSoul'; souls.push('OtherSoul'); utils.refreshMemuGate();
  await utils.initChatExtraInfo(ctx);
  assert.equal(extras.baseInfo.userName, 'OtherOwner');
  names.OtherSoul = ''; await assert.rejects(utils.initChatExtraInfo(ctx), /missing binding/);

  ctx.characters[0].name = 'FailedToggleSoul'; utils.refreshMemuGate();
  let cardWrites = 0, switchError;
  const change = {
    st, switchBusy: false, persona: 'created.png', personaLocked: false,
    power_user: native.power_user, currentScope: utils.currentScope,
    initChatExtraInfo: utils.initChatExtraInfo,
    async writeMemuDisabled(character, disabled) {
      updated = ++cardWrites === 2 ? [] : ['test.png'];
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
  assert.equal(ctx.characters[0].data.extensions.memu.disabled, true);
  assert.equal(await utils.isMemuActive(), false);
  const previousCreates = creates, previousWrites = cardWrites;
  change.persona = 'deleted-persona';
  await change.changeMemu(true);
  assert.equal(creates, previousCreates); assert.equal(cardWrites, previousWrites);
  updated = ['test.png']; ctx.characters[0].name = 'OtherSoul';
  ctx.characters[0].data.extensions.memu.disabled = false;
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
    'utils/types': {}, '@silly-tavern/scripts/world-info.js': {}, './utils': utils, 'utils/log': log, 'ui/inspect-panel': {},
  }, { window: { setTimeout: () => 1, clearTimeout() {} }, AbortController });
  assert.equal(producer.messageRole({ is_user: true, name: 'OtherOwner' }, 'OtherOwner'), 'user');
  assert.equal(producer.messageRole({ is_user: true, name: 'Renamed' }, 'OtherOwner'), 'unknown');
  assert.equal(producer.messageRole({ is_user: true, name: 'TestOwner' }, 'OtherOwner'), 'unknown');
  names.OtherSoul = 'OtherOwner';
  ctx.name1 = 'UnrelatedActivePersona';
  ctx.chat = [{ is_user: true, name: 'OtherOwner', mes: 'Owner row' }, { is_user: true, name: 'Renamed', mes: 'Latest human row' }];
  const query = await producer.query();
  assert.equal(query.userName, 'Renamed'); assert.equal(query.queryText, 'Latest human row');
  assert.equal(query.history[0].role, 'user');
  st.toolManager = { isToolCallingSupported: () => false };
  st.regex_placement = {}; st.getRegexedString = value => value; st.appendFileContent = async (_, value) => value;
  const savedRows = await producer.saved(0, 1);
  assert.equal(savedRows[0].role, 'user'); assert.equal(savedRows[1].role, 'unknown'); assert.equal(savedRows[1].name, 'Renamed');
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
  console.log('Character gate, native dispatcher, persona binding, card failures, producer roles and parent-to-copy polling pass.');
})().catch(error => { console.error(error); process.exitCode = 1; });
