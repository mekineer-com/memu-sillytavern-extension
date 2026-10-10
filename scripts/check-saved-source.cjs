const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const source = fs.readFileSync(`${__dirname}/../src/memory/memorize.ts`, 'utf8');
const sandbox = {
  exports: {}, memuExtras: { baseInfo: { userName: 'TestOwner', characterName: 'TestSoul' } },
  resolveMessageTsMs: row => row.send_date,
};
vm.runInNewContext(ts.transpileModule(source.slice(source.indexOf('export function messageRole('),
  source.indexOf('function _chatContentText(')), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, sandbox);
const rows = [
  { name: 'TestOwner', is_user: true, mes: 'hello', send_date: 1000 },
  { name: 'TestSoul', mes: 'hidden', is_system: true },
  { name: 'TestSoul', mes: '  ' },
  { name: 'TestSoul', mes: 'reply', send_date: 2000 },
  { name: 'OtherPersona', is_user: true, mes: 'other human' },
  { name: 'TestSoul', mes: 'narration', extra: { type: 'narrator' } },
  { name: 'OtherCharacter', mes: 'another character' },
];
const plain = JSON.parse(JSON.stringify(sandbox.buildTurnHistory(rows, rows.length)));
assert.deepEqual(plain.map(row => row.role), ['user', 'soul', 'unknown', 'unknown', 'unknown']);
// Native indices are emitted only with the coordinated saved-source cutover.
assert(plain.every(row => !Object.hasOwn(row, 'source_conversation_index')));
assert.deepEqual(plain.map(row => row.source_message_id), ['0', '3', '4', '5', '6']);
assert.equal(plain[1].ts_ms, 2000);
assert.equal(plain[2].name, 'OtherPersona');
assert.deepEqual(JSON.parse(JSON.stringify(sandbox.buildTurnHistory([], 0))), []);
console.log('Plain ST history keeps original source IDs, hidden exclusions, timestamps and speaker attribution.');
