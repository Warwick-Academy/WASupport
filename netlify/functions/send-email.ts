import type { Handler } from '@netlify/functions';

type QueuedEmail = {
  id: string;
  lease_id: string;
  recipient: string;
  attempts: number;
  payload: {
    title: string;
    intro: string;
    body: string | null;
    ticket: {
      id: string;
      ref: string;
      subject: string;
      department: string;
      status: string;
      priority: string;
      description?: string | null;
      submitter_name?: string | null;
      submitter_email?: string | null;
      assignee_name?: string | null;
      legacy_assignee_name?: string | null;
      category_name?: string | null;
      subcategory_name?: string | null;
      requested_for?: string | null;
      location_label?: string | null;
      building?: string | null;
      room?: string | null;
      legacy_location?: string | null;
      created_at?: string | null;
    };
  };
};

export async function emailRest<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Supabase email worker configuration is missing');
  const response = await fetch(`${url.replace(/\/$/, '')}/rest/v1/${path}`, {
    method,
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(12000),
  });
  if (!response.ok) throw new Error(`Email database request failed (${response.status})`);
  const text = await response.text();
  return (text ? JSON.parse(text) : null) as T;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function renderQueuedEmail(email: QueuedEmail): { html: string; text: string } {
  const { title, intro, body, ticket } = email.payload;
  const appUrl = process.env.APP_URL || 'https://wasupportportal.netlify.app';
  const link = `${appUrl.replace(/\/$/, '')}/tickets/${encodeURIComponent(ticket.id)}`;
  const status = ticket.status.replace(/_/g, ' ');
  const location =
    ticket.location_label ||
    [ticket.building, ticket.room].filter(Boolean).join(' / ') ||
    ticket.legacy_location;
  const category = [ticket.category_name, ticket.subcategory_name].filter(Boolean).join(' / ');
  const details = [
    ['Submitted by', [ticket.submitter_name, ticket.submitter_email].filter(Boolean).join(' · ')],
    ['Department', ticket.department],
    ['Status', status],
    ['Priority', ticket.priority],
    ['Category', category],
    ['Requested for', ticket.requested_for],
    ['Location', location],
    ['Assigned to', ticket.assignee_name || ticket.legacy_assignee_name || 'Unassigned'],
    ['Submitted', ticket.created_at],
  ].filter((detail): detail is [string, string] => Boolean(detail[1]));
  const description = ticket.description || (body === ticket.description ? body : null);
  const update = body && body !== description ? body : null;
  const detailText = details.map(([label, value]) => `${label}: ${value}`);
  const text = [
    title,
    intro,
    `${ticket.ref}: ${ticket.subject}`,
    ...detailText,
    description ? `Description:\n${description}` : '',
    update ? `Update:\n${update}` : '',
    `View ticket: ${link}`,
    'Reply using the ticket link; email replies are not monitored.',
  ]
    .filter(Boolean)
    .join('\n\n');
  const detailHtml = details
    .map(
      ([label, value]) =>
        `<tr><th style="padding:4px 12px 4px 0;text-align:left;vertical-align:top">${escapeHtml(label)}</th><td style="padding:4px 0">${escapeHtml(value)}</td></tr>`,
    )
    .join('');
  const html = `<html><body style="font-family:Segoe UI,sans-serif;background:#f0f4f8;padding:24px;color:#1f2937"><div style="max-width:600px;margin:auto;background:white;padding:28px;border-left:3px solid #1a2744"><h1 style="font-size:20px">${escapeHtml(title)}</h1><p>${escapeHtml(intro)}</p><h2 style="font-size:16px">${escapeHtml(ticket.ref)}: ${escapeHtml(ticket.subject)}</h2><table style="font-size:14px">${detailHtml}</table>${description ? `<h3 style="font-size:15px;margin-bottom:4px">Description</h3><p style="white-space:pre-wrap;margin-top:0">${escapeHtml(description)}</p>` : ''}${update ? `<h3 style="font-size:15px;margin-bottom:4px">Update</h3><p style="white-space:pre-wrap;margin-top:0">${escapeHtml(update)}</p>` : ''}<a href="${escapeHtml(link)}">View ticket and reply</a><p style="font-size:12px">Reply using the ticket link; email replies are not monitored.</p></div></body></html>`;
  return { html, text };
}

export async function drainTicketEmails(): Promise<{ processed: number; accepted: number; failed: number }> {
  const emails = await emailRest<QueuedEmail[]>('rpc/claim_ticket_emails', 'POST', { p_limit: 10 });
  let accepted = 0;
  let failed = 0;
  await Promise.all(emails.map(async (email) => {
    let acceptedByProvider = false;
    try {
      await emailRest(`notifications_log?outbox_id=eq.${email.id}`, 'PATCH', {
        status: 'processing', attempts: email.attempts, updated_at: new Date().toISOString(),
      });
      const apiKey = process.env.SENDGRID_API_KEY;
      const from = process.env.SENDGRID_FROM_EMAIL;
      if (!apiKey?.startsWith('SG.') || apiKey.startsWith('SG....') || !from) {
        throw new Error('SendGrid API key or verified sender is not configured');
      }
      const template = renderQueuedEmail(email);
      const response = await fetch('https://api.sendgrid.com/v3/mail/send', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          personalizations: [{ to: [{ email: email.recipient }], custom_args: { outbox_id: email.id } }],
          from: { email: from, name: 'WA Support Center' },
          subject: `[${email.payload.ticket.ref}] ${email.payload.title}`,
          content: [{ type: 'text/plain', value: template.text }, { type: 'text/html', value: template.html }],
        }),
        signal: AbortSignal.timeout(12000),
      });
      if (!response.ok) throw new Error(`SendGrid rejected this email (${response.status}): ${(await response.text()).slice(0, 1000)}`);
      acceptedByProvider = true;
      await emailRest('rpc/finish_ticket_email', 'POST', {
        p_id: email.id, p_lease: email.lease_id, p_ok: true, p_provider: response.headers.get('x-message-id'),
      });
      accepted += 1;
    } catch (error) {
      failed += 1;
      const reason = error instanceof Error ? error.message : 'Email delivery failed';
      if (acceptedByProvider) {
        console.error('[ticket-emails] SendGrid accepted email but acknowledgement failed:', email.id);
        return;
      }
      try {
        await emailRest('rpc/finish_ticket_email', 'POST', {
          p_id: email.id, p_lease: email.lease_id, p_ok: false, p_error: reason,
        });
      } catch {
        console.error('[ticket-emails] Could not persist failure:', email.id);
      }
    }
  }));
  return { processed: emails.length, accepted, failed };
}

export const handler: Handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };
  const secret = event.headers['x-webhook-secret'];
  if (!secret || secret !== process.env.NOTIFY_WEBHOOK_SECRET) return { statusCode: 401, body: 'Unauthorized' };
  return { statusCode: 200, body: JSON.stringify({ ok: true, delivery: 'database-outbox' }) };
};