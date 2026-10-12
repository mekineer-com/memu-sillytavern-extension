const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const jsx = require('react/jsx-runtime');
const source = fs.readFileSync(`${__dirname}/../src/memory/utils.ts`, 'utf8');
let card, stored, writes = 0, metadataWrites = 0, reads = 0, narrative = 'Real self', edit = () => {}, readEdit = () => {}, writeEdit = () => {};
let metadataWait;
const inputs = Object.fromEntries(['avatar_url_pole', 'character_json_data', 'description_textarea', 'personality_textarea', 'scenario_pole', 'mes_example_textarea'].map(id => [id, { id, value: '' }]));
const fields = { description: 'description_textarea', personality: 'personality_textarea', scenario: 'scenario_pole', mes_example: 'mes_example_textarea' };
const ctx = { characters: [], characterId: 0, chatMetadata: {}, getCurrentChatId: () => 'main',
  getOneCharacter: async () => { card = structuredClone(stored); card.json_data = JSON.stringify(stored); ctx.characters[0] = card; } };
function show(description = '', extra = {}) {
  card = { avatar: 'test.png', name: 'TestSoul', description, personality: '', scenario: '', mes_example: '',
    data: { extensions: { memu: { disabled: false, enabled_for: 'TestSoul', retained: 7 } } }, ...extra };
  stored = structuredClone(card); card.json_data = JSON.stringify(stored); ctx.characters[0] = card;
  inputs.avatar_url_pole.value = card.avatar; inputs.character_json_data.value = card.json_data;
  for (const [field, id] of Object.entries(fields)) inputs[id].value = card[field];
}
const network = { getSouls: async () => ({ souls: ['TestSoul'] }), getSoul: async (id, live) => {
  assert.equal(id, 'TestSoul'); assert.equal(live, true); reads++; readEdit();
  return { user_name: 'TestOwner', narrative_self: narrative };
} };
const st = { getContext: () => ctx, event_types: { APP_READY: 'ready' }, eventSource: { once: (_event, callback) => callback() } };
const imports = {
  'utils/context-extra': { st }, 'utils/network': network, '@silly-tavern/scripts/power-user.js': {},
  '@silly-tavern/script.js': {},
  'utils/csrf': { getCsrfTokenCached: async () => { edit(); return 'test-token'; } },
  '@silly-tavern/scripts/extensions.js': { extension_settings: { memu: { soulCards: { TestSoul: 'test.png' } } },
    writeExtensionFieldBulk: async (avatars, key, metadata) => {
      assert.deepEqual(Array.from(avatars), ['test.png']); assert.equal(key, 'memu'); metadataWrites++;
      if (metadataWait) await metadataWait();
      stored.data.extensions.memu = structuredClone(metadata); card.data.extensions.memu = structuredClone(metadata);
      card.json_data = JSON.stringify(stored); inputs.character_json_data.value = card.json_data;
      return { updated: ['test.png'] };
    } },
};
const context = { exports: {}, require: name => { assert(name in imports, name); return imports[name]; },
  document: { getElementById: id => inputs[id] }, window: { alert: message => assert.fail(message) },
  fetch: async (url, options) => {
    assert.equal(url, '/api/characters/merge-attributes'); writes++;
    writeEdit();
    const payload = JSON.parse(options.body); assert.deepEqual(payload.avatars, ['test.png']);
    assert.equal(payload.data.description, payload.data.data.description);
    assert.equal(payload.data.data.extensions.memu.retained, 7);
    stored.description = payload.data.description;
    stored.data.description = payload.data.description;
    stored.data.extensions.memu = payload.data.data.extensions.memu;
    return { ok: true, json: async () => ({ updated: ['test.png'] }) };
  },
};
vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ESNext } }).outputText, context);
const utils = context.exports;
const producer = fs.readFileSync(`${__dirname}/../src/memory/memorize.ts`, 'utf8');
const projection = { cardText: utils.cardText };
vm.runInNewContext(ts.transpileModule(producer.slice(producer.indexOf('function resolveSoulCard('), producer.indexOf('function resolveMessageTsMs(')), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ESNext },
}).outputText, projection);
(async () => {
  show();
  await utils.refreshSoulCard();
  assert.equal(card.description, 'Real self'); assert.equal(inputs.description_textarea.value, 'Real self');
  assert.equal(JSON.parse(inputs.character_json_data.value).data.extensions.memu.description_auto, 'Real self');
  assert.equal(card.data.extensions.memu.disabled, false); assert.equal(card.data.extensions.memu.enabled_for, 'TestSoul');
  assert.equal(projection.resolveSoulCard(ctx), '');
  narrative = 'Real self evolved'; await utils.refreshSoulCard();
  assert.equal(card.description, narrative); assert.equal(writes, 2);
  // A later unrelated native whole-form save reads the refreshed Description and JSON.
  const nativeForm = JSON.parse(inputs.character_json_data.value);
  nativeForm.description = inputs.description_textarea.value; nativeForm.first_mes = 'Unrelated greeting';
  assert.equal(nativeForm.description, narrative); assert.equal(nativeForm.data.extensions.memu.description_auto, narrative);

  inputs.description_textarea.value = 'Manual self';
  utils.onSoulCardInput({ target: inputs.description_textarea });
  await new Promise(resolve => setImmediate(resolve));
  const beforeManual = [reads, writes, metadataWrites];
  inputs.description_textarea.value = narrative; // matching prose is not a reset
  utils.onSoulCardInput({ target: inputs.description_textarea });
  await new Promise(resolve => setImmediate(resolve));
  narrative = 'Another evolution'; await utils.refreshSoulCard();
  assert.equal(card.data.extensions.memu.description_auto, null);
  assert.deepEqual([reads, writes, metadataWrites], beforeManual);
  assert.match(projection.resolveSoulCard(ctx), /Real self evolved/);
  await ctx.getOneCharacter('test.png'); // durable manual state survives reload
  assert.equal(await utils.reconcileSoulCard(card), false);

  inputs.personality_textarea.value = 'Retained personality'; inputs.scenario_pole.value = 'Retained scenario';
  inputs.mes_example_textarea.value = 'Retained dialogue'; inputs.description_textarea.value = '';
  await utils.reconcileSoulCard(card, 'description'); await utils.refreshSoulCard();
  assert.equal(inputs.description_textarea.value, narrative);
  assert.equal(inputs.personality_textarea.value, 'Retained personality');
  assert.match(projection.resolveSoulCard(ctx), /Personality:\nRetained personality/);
  assert.match(projection.resolveSoulCard(ctx), /Scenario:\nRetained scenario/);
  assert.match(projection.resolveSoulCard(ctx), /Example dialogue:\nRetained dialogue/);
  inputs.scenario_pole.value = 'Later scenario edit'; await utils.reconcileSoulCard(card, 'scenario');
  assert.equal(card.data.extensions.memu.description_auto, null);

  show('Handwritten first-use card'); const beforeHandwritten = writes;
  await utils.refreshSoulCard(); assert.equal(writes, beforeHandwritten); assert.equal(card.description, 'Handwritten first-use card');
  for (const change of ['description', 'personality', 'avatar']) {
    show(); edit = () => {
      if (change === 'avatar') card.avatar = 'other.png';
      else inputs[fields[change]].value = 'Unsaved user edit';
    };
    const before = writes; await utils.refreshSoulCard(); assert.equal(writes, before);
    edit = () => {};
  }
  show(); readEdit = () => { inputs.description_textarea.value = 'Edited during live read'; };
  const beforeReadEdit = writes; await utils.refreshSoulCard(); assert.equal(writes, beforeReadEdit);
  assert.equal(inputs.description_textarea.value, 'Edited during live read'); readEdit = () => {};
  show(); writeEdit = () => {
    inputs.description_textarea.value = 'Edited during automatic save';
    utils.onSoulCardInput({ target: inputs.description_textarea });
  };
  await utils.refreshSoulCard(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(inputs.description_textarea.value, 'Edited during automatic save');
  assert.equal(card.data.extensions.memu.description_auto, null);
  assert.equal(JSON.parse(inputs.character_json_data.value).data.extensions.memu.description_auto, null);
  writeEdit = () => {};
  show(); writeEdit = () => {
    inputs.personality_textarea.value = 'Late manual Personality';
    utils.onSoulCardInput({ target: inputs.personality_textarea });
  };
  await utils.refreshSoulCard(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(card.data.extensions.memu.description_auto, null);
  assert.equal(inputs.personality_textarea.value, 'Late manual Personality');
  writeEdit = () => {};
  show(); inputs.avatar_url_pole.value = ''; // hidden/closed editor uses stored card text
  await utils.refreshSoulCard();
  assert.equal(card.description, narrative); assert.equal(card.data.extensions.memu.description_auto, narrative);
  show(); narrative = ''; await utils.refreshSoulCard();
  inputs.personality_textarea.value = 'Manual extras with empty real narrative';
  await utils.reconcileSoulCard(card, 'personality');
  assert.equal(await utils.reconcileSoulCard(card), false); // blank narrative must not erase sticky manual intent

  // Native bulk completion reapplies its snapshot. OFF must run after that save.
  show(); narrative = 'Real self'; await utils.refreshSoulCard();
  let releaseMetadata;
  metadataWait = () => { metadataWait = null; return new Promise(resolve => { releaseMetadata = resolve; }); };
  inputs.description_textarea.value = 'Manual during a slow metadata save';
  const manualSave = utils.reconcileSoulCard(card, 'description');
  await new Promise(resolve => setImmediate(resolve));
  const switchingOff = utils.writeMemuDisabled(card, true);
  await new Promise(resolve => setImmediate(resolve));
  releaseMetadata(); await manualSave; await switchingOff;
  assert.equal(card.data.extensions.memu.disabled, true);
  assert.equal(card.data.extensions.memu.description_auto, null);
  assert.equal(stored.data.extensions.memu.disabled, true);

  show(); let offDuringRead;
  readEdit = () => { offDuringRead = utils.writeMemuDisabled(card, true); };
  const beforeOff = writes; await utils.refreshSoulCard(); await offDuringRead;
  assert.equal(writes, beforeOff); assert.equal(card.data.extensions.memu.disabled, true);
  readEdit = () => {};

  for (const description of ['Copied automatic prose', '']) {
    show(description);
    card.data.extensions.memu = { ...card.data.extensions.memu, enabled_for: 'PreviousSoul',
      description_auto: description, card_text: utils.cardText(card) };
    await utils.writeMemuDisabled(card, false);
    assert.equal(card.data.extensions.memu.description_auto, description ? null : '');
    assert.equal(card.description, description);
  }

  const networkSource = fs.readFileSync(`${__dirname}/../src/utils/network.ts`, 'utf8');
  const settings = { useServerSettings: false, useClaudeCode: true, defaultProfileId: 'captured', stepProfileId: { reflection: 'captured-step' } };
  let wire;
  const transport = { exports: {}, pluginConfig: settings, request: async (route, payload, method) => { wire = { route, payload, method }; return {}; } };
  const transportCode = networkSource.slice(networkSource.indexOf('export function captureRuntimeSettings('), networkSource.indexOf('export async function serverStatus('))
    + networkSource.slice(networkSource.indexOf('export async function getSoul('), networkSource.indexOf('export async function getPluginConfig('))
    + networkSource.slice(networkSource.indexOf('export async function sendNarrativeSuggestion('), networkSource.indexOf('export async function listRelationships('));
  vm.runInNewContext(ts.transpileModule(transportCode, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ESNext } }).outputText, transport);
  await transport.exports.getSoul('Test Soul', true); assert.equal(wire.route, '/souls/Test%20Soul?include_narrative=true');
  await transport.exports.getSoul('Test Soul'); assert.equal(wire.route, '/souls/Test%20Soul');
  const sending = transport.exports.sendNarrativeSuggestion('TestOwner', 'TestSoul', 'Fictional request');
  settings.defaultProfileId = 'later'; settings.stepProfileId.reflection = 'later-step';
  await sending;
  assert.equal(wire.payload.runtimeSettings.defaultProfileId, 'captured');
  assert.equal(wire.payload.runtimeSettings.stepProfileId.reflection, 'captured-step');
  assert.equal(wire.payload.userId, 'TestOwner'); assert.equal(wire.payload.soulId, 'TestSoul');

  const component = fs.readFileSync(`${__dirname}/../src/component/NarrativeSuggestion.tsx`, 'utf8');
  const state = ['A fictional suggestion', 'idle', '', '']; let cursor = 0, sent = 0, refreshed = 0;
  const storage = new Map();
  const ui = { exports: {}, require: name => ({
    react: { useState: initial => { const index = cursor++; return [state[index] ?? initial, value => { state[index] = value; }]; } },
    'react/jsx-runtime': jsx, 'utils/context-extra': { memuExtras: { baseInfo: { userId: 'TestOwner', characterName: 'TestSoul' } } },
    'memory/utils': { isMemuActive: async () => true, currentScope: () => 'scope', refreshSoulCard: async () => { refreshed++; } },
    'utils/network': { sendNarrativeSuggestion: async () => { sent++; return { narrative_self: 'Unchanged real self' }; } },
  })[name], localStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) } };
  vm.runInNewContext(ts.transpileModule(component, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText, ui);
  function nodes(tree) { return !tree || typeof tree !== 'object' ? [] : Array.isArray(tree) ? tree.flatMap(nodes) : [tree, ...nodes(tree.props?.children)]; }
  const button = nodes(ui.exports.default({ enabled: true })).find(node => node.type === 'button');
  assert.equal(button.props.disabled, false); await button.props.onClick();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sent, 1); assert.equal(refreshed, 1); assert.equal(state[1], 'ok');
  assert(!component.includes('overrideActive')); assert(component.includes('not necessarily adopted'));
  console.log('Durable following/manual cards, Description-only reset, extras, fresh reads, unsaved editor protection and unrestricted suggestions pass.');
})().catch(error => { console.error(error); process.exitCode = 1; });
