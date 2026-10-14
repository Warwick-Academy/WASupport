#!/usr/bin/env node
/**
 * Seed categories & locations from the Spiceworks CSV export.
 *
 *   node --env-file=.env.local scripts/seed-taxonomy.mjs [csv-path]
 *
 * - Categories: distinct values from "Category_2" (subcategory) bucketed
 *   by department (using the same IT/FAC/HS mapping as the ticket import).
 * - Locations: distinct values from "Room Number / Location"; we store
 *   the whole string as `building` since the source is freeform.
 *
 * Idempotent. Safe to re-run.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'csv-parse/sync';
import { createClient } from '@supabase/supabase-js';
import 'dotenv/config';

const csvPath = process.argv[2] ?? '.local/spiceworks_export.csv';
const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}
const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

function mapDepartment(category) {
  const v = (category ?? '').trim().toLowerCase();
  if (v.startsWith('facilit')) return 'FAC';
  if (v.startsWith('health')) return 'HS';
  return 'IT';
}

const crossDepartmentNames = {
  IT: new Set(['facilities', 'health and safety']),
  FAC: new Set(['it', 'health and safety']),
  HS: new Set(['it', 'facilities']),
};

function normalizeCategoryName(name) {
  return name.toLowerCase().replace(/&/g, 'and').replace(/\s+/g, ' ').trim();
}

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

// -------- collect distinct values --------
const catByDept = { IT: new Set(), FAC: new Set(), HS: new Set() };
const locations = new Set();

for (const r of rows) {
  const dep = mapDepartment(r.Category);
  const sub = (r.Category_2 ?? '').trim();
  if (sub && !crossDepartmentNames[dep].has(normalizeCategoryName(sub))) {
    catByDept[dep].add(sub);
  }
  const loc = (r['Room Number / Location'] ?? '').trim();
  if (loc) locations.add(loc);
}

console.log(
  `Distinct categories: IT=${catByDept.IT.size} FAC=${catByDept.FAC.size} HS=${catByDept.HS.size}`,
);
console.log(`Distinct locations: ${locations.size}`);

// -------- upsert categories --------
let catInserted = 0;
for (const dep of ['IT', 'FAC', 'HS']) {
  const { data: existing, error: e1 } = await supabase
    .from('categories')
    .select('name')
    .eq('department', dep)
    .is('parent_id', null);
  if (e1) throw e1;
  const have = new Set((existing ?? []).map((c) => c.name.toLowerCase()));
  const toInsert = [...catByDept[dep]]
    .filter((n) => !have.has(n.toLowerCase()))
    .map((name) => ({ department: dep, name, parent_id: null }));
  if (toInsert.length) {
    const { error } = await supabase.from('categories').insert(toInsert);
    if (error) throw error;
    catInserted += toInsert.length;
  }
}
console.log(`Categories inserted: ${catInserted}`);

// -------- upsert locations (chunked) --------
// Dedupe case-insensitively, keeping the first-seen original casing.
const locMap = new Map();
for (const label of locations) {
  const key = label.toLowerCase();
  if (!locMap.has(key)) locMap.set(key, label);
}
const locArr = [...locMap.values()].map((label) => ({
  building: label,
  floor: null,
  room: null,
}));

// Pull all existing locations once, keyed by lowercase building.
const haveLoc = new Set();
{
  let from = 0;
  const pageSize = 1000;
  while (true) {
    const { data, error } = await supabase
      .from('locations')
      .select('building')
      .range(from, from + pageSize - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    for (const r of data) haveLoc.add((r.building ?? '').toLowerCase());
    if (data.length < pageSize) break;
    from += pageSize;
  }
}

let locInserted = 0;
const CHUNK = 500;
const pending = locArr.filter((l) => !haveLoc.has(l.building.toLowerCase()));
for (let i = 0; i < pending.length; i += CHUNK) {
  const chunk = pending.slice(i, i + CHUNK);
  const { error } = await supabase.from('locations').insert(chunk);
  if (error) throw error;
  locInserted += chunk.length;
}
console.log(`Locations inserted: ${locInserted}`);
console.log('Done.');
