/** Create Microsoft calendar events for AV requests and recurring schedules. */
import type { Handler } from '@netlify/functions';

type Profile = { id: string; role: string };
type AvRequest = {
  id: string;
  requester_id: string;
  requester_name: string;
  requested_date: string;
  setup_time: string;
  equipment: string[];
  music_request: string;
  location: string;
  details: string | null;
  links: string[];
};
type RecurringEvent = {
  id: string;
  created_by: string;
  title: string;
  contact_name: string;
  contact_email: string;
  weekday: number;
  start_date: string;
  end_date: string | null;
  setup_time: string;
  location: string;
  calendar_event_id: string | null;
};

const GRAPH_TIME_ZONE = 'Atlantic Standard Time';
const AV_REQUEST_EMAIL = 'audiovisual@warwick.bm';
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing env: ${name}`);
  return value;
}

function json(statusCode: number, body: unknown) {
  return { statusCode, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

function restHeaders() {
  const key = env('SUPABASE_SERVICE_ROLE_KEY');
  return { apikey: key, Authorization: `Bearer ${key}`, 'content-type': 'application/json' };
}

async function selectOne<T>(table: string, query: string): Promise<T | null> {
  const base = env('SUPABASE_URL').replace(/\/$/, '');
  const response = await fetch(`${base}/rest/v1/${table}?${query}`, { headers: restHeaders() });
  if (!response.ok) throw new Error(`Database read failed: ${await response.text()}`);
  return ((await response.json()) as T[])[0] ?? null;
}

async function patch(table: string, id: string, values: Record<string, unknown>) {
  const base = env('SUPABASE_URL').replace(/\/$/, '');
  const response = await fetch(`${base}/rest/v1/${table}?id=eq.${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { ...restHeaders(), Prefer: 'return=minimal' },
    body: JSON.stringify(values),
  });
  if (!response.ok) throw new Error(`Database update failed: ${await response.text()}`);
}

function dateTime(date: string, time: string) {
  return `${date}T${time.slice(0, 5)}:00`;
}

function oneHourLater(time: string) {
  const [hours, minutes] = time.split(':').map(Number);
  const total = ((hours ?? 0) * 60 + (minutes ?? 0) + 60) % (24 * 60);
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

function eventEnd(date: string, time: string) {
  const endTime = oneHourLater(time);
  if (endTime > time.slice(0, 5)) return dateTime(date, endTime);
  const nextDate = new Date(`${date}T12:00:00Z`);
  nextDate.setUTCDate(nextDate.getUTCDate() + 1);
  return dateTime(nextDate.toISOString().slice(0, 10), endTime);
}

async function createGraphEvent(providerToken: string, event: Record<string, unknown>) {
  const response = await fetch('https://graph.microsoft.com/v1.0/me/events', {
    method: 'POST',
    headers: { Authorization: `Bearer ${providerToken}`, 'content-type': 'application/json' },
    body: JSON.stringify(event),
  });
  if (!response.ok) {
    const detail = await response.text();
    if (response.status === 401 || response.status === 403) {
      throw new Error('Microsoft calendar permission is unavailable. Sign out, sign in with Microsoft again, and retry.');
    }
    throw new Error(`Microsoft calendar creation failed: ${detail}`);
  }
  return (await response.json()) as { id: string; webLink?: string };
}

async function updateGraphEvent(providerToken: string, id: string, event: Record<string, unknown>) {
  const response = await fetch(`https://graph.microsoft.com/v1.0/me/events/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${providerToken}`, 'content-type': 'application/json' },
    body: JSON.stringify(event),
  });
  if (!response.ok) {
    const detail = await response.text();
    if (response.status === 401 || response.status === 403) {
      throw new Error('Microsoft calendar permission is unavailable. Sign out, sign in with Microsoft again, and retry.');
    }
    throw new Error(`Microsoft calendar update failed: ${detail}`);
  }
}

