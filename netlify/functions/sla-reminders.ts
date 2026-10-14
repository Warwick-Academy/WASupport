/**
 * Scheduled SLA reminder sweep.
 *
 * Runs every 15 minutes (configured in netlify.toml). For every active ticket
 * (`open` or `in_progress`) it inspects `sla_due_at` and sends two kinds of
 * email at most once each:
 *
 *   approaching → 60 minutes before breach        (assignee only)
 *   overdue     → after breach                    (assignee + dept staff)
 *
 * The two `sla_reminder_*_sent` flags on `tickets` prevent duplicates; they
 * are cleared automatically by the SLA trigger if priority changes.
 */
import type { Handler, HandlerEvent } from '@netlify/functions';

const APPROACHING_MS = 60 * 60 * 1000;

type Ticket = {
  id: string;
  ref: string;
  subject: string;
  description: string;
  department: 'IT' | 'FAC' | 'AV' | 'HS';
  priority: string;
  status: string;
  assignee_id: string | null;
  sla_due_at: string | null;
  sla_reminder_approaching_sent: boolean;
  sla_reminder_overdue_sent: boolean;
};

const STATUS_LABEL: Record<string, string> = {
  awaiting_triage: 'Awaiting triage',
  open: 'Open',
  in_progress: 'In progress',
  on_hold: 'On hold',
  resolved: 'Resolved',
  closed: 'Closed',
};
const PRIORITY_LABEL: Record<string, string> = {
  low: 'Low',
  normal: 'Normal',
  high: 'High',
  critical: 'Critical',
  urgent: 'Urgent',
};
const DEPT_LABEL: Record<string, string> = {
  IT: 'IT',
  FAC: 'Facilities',
  AV: 'Audio Visual',
  HS: 'Health & Safety',
};

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

function pgrest(): { url: string; key: string } {
  return {
    url: env('SUPABASE_URL').replace(/\/$/, '') + '/rest/v1',
    key: env('SUPABASE_SERVICE_ROLE_KEY'),
  };
}

async function restSelect<T = unknown>(table: string, query: string): Promise<T[]> {
  const { url, key } = pgrest();
  const res = await fetch(`${url}/${table}?${query}`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  });
  if (!res.ok) throw new Error(`PostgREST ${table} ${res.status}: ${await res.text()}`);
  return (await res.json()) as T[];
}

async function restPatch(
  table: string,
  query: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const { url, key } = pgrest();
  const res = await fetch(`${url}/${table}?${query}`, {
    method: 'PATCH',
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'content-type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify(patch),
  });
  if (!res.ok) {
    throw new Error(`PostgREST PATCH ${table} ${res.status}: ${await res.text()}`);
  }
}

async function restInsert(table: string, row: Record<string, unknown>): Promise<void> {
  const { url, key } = pgrest();
  const res = await fetch(`${url}/${table}`, {
    method: 'POST',
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'content-type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify(row),
  });
  if (!res.ok) {
    console.error('[sla-reminders] log insert failed', res.status, await res.text());
  }
}

async function resolveEmail(userId: string | null): Promise<string | null> {
  if (!userId) return null;
  const rows = await restSelect<{ email: string }>(
    'profiles',
    `select=email&id=eq.${encodeURIComponent(userId)}&limit=1`,
  );
  return rows[0]?.email ?? null;
}

function deptStaffEmails(department: string): string[] {
  const raw = process.env[`STAFF_NOTIFY_${department}`] ?? '';
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function sendgridSend(opts: {
  to: string[];
  subject: string;
  html: string;
  text: string;
}): Promise<{ skipped: boolean }> {
  const apiKey = env('SENDGRID_API_KEY');
  const from = env('SENDGRID_FROM_EMAIL');
  if (apiKey.startsWith('SG....') || !apiKey.startsWith('SG.')) {
    console.warn('[sla-reminders] SENDGRID_API_KEY not configured; skipping send.');
    return { skipped: true };
  }
  const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      personalizations: [{ to: opts.to.map((email) => ({ email })) }],
      from: { email: from, name: 'AcademyDesk' },
      subject: opts.subject,
      content: [
        { type: 'text/plain', value: opts.text },
        { type: 'text/html', value: opts.html },
      ],
    }),
  });
  if (!res.ok) throw new Error(`SendGrid ${res.status}: ${await res.text()}`);
  return { skipped: false };
}

function renderEmail(opts: {
  title: string;
  intro: string;
  ticket: Ticket;
  appUrl: string;
}): { html: string; text: string } {
  const link = `${opts.appUrl.replace(/\/$/, '')}/tickets/${opts.ticket.id}`;
  const due = opts.ticket.sla_due_at
    ? new Date(opts.ticket.sla_due_at).toLocaleString()
    : 'unknown';
  const html = `
<!doctype html>
<html><body style="margin:0;padding:24px;background:#f0f4f8;font-family:-apple-system,Segoe UI,sans-serif;color:#1f2937">
  <div style="max-width:600px;margin:0 auto;background:#fff;border-radius:16px;border-left:3px solid #dc2626;padding:32px;box-shadow:0 1px 3px rgba(0,0,0,0.06)">
    <h1 style="margin:0 0 4px;color:#991b1b;font-size:20px">${escapeHtml(opts.title)}</h1>
    <p style="margin:0 0 20px;color:#6b7280;font-size:14px">${escapeHtml(opts.intro)}</p>
    <div style="background:#f8fafc;border-radius:8px;padding:16px;margin-bottom:20px">
      <div style="font-family:monospace;font-size:13px;font-weight:600;color:#1a2744;margin-bottom:6px">${escapeHtml(opts.ticket.ref)}</div>
      <div style="font-size:16px;font-weight:600;color:#111827;margin-bottom:8px">${escapeHtml(opts.ticket.subject)}</div>
      <div style="font-size:12px;color:#6b7280">
        ${escapeHtml(DEPT_LABEL[opts.ticket.department] ?? opts.ticket.department)}
        &nbsp;·&nbsp; Priority: ${escapeHtml(PRIORITY_LABEL[opts.ticket.priority] ?? opts.ticket.priority)}
        &nbsp;·&nbsp; Status: ${escapeHtml(STATUS_LABEL[opts.ticket.status] ?? opts.ticket.status)}
        &nbsp;·&nbsp; SLA due: ${escapeHtml(due)}
      </div>
    </div>
    <a href="${link}" style="display:inline-block;background:#dc2626;color:#fff;font-weight:600;text-decoration:none;padding:10px 20px;border-radius:9999px;font-size:14px">
      Open ticket →
    </a>
    <p style="margin:24px 0 0;color:#9ca3af;font-size:11px;border-top:1px solid #e5e7eb;padding-top:16px">
      AcademyDesk · Warwick Academy helpdesk
    </p>
  </div>
</body></html>`.trim();
  const text = [
    opts.title,
    opts.intro,
    '',
    `${opts.ticket.ref}  —  ${opts.ticket.subject}`,
    `${DEPT_LABEL[opts.ticket.department] ?? opts.ticket.department} · Priority ${PRIORITY_LABEL[opts.ticket.priority] ?? opts.ticket.priority} · Status ${STATUS_LABEL[opts.ticket.status] ?? opts.ticket.status}`,
    `SLA due: ${due}`,
    '',
    `Open: ${link}`,
  ].join('\n');
  return { html, text };
}

async function logNotification(row: {
  ticket_id: string;
  event: string;
  recipients: string[];
  status: 'sent' | 'skipped' | 'error';
  error?: string;
}): Promise<void> {
  await restInsert('notifications_log', {
    ticket_id: row.ticket_id,
    event: row.event,
    recipients: row.recipients,
    status: row.status,
    error: row.error ?? null,
  });
}

