#!/usr/bin/env node
/**
 * Import Spiceworks ticket CSV export into AcademyDesk.
 *
 * Usage:
 *   node scripts/import-spiceworks.mjs <path-to-csv>
 *
 * Requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local
 * (the service role key bypasses RLS so we can write historical rows
 * without an auth user).
 *
 * Existing assignments are preserved; missing assignees are filled on re-import.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'csv-parse/sync';
import { createClient } from '@supabase/supabase-js';
import 'dotenv/config';

const csvPath = process.argv[2] ?? '.local/spiceworks_export.csv';
const BATCH = 200;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in env');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// ---------- mapping helpers ----------
function mapDepartment(category) {
  const v = (category ?? '').trim().toLowerCase();
  if (v.startsWith('facilit')) return 'FAC';
  if (v.startsWith('health')) return 'HS';
  return 'IT'; // default for "IT" and blanks
}

function mapPriority(p) {
  const v = (p ?? '').trim().toLowerCase();
  if (v === 'high') return 'high';
  if (v === 'low') return 'low';
  if (v === 'critical' || v === 'urgent') return v;
  return 'normal';
}

function mapStatus(s) {
  const v = (s ?? '').trim().toLowerCase();
  const statuses = {
    open: 'open',
    closed: 'closed',
    resolved: 'resolved',
    'in progress': 'in_progress',
    in_progress: 'in_progress',
    'on hold': 'on_hold',
    on_hold: 'on_hold',
    'awaiting triage': 'awaiting_triage',
    awaiting_triage: 'awaiting_triage',
  };
  const status = statuses[v];
  if (!status) throw new Error(`Unsupported Spiceworks status: "${s ?? ''}"`);
  return status;
}

function parseDate(s) {
  if (!s) return null;
  // CSV format: "5/6/2013 1:03 pm UTC"
  const cleaned = s.replace(/\s+UTC$/i, '').trim();
  const d = new Date(cleaned + ' UTC');
  return isNaN(d.getTime()) ? null : d.toISOString();
}

// ---------- read & dedup headers ----------
const raw = readFileSync(resolve(csvPath), 'utf8');
const rows = parse(raw, {
  bom: true,
  columns: (header) => {
    const seen = {};
    return header.map((h) => {
      if (seen[h]) {
        seen[h] += 1;
        return `${h}_${seen[h]}`;
      }
      seen[h] = 1;
      return h;
    });
  },
  skip_empty_lines: true,
  relax_quotes: true,
  relax_column_count: true,
});

console.log(`Parsed ${rows.length} rows from ${csvPath}`);
if (!rows[0] || !Object.hasOwn(rows[0], 'Assigned To')) {
  throw new Error('The CSV must include the Assigned To column. Blank values are allowed.');
}

// ---------- map rows ----------
const now = new Date().toISOString();
const toInsert = [];
for (const r of rows) {
  const legacyRef = String(r['Ticket Number'] ?? '').trim();
  if (!legacyRef) continue;

  const department = mapDepartment(r['Category']);
  const status = mapStatus(r['Status']);
  const closedAt = status === 'closed' ? parseDate(r['Closed On']) : null;
  const createdAt = parseDate(r['Created On']) ?? now;

  toInsert.push({
    legacy_ref: legacyRef,
    department,
    subject: (r['Summary'] || '(no subject)').slice(0, 500),
    description: r['Description'] || '',
    priority: mapPriority(r['Priority']),
    status,
    submitter_id: null,
    legacy_submitter_name: (r['Created By'] || '').trim() || null,
    legacy_assignee_name: (r['Assigned To'] || '').trim() || null,
    legacy_subcategory: (r['Category_2'] || '').trim() || null,
    legacy_location:
      [r['Room Number / Location'], r['Department']].filter(Boolean).join(' / ') || null,
    legacy_link: r['Link to Ticket'] || null,
    imported_from: 'spiceworks',
    imported_at: now,
    created_at: createdAt,
    sla_due_at: parseDate(r['Due On']),
    resolved_at: closedAt,
    closed_at: closedAt,
  });
}
console.log(`Rows to process: ${toInsert.length}`);

// ---------- insert in batches ----------
// Tickets currently auto-assign a ref via trigger using ticket_seq_*; we'll
// let that happen so new refs don't clash with existing/future tickets.
let inserted = 0;
let failed = 0;
let updated = 0;
let assigned = 0;
let skipped = 0;
const unmatched = [];
for (let i = 0; i < toInsert.length; i += BATCH) {
  const batch = toInsert.slice(i, i + BATCH);
  const { error, data } = await supabase.rpc('import_spiceworks_tickets', { p_tickets: batch });
  if (error) {
    failed += batch.length;
    console.error(`Batch ${i / BATCH + 1} failed:`, error.message);
  } else {
    inserted += data.inserted;
    updated += data.updated;
    assigned += data.assigned;
    skipped += data.skipped;
    unmatched.push(...data.unmatched);
    process.stdout.write(`  +${inserted}/${toInsert.length}\r`);
  }
}
console.log(`\nDone. inserted=${inserted} failed=${failed} existing=${skipped} filled=${updated} assignedNew=${assigned}`);
if (unmatched.length) {
  console.log('Unmatched or ambiguous assignees (no assignment guessed):');
  const groups = new Map();
  for (const row of unmatched) {
    const key = `${row.department}:${row.name}`;
    const group = groups.get(key) ?? { department: row.department, name: row.name, tickets: 0 };
    group.tickets += 1;
    groups.set(key, group);
  }
  console.table([...groups.values()]);
  const csvRows = [['Ticket Number', 'Assigned To', 'Department'], ...unmatched.map((row) => [row.legacy_ref, row.name, row.department])];
  const csv = csvRows.map((row) => row.map((value) => {
    const safe = /^[=+\-@]/.test(value) ? `'${value}` : value;
    return `"${safe.replace(/"/g, '""')}"`;
  }).join(',')).join('\r\n');
  const reportPath = resolve(`${csvPath}.unmatched-assignees.csv`);
  writeFileSync(reportPath, csv, 'utf8');
  console.log(`Unmatched ticket details: ${reportPath}`);
}
if (failed) process.exitCode = 1;
