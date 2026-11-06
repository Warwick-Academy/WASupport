import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import ts from 'typescript';

const require = createRequire(import.meta.url);
function load(filename, imports = {}) {
  const code = ts.transpileModule(readFileSync(filename, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
    },
  }).outputText;
  const target = { exports: {} };
  new Function('require', 'module', 'exports', code)(
    (name) => imports[name] || require(name), target, target.exports,
  );
  return target.exports;
}
const types = load('apps/web/src/lib/types.ts');
const categories = load('apps/web/src/lib/ticketCategories.ts', { './types': types });
for (const role of ['admin', 'manager', 'it_tech', 'fac_tech', 'hs_officer', 'av_admin']) {
  assert.equal(categories.canEditTicketCategory(role), true, role);
}
for (const role of ['submitter', 'support', 'leadership', null]) {
  assert.equal(categories.canEditTicketCategory(role), false, String(role));
}
const catalogue = [
  { id: 'root', name: 'IT', parent_id: null, department: 'IT' },
  { id: 'child', name: 'Smartboard', parent_id: 'root', department: 'IT' },
  { id: 'retired', name: 'Old hardware', parent_id: 'root', department: 'IT', is_active: false },
  { id: 'hs', name: 'Health & Safety', parent_id: null, department: 'HS' },
];
assert.equal(categories.categoryRoot(catalogue, 'IT').id, 'root');
assert.equal(categories.categoryRoot(catalogue, 'HS').id, 'hs');
assert.equal(categories.categoryRoot(catalogue, 'FAC'), undefined);
const ticket = { category_id: 'root', subcategory_id: null, legacy_subcategory: null };
assert.equal(categories.ticketCategoryLabel(ticket, catalogue), 'Uncategorised');
assert.equal(categories.hasTicketCategory(ticket, catalogue), false);
for (const [patch, expected] of [
  [{ subcategory_id: 'child' }, 'Smartboard'],
  [{ category_id: 'child' }, 'Smartboard'],
  [{ subcategory_id: 'retired' }, 'Old hardware'],
  [{ legacy_subcategory: ' Historical label ' }, 'Historical label'],
  [{ legacy_subcategory: ' ' }, 'Uncategorised'],
  [{ subcategory_id: 'child', legacy_subcategory: 'Stale label' }, 'Smartboard'],
]) {
  const value = { ...ticket, ...patch };
  assert.equal(categories.ticketCategoryLabel(value, catalogue), expected);
  assert.equal(categories.hasTicketCategory(value, catalogue), expected !== 'Uncategorised');
}
let calls = 0;
const client = { rpc: async (name, args) => {
  calls++;
  assert.equal(name, 'create_ticket_category');
  assert.deepEqual(args, { p_parent_id: 'root', p_name: 'New category' });
  return { data: 'new-id', error: null };
} };
assert.equal(await categories.resolveTicketCategory(client, 'root', 'child', '', false), 'child');
assert.equal(calls, 0);
assert.equal(await categories.resolveTicketCategory(client, 'root', categories.OTHER_CATEGORY, ' New category ', true), 'new-id');
assert.equal(calls, 1);
await assert.rejects(categories.resolveTicketCategory(client, 'root', '', '', true), /Select a category/);
await assert.rejects(categories.resolveTicketCategory(client, 'root', categories.OTHER_CATEGORY, 'New category', false), /Only department members/);
await assert.rejects(categories.resolveTicketCategory(client, 'root', categories.OTHER_CATEGORY, '   ', true), /Enter a category name/);
await assert.rejects(categories.resolveTicketCategory(client, 'root', categories.OTHER_CATEGORY, 'x'.repeat(201), true), /200 characters/);
await assert.rejects(categories.resolveTicketCategory({ rpc: async () => ({ error: { message: 'denied' } }) },
  'root', categories.OTHER_CATEGORY, 'Name', true), { message: 'denied' });
await assert.rejects(categories.resolveTicketCategory({ rpc: async () => ({ data: null, error: null }) },
  'root', categories.OTHER_CATEGORY, 'Name', true), /not returned/);
