const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const source = fs.readFileSync(`${__dirname}/../src/component/NarrativeSuggestion.tsx`, 'utf8');
const code = source.slice(source.indexOf('async function writeDescriptionToCard('), source.indexOf('function getOverrideState('));
let card = {avatar: 'test.png', name: 'TestSoul', description: 'Original'};
let edit = () => {};
let writes = 0;
const context = {
  st: {getContext: () => ({characters: [card], characterId: 0, getOneCharacter: async () => {}})},
  getCsrfTokenCached: async () => { edit(); return 'test-token'; },
  fetch: async () => { writes++; return {ok: true}; },
  localStorage: {setItem: () => {}},
  lsLastWrittenKey: name => name,
};
vm.runInNewContext(ts.transpileModule(code, {compilerOptions: {module: ts.ModuleKind.CommonJS}}).outputText, context);
(async () => {
  for (const changed of [{...card, description: 'User edit'}, {...card, avatar: 'other.png'}]) {
    card = {avatar: 'test.png', name: 'TestSoul', description: 'Original'};
    edit = () => { card = changed; };
    await assert.rejects(context.writeDescriptionToCard('TestSoul', 'Suggested', 'test.png', 'Original'), /not overwritten/);
    assert.equal(writes, 0);
  }
  card = {avatar: 'test.png', name: 'TestSoul', description: 'Original'};
  edit = () => {};
  await context.writeDescriptionToCard('TestSoul', 'Suggested', 'test.png', 'Original');
  assert.equal(writes, 1);
  console.log('Narrative card edits and character switches survive the suggestion wait.');
})().catch(error => {console.error(error); process.exitCode = 1;});
