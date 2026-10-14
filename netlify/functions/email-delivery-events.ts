import type { Handler } from '@netlify/functions';
import { createPublicKey, createVerify } from 'node:crypto';
import { emailRest } from './send-email';

export const handler: Handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };
  const publicKey = process.env.SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY;
  if (!publicKey) return { statusCode: 503, body: 'Signed delivery webhook not configured' };
  const signature = event.headers['x-twilio-email-event-webhook-signature'];
  const timestamp = event.headers['x-twilio-email-event-webhook-timestamp'];
  if (!signature || !timestamp || !/^\d+$/.test(timestamp)) return { statusCode: 401, body: 'Missing signature' };
  if (Math.abs(Date.now()/1000 - Number(timestamp)) > 600) return { statusCode: 401, body: 'Expired signature' };
  const body = event.isBase64Encoded ? Buffer.from(event.body || '', 'base64') : Buffer.from(event.body || '', 'utf8');
  try {
    const key = publicKey.includes('BEGIN PUBLIC KEY')
      ? createPublicKey(publicKey)
      : createPublicKey({ key: Buffer.from(publicKey, 'base64'), format: 'der', type: 'spki' });
    const verifier = createVerify('SHA256');
    verifier.update(timestamp);
    verifier.update(body);
    if (!verifier.verify(key, Buffer.from(signature, 'base64'))) return { statusCode: 401, body: 'Invalid signature' };
  } catch {
    return { statusCode: 401, body: 'Invalid signature or public key' };
  }
  let events: unknown;
  try { events = JSON.parse(body.toString('utf8')); } catch { return { statusCode: 400, body: 'Invalid JSON' }; }
  if (!Array.isArray(events) || events.length > 1000) return { statusCode: 400, body: 'Invalid event batch' };
  try {
    await emailRest('rpc/record_email_delivery', 'POST', { p_events: events });
    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  } catch {
    return { statusCode: 500, body: 'Could not record delivery events' };
  }
};