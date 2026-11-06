import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createClient } from '@supabase/supabase-js';
import ts from 'typescript';

const require = createRequire(import.meta.url);
function load(filename, imports = {}) {
  const code = ts.transpileModule(readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const target = { exports: {} };
  new Function('require', 'module', 'exports', code)(
    (name) => imports[name] || require(name), target, target.exports,
  );
  return target.exports;
}

const types = load('apps/web/src/lib/types.ts');
const report = load('apps/web/src/lib/ticketSearchReport.ts', { './types': types });
const exports = load('apps/web/src/lib/reportExport.ts');
const statuses = ['open', 'in_progress', 'on_hold', 'awaiting_triage', 'resolved', 'closed'];
const categories = Array.from({ length: 501 }, (_, i) => ({
  id: `category-${i}`, department: i === 500 ? 'FAC' : 'IT', name: `Category ${i}`,
  parent_id: i > 0 && i < 500 ? 'category-0' : null, is_active: i !== 1,
}));
const tickets = Array.from({ length: 1205 }, (_, i) => ({
  id: `ticket-${i}`, ref: `IT-${i}`, legacy_ref: `OLD-${i}`,
  department: i >= 1200 ? 'FAC' : 'IT', category_id: i >= 1200 ? 'category-500' : 'category-0',
  subcategory_id: i % 2 === 0 ? 'category-1' : null,
  subject: i === 1100 ? 'Roof "leak", =SUM(A1)' : 'Repair',
  description: i === 1100 ? 'Water\nneeds attention %_(),.*' : 'General maintenance',
  status: statuses[i % statuses.length], priority: 'normal',
  created_at: i % 2 === 0 ? '2015-01-01T12:00:00Z' : '2026-11-01T12:00:00Z',
  resolved_at: i % 6 === 4 ? '2026-11-01T12:00:00Z' : null,
  closed_at: i % 6 === 5 ? '2026-11-01T12:00:00Z' : null,
  submitter_id: `person-${i}`, assignee_id: null,
  legacy_submitter_name: 'Imported submitter', legacy_assignee_name: 'Imported assignee',
  legacy_subcategory: 'Historical category', time_spent_minutes: 20,
}));
const calls = [];
let failTable = null;
let failOffset = 0;
const client = createClient('https://report-test.invalid', 'test-key', {
  auth: { persistSession: false, autoRefreshToken: false },
  global: { fetch: async (input, options) => {
    const url = new URL(input);
    const table = url.pathname.split('/').at(-1);
    calls.push(url);
    assert.ok(options.signal, 'Queries must carry cancellation signals');
    const offset = Number(url.searchParams.get('offset') ?? 0);
    if (table === failTable && offset >= failOffset) {
      return new Response(JSON.stringify({ message: 'Test database failure' }), { status: 400 });
    }
    let rows = [];
    if (table === 'categories') rows = categories;
    else if (table === 'tickets') {
      assert.equal(url.searchParams.get('order'), 'created_at.desc,id.asc');
      assert.equal(url.searchParams.has('status'), false, 'All statuses must be included');
      assert.equal(url.searchParams.has('created_at'), false, 'No implicit date filter');
      rows = tickets;
      const department = url.searchParams.get('department');
      if (department) rows = rows.filter((ticket) => `eq.${ticket.department}` === department);
      const category = url.searchParams.get('or')?.match(/category_id\.eq\.([^,)]+)/)?.[1];
      if (category) rows = rows.filter((ticket) => ticket.category_id === category || ticket.subcategory_id === category);
    } else if (table === 'profiles') {
      const ids = url.searchParams.get('id').slice(4, -1).split(',');
      assert.ok(ids.length <= 200, 'Profile batches must stay below API limits');
      rows = ids.filter((id) => id !== 'person-1100').map((id) => ({ id, full_name: `Name ${id}`, email: `${id}@example.test` }));
    } else assert.fail(`Unexpected request: ${url}`);
    return new Response(JSON.stringify(rows.slice(offset, offset + Number(url.searchParams.get('limit') ?? 1000))), {
      headers: { 'Content-Type': 'application/json' },
    });
  } },
});
const signal = new AbortController().signal;
const loadedCategories = await report.loadReportCategories(client, signal);
assert.equal(loadedCategories.length, 501);
assert.equal(loadedCategories[1].is_active, false, 'Retired categories must remain searchable');
const filters = { department: 'all', categoryId: '', keywords: '' };
const all = await report.loadTicketSearchReport(client, filters, loadedCategories, signal);
assert.equal(all.length, 1205, 'All pages must load, including tickets beyond 1000');
assert.deepEqual(new Set(all.map(({ ticket }) => ticket.status)), new Set(statuses));
assert.ok(calls.filter((url) => url.pathname.endsWith('/profiles')).length > 1);
const it = await report.loadTicketSearchReport(client, { ...filters, department: 'IT' }, loadedCategories, signal);
assert.equal(it.length, 1200);
const category = await report.loadTicketSearchReport(client, { ...filters, categoryId: 'category-1' }, loadedCategories, signal);
assert.equal(category.length, 603);
assert.equal(category[0].subcategory, 'Category 1');
const root = await report.loadTicketSearchReport(client, { ...filters, categoryId: 'category-0' }, loadedCategories, signal);
assert.equal(root.length, 1200, 'Root category must include its subcategories');
const matched = await report.loadTicketSearchReport(client, {
  department: 'IT', categoryId: 'category-1', keywords: ' ROOF water ',
}, loadedCategories, signal);
assert.equal(matched.length, 1, 'Match across subject and description after page 2');
assert.equal(matched[0].ticket.id, 'ticket-1100');
assert.equal(matched[0].submitter, 'Imported submitter');
assert.equal(matched[0].assignee, 'Imported assignee');
assert.equal(report.matchesReportKeywords(tickets[1100], '%_(),.*'), true, 'Punctuation is literal');
assert.equal(report.matchesReportKeywords(tickets[1100], 'roof absent'), false);
assert.equal(report.matchesReportKeywords(tickets[1100], 'old-1100'), true);
assert.equal(report.matchesReportKeywords(tickets[1101], '%'), false);
assert.equal((await report.loadTicketSearchReport(client, { ...filters, keywords: 'no-such-ticket' }, loadedCategories, signal)).length, 0);

