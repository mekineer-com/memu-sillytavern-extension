const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const source = fs.readFileSync(`${__dirname}/../src/memory/memorize.ts`, 'utf8');
const sandbox = {
  exports: {}, memuExtras: { baseInfo: { userName: 'TestOwner', characterName: 'TestSoul' } },
};
vm.runInNewContext(ts.transpileModule(source.slice(source.indexOf('function resolveMessageTsMs('),
  source.indexOf('function _chatContentText(')), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, sandbox);
const rows = [
  { name: 'TestOwner', is_user: true, mes: 'hello', send_date: '1970-01-01T00:00:01.000Z', extra: { append_title: true, title: 'must not append', file: { name: 'must not expand' } } },
  { name: 'TestSoul', mes: 'hidden', is_system: true, extra: { tool_invocations: [{ name: 'fictional-tool' }] } },
  { name: 'TestSoul', mes: '  ' },
  { name: 'TestSoul', mes: 'reply', send_date: '1970-01-01T00:00:02.000Z' },
  { name: 'OtherPersona', is_user: true, mes: 'other human' },
  { name: 'TestSoul', mes: 'narration', extra: { type: 'narrator' } },
  { name: 'OtherCharacter', mes: 'another character' },
];
const plain = JSON.parse(JSON.stringify(sandbox.buildTurnHistory(rows, rows.length)));
assert.deepEqual(plain.map(row => row.role), ['user', 'soul', 'unknown', 'unknown', 'unknown']);
assert.deepEqual(plain.map(row => row.source_conversation_index), [0, 3, 4, 5, 6]);
assert.deepEqual(plain.map(row => row.source_message_id), ['0', '3', '4', '5', '6']);
assert.equal(plain[1].ts_ms, 2000);
assert.equal(plain[2].name, 'OtherPersona');
assert.deepEqual(JSON.parse(JSON.stringify(sandbox.buildTurnHistory([], 0))), []);
console.log('Plain ST history keeps original source IDs, hidden exclusions, timestamps and speaker attribution.');

function load(file, imports, globals) {
  const ctx = { exports: {}, require: name => {
    assert(name in imports, `Unexpected import ${name}`);
    return imports[name];
  }, ...globals };
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(`${__dirname}/../src/${file}`, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS },
  }).outputText, ctx);
  return ctx.exports;
}
const flush = () => new Promise(resolve => setImmediate(resolve));
(async () => {
  const statuses = { PENDING: 'PENDING', PROCESSING: 'PROCESSING', SUCCESS: 'SUCCESS', FAILURE: 'FAILURE' };
  const extras = { baseInfo: { userId: 'TestOwner', userName: 'TestOwner', characterId: 'TestSoul', characterName: 'TestSoul' } };
  let scope = 'loaded-main', saves = 0, reads = 0, publications = [], alerts = [], inspectWrites = 0, undos = [];
  let ctx = { chatId: 'renamed-main', chatMetadata: { integrity: 'test-main' }, characterId: 0,
    characters: [{ name: 'TestSoul', avatar: 'test.png' }], getCurrentChatId: () => ctx.chatId,
    chat: [{ name: 'TestOwner', is_user: true, mes: 'UNSAVED must never publish' }] };
  let persisted = [{ chat_metadata: { integrity: 'test-main' } }, ...rows];
  let settings = { version: 4, useServerSettings: false, useClaudeCode: true, defaultProfileId: 'captured-profile', stepProfileId: { reflection: 'captured-reflection' } };
  let admission = { status: 'deferred' }, nativeRead, proxyWait, proxyError = false, listenResponse;
  let importLorebooks = false, categoriesResponse = { categories: [] }, lorebooks = [];
  const fetch = async (url, options) => {
    let result;
    if (url === '/csrf-token') result = { token: 'fictional-csrf' };
    else if (url === '/api/plugins/memu/config') result = options.method === 'POST'
      ? { ok: true, config: structuredClone(settings) } : structuredClone(settings);
    else if (url === '/api/chats/get') {
      reads++;
      assert.equal(options.headers['x-csrf-token'], 'fictional-csrf');
      assert.deepEqual(JSON.parse(options.body), { file_name: 'renamed-main', avatar_url: 'test.png' });
      result = nativeRead ? await nativeRead() : structuredClone(persisted);
    } else if (url.startsWith('/api/plugins/memu/memorizeConversation')) {
      publications.push({ url, body: JSON.parse(options.body) });
      if (proxyError) return { ok: false, status: 409, text: async () => JSON.stringify({ error: { code: 'soul_paused', message: 'TestSoul is paused' } }) };
      if (proxyWait) await proxyWait();
      result = admission;
    } else if (url === '/api/plugins/memu/conversationRetrieve') {
      result = { turn_system_prompt: 'Fictional system', turn_user_prompt: 'Fictional human message' };
    } else if (url === '/api/plugins/memu/conversationTurn') {
      result = listenResponse;
    } else if (url === '/api/plugins/memu/conversationTurnUndo') {
      undos.push(JSON.parse(options.body));
      result = { status: 'restored' };
    } else if (url === '/api/plugins/memu/retrieveDefaultCategories') {
      result = categoriesResponse;
    } else if (url === '/api/worldinfo/list') {
      result = lorebooks.map(name => ({ name }));
    } else if (url === '/api/worldinfo/delete') {
      const { name } = JSON.parse(options.body);
      lorebooks = lorebooks.filter(book => book !== name);
      result = {};
    } else assert.fail(`Unexpected request ${url}`);
    return { ok: true, status: 200, json: async () => result };
  };
  const csrf = load('utils/csrf.ts', {}, { fetch });
  const network = load('utils/network.ts', { 'utils/csrf': csrf }, { fetch });
  assert.throws(() => network.captureRuntimeSettings(), /not loaded/);
  await network.getPluginConfig();
  const st = { getContext: () => ctx, saveChat: async () => { saves++; } };
  const utils = { currentScope: () => scope, initChatExtraInfo: async () => {},
    isMemuActive: async () => !ctx.chatMetadata.main_chat && !ctx.groupId && !ctx.disabled };
  const log = { warn() {}, error() {}, onceWarn() {}, onceError() {}, info() {} };
  const globals = { window: { alert: value => alerts.push(value), setTimeout, clearTimeout }, AbortController, console, fetch };
  let inspection;
  const producer = load('memory/memorize.ts', {
    'utils/context-extra': { st, memuExtras: extras, IMPORT_LOREBOOKS: { get: () => importLorebooks }, MENTAL_HEALTH_ADDON: { get: () => false } }, 'utils/network': network, 'utils/csrf': csrf,
    'utils/types': { MemuTaskStatus: statuses }, '@silly-tavern/scripts/world-info.js': { updateWorldInfoList: async () => {} },
    './utils': utils, 'utils/log': log, 'ui/inspect-panel': {
      getInspectData: () => inspection, stashInspectData: value => { inspection = value; }, seedInspectPromptTextarea() {},
    },
  }, globals);
  const bound = producer.bindSavedSource();
  settings = { ...settings, useServerSettings: true, useClaudeCode: false, defaultProfileId: 'later-profile', stepProfileId: { reflection: 'later-reflection' } };
  await network.setPluginConfig(settings);
  await producer.publishSavedSource(bound, 'manual', { force: true });
  let wire = publications.at(-1);
  assert.equal(wire.url, '/api/plugins/memu/memorizeConversation?rebuild=true');
  assert.equal(wire.body.runtimeSettings.defaultProfileId, 'captured-profile');
  assert.equal(wire.body.runtimeSettings.useClaudeCode, true);
  assert.equal(wire.body.runtimeSettings.stepProfileId.reflection, 'captured-reflection');
  assert.equal(network.captureRuntimeSettings().stepProfileId.reflection, 'later-reflection');
  assert.equal(wire.body.intent, 'manual'); assert.equal(wire.body.conversationId, 'integrity:test-main');
  assert.equal(wire.body.source_message_count, rows.length);
  assert.deepEqual(wire.body.conversation.map(row => row.source_conversation_index), [0, 3, 4, 5, 6]);
  assert.equal(wire.body.conversation[1].content, 'reply');
  assert.equal(wire.body.conversation[1].ts_ms, 2000); assert.equal(wire.body.conversation[0].content, 'hello');
  assert.equal(extras.summary, undefined); assert.equal(saves, 0);
  // Headerless native rows keep their first real message; empty saved header is valid.
  for (const [saved, count] of [[[rows[0]], 1], [[{ chat_metadata: {} }], 0]]) {
    persisted = saved; await producer.publishSavedSource(bound, 'publish_only');
    assert.equal(publications.at(-1).body.source_message_count, count);
  }
  for (const saved of [[], {}, [null], [{}], [{ chat_metadata: {} }, null]]) {
    persisted = saved;
    const before = publications.length;
    await assert.rejects(producer.publishSavedSource(bound, 'manual'), /missing|unreadable/);
    assert.equal(publications.length, before);
  }
  persisted = [{ chat_metadata: { main_chat: 'parent', integrity: 'test-main' } }, rows[0]];
  const beforeCopy = publications.length;
  await producer.publishSavedSource(bound, 'manual');
  assert.equal(publications.length, beforeCopy); assert.equal(extras.summary, undefined);
  persisted = [{ chat_metadata: {} }, rows[0], rows[3]];
  proxyError = true;
  await assert.rejects(producer.publishSavedSource(bound, 'automatic'), error => error.code === 'soul_paused');
  assert.equal(extras.summary, undefined);
  proxyError = false;
  // Serialize both the native read AND admission; rejection must recover the chain.
  let releaseRead, releaseProxy;
  nativeRead = () => new Promise(resolve => { releaseRead = resolve; });
  proxyWait = () => new Promise(resolve => { releaseProxy = resolve; });
  const old = producer.publishSavedSource(bound, 'automatic');
  const rewind = producer.publishSavedSource(bound, 'publish_only');
  await flush(); const readsAtWait = reads;
  nativeRead = null;
  releaseRead([{ chat_metadata: {} }, rows[0], rows[3]]);
  await flush(); assert.equal(reads, readsAtWait); // second read cannot overtake first admission
  proxyWait = null; releaseProxy(); await old; await rewind;
  assert.deepEqual(publications.slice(-2).map(p => p.body.intent), ['automatic', 'publish_only']);
  persisted = [{ chat_metadata: {} }];
  await producer.publishSavedSource(bound, 'publish_only'); // empty rewind
  assert.equal(publications.at(-1).body.source_message_count, 0);
  persisted = [{ chat_metadata: {} }, rows[0]];
  await producer.publishSavedSource(bound, 'automatic'); // regrowth position zero
  assert.equal(publications.at(-1).body.conversation[0].source_conversation_index, 0);
  // Publication cannot mutate a later selected chat's status, even for accepted work.
  nativeRead = () => new Promise(resolve => { releaseRead = resolve; });
  admission = { status: 'accepted', taskId: 'real-task' };
  const changed = producer.publishSavedSource(bound, 'manual');
  await flush(); scope = 'loaded-other'; extras.baseInfo = { ...extras.baseInfo, characterName: 'OtherSoul' };
  nativeRead = null; releaseRead(persisted); await changed;
  assert.equal(publications.at(-1).body.soulId, 'TestSoul');
  assert.equal(extras.summary, undefined); assert.equal(saves, 0);
  scope = bound.scope; extras.baseInfo.characterName = 'TestSoul';
  await producer.publishSavedSource(bound, 'manual');
  assert.equal(extras.summary.summaryTaskId, 'real-task'); assert.equal(extras.summary.summaryTaskStatus, 'PENDING');
  const activeSummary = extras.summary;
  for (const status of ['waiting_for_import', 'deferred', 'nothing_to_memorize', 'published', 'coalesced']) {
    admission = { status }; await producer.doSummary(0, 0, { tail: true });
    assert.equal(extras.summary, activeSummary); assert.equal(saves, 1);
  }
  for (const meta of [{ main_chat: 'ui-checkpoint' }, { main_chat: 'command-branch' }]) {
    ctx.chatMetadata = meta;
    const before = reads;
    for (const disabled of [true, false]) {
      ctx.disabled = disabled;
      await producer.memorizeNow(); await producer.doSummary(0, 0);
    }
    assert.equal(reads, before); assert.equal(extras.summary, activeSummary);
  }
  ctx.disabled = false; ctx.chatMetadata = { integrity: 'test-main' };
  const calls = { replies: 0, turnErrors: 0 };
  let duringSave;
  ctx.saveReply = async ({ getMessage }) => {
    calls.replies++;
    ctx.chat.push({ name: 'TestSoul', mes: getMessage, extra: {}, gen_finished: new Date(calls.replies * 1000),
      swipe_id: 0, swipes: [getMessage], swipe_info: [{ extra: {} }] });
    await hooks.onMessageReceived(ctx.chat.length - 1);
    if (duringSave) duringSave();
  };
  st.saveChat = async () => { saves++; }; // swallowed persistence failure: server still returns prior saved rows
  const hookMemory = { ...producer, preparePendingRetrieveTurnForInterceptor: async () => true,
    dispatchConversationTurn: async () => ({ reply: 'Newest saved reply', savedSource: bound,
      generationMetadata: { api: 'test-api', model: 'test-model', turn_id: `test-turn-${calls.replies + 1}` } }),
    dropPendingTurnIfStopped: () => false };
  const hooks = load('memory/exports.ts', {
    'utils/context-extra': { st, memuExtras: extras, OVERRIDE_SUMMARIZER: { get: () => true } },
    './memorize': hookMemory, './utils': utils, './summary-poller': {},
    'utils/network': network, 'utils/log': log,
    'ui/inspect-panel': { getInspectData: () => null, stashInspectData: value => { inspectWrites++; if (value.turnStatus === 'error') calls.turnErrors++; } },
  }, globals);
  let aborts = 0;
  const generate = () => hooks.memuGenerationInterceptor([], 0, () => { aborts++; }, 'normal');
  const beforeReply = publications.length;
  await generate();
  assert.equal(publications.length, beforeReply + 1);
  assert.equal(publications.at(-1).body.intent, 'automatic');
  assert.equal(publications.at(-1).body.source_message_count, 1); // no unsaved fallback after swallowed save
  assert.equal(ctx.chat.at(-1).extra.model, 'test-model');
  assert.equal(ctx.chat.at(-1).extra.memu_turn_id, 'test-turn-1');
  assert.equal(ctx.chat.at(-1).swipe_info[0].extra.memu_turn_id, 'test-turn-1');
  // Successful persistence captures the newest reply and stamps metadata before saved-file read.
  st.saveChat = async () => { saves++; persisted = [{ chat_metadata: {} }, ...structuredClone(ctx.chat)]; };
  await generate();
  assert.equal(publications.at(-1).body.conversation.at(-1).content, 'Newest saved reply');
  assert.equal(publications.at(-1).body.source_message_count, ctx.chat.length);
  st.saveChat = async () => { saves++; persisted = []; };
  const beforeError = calls.replies;
  await generate();
  assert.equal(calls.replies, beforeError + 1); assert.equal(calls.turnErrors, 0); assert.equal(inspectWrites, 0);
  assert.match(alerts.at(-1), /saved chat Memorize failed/);
  const beforeSave = saves, beforePublish = publications.length;
  duringSave = () => { scope = 'loaded-copy'; ctx.chatMetadata = { main_chat: 'parent' }; };
  await generate();
  assert.equal(saves, beforeSave); assert.equal(publications.length, beforePublish);
  assert.equal(ctx.chat.at(-1).extra.model, undefined);
  // An opted-out copy stays native, including Continue.
  const beforeAbort = aborts;
  await hooks.memuGenerationInterceptor([], 0, () => { aborts++; }, 'continue');
  assert.equal(aborts, beforeAbort);
  scope = bound.scope; ctx.chatMetadata = { integrity: 'test-main' }; duringSave = null;
  ctx.chat = [rows[0]];
  persisted = [{ chat_metadata: {} }, rows[0], { name: 'TestSoul', mes: 'Deleted reply still on disk' }];
  const beforeDeleteSave = saves;
  admission = { status: 'published' };
  let releaseDeletionSave;
  ctx.saveChat = async () => {
    saves++;
    await new Promise(resolve => { releaseDeletionSave = resolve; });
    persisted = [{ chat_metadata: {} }, ...structuredClone(ctx.chat)];
  };
  const deletion = hooks.onMessageDeleted();
  const beforeDeletionPublish = publications.length;
  await flush();
  assert.equal(typeof releaseDeletionSave, 'function');
  assert.equal(publications.length, beforeDeletionPublish);
  releaseDeletionSave(); await deletion;
  assert.equal(publications.at(-1).body.intent, 'publish_only');
  assert.equal(publications.at(-1).body.source_message_count, 1);
  assert.deepEqual(publications.at(-1).body.conversation.map(row => row.content), [rows[0].mes]);
  assert.equal(saves, beforeDeleteSave + 1);
  const beforeSwitchPublish = publications.length;
  const switchedDeletion = hooks.onMessageDeleted(); await flush();
  scope = 'other-chat'; releaseDeletionSave(); await switchedDeletion;
  assert.equal(publications.length, beforeSwitchPublish);
  scope = bound.scope;
  ctx.saveChat = async () => { saves++; persisted = [{ chat_metadata: {} }, ...structuredClone(ctx.chat)]; };
  // Removing a native off-mode reply must not Undo the MCP reply still in the chat.
  const user = { name: 'TestOwner', is_user: true, mes: 'Fictional request' };
  const mcpReply = { name: 'TestSoul', mes: 'MCP reply', gen_finished: '2026-01-01T00:00:00.000Z',
    extra: { memu_turn_id: 'mcp-reply-a', memu_turn_finished: Date.parse('2026-01-01T00:00:00.000Z') },
    swipe_id: 0, swipes: ['MCP reply'], swipe_info: [{ extra: {} }] };
  const nativeReply = { name: 'TestSoul', mes: 'Native reply', gen_finished: '2026-01-01T00:01:00.000Z',
    extra: { ...mcpReply.extra }, swipe_id: 0, swipes: ['Native reply'] };
  const beforeUndo = undos.length;
  ctx.chat = [user, mcpReply];
  await hooks.onMessageReceived(1);
  ctx.disabled = true;
  ctx.chat.push(user, nativeReply);
  await hooks.onMessageReceived(3);
  ctx.disabled = false;
  ctx.chat.pop();
  await hooks.onMessageDeleted(); await flush();
  assert.equal(undos.length, beforeUndo);
  ctx.chat.push(nativeReply);
  await hooks.onMessageReceived(3);
  nativeReply.swipe_id = nativeReply.swipes.length;
  delete nativeReply.gen_finished; // native swipe overshoot resets this before its event
  await hooks.onMessageSwiped(3); await flush();
  assert.equal(undos.length, beforeUndo);
  // Reloaded dates and genuine MCP regeneration use the prior selected variant.
  ctx.chat = [user, structuredClone(mcpReply)];
  await hooks.onMessageReceived(1);
  ctx.chat[1].swipe_id = ctx.chat[1].swipes.length;
  delete ctx.chat[1].gen_finished;
  await hooks.onMessageSwiped(1); await flush();
  assert.equal(undos.length, beforeUndo + 1);
  assert.deepEqual(undos.at(-1), { conversationId: 'integrity:test-main', userId: 'TestOwner', soulId: 'TestSoul', turnId: 'mcp-reply-a' });
  await hooks.onMessageSwiped(1); await flush();
  assert.equal(undos.length, beforeUndo + 1);
  ctx.chat = [user, structuredClone(mcpReply)];
  await hooks.onMessageReceived(1);
  ctx.chat.pop();
  await hooks.onMessageDeleted(); await flush();
  assert.equal(undos.length, beforeUndo + 2);
  // Invalid dates and untagged old replies do not qualify.
  for (const reply of [{ ...mcpReply, gen_finished: 'invalid' }, { ...mcpReply, extra: {} }]) {
    ctx.chat = [user, reply];
    await hooks.onMessageReceived(1);
    ctx.chat.pop(); await hooks.onMessageDeleted(); await flush();
    assert.equal(undos.length, beforeUndo + 2);
  }
  ctx.chat = [user, { ...structuredClone(mcpReply), gen_finished: new Date(mcpReply.gen_finished) }];
  await hooks.onMessageReceived(1); ctx.chat.pop();
  await hooks.onMessageDeleted(); await flush();
  assert.equal(undos.length, beforeUndo + 3);
  // Browsing an older saved variant is inert; regenerating it identifies that variant, not the newest one.
  ctx.chat = [user, { ...structuredClone(mcpReply), swipes: ['old', 'new'], swipe_id: 1 }];
  await hooks.onMessageReceived(1);
  ctx.chat[1].swipe_id = 0;
  ctx.chat[1].extra.memu_turn_id = 'older-variant';
  await hooks.onMessageSwiped(1); await flush();
  assert.equal(undos.length, beforeUndo + 3);
  ctx.chat[1].swipe_id = 2; delete ctx.chat[1].gen_finished;
  await hooks.onMessageSwiped(1); await flush();
  assert.equal(undos.at(-1).turnId, 'older-variant');
  const undoCount = undos.length;
  // A chat switch during async initialization cannot Undo the new chat.
  ctx.chat = [user, structuredClone(mcpReply)];
  await hooks.onMessageReceived(1); ctx.chat.pop();
  utils.initChatExtraInfo = async () => { scope = 'other-chat'; };
  await hooks.onMessageDeleted(); await flush();
  assert.equal(undos.length, undoCount);
  scope = bound.scope; utils.initChatExtraInfo = async () => {};
  ctx.chatMetadata = { main_chat: 'parent' };
  ctx.chat = [user, structuredClone(mcpReply)];
  await hooks.onMessageReceived(1); ctx.chat.pop();
  await hooks.onMessageDeleted(); await flush();
  assert.equal(undos.length, undoCount);
  ctx.chatMetadata = { integrity: 'test-main' };
  console.log('Reply-scoped Undo keeps native/inherited swipes inert and matches saved MCP generations.');
  extras.summary = undefined; persisted = [];
  const beforeRefusedSave = saves;
  await producer.doSummary(0, 0);
  assert.equal(extras.summary, undefined); assert.equal(saves, beforeRefusedSave);
  assert.match(alerts.at(-1), /Saved chat is missing or unreadable/);
  // Real retrieve + dispatch must hand successful listen's saved source to the interceptor.
  let listenResult;
  hookMemory.preparePendingRetrieveTurnForInterceptor = producer.preparePendingRetrieveTurnForInterceptor;
  hookMemory.dispatchConversationTurn = async options => {
    listenResult = await producer.dispatchConversationTurn(options);
    return listenResult;
  };
  ctx.chat = [rows[0], { name: 'TestOwner', is_user: true, mes: 'New saved human message', send_date: '1970-01-01T00:00:03.000Z' }];
  ctx.saveReply = async () => assert.fail('Successful listen must not save an assistant reply');
  st.saveChat = async () => { saves++; persisted = [{ chat_metadata: {} }, ...structuredClone(ctx.chat)]; };
  admission = { status: 'deferred' }; extras.summary = undefined;
  for (const decision of [{ response_target: 'listen' }, { should_respond: false }]) {
    listenResponse = { ok: true, response: '', ...decision };
    const beforeListenSave = saves, beforeListenPublish = publications.length;
    await generate();
    assert.equal(listenResult.reply, '');
    assert.equal(listenResult.savedSource.scope, bound.scope);
    assert.equal(inspection.turnStatus, 'ok');
    assert.equal(saves, beforeListenSave + 1);
    assert.equal(publications.length, beforeListenPublish + 1);
    assert.equal(publications.at(-1).body.intent, 'automatic');
    assert.equal(publications.at(-1).body.source_message_count, 2);
    assert.deepEqual(publications.at(-1).body.conversation.map(row => row.content), ['hello', 'New saved human message']);
    assert.deepEqual(publications.at(-1).body.conversation.map(row => row.source_conversation_index), [0, 1]);
    assert.equal(extras.summary, undefined);
  }
  console.log('Real successful listen dispatch publishes saved human rows automatically, without saveReply or an invented task.');
  // Exercise the actual menu action, not a replacement rebuild handler.
  const indexSource = fs.readFileSync(`${__dirname}/../src/index.tsx`, 'utf8');
  const reset = { currentScope: utils.currentScope, isMemuActive: utils.isMemuActive,
    info: log.info, logError: log.error, require: name => {
      if (name === './utils/context-extra') return { st };
      if (name === './memory/memorize') return producer;
      assert.fail(`Unexpected rebuild import ${name}`);
    } };
  vm.runInNewContext(ts.transpileModule(indexSource.slice(indexSource.indexOf('    async function resetCursor()'),
    indexSource.indexOf('\n\n    function tryInstall()')), {
    compilerOptions: { module: ts.ModuleKind.CommonJS },
  }).outputText, reset);
  const menu = { anchor: { addEventListener: (_event, callback) => { menu.click = callback; } },
    isMemuActive: utils.isMemuActive, isMemorizeActive: () => false,
    window: { confirm: () => true }, document: { getElementById: () => null },
    resetCursor: reset.resetCursor, require: reset.require };
  vm.runInNewContext(ts.transpileModule(indexSource.slice(indexSource.indexOf("        anchor.addEventListener('click'"),
    indexSource.indexOf('\n\n        // Place it near')), {
    compilerOptions: { module: ts.ModuleKind.CommonJS },
  }).outputText, menu);
  reset.resetCursor = () => menu.click({ preventDefault() {} });
  const beforeMissingCard = publications.length;
  for (const missing of [null, undefined]) {
    ctx.characterId = missing; await reset.resetCursor();
  }
  assert.equal(publications.length, beforeMissingCard);
  ctx.characterId = 0;
  importLorebooks = true;
  lorebooks = ['memU - TestSoul - Old', 'memU - OtherSoul - Private', 'Manual book'];
  extras.summary = { summaryTaskId: 'old-task', summaryTaskStatus: 'SUCCESS', summaryRange: [0, 1] };
  extras.retrieve = { history: [], nowRetrieve: { summaryTaskId: 'old-task', summary: 'Old dossier prose' } };
  ctx.chatMetadata = { integrity: 'test-main', memuExtras: extras };
  ctx.chat = [rows[0], rows[3]];
  persisted = [{ chat_metadata: {} }, ...ctx.chat];
  const beforeMetadata = JSON.stringify(ctx.chatMetadata), beforeBooks = [...lorebooks], beforeSaves = saves;
  for (const status of ['deferred', 'waiting_for_import', 'nothing_to_memorize', 'published', 'coalesced']) {
    admission = { status }; await reset.resetCursor();
    assert.equal(JSON.stringify(ctx.chatMetadata), beforeMetadata);
    assert.deepEqual(lorebooks, beforeBooks); assert.equal(saves, beforeSaves);
    assert.match(publications.at(-1).url, /rebuild=true/);
  }
  proxyError = true; await reset.resetCursor(); proxyError = false;
  assert.match(alerts.at(-1), /TestSoul is paused/);
  assert.equal(JSON.stringify(ctx.chatMetadata), beforeMetadata);
  assert.deepEqual(lorebooks, beforeBooks); assert.equal(saves, beforeSaves);
  persisted = []; await reset.resetCursor();
  assert.equal(JSON.stringify(ctx.chatMetadata), beforeMetadata);
  assert.deepEqual(lorebooks, beforeBooks); assert.equal(saves, beforeSaves);
  const beforeEmpty = publications.length;
  ctx.chat = []; await reset.resetCursor();
  assert.equal(publications.length, beforeEmpty); assert.equal(saves, beforeSaves);
  assert.equal(JSON.stringify(ctx.chatMetadata), beforeMetadata); assert.deepEqual(lorebooks, beforeBooks);
  ctx.chat = [rows[0], rows[3]]; persisted = [{ chat_metadata: {} }, ...ctx.chat];
  admission = { status: 'accepted', taskId: 'rebuilt-task' };
  await reset.resetCursor();
  assert.equal(extras.summary.summaryTaskId, 'rebuilt-task');
  assert.equal(extras.summary.summaryTaskStatus, 'PENDING'); assert.equal(extras.summary.force, true);
  assert.equal(saves, beforeSaves + 1); assert.deepEqual(lorebooks, beforeBooks);
  const completed = extras.summary; completed.summaryTaskStatus = 'SUCCESS';
  categoriesResponse = {}; await producer.retrieveMemories(completed);
  assert.deepEqual(lorebooks, beforeBooks); // malformed data must never be treated as an empty result
  categoriesResponse = { categories: [] }; await producer.retrieveMemories(completed);
  assert.deepEqual(lorebooks, ['memU - OtherSoul - Private', 'Manual book']);
  assert.equal(extras.retrieve.nowRetrieve.summaryTaskId, 'rebuilt-task');
  console.log('Refused rebuild leaves ST metadata/books untouched; accepted empty completion prunes only its managed books.');
  console.log('Saved capture, missing/empty/copy source, serialized read/admission, frozen scope/settings, rewind and post-save boundaries pass.');
})().catch(error => { console.error(error); process.exitCode = 1; });
