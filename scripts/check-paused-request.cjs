const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const babel = require('@babel/core');
const ts = require('typescript');

// Run the actual request decoder with a refused send, without a live ST session.
const source = fs.readFileSync(`${__dirname}/../src/utils/network.ts`, 'utf8');
const code = source.slice(source.indexOf('async function request<T>('));
const message = 'Test Soul is paused. Retry in OpenAlma launcher.';
const context = {
  ROUTER_BASE_URL: '/api/plugins/memu', getCsrfTokenCached: async () => 'fake',
  fetch: async () => ({ status: 409, text: async () => JSON.stringify({ error: { code: 'soul_paused', message } }) }),
};
vm.runInNewContext(babel.transformSync(code, {
  filename: 'request.ts', configFile: false, babelrc: false, presets: ['@babel/preset-typescript'],
}).code, context);
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
  vm.runInNewContext(babel.transformSync(taskKeyFunction, {
    filename: 'task.ts', configFile: false, babelrc: false, presets: ['@babel/preset-typescript'],
  }).code, cancel);
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
  assert.equal(cancel.memuExtras.summary, undefined);
  assert.equal(saved, true);
  // Failed paid work stays failed; only the separate category retrieval retries.
  const pollerSource = fs.readFileSync(`${__dirname}/../src/memory/summary-poller.ts`, 'utf8');
  let retrieved = 0;
  const failed = { summaryTaskStatus: 'FAILURE', summaryTaskId: null, summaryRange: [0, 2], failureCount: 3 };
  const poller = {
    MAX_RETRIEVE_FAILURE_RETRIES: 2, isMemuActive: async () => true,
    MemuTaskStatus: { PENDING: 'PENDING', PROCESSING: 'PROCESSING', SUCCESS: 'SUCCESS', FAILURE: 'FAILURE' },
    memuExtras: { summary: failed }, retrieveMemories: async () => { retrieved++; },
    st: { saveChat: async () => assert.fail('Failure polling must not save or clear failed work') },
    onceError() {},
  };
  vm.runInNewContext(babel.transformSync(pollerSource.slice(pollerSource.indexOf('async function tick()'),
    pollerSource.indexOf('function fireAndUpdateTaskStatus(')), {
    filename: 'poller.ts', configFile: false, babelrc: false, presets: ['@babel/preset-typescript'],
  }).code, poller);
  await poller.tick(); await poller.tick();
  assert.equal(poller.memuExtras.summary, failed); assert.equal(retrieved, 0);
  poller.memuExtras.summary = { ...failed, summaryTaskStatus: 'SUCCESS', summaryTaskId: 'task-retrieve' };
  await poller.tick(); await poller.tick(); assert.equal(retrieved, 2);
  poller.memuExtras.retrieve = { lastFailure: { summaryTaskId: 'task-retrieve', failureCount: 2 } };
  await poller.tick(); assert.equal(retrieved, 2);
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
  assert.match(render('PROCESSING', 'extracting'), /Memorizing saved chat/);
  assert.match(render('PROCESSING', 'consolidation'), /Finalizing/);
  assert.match(render('FAILURE', ''), /Retry in OpenAlma launcher/);
  assert.doesNotMatch(render('FAILURE', ''), /after .* retry/);
  console.log('Paused send remains an error with launcher-directed text.');
  console.log('Failure polling does not retry paid work; retrieval retries, Cancel and extracting/accepted UI remain truthful.');
})().catch(error => { console.error(error); process.exitCode = 1; });
