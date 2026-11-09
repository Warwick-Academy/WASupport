import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import ts from 'typescript';

const require = createRequire(new URL('../apps/web/package.json', import.meta.url));
const React = require('react');
function load(filename, imports = {}) {
  const code = ts.transpileModule(readFileSync(filename, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
    },
  }).outputText;
  const module = { exports: {} };
  new Function('require', 'module', 'exports', code)(
    (name) => imports[name] ?? require(name), module, module.exports,
  );
  return module.exports;
}

let states = [];
let cursor = 0;
let effects = [];
const hooks = {
  useState(initial) {
    const index = cursor++;
    if (!(index in states)) states[index] = typeof initial === 'function' ? initial() : initial;
    return [states[index], (value) => {
      states[index] = typeof value === 'function' ? value(states[index]) : value;
    }];
  },
  useRef(initial) {
    const index = cursor++;
    if (!(index in states)) states[index] = { current: initial };
    return states[index];
  },
  useMemo: (fn) => fn(),
  useEffect(fn, dependencies) {
    const index = cursor++;
    const previous = states[index];
    if (!previous || dependencies.some((value, i) => value !== previous[i])) effects.push(fn);
    states[index] = dependencies;
  },
};
const types = load('apps/web/src/lib/types.ts');
let auth;
let directory;
let mutation;
const categories = [
  { id: 'it', name: 'IT', department: 'IT', parent_id: null, is_active: true },
  { id: 'it-category', name: 'Printer', department: 'IT', parent_id: 'it', is_active: true },
  { id: 'fac', name: 'Facilities', department: 'FAC', parent_id: null, is_active: true },
  { id: 'fac-category', name: 'Building', department: 'FAC', parent_id: 'fac', is_active: true },
];
let inserted;
const client = {
  from: () => ({
    insert: (row) => {
      inserted = row;
      return { select: () => ({ single: async () => ({ data: { id: 'ticket' }, error: null }) }) };
    },
  }),
};
const NewTicket = load('apps/web/src/pages/NewTicket.tsx', {
  react: hooks,
  'react-router-dom': { useNavigate: () => () => {} },
  '@tanstack/react-query': {
    useQueryClient: () => ({ invalidateQueries: () => {} }),
    useQuery: ({ queryKey }) => ({
      data: queryKey[0] === 'categories' ? categories : directory,
      isLoading: !directory && queryKey[0] !== 'categories',
    }),
    useMutation: (options) => { mutation = options; return {}; },
  },
  '../lib/supabase': { supabase: client },
  '../lib/auth': { useAuth: () => auth },
  '../components/Combobox': { Combobox: () => null },
  '../components/CameraCaptureButton': { default: () => null },
  '../lib/dictation': { parseTicketDictation: () => ({}) },
  '../lib/types': types,
  '../lib/ticketCategories': {
    canEditTicketCategory: () => true,
    categoryRoot: (items, dept) => items.find((item) => item.department === dept && !item.parent_id),
    OTHER_CATEGORY: 'other',
    resolveTicketCategory: async (_client, _root, subcategory) => subcategory,
  },
  '../lib/ticketSearchReport': {},
}).default;

function find(node, predicate) {
  if (!React.isValidElement(node)) return null;
  if (predicate(node)) return node;
  return React.Children.toArray(node.props.children)
    .map((child) => find(child, predicate)).find(Boolean) ?? null;
}
function render(component = NewTicket, props) {
  cursor = 0;
  effects = [];
  return component(props);
}
function reset(role, department = 'IT', id = 'self') {
  states = [];
  directory = undefined;
  inserted = undefined;
  auth = { user: { id }, profile: { id, role, department, full_name: 'My Name', email: 'me@example.test' }, role };
}
function picker() {
  return find(render(), (node) => node.props.id === 'submitter');
}
for (const role of ['admin', 'manager', 'it_tech', 'fac_tech', 'hs_officer', 'av_admin']) {
  reset(role);
  let box = picker();
  assert.equal(box.props.value, 'self', `${role} defaults to self`);
  assert.deepEqual(box.props.options, [{ value: 'self', label: 'My Name (me@example.test)' }]);
  directory = [{ id: 'self', label: 'My Name (me@example.test)' }, { id: 'other', label: 'Other' }];
  box = picker();
  assert.equal(box.props.value, 'self');
  assert.equal(box.props.options.length, 2);
  box.props.onChange('other');
  assert.equal(picker().props.value, 'other');
  picker().props.onChange('');
  assert.equal(picker().props.value, '', 'clearing selection does not restore the default');
  auth.user = { id: 'new-user' };
  assert.equal(picker().props.value, 'new-user', 'changing sessions resets the selection');
}
for (const role of ['submitter', 'support', 'leadership']) {
  reset(role);
  assert.equal(picker(), null, `${role} does not get the directory`);
}

reset('it_tech');
directory = [{ id: 'self', label: 'My Name' }, { id: 'other', label: 'Other' }];
let tree = render();
find(tree, (node) => node.props.id === 'submitter').props.onChange('other');
find(tree, (node) => node.props.id === 'category').props.onChange('fac');
tree = render();
find(tree, (node) => node.props.id === 'subcategory').props.onChange({ target: { value: 'fac-category' } });
render();
await assert.rejects(mutation.mutationFn(), /only in your own department/);
tree = render();
find(tree, (node) => node.props.id === 'category').props.onChange('it');
tree = render();
find(tree, (node) => node.props.id === 'subcategory').props.onChange({ target: { value: 'it-category' } });
render();
await mutation.mutationFn();
assert.equal(inserted.submitter_id, 'other');
assert.equal(inserted.department, 'IT');

const { Combobox } = load('apps/web/src/components/Combobox.tsx', { react: hooks });
states = [];
const changes = [];
let props = { value: 'self', options: [], onChange: (value) => changes.push(value) };
let combo = render(Combobox, props);
effects[0]();
props = { ...props, options: [{ value: 'self', label: 'My Name' }] };
combo = render(Combobox, props);
effects[0]();
combo = render(Combobox, props);
let input = find(combo, (node) => node.type === 'input');
assert.equal(input.props.value, 'My Name', 'late-arriving options show the selected label');
input.props.onChange({ target: { value: 'Other' } });
assert.deepEqual(changes, ['']);
props = { ...props, value: '' };
combo = render(Combobox, props);
effects[0]();
combo = render(Combobox, props);
input = find(combo, (node) => node.type === 'input');
assert.equal(input.props.value, 'Other', 'editing a selection preserves the typed search');
props = { ...props, value: 'self' };
render(Combobox, props);
effects[0]();
props = { ...props, value: '' };
render(Combobox, props);
effects[0]();
combo = render(Combobox, props);
assert.equal(find(combo, (node) => node.type === 'input').props.value, '', 'external resets clear the label');

console.log('PASS: submitter defaults, session changes, staff picker, department restriction, and asynchronous combobox labels');
