import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import ts from 'typescript';

const require = createRequire(new URL('../apps/web/package.json', import.meta.url));
const React = require('react');
const RealDate = Date;
class FixedDate extends RealDate {
  constructor(...args) {
    super(...(args.length ? args : [2026, 11, 30, 12]));
  }
}

let states = [];
let cursor = 0;
const hooks = {
  useState(initial) {
    const index = cursor++;
    if (!(index in states)) states[index] = typeof initial === 'function' ? initial() : initial;
    return [
      states[index],
      (value) => {
        states[index] = typeof value === 'function' ? value(states[index]) : value;
      },
    ];
  },
  useRef(initial) {
    const index = cursor++;
    if (!(index in states)) states[index] = { current: initial };
    return states[index];
  },
  useMemo: (fn) => fn(),
};

const baseRequest = {
  requester_id: 'user',
  requester_name: 'Requester',
  requester_email: 'user@example.com',
  setup_type: 'event',
  setup_time: '09:00:00',
  location: 'Hall',
  recurrence_days: [],
  recurrence_end_date: null,
  recurrence_dates: [],
  fast_turnaround: false,
  status: 'pending',
  equipment: [],
  seat_back_row_chairs: 0,
  special_instructions: null,
  ticket_id: null,
};
const requests = [
  ...Array.from({ length: 4 }, (_, index) => ({
    ...baseRequest,
    id: `dec-${index}`,
    event_title: `December event ${index}`,
    event_date: '2026-12-31',
  })),
  {
    ...baseRequest,
    id: 'weekly',
    event_title: 'Weekly event',
    event_date: '2026-12-25',
    recurrence_days: [5],
    recurrence_end_date: '2027-01-08',
  },
  {
    ...baseRequest,
    id: 'dates',
    event_title: 'Additional date',
    event_date: '2026-12-01',
    recurrence_dates: ['2027-01-02'],
  },
];
const imports = {
  react: hooks,
  '@tanstack/react-query': {
    useQuery: () => ({ data: requests, isPending: false, error: null }),
    useQueryClient: () => ({ invalidateQueries: () => {} }),
  },
  '../lib/auth': { useAuth: () => ({ user: { id: 'user' }, role: 'fac_tech', isManager: false }) },
  '../lib/supabase': { supabase: {} },
};
const source = readFileSync('apps/web/src/pages/EventSetup.tsx', 'utf8');
const code = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
    jsx: ts.JsxEmit.ReactJSX,
  },
}).outputText;
const module = { exports: {} };
new Function('require', 'module', 'exports', 'Date', code)(
  (name) => imports[name] ?? require(name),
  module,
  module.exports,
  FixedDate,
);
const EventSetup = module.exports.default;

function render() {
  cursor = 0;
  return EventSetup();
}
function findAll(node, predicate) {
  if (!React.isValidElement(node)) return [];
  return [
    ...(predicate(node) ? [node] : []),
    ...React.Children.toArray(node.props.children).flatMap((child) => findAll(child, predicate)),
  ];
}
function button(tree, label) {
  const found = findAll(
    tree,
    (node) =>
      node.type === 'button' &&
      (node.props['aria-label'] === label || node.props.children === label),
  );
  assert.equal(found.length, 1, `Expected one button: ${label}`);
  return found[0];
}
function text(tree) {
  if (typeof tree === 'string' || typeof tree === 'number') return String(tree);
  if (!React.isValidElement(tree)) return '';
  return React.Children.toArray(tree.props.children).map(text).join(' ');
}
function calendar(tree) {
  const section = findAll(
    tree,
    (node) => node.type === 'section' && node.props['aria-labelledby'] === 'event-calendar-title',
  )[0];
  assert.ok(section);
  return section;
}

let tree = render();
assert.equal(button(tree, 'Month').props['aria-pressed'], true);
assert.match(text(calendar(tree)), /December 2026/);
assert.match(text(calendar(tree)), /\+\s*1\s+more/);
button(tree, 'Week').props.onClick();
tree = render();
assert.equal(button(tree, 'Week').props['aria-pressed'], true);
assert.match(text(calendar(tree)), /Dec 27, 2026 – Jan 2, 2027/);
for (let index = 0; index < 4; index += 1) {
  assert.match(text(calendar(tree)), new RegExp(`December event ${index}`));
}
assert.match(text(calendar(tree)), /Weekly event/);
assert.match(text(calendar(tree)), /Additional date/);
const occurrence = findAll(
  calendar(tree),
  (node) => node.type === 'button' && node.props.title?.startsWith('Weekly event'),
)[0];
assert.ok(occurrence);
occurrence.props.onClick();
tree = render();
assert.match(text(calendar(tree)), /Fri, 1 Jan 2027/);
button(tree, 'Next week').props.onClick();
tree = render();
assert.match(text(calendar(tree)), /Jan 3, 2027 – Jan 9, 2027/);
assert.match(text(calendar(tree)), /Weekly event/);
button(tree, 'Previous week').props.onClick();
tree = render();
assert.match(text(calendar(tree)), /Dec 27, 2026 – Jan 2, 2027/);
button(tree, 'Month').props.onClick();
tree = render();
assert.match(text(calendar(tree)), /December 2026/);
button(tree, 'Next month').props.onClick();
tree = render();
assert.match(text(calendar(tree)), /January 2027/);
console.log('Event Setup calendar month/week checks passed.');
