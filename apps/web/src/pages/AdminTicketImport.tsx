import { useState, type ChangeEvent } from 'react';
import { parse } from 'csv-parse/browser/esm/sync';
import { useAuth } from '../lib/auth';
import { supabase } from '../lib/supabase';

type CsvRow = Record<string, string>;

type ImportTotals = {
  inserted: number;
  skipped: number;
  invalid: number;
  updated: number;
  assigned: number;
};

type UnmatchedAssignee = { legacy_ref: string; name: string; department: string };

const BATCH_SIZE = 100;
const REQUIRED_COLUMNS = ['Ticket Number', 'Summary', 'Description', 'Status', 'Created On', 'Assigned To'];

function deduplicateHeaders(headers: string[]) {
  const seen: Record<string, number> = {};
  return headers.map((header) => {
    const name = header.trim();
    if (seen[name]) {
      seen[name] += 1;
      return `${name}_${seen[name]}`;
    }
    seen[name] = 1;
    return name;
  });
}

export default function AdminTicketImport() {
  const { isAdmin, role } = useAuth();
  const [file, setFile] = useState<File | null>(null);
  const [isImporting, setIsImporting] = useState(false);
  const [progress, setProgress] = useState({ completed: 0, total: 0 });
  const [totals, setTotals] = useState<ImportTotals | null>(null);
  const [unmatched, setUnmatched] = useState<UnmatchedAssignee[]>([]);
  const [error, setError] = useState<string | null>(null);

  function selectFile(event: ChangeEvent<HTMLInputElement>) {
    setFile(event.target.files?.[0] ?? null);
    setTotals(null);
    setUnmatched([]);
    setError(null);
    setProgress({ completed: 0, total: 0 });
  }

  async function importFile() {
    if (!file || !supabase) return;

    setIsImporting(true);
    setError(null);
    setTotals(null);
    setUnmatched([]);

    try {
      const csv = await file.text();
      const rows = parse(csv, {
        bom: true,
        columns: deduplicateHeaders,
        skip_empty_lines: true,
        relax_quotes: true,
        relax_column_count: true,
      }) as CsvRow[];

      const firstRow = rows[0];
      if (!firstRow) throw new Error('The CSV contains no ticket rows.');
      const columns = Object.keys(firstRow);
      const missing = REQUIRED_COLUMNS.filter((column) => !columns.includes(column));
      if (missing.length > 0) {
        throw new Error(`This is not a supported Spiceworks export. Missing: ${missing.join(', ')}`);
      }

      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData.session?.access_token;
      if (!token) throw new Error('Your session has expired. Sign in again before importing.');

      const nextTotals: ImportTotals = { inserted: 0, skipped: 0, invalid: 0, updated: 0, assigned: 0 };
      setProgress({ completed: 0, total: rows.length });

      for (let start = 0; start < rows.length; start += BATCH_SIZE) {
        const batch = rows.slice(start, start + BATCH_SIZE);
        const response = await fetch('/api/admin-import-tickets', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ rows: batch }),
        });
        const result = (await response.json().catch(() => ({}))) as Partial<ImportTotals> & {
          error?: string;
          detail?: string;
          unmatched?: UnmatchedAssignee[];
        };
        if (!response.ok) {
          throw new Error(result.detail || result.error || `Import failed with HTTP ${response.status}`);
        }

        nextTotals.inserted += result.inserted ?? 0;
        nextTotals.skipped += result.skipped ?? 0;
        nextTotals.invalid += result.invalid ?? 0;
        nextTotals.updated += result.updated ?? 0;
        nextTotals.assigned += result.assigned ?? 0;
        setUnmatched((current) => [...current, ...(result.unmatched ?? [])]);
        setTotals({ ...nextTotals });
        setProgress({ completed: Math.min(start + batch.length, rows.length), total: rows.length });
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The ticket import failed.');
    } finally {
      setIsImporting(false);
    }
  }

  if (!isAdmin) {
    return <p className="alert-warn">Admins only. Your role: {role ?? 'unknown'}.</p>;
  }

  const percent = progress.total
    ? Math.round((progress.completed / progress.total) * 100)
    : 0;

  return (
    <section>
      <div className="page-header">
        <div>
          <h1 className="page-title">Import tickets</h1>
          <p className="text-sm italic text-slate-500">
            Import a Spiceworks export, including Assigned To. Existing assignments are preserved; missing owners are filled when a unique department-member match is found. Submitters are associated by full name, including on closed historical tickets.
          </p>
        </div>
      </div>

      <div className="card-pad max-w-3xl">
        <label htmlFor="ticket-csv" className="field-label">
          Spiceworks CSV file
        </label>
        <input
          id="ticket-csv"
          type="file"
          accept=".csv,text/csv"
          onChange={selectFile}
          disabled={isImporting}
          className="field file:mr-4 file:rounded-md file:border-0 file:bg-slate-100 file:px-3 file:py-2 file:text-sm file:font-semibold file:text-brand-navy hover:file:bg-slate-200"
        />

        {file && (
          <div className="mt-3 flex flex-wrap items-center justify-between gap-3 text-sm text-slate-600">
            <span>
              {file.name} ({(file.size / 1024 / 1024).toFixed(1)} MB)
            </span>
            <button
              type="button"
              onClick={importFile}
              disabled={isImporting}
              className="btn-primary"
            >
              {isImporting ? 'Importing…' : 'Import tickets'}
            </button>
          </div>
        )}

        {progress.total > 0 && (
          <div className="mt-6" aria-live="polite">
            <div className="mb-2 flex justify-between text-xs font-medium text-slate-600">
              <span>{isImporting ? 'Import in progress' : 'Import processed'}</span>
              <span>
                {progress.completed.toLocaleString()} / {progress.total.toLocaleString()} ({percent}%)
              </span>
            </div>
            <div className="h-2 overflow-hidden rounded bg-slate-200">
              <div
                className="h-full bg-brand-navy transition-[width] duration-200"
                style={{ width: `${percent}%` }}
              />
            </div>
          </div>
        )}

        {totals && (
          <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3" aria-live="polite">
            <div className="rounded-lg bg-emerald-50 p-3">
              <div className="text-2xl font-bold text-emerald-800">{totals.inserted.toLocaleString()}</div>
              <div className="text-xs font-medium text-emerald-700">Inserted</div>
            </div>
            <div className="rounded-lg bg-slate-100 p-3">
              <div className="text-2xl font-bold text-slate-700">{totals.skipped.toLocaleString()}</div>
              <div className="text-xs font-medium text-slate-600">Already imported</div>
            </div>
            <div className="rounded-lg bg-amber-50 p-3">
              <div className="text-2xl font-bold text-amber-800">{totals.invalid.toLocaleString()}</div>
              <div className="text-xs font-medium text-amber-700">Invalid rows</div>
            </div>
            <div className="rounded-lg bg-sky-50 p-3">
              <div className="text-2xl font-bold text-sky-800">{totals.updated.toLocaleString()}</div>
              <div className="text-xs font-medium text-sky-700">Existing missing assignees filled</div>
            </div>
            <div className="rounded-lg bg-emerald-50 p-3">
              <div className="text-2xl font-bold text-emerald-800">{totals.assigned.toLocaleString()}</div>
              <div className="text-xs font-medium text-emerald-700">New tickets assigned</div>
            </div>
          </div>
        )}

        {unmatched.length > 0 && (
          <div className="mt-6 space-y-3">
            <p className="alert-warn">{unmatched.length.toLocaleString()} assignee names could not be uniquely matched to an eligible department member. No assignments were guessed.</p>
            <button type="button" className="btn-ghost" onClick={() => {
              const rows = [['Ticket Number', 'Assigned To', 'Department'], ...unmatched.map((row) => [row.legacy_ref, row.name, row.department])];
              const csv = rows.map((row) => row.map((value) => {
                const safe = /^[=+\-@]/.test(value) ? `'${value}` : value;
                return `"${safe.replace(/"/g, '""')}"`;
              }).join(',')).join('\r\n');
              const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
              const anchor = document.createElement('a');
              anchor.href = url;
              anchor.download = 'unmatched-spiceworks-assignees.csv';
              anchor.click();
              URL.revokeObjectURL(url);
            }}>Download unmatched assignees</button>
          </div>
        )}

        {error && <p className="mt-6 alert-error">{error}</p>}
      </div>
    </section>
  );
}