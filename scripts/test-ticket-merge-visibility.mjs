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
  const module = { exports: {} };
  new Function('require', 'module', 'exports', code)(
    (name) => imports[name] ?? require(name), module, module.exports,
  );
  return module.exports;
}

const types = load('apps/web/src/lib/types.ts');
const categories = load('apps/web/src/lib/ticketCategories.ts', { './types': types });
let role = 'admin';
let department = null;
let merged = false;
let status = 'open';
const Empty = () => null;
const TicketDetail = load('apps/web/src/pages/TicketDetail.tsx', {
  'react-router-dom': {
    Link: ({ to, children, ...props }) => React.createElement('a', { href: to, ...props }, children),
    useNavigate: () => () => {},
    useParams: () => ({ id: 'ticket-id' }),
    useSearchParams: () => [new URLSearchParams(), () => {}],
  },
  '@tanstack/react-query': {
    useQueryClient: () => ({ invalidateQueries: async () => {} }),
    useMutation: () => ({ isPending: false, error: null }),
    useQuery: ({ queryKey }) => ({
      isPending: false,
      isLoading: false,
      error: null,
      data: queryKey[0] === 'ticket' && queryKey.length === 2
        ? {
          id: 'ticket-id', ref: 'IT-12345', subject: 'Duplicate printer issue',
          description: 'Original ticket description', department: 'IT', status,
          priority: 'normal', created_at: '2026-11-06T10:00:00Z',
          time_spent_minutes: 0,
          merged_into_ticket_id: merged ? 'destination-id' : null,
        }
        : queryKey[0] === 'profile' ? null : [],
    }),
  },
  '../lib/auth': {
    useAuth: () => ({
      user: { id: 'user-id' },
      profile: { role, department },
      role,
      isAdmin: role === 'admin',
      isManager: role === 'admin' || role === 'manager',
      isTicketStaff: role !== 'submitter',
    }),
  },
  '../lib/supabase': { supabase: null },
  '../lib/dictation': { formatDictation: (value) => value },
  '../lib/types': types,
  '../lib/ticketCategories': categories,
  '../lib/ticketSearchReport': {},
  '../components/CameraCaptureButton': { default: Empty },
  '../components/SlaBadge': { default: Empty },
  '../components/TicketCategoryEditor': { default: Empty },
}).default;

function mergeButton() {
  const html = renderToStaticMarkup(React.createElement(TicketDetail));
  const button = html.match(/<button\b[^>]*>Merge ticket<\/button>/)?.[0];
  if (button) {
    assert.ok(html.indexOf(button) < html.indexOf('<h1'), 'Merge action must precede the subject');
  }
  return { html, button };
}

assert.ok(mergeButton().button, 'Administrators see the merge button');
role = 'manager';
department = 'IT';
assert.doesNotMatch(mergeButton().button, /disabled/);
status = 'closed';
assert.doesNotMatch(mergeButton().button, /disabled/, 'Closed unmerged tickets remain mergeable');
department = 'FAC';
assert.match(mergeButton().button, /disabled/);
assert.match(mergeButton().html, /Only this department&#x27;s manager or an administrator/);
department = null;
assert.match(mergeButton().button, /disabled/);
for (role of ['submitter', 'it_tech', 'support', 'leadership']) {
  assert.equal(mergeButton().button, undefined, role);
}
role = 'admin';
merged = true;
assert.equal(mergeButton().button, undefined, 'Already merged tickets cannot be merged again');

console.log('PASS: merge action is above the subject, permitted roles can use it, other managers see an explanation, and non-manager/already-merged tickets hide it');