export const handler: Handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });
  const auth = event.headers.authorization ?? event.headers.Authorization;
  if (!auth?.startsWith('Bearer ')) return json(401, { error: 'Missing bearer token' });
  const providerToken = event.headers['x-ms-provider-token'];
  if (!providerToken) return json(409, { error: 'Microsoft calendar permission is required. Sign out and sign in with Microsoft again.' });

  let body: { kind?: 'request' | 'recurring'; id?: string; action?: 'create' | 'update' };
  try {
    body = JSON.parse(event.body ?? '{}') as typeof body;
  } catch {
    return json(400, { error: 'Invalid JSON' });
  }
  if (
    !body.id ||
    !['request', 'recurring'].includes(body.kind ?? '') ||
    (body.action !== undefined && body.action !== 'create' && body.action !== 'update')
  ) {
    return json(400, { error: 'Valid kind and id are required' });
  }

  const base = env('SUPABASE_URL').replace(/\/$/, '');
  const serviceKey = env('SUPABASE_SERVICE_ROLE_KEY');
  const meResponse = await fetch(`${base}/auth/v1/user`, {
    headers: { apikey: serviceKey, Authorization: auth },
  });
  if (!meResponse.ok) return json(401, { error: 'Invalid session' });
  const me = (await meResponse.json()) as { id: string };
  const profile = await selectOne<Profile>('profiles', `id=eq.${me.id}&select=id,role`);
  if (!profile) return json(403, { error: 'Profile not found' });

  try {
    if (body.kind === 'request') {
      const request = await selectOne<AvRequest>(
        'av_requests',
        `id=eq.${encodeURIComponent(body.id)}&select=*`,
      );
      if (!request || request.requester_id !== me.id) return json(403, { error: 'Request access denied' });
      const details = [
        `Requester: ${request.requester_name}`,
        `Equipment: ${request.equipment.join(', ') || 'None selected'}`,
        `Music: ${request.music_request}`,
        request.details ? `Details: ${request.details}` : '',
        request.links.length ? `Links:\n${request.links.join('\n')}` : '',
      ].filter(Boolean).join('\n\n');
      const graphEvent = await createGraphEvent(providerToken, {
        subject: `AV Setup — ${request.location}`,
        body: { contentType: 'text', content: details },
        start: { dateTime: dateTime(request.requested_date, request.setup_time), timeZone: GRAPH_TIME_ZONE },
        end: { dateTime: eventEnd(request.requested_date, request.setup_time), timeZone: GRAPH_TIME_ZONE },
        location: { displayName: request.location },
        attendees: [{ emailAddress: { address: AV_REQUEST_EMAIL, name: 'Audiovisual' }, type: 'required' }],
        isReminderOn: true,
        reminderMinutesBeforeStart: 1440,
      });
      await patch('av_requests', request.id, { calendar_event_id: graphEvent.id, calendar_status: 'created' });
      return json(200, { ok: true, webLink: graphEvent.webLink ?? null });
    }

    if (profile.role !== 'admin' && profile.role !== 'av_admin') {
      return json(403, { error: 'AV administrators only' });
    }
    const recurring = await selectOne<RecurringEvent>(
      'av_recurring_events',
      `id=eq.${encodeURIComponent(body.id)}&select=*`,
    );
    if (!recurring) return json(404, { error: 'Recurring event not found' });
    const recurrenceRange = recurring.end_date
      ? { type: 'endDate', startDate: recurring.start_date, endDate: recurring.end_date, recurrenceTimeZone: GRAPH_TIME_ZONE }
      : { type: 'noEnd', startDate: recurring.start_date, recurrenceTimeZone: GRAPH_TIME_ZONE };
    const graphEvent = {
      subject: recurring.title,
      body: {
        contentType: 'text',
        content: `Recurring AV readiness event. Contact: ${recurring.contact_name} <${recurring.contact_email}>`,
      },
      start: { dateTime: dateTime(recurring.start_date, recurring.setup_time), timeZone: GRAPH_TIME_ZONE },
      end: { dateTime: eventEnd(recurring.start_date, recurring.setup_time), timeZone: GRAPH_TIME_ZONE },
      location: { displayName: recurring.location },
      attendees: [{ emailAddress: { address: recurring.contact_email, name: recurring.contact_name }, type: 'required' }],
      recurrence: {
        pattern: { type: 'weekly', interval: 1, daysOfWeek: [WEEKDAYS[recurring.weekday]] },
        range: recurrenceRange,
      },
    };
    if (body.action === 'update') {
      if (!recurring.calendar_event_id) {
        return json(409, { error: 'This recurring schedule has no Microsoft calendar event to update.' });
      }
      await updateGraphEvent(providerToken, recurring.calendar_event_id, graphEvent);
      await patch('av_recurring_events', recurring.id, { calendar_status: 'created' });
      return json(200, { ok: true });
    }

    const createdEvent = await createGraphEvent(providerToken, graphEvent);
    await patch('av_recurring_events', recurring.id, { calendar_event_id: createdEvent.id, calendar_status: 'created' });
    return json(200, { ok: true, webLink: createdEvent.webLink ?? null });
  } catch (error) {
    const table = body.kind === 'request' ? 'av_requests' : 'av_recurring_events';
    await patch(table, body.id, { calendar_status: 'failed' }).catch(() => undefined);
    return json(502, { error: error instanceof Error ? error.message : 'Calendar creation failed' });
  }
};