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