failTable = 'tickets';
failOffset = 500;
await assert.rejects(report.loadTicketSearchReport(client, filters, loadedCategories, signal), { message: 'Test database failure' });
failTable = 'profiles';
failOffset = 0;
await assert.rejects(report.loadTicketSearchReport(client, filters, loadedCategories, signal), { message: 'Test database failure' });
failTable = 'categories';
await assert.rejects(report.loadReportCategories(client, signal), { message: 'Test database failure' });

const csvRows = report.searchReportCsvRows(all);
assert.equal(csvRows.length, 1206);
assert.ok(csvRows.every((row) => row.length === 15));
assert.equal(csvRows[1101][13], tickets[1100].description);
assert.equal(exports.csvCell('"quoted",\nline'), '"""quoted"",\nline"');
for (const value of ['=SUM(A1)', '+cmd', '-cmd', '@cmd', ' \t=cmd', '\tcmd', '\rcmd', '\ncmd']) {
  assert.ok(exports.csvCell(value).startsWith(`"'`), `Unsafe spreadsheet prefix: ${JSON.stringify(value)}`);
}
assert.equal(exports.csvCell(null), '""');
assert.equal(exports.csvCell('ordinary'), '"ordinary"');
let downloadedBlob;
let downloadName;
let clicked = false;
let revoked = false;
let afterprint;
const classes = new Set();
globalThis.document = {
  body: { classList: { add: (value) => classes.add(value), remove: (value) => classes.delete(value) },
    appendChild: () => {} },
  createElement: () => ({ set href(value) { assert.equal(value, 'blob:test'); },
    set download(value) { downloadName = value; }, click: () => { clicked = true; }, remove: () => {} }),
};
URL.createObjectURL = (blob) => { downloadedBlob = blob; return 'blob:test'; };
URL.revokeObjectURL = (url) => { assert.equal(url, 'blob:test'); revoked = true; };
exports.downloadCsv('report.csv', csvRows);
await new Promise((resolve) => setTimeout(resolve, 10));
assert.equal(downloadName, 'report.csv');
assert.equal(clicked && revoked, true);
assert.equal(downloadedBlob.type, 'text/csv;charset=utf-8');
assert.deepEqual([...new Uint8Array(await downloadedBlob.arrayBuffer()).slice(0, 3)], [239, 187, 191]);
assert.ok((await downloadedBlob.text()).includes('IT-1204'), 'CSV must include the final result');
globalThis.window = {
  addEventListener: (event, callback) => { assert.equal(event, 'afterprint'); afterprint = callback; },
  print: () => assert.equal(classes.has('printing-report'), true),
};
exports.printReport();
assert.equal(classes.has('printing-report'), true);
afterprint();
assert.equal(classes.size, 0);
window.print = () => { throw new Error('Print failed'); };
assert.throws(exports.printReport, /Print failed/);
assert.equal(classes.size, 0);
console.log('PASS: all-history/status search, 1205 tickets, category/department/keyword combinations, retired categories, pagination, profile batching, failures, CSV contents/formula safety, and print lifecycle');
