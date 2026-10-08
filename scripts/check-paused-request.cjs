const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const babel = require('@babel/core');

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
  const summary = { summaryTaskStatus: 'PROCESSING' };
  const cancel = {
    cancelling: false, memuExtras: { baseInfo: { userId: 'fictional-owner', characterId: 'fictional-soul' }, summary },
    cancelMemorize: async () => ({ ok: false }),
    setCancelling(value) { this.cancelling = value; },
    setCancelUnavailable(value) { this.unavailable = value; },
    st: { saveChat: async () => assert.fail('Refused cancel must not save or hide progress') },
  };
  cancel.setCancelling = cancel.setCancelling.bind(cancel);
  cancel.setCancelUnavailable = cancel.setCancelUnavailable.bind(cancel);
  vm.runInNewContext(component.slice(component.indexOf('async function handleCancel()'), component.indexOf('\n  return createPortal(')), cancel);
  await cancel.handleCancel();
  assert.equal(cancel.memuExtras.summary, summary);
  assert.equal(cancel.cancelling, false);
  assert.equal(cancel.unavailable, true);
  let saved = false;
  cancel.cancelMemorize = async () => ({ ok: true });
  cancel.st.saveChat = async () => { saved = true; };
  await cancel.handleCancel();
  assert.equal(cancel.memuExtras.summary, undefined);
  assert.equal(saved, true);
  console.log('Paused send remains an error with launcher-directed text.');
})().catch(error => { console.error(error); process.exitCode = 1; });