const webRequire = createRequire(new URL('../apps/web/package.json', import.meta.url));
const React = webRequire('react');
const { renderToStaticMarkup } = webRequire('react-dom/server');
let mutation;
let mutationError = null;
let rpcError = null;
let saved = false;
const invalidated = [];
const rpcCalls = [];
const editorImports = {
  react: React,
  'react/jsx-runtime': webRequire('react/jsx-runtime'),
  '@tanstack/react-query': {
    useQueryClient: () => ({
      invalidateQueries: async ({ queryKey }) => invalidated.push(queryKey),
    }),
    useMutation: (options) => {
      mutation = options;
      return { isPending: false, error: mutationError, isSuccess: false };
    },
  },
  '../lib/supabase': {
    supabase: { rpc: async (name, args) => {
      rpcCalls.push({ name, args });
      return { error: rpcError };
    } },
  },
  '../lib/ticketCategories': categories,
};
const Editor = load('apps/web/src/components/TicketCategoryEditor.tsx', editorImports).default;
const editorCategories = [
  ...catalogue.map((category) => ({ is_active: true, ...category })),
  { id: 'fac-child', name: 'Furniture', parent_id: 'fac-root', department: 'FAC', is_active: true },
  { id: 'other', name: 'Other', parent_id: 'root', department: 'IT', is_active: true },
];
function renderEditor(patch = {}, options = editorCategories) {
  return renderToStaticMarkup(React.createElement(Editor, {
    ticket: { ...ticket, id: 'ticket-id', department: 'IT', status: 'open', ...patch },
    categories: options,
    onSaved: () => { saved = true; },
  }));
}
const markup = renderEditor();
assert.match(markup, /<select[^>]*required/);
assert.match(markup, /Select a category/);
assert.match(markup, /Smartboard/);
assert.match(markup, /Save category/);
assert.match(markup, /before resolving or closing/);
assert.doesNotMatch(markup, /Furniture|Old hardware/);
assert.equal((markup.match(/>Other<\/option>/g) ?? []).length, 1);
assert.match(renderEditor({ subcategory_id: 'retired' }), /Old hardware \(retired\)/);
assert.match(renderEditor({ subcategory_id: 'other' }), /placeholder="Enter a category"/);
assert.match(renderEditor({ department: 'FAC' }), /No category root is configured/);
assert.match(renderEditor({ subcategory_id: 'child' }), /value="child" selected=""/);
await mutation.mutationFn();
assert.deepEqual(rpcCalls.at(-1), {
  name: 'set_ticket_category',
  args: { p_ticket_id: 'ticket-id', p_category_id: 'child', p_other_name: null },
});
await mutation.onSuccess();
assert.equal(saved, true);
assert.ok(invalidated.some((key) => key[0] === 'ticket' && key[1] === 'ticket-id'));
assert.ok(invalidated.some((key) => key[0] === 'tickets'));
rpcError = new Error('Category save denied');
await assert.rejects(mutation.mutationFn(), /Category save denied/);
mutationError = rpcError;
assert.match(renderEditor(), /Could not save category: Category save denied/);
rpcError = null;
mutationError = null;
let state = [];
let stateIndex = 0;
const mutations = [];
let openedOther = false;
const InteractiveEditor = load('apps/web/src/components/TicketCategoryEditor.tsx', {
  ...editorImports,
  react: { useState: (initial) => {
    const index = stateIndex++;
    if (!(index in state)) state[index] = initial;
    return [state[index], (value) => { state[index] = value; }];
  } },
  '@tanstack/react-query': {
    ...editorImports['@tanstack/react-query'],
    useMutation: (options) => {
      mutation = options;
      return {
        isPending: false,
        reset: () => {},
        mutate: (value) => { mutations.push(options.mutationFn(value)); },
      };
    },
  },
}).default;
const editorProps = {
  ticket: { ...ticket, id: 'ticket-id', ref: 'IT-123', department: 'IT' },
  categories: editorCategories,
  onSaved: () => {},
};
function find(node, type) {
  if (!React.isValidElement(node)) return null;
  if (node.type === type) return node;
  return React.Children.toArray(node.props.children)
    .map((child) => find(child, type)).find(Boolean) ?? null;
}
function interactive(props) {
  stateIndex = 0;
  return InteractiveEditor({ ...editorProps, ...props });
}
let tree = interactive({ onOtherSelected: () => { openedOther = true; } });
find(tree, 'select').props.onChange({ target: { value: 'child' } });
await Promise.all(mutations);
assert.equal(rpcCalls.at(-1).args.p_category_id, 'child');
const callsBeforeOther = rpcCalls.length;
find(tree, 'select').props.onChange({ target: { value: categories.OTHER_CATEGORY } });
assert.equal(openedOther, true);
assert.equal(rpcCalls.length, callsBeforeOther, 'Other opens ticket without prematurely changing its category');
state = [];
tree = interactive({ initialOther: true });
assert.equal(find(tree, 'select').props.value, categories.OTHER_CATEGORY);
assert.equal(find(tree, 'input').props.autoFocus, true);
find(tree, 'input').props.onChange({ target: { value: ' New furniture ' } });
tree = interactive({ initialOther: true });
find(tree, 'form').props.onSubmit({ preventDefault: () => {} });
await Promise.all(mutations);
assert.deepEqual(rpcCalls.at(-1), {
  name: 'set_ticket_category',
  args: { p_ticket_id: 'ticket-id', p_category_id: null, p_other_name: 'New furniture' },
});
console.log('PASS: category helpers, dropdown rendering, inline save, Other handoff and focused entry, custom category payload, cache refresh, and failure handling');