export const handler: Handler = async (_event: HandlerEvent) => {
  const appUrl = process.env.APP_URL ?? 'http://localhost:8888';
  const now = Date.now();
  const approachingCutoff = new Date(now + APPROACHING_MS).toISOString();

  let approachingSent = 0;
  let overdueSent = 0;

  try {
    // Overdue: sla_due_at < now AND not yet flagged as overdue.
    const overdue = await restSelect<Ticket>(
      'tickets',
      [
        'select=id,ref,subject,description,department,priority,status,assignee_id,sla_due_at,sla_reminder_approaching_sent,sla_reminder_overdue_sent',
        'status=in.(open,in_progress)',
        `sla_due_at=lt.${encodeURIComponent(new Date(now).toISOString())}`,
        'sla_reminder_overdue_sent=is.false',
      ].join('&'),
    );

    for (const t of overdue) {
      const recipients = new Set<string>();
      const assigneeEmail = await resolveEmail(t.assignee_id);
      if (assigneeEmail) recipients.add(assigneeEmail);
      deptStaffEmails(t.department).forEach((e) => recipients.add(e));

      if (recipients.size === 0) {
        await logNotification({
          ticket_id: t.id,
          event: 'sla.overdue',
          recipients: [],
          status: 'skipped',
          error: 'no recipients',
        });
        await restPatch(
          'tickets',
          `id=eq.${encodeURIComponent(t.id)}`,
          { sla_reminder_overdue_sent: true },
        );
        continue;
      }

      const tpl = renderEmail({
        title: `SLA breached: ${t.ref}`,
        intro: 'This ticket has passed its SLA deadline. Please action it as soon as possible.',
        ticket: t,
        appUrl,
      });
      try {
        const r = await sendgridSend({
          to: [...recipients],
          subject: `[${t.ref}] SLA OVERDUE — ${t.subject}`,
          ...tpl,
        });
        await logNotification({
          ticket_id: t.id,
          event: 'sla.overdue',
          recipients: [...recipients],
          status: r.skipped ? 'skipped' : 'sent',
        });
        if (!r.skipped) overdueSent += 1;
      } catch (err) {
        await logNotification({
          ticket_id: t.id,
          event: 'sla.overdue',
          recipients: [...recipients],
          status: 'error',
          error: err instanceof Error ? err.message : String(err),
        });
      }
      await restPatch(
        'tickets',
        `id=eq.${encodeURIComponent(t.id)}`,
        { sla_reminder_overdue_sent: true },
      );
    }

    // Approaching: sla_due_at within next hour AND not yet flagged & not overdue.
    const approaching = await restSelect<Ticket>(
      'tickets',
      [
        'select=id,ref,subject,description,department,priority,status,assignee_id,sla_due_at,sla_reminder_approaching_sent,sla_reminder_overdue_sent',
        'status=in.(open,in_progress)',
        `sla_due_at=gte.${encodeURIComponent(new Date(now).toISOString())}`,
        `sla_due_at=lt.${encodeURIComponent(approachingCutoff)}`,
        'sla_reminder_approaching_sent=is.false',
      ].join('&'),
    );

    for (const t of approaching) {
      const assigneeEmail = await resolveEmail(t.assignee_id);
      if (!assigneeEmail) {
        await logNotification({
          ticket_id: t.id,
          event: 'sla.approaching',
          recipients: [],
          status: 'skipped',
          error: 'no assignee email',
        });
        await restPatch(
          'tickets',
          `id=eq.${encodeURIComponent(t.id)}`,
          { sla_reminder_approaching_sent: true },
        );
        continue;
      }

      const tpl = renderEmail({
        title: `SLA approaching: ${t.ref}`,
        intro: 'This ticket is due within the next hour. Please make sure it is on track.',
        ticket: t,
        appUrl,
      });
      try {
        const r = await sendgridSend({
          to: [assigneeEmail],
          subject: `[${t.ref}] Due soon — ${t.subject}`,
          ...tpl,
        });
        await logNotification({
          ticket_id: t.id,
          event: 'sla.approaching',
          recipients: [assigneeEmail],
          status: r.skipped ? 'skipped' : 'sent',
        });
        if (!r.skipped) approachingSent += 1;
      } catch (err) {
        await logNotification({
          ticket_id: t.id,
          event: 'sla.approaching',
          recipients: [assigneeEmail],
          status: 'error',
          error: err instanceof Error ? err.message : String(err),
        });
      }
      await restPatch(
        'tickets',
        `id=eq.${encodeURIComponent(t.id)}`,
        { sla_reminder_approaching_sent: true },
      );
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        ok: true,
        scanned: { overdue: overdue.length, approaching: approaching.length },
        sent: { overdue: overdueSent, approaching: approachingSent },
      }),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[sla-reminders] error', message);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: message }) };
  }
};
