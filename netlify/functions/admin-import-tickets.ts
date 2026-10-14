/**
 * Admin-only: import a batch of rows from a Spiceworks ticket CSV export.
 *
 * The browser splits large files into batches so imports are not constrained
 * by the Netlify request body limit. Ticket Number is used as the idempotency
 * key, making retries safe.
 */
import type { Handler } from '@netlify/functions';

type CsvRow = Record<string, unknown>;

const MAX_BATCH_SIZE = 100;

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing env: ${name}`);
  return value;
}

function json(statusCode: number, body: unknown) {
  return {
    statusCode,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

function text(row: CsvRow, column: string): string {
  const value = row[column];
  return value == null ? '' : String(value).trim();
}

function mapDepartment(value: string) {
  const normalized = value.toLowerCase();
  if (normalized.startsWith('facilit')) return 'FAC';
  if (normalized.startsWith('health')) return 'HS';
  return 'IT';
}

function mapPriority(value: string) {
  const normalized = value.toLowerCase();
  if (normalized === 'high' || normalized === 'low') return normalized;
  if (normalized === 'critical' || normalized === 'urgent') return normalized;
  return 'normal';
}

function mapStatus(value: string) {
  const normalized = value.trim().toLowerCase();
  const statuses: Record<string, string> = {
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
  const status = statuses[normalized];
  if (!status) throw new Error(`Unsupported Spiceworks status: "${value}"`);
  return status;
}

function parseDate(value: string): string | null {
  if (!value) return null;
  const cleaned = value.replace(/\s+UTC$/i, '').trim();
  const date = new Date(`${cleaned} UTC`);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function mapRow(row: CsvRow, importedAt: string) {
  const legacyRef = text(row, 'Ticket Number');
  if (!legacyRef) return null;

  const status = mapStatus(text(row, 'Status'));
  const closedAt = status === 'closed' ? parseDate(text(row, 'Closed On')) : null;
  const room = text(row, 'Room Number / Location');
  const schoolDepartment = text(row, 'Department');

  return {
    legacy_ref: legacyRef,
    department: mapDepartment(text(row, 'Category')),
    subject: (text(row, 'Summary') || '(no subject)').slice(0, 500),
    description: text(row, 'Description'),
    priority: mapPriority(text(row, 'Priority')),
    status,
    submitter_id: null,
    legacy_submitter_name: text(row, 'Created By') || null,
    legacy_assignee_name: text(row, 'Assigned To') || null,
    legacy_subcategory: text(row, 'Category_2') || null,
    legacy_location: [room, schoolDepartment].filter(Boolean).join(' / ') || null,
    legacy_link: text(row, 'Link to Ticket') || null,
    imported_from: 'spiceworks',
    imported_at: importedAt,
    created_at: parseDate(text(row, 'Created On')) ?? importedAt,
    sla_due_at: parseDate(text(row, 'Due On')),
    resolved_at: closedAt,
    closed_at: closedAt,
  };
}

export const handler: Handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });

  const auth = event.headers.authorization ?? event.headers.Authorization;
  if (!auth?.startsWith('Bearer ')) return json(401, { error: 'Missing bearer token' });
  const callerJwt = auth.slice(7);

  let body: { rows?: unknown };
  try {
    body = JSON.parse(event.body ?? '{}') as { rows?: unknown };
  } catch {
    return json(400, { error: 'Invalid JSON' });
  }

  if (!Array.isArray(body.rows) || body.rows.length === 0) {
    return json(400, { error: 'A non-empty rows array is required' });
  }
  if (body.rows.length > MAX_BATCH_SIZE) {
    return json(400, { error: `A batch cannot exceed ${MAX_BATCH_SIZE} rows` });
  }
  if (body.rows.some((row) => !row || typeof row !== 'object' || Array.isArray(row))) {
    return json(400, { error: 'Every row must be an object' });
  }
  if (body.rows.some((row) => !Object.hasOwn(row as object, 'Assigned To'))) {
    return json(400, { error: 'The CSV must include the Assigned To column. Blank values are allowed.' });
  }

  const supabaseUrl = env('SUPABASE_URL').replace(/\/$/, '');
  const serviceKey = env('SUPABASE_SERVICE_ROLE_KEY');

  const meResponse = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: { apikey: serviceKey, Authorization: `Bearer ${callerJwt}` },
  });
  if (!meResponse.ok) return json(401, { error: 'Invalid session' });
  const me = (await meResponse.json()) as { id: string };

  const profileResponse = await fetch(
    `${supabaseUrl}/rest/v1/profiles?id=eq.${me.id}&select=role`,
    { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } },
  );
  if (!profileResponse.ok) return json(502, { error: 'Could not verify admin role' });
  const profiles = (await profileResponse.json()) as { role: string }[];
  if (profiles[0]?.role !== 'admin') return json(403, { error: 'Admin only' });

  const importedAt = new Date().toISOString();
  let mapped: ReturnType<typeof mapRow>[];
  try {
    mapped = (body.rows as CsvRow[])
      .map((row) => mapRow(row, importedAt))
      .filter((row): row is NonNullable<typeof row> => row !== null);
  } catch (error) {
    return json(400, {
      error: error instanceof Error ? error.message : 'Unsupported Spiceworks status',
    });
  }
  const invalid = body.rows.length - mapped.length;

  if (mapped.length === 0) return json(200, { inserted: 0, skipped: 0, invalid });

  const insertResponse = await fetch(
    `${supabaseUrl}/rest/v1/rpc/import_spiceworks_tickets`,
    {
      method: 'POST',
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ p_tickets: mapped }),
    },
  );

  if (!insertResponse.ok) {
    return json(500, {
      error: 'Ticket batch import failed',
      detail: await insertResponse.text(),
    });
  }

  const result = await insertResponse.json() as {
    inserted: number;
    skipped: number;
    updated: number;
    assigned: number;
    unmatched: Array<{ legacy_ref: string; name: string; department: string }>;
  };
  return json(200, {
    ...result,
    invalid,
  });
};