const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

// Run the actual request decoder with a refused send, without a live ST session.
const source = fs.readFileSync(`${__dirname}/../src/utils/network.ts`, 'utf8');
const code = source.slice(source.indexOf('async function request<T>('));
const message = 'Test Soul is paused. Retry in OpenAlma launcher.';
const context = {
  ROUTER_BASE_URL: '/api/plugins/memu', AbortSignal, getCsrfTokenCached: async () => 'fake',
  fetch: async () => ({ status: 409, text: async () => JSON.stringify({ error: { code: 'soul_paused', message } }) }),
};
vm.runInNewContext(ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ESNext } }).outputText, context);
(async () => {
  await assert.rejects(context.request('/conversationTurn', {}), error => error.code === 'soul_paused' && error.message === message);
  const component = fs.readFileSync(`${__dirname}/../src/component/MemorizeProgress.tsx`, 'utf8');
  const summary = { summaryTaskStatus: 'PROCESSING', summaryTaskId: 'task-a' };
  const cancel = {
    isMemuActive: async () => true, currentScope: () => 'test.png/main',
    cancelling: false, memuExtras: { baseInfo: { userId: 'fictional-owner', characterId: 'fictional-soul' }, summary },
    cancelMemorize: async () => ({ ok: false }),
    setCancelling(value) { this.cancelling = value; },
    setRefusedTask(value) { this.refusedTask = value; },
    st: { saveChat: async () => assert.fail('Refused cancel must not save or hide progress') },
  };
  cancel.setCancelling = cancel.setCancelling.bind(cancel);
  cancel.setRefusedTask = cancel.setRefusedTask.bind(cancel);
  const taskKeyFunction = component.slice(component.indexOf('function currentTaskKey()'), component.indexOf('export default function'));
  vm.runInNewContext(ts.transpileModule(taskKeyFunction, { compilerOptions: { target: ts.ScriptTarget.ESNext } }).outputText, cancel);
  vm.runInNewContext(component.slice(component.indexOf('async function handleCancel()'), component.indexOf('\n  return createPortal(')), cancel);
  await cancel.handleCancel();
  assert.equal(cancel.memuExtras.summary, summary);
  assert.equal(cancel.cancelling, false);
  assert.equal(cancel.refusedTask, cancel.currentTaskKey());
  const other = { summaryTaskStatus: 'PROCESSING', summaryTaskId: 'task-b' };
  cancel.memuExtras.summary = other;
  assert.notEqual(cancel.refusedTask, cancel.currentTaskKey());
  let resolveCancel;
  cancel.cancelMemorize = () => new Promise(resolve => { resolveCancel = resolve; });
  for (const ok of [false, true]) {
    cancel.cancelling = false;
    cancel.memuExtras.summary = summary;
    const pending = cancel.handleCancel();
    await new Promise(resolve => setImmediate(resolve));
    cancel.memuExtras.summary = other;
    resolveCancel({ ok });
    await pending;
    assert.equal(cancel.memuExtras.summary, other);
    assert.notEqual(cancel.refusedTask, cancel.currentTaskKey());
  }
  cancel.cancelling = false;
  cancel.memuExtras.summary = summary;
  let saved = false;
  cancel.cancelMemorize = async () => ({ ok: true });
  cancel.st.saveChat = async () => { saved = true; };
  await cancel.handleCancel();
  assert.equal(cancel.memuExtras.summary, summary);
  assert.equal(saved, false);
  assert.equal(cancel.cancelling, true);
  cancel.cancelling = false; cancel.refusedTask = null;
  cancel.cancelMemorize = async () => { throw new Error('Temporary outage'); };
  await cancel.handleCancel();
  assert.equal(cancel.cancelling, false);
  assert.equal(cancel.refusedTask, null);
  assert.equal(cancel.memuExtras.summary.summaryTaskId, summary.summaryTaskId);
  assert.match(cancel.memuExtras.summary.lastError, /could not be confirmed/);
  cancel.isMemuActive = async () => { throw new Error('Discovery outage'); };
  await cancel.handleCancel();
  assert.equal(cancel.cancelling, false); assert.equal(cancel.refusedTask, null);
  cancel.isMemuActive = async () => true;
  // Failed paid work stays failed; only the separate category retrieval retries.
  const pollerSource = fs.readFileSync(`${__dirname}/../src/memory/summary-poller.ts`, 'utf8');
  let retrieved = 0;
  const failed = { summaryTaskStatus: 'FAILURE', summaryTaskId: null, summaryRange: [0, 2], failureCount: 3 };
  const poller = {
    exports: {},
    MAX_RETRIEVE_FAILURE_RETRIES: 2, isMemuActive: async () => true,
    MemuTaskStatus: { PENDING: 'PENDING', PROCESSING: 'PROCESSING', SUCCESS: 'SUCCESS', FAILURE: 'FAILURE' },
    memuExtras: { summary: failed }, retrieveMemories: async () => { retrieved++; },
    st: { saveChat: async () => assert.fail('Failure polling must not save or clear failed work') },
    onceError() {}, onceWarn() {}, currentScope: () => 'fictional-main',
  };
  let pollResponse;
  poller.getTaskStatus = async (user, soul) => {
    assert.equal(user, 'TestOwner'); assert.equal(soul, 'TestSoul'); return pollResponse;
  };
  poller.require = name => ({
    'utils/consts': { MEMU_DEFAULT_TIMEOUT: 30_000 },
    'utils/context-extra': { st: poller.st, memuExtras: poller.memuExtras },
    'utils/network': { getTaskStatus: (...args) => poller.getTaskStatus(...args) },
    'utils/types': { MemuTaskStatus: poller.MemuTaskStatus },
    './memorize': { retrieveMemories: () => poller.retrieveMemories() },
    './utils': { isMemuActive: () => poller.isMemuActive(), currentScope: () => poller.currentScope() },
    'utils/log': { onceError() {}, onceWarn() {} },
  }[name]);
  vm.runInNewContext(ts.transpileModule(pollerSource, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ESNext },
  }).outputText, poller);
  await poller.tick(); await poller.tick();
  assert.equal(poller.memuExtras.summary, failed); assert.equal(retrieved, 0);
  poller.memuExtras.summary = { ...failed, summaryTaskStatus: 'SUCCESS', summaryTaskId: 'task-retrieve' };
  await poller.tick(); await poller.tick(); assert.equal(retrieved, 2);
  poller.memuExtras.retrieve = { lastFailure: { summaryTaskId: 'task-retrieve', failureCount: 2 } };
  await poller.tick(); assert.equal(retrieved, 2);
  let progressSaves = 0;
  poller.st.saveChat = async () => { progressSaves++; };
  poller.memuExtras.baseInfo = { userId: 'TestOwner', characterId: 'TestSoul' };
  poller.memuExtras.summary = undefined;
  pollResponse = { status: 'PROCESSING', progress: { phase: 'extracting', current: 1, total: 3 } };
  await poller.tick();
  const discovered = poller.memuExtras.summary.summaryTaskId;
  assert(discovered); assert.equal(poller.memuExtras.summary.summaryTaskStatus, 'PROCESSING');
  pollResponse = { status: 'UNKNOWN' }; await poller.tick();
  assert.equal(poller.memuExtras.summary.summaryTaskId, discovered);
  assert.equal(poller.memuExtras.summary.summaryTaskStatus, 'PROCESSING');
  assert.match(poller.memuExtras.summary.lastError, /unavailable/);
  pollResponse = { status: 'PROCESSING' }; await poller.tick();
  assert.equal(poller.memuExtras.summary.lastError, undefined);
  for (const status of ['SKIPPED', 'CANCELLED', 'IDLE']) {
    pollResponse = { status }; await poller.tick();
    assert.equal(poller.memuExtras.summary, undefined);
    assert.equal(retrieved, 2);
    pollResponse = { status: 'PENDING' }; await poller.tick();
  }
  let resolveStatus;
  poller.getTaskStatus = () => new Promise(resolve => { resolveStatus = resolve; });
  const stalePoll = poller.tick();
  await new Promise(resolve => setImmediate(resolve));
  poller.memuExtras.summary = { summaryTaskId: 'new-admission', summaryTaskStatus: 'PENDING', summaryRange: [0, 2] };
  const savedAtSwitch = progressSaves;
  resolveStatus({ status: 'FAILURE', error: 'Old result' }); await stalePoll;
  assert.equal(poller.memuExtras.summary.summaryTaskId, 'new-admission');
  assert.equal(poller.memuExtras.summary.summaryTaskStatus, 'PENDING');
  assert.equal(progressSaves, savedAtSwitch);
  poller.getTaskStatus = async () => ({ status: 'FAILURE', error: 'Real extraction failure' });
  await poller.tick();
  const terminalSaves = progressSaves;
  await poller.tick(); assert.equal(progressSaves, terminalSaves);
  poller.getTaskStatus = async () => ({ status: 'UNKNOWN' }); await poller.tick();
  assert.equal(poller.memuExtras.summary.lastError, 'Real extraction failure');
  poller.getTaskStatus = async () => { throw new Error('Outage after failure'); }; await poller.tick();
  assert.equal(poller.memuExtras.summary.lastError, 'Real extraction failure');
  const timers = [];
  poller.setTimeout = callback => { timers.push(callback); return timers.length; };
  poller.clearTimeout = () => {};
  poller.getTaskStatus = () => new Promise(resolve => { resolveStatus = resolve; });
  poller.exports.startSummaryPolling(); poller.exports.startSummaryPolling();
  assert.equal(timers.length, 1); timers[0]();
  await new Promise(resolve => setImmediate(resolve));
  poller.exports.startSummaryPolling(); assert.equal(timers.length, 1);
  poller.exports.stopSummaryPolling();
  resolveStatus({ status: 'SUCCESS' }); await new Promise(resolve => setImmediate(resolve));
  assert.equal(poller.memuExtras.summary.summaryTaskStatus, 'FAILURE');
  assert.equal(progressSaves, terminalSaves); assert.equal(timers.length, 1);

  // Deadlines remain live through response bodies and CSRF, and caller abort wins.
  const held = setTimeout(() => assert.fail('Request deadline did not fire'), 1000);
  const waitForAbort = signal => new Promise((_resolve, reject) => {
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
  try {
    let calls = 0, requestSignal;
    context.getCsrfTokenCached = async signal => { requestSignal = signal; return 'fake'; };
    context.fetch = async (_url, opts) => {
      calls++; assert.equal(opts.signal, requestSignal);
      return { status: 200, json: () => waitForAbort(opts.signal) };
    };
    await assert.rejects(context.request('/memorizeConversation', {}, 'POST', undefined, { timeoutMs: 1 }), error => error.name === 'TimeoutError');
    assert.equal(calls, 1);
    const parent = new AbortController();
    const request = context.request('/conversationRetrieve', {}, 'POST', undefined, { signal: parent.signal });
    parent.abort(); await assert.rejects(request, error => error.name === 'AbortError');
    const csrf = { exports: {}, AbortSignal, fetch: async (_url, opts) => ({ json: () => waitForAbort(opts.signal) }) };
    vm.runInNewContext(ts.transpileModule(fs.readFileSync(`${__dirname}/../src/utils/csrf.ts`, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS },
    }).outputText, csrf);
    await assert.rejects(csrf.exports.getCsrfTokenCached(AbortSignal.timeout(1)), error => error.name === 'TimeoutError');
  } finally { clearTimeout(held); }
  // Render the maintained progress UI, with effects disabled and memU enabled.
  const summaryView = { summaryTaskStatus: 'PENDING', summaryTaskId: 'test-task', progress: { current: 0, total: 3, phase: 'accepted' } };
  let cursor = 0;
  const progress = {
    exports: {}, document: { body: {} },
    require: name => {
      if (name === 'react') return { useEffect() {}, useState: value => {
        const index = cursor++;
        return [index === 3 ? true : value, () => {}];
      } };
      if (name === 'react/jsx-runtime') return require('react/jsx-runtime');
      if (name === 'react-dom') return { createPortal: value => value };
      if (name === 'utils/context-extra') return { memuExtras: { summary: summaryView }, st: { getContext: () => ({}) } };
      if (name === 'utils/types') return { MemuTaskStatus: poller.MemuTaskStatus };
      if (name === 'ui/inspect-panel') return { getInspectData: () => null };
      if (name === 'memory/utils') return { currentScope: () => 'test-main' };
      if (name === 'utils/network') return {};
      assert.fail(`Unexpected import ${name}`);
    },
  };
  vm.runInNewContext(ts.transpileModule(component, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, progress);
  function text(tree) {
    if (Array.isArray(tree)) return tree.map(text).join(' ');
    if (tree && typeof tree === 'object') return text(tree.props?.children);
    return String(tree ?? '');
  }
  function render(status, phase) {
    cursor = 0; summaryView.summaryTaskStatus = status; summaryView.progress.phase = phase;
    return text(progress.exports.default());
  }
  assert.match(render('PENDING', 'accepted'), /Memorize pending/);
  assert.doesNotMatch(render('PENDING', 'accepted'), /Memorizing saved chat/);
  assert.match(render('PROCESSING', 'extracting'), /Memorizing saved conversations/);
  assert.match(render('PROCESSING', 'consolidation'), /Finalizing/);
  assert.match(render('FAILURE', ''), /Retry in OpenAlma launcher/);
  assert.doesNotMatch(render('FAILURE', ''), /after .* retry/);
  console.log('Paused send remains an error with launcher-directed text.');
  console.log('Failure polling does not retry paid work; retrieval retries, Cancel and extracting/accepted UI remain truthful.');
})().catch(error => { console.error(error); process.exitCode = 1; });
