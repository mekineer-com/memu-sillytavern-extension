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
  console.log('Paused send remains an error with launcher-directed text.');
})().catch(error => { console.error(error); process.exitCode = 1; });
