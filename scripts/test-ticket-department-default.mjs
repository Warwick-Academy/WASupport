import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import ts from 'typescript';

const require = createRequire(new URL('../apps/web/package.json', import.meta.url));
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
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
    (name) => imports[name] ?? require(name), target, target.exports,
  );
  return target.exports;
}
const types = load('apps/web/src/lib/types.ts');
let auth;
let params;
let states;
let cursor;
let queries;
const TicketsList = load('apps/web/src/pages/TicketsList.tsx', {
  react: {
    useMemo: (fn) => fn(),
    useState: (initial) => {
      const index = cursor++;
      if (!(index in states)) states[index] = typeof initial === 'function' ? initial() : initial;
      return [states[index], (value) => {
        states[index] = typeof value === 'function' ? value(states[index]) : value;
      }];
    },
  },
  'react/jsx-runtime': require('react/jsx-runtime'),
  'react-router-dom': {
    Link: ({ to, children, ...props }) => React.createElement('a', { ...props, href: to }, children),
    useSearchParams: () => [params, (value) => { params = new URLSearchParams(value); }],
    useNavigate: () => () => {},
  },
  '@tanstack/react-query': {
    useQueryClient: () => ({}),
    useMutation: () => ({}),
    useQuery: (options) => { queries.push(options); return {}; },
  },
  '../lib/supabase': { supabase: {} },
  '../lib/auth': { useAuth: () => auth },
  '../lib/types': types,
  '../lib/ticketCategories': { ticketCategoryLabel: () => '' },
  '../lib/ticketSearchReport': { loadReportCategories: () => [] },
  '../components/TicketCategoryEditor': { default: () => null },
}).default;

function reset(role, department, query = '') {
  auth = {
    user: { id: 'member' },
    profile: { role, department },
    role,
    profileLoading: false,
    isTicketStaff: !['submitter', 'av_admin'].includes(role),
    isAdmin: role === 'admin',
    isManager: role === 'manager' || role === 'admin',
    isAvAdmin: role === 'av_admin',
  };
  params = new URLSearchParams(query);
  states = [];
}
function find(node, predicate) {
  if (!React.isValidElement(node)) return null;
  if (predicate(node)) return node;
  return React.Children.toArray(node.props.children)
    .map((child) => find(child, predicate)).find(Boolean) ?? null;
}
function render(expected) {
  cursor = 0;
  queries = [];
  const tree = TicketsList();
  const dropdown = find(tree, (node) => node.props.id === 'ticket-department-filter');
  assert.equal(dropdown.props.value, expected);
  const markup = renderToStaticMarkup(tree);
  assert.match(markup, new RegExp(`value="${expected}" selected=""`));
  assert.ok(queries.find((query) => query.queryKey[0] === 'tickets').queryKey.includes(expected));
  return { tree, dropdown };
}
for (const [role, department, expected] of [
  ['it_tech', 'IT', 'IT'],
  ['fac_tech', 'FAC', 'FAC'],
  ['hs_officer', 'HS', 'HS'],
  ['manager', 'FAC', 'FAC'],
  ['manager', null, 'all'],
  ['admin', null, 'all'],
  ['submitter', 'FAC', 'all'],
  ['av_admin', 'AV', 'all'],
  ['fac_tech', null, 'FAC'],
]) {
  reset(role, department);
  render(expected);
}
for (const [query, expected] of [
  ['department=HS', 'HS'],
  ['department=all', 'all'],
  ['department=invalid', 'FAC'],
]) {
  reset('manager', 'FAC', query);
  render(expected);
}
reset('manager', 'FAC');
auth.profile = null;
auth.role = null;
auth.profileLoading = true;
render('all');
assert.equal(queries.find((query) => query.queryKey[0] === 'tickets').enabled, false);
auth.profile = { role: 'manager', department: 'FAC' };
auth.role = 'manager';
auth.profileLoading = false;
let { dropdown } = render('FAC');
assert.equal(queries.find((query) => query.queryKey[0] === 'tickets').enabled, true);
dropdown.props.onChange({ target: { value: 'HS' } });
({ dropdown } = render('HS'));
dropdown.props.onChange({ target: { value: 'all' } });
const { tree } = render('all');
find(tree, (node) => node.type === 'button' && node.props.children === 'All closed tickets')
  .props.onClick();
render('all');
console.log('PASS: member/manager defaults, role fallback, explicit links, delayed profiles, manual department/all overrides, and status switching');
