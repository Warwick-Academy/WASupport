import { readFileSync } from 'node:fs';
import { createSign, generateKeyPairSync } from 'node:crypto';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
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

process.env.SUPABASE_URL = 'https://email-test.invalid';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role';
process.env.SENDGRID_API_KEY = 'SG.test-only';
process.env.SENDGRID_FROM_EMAIL = 'sender@example.test';
const email = {
  id: 'b4e7a3ee-b89f-4f53-a20b-bd7cc2d28f84', lease_id: 'test-lease', recipient: 'recipient@example.test', attempts: 1,
  payload: { title: 'New reply', intro: 'A reply was posted.', body: '<script>unsafe</script>',
    ticket: {
      id: 'test-ticket', ref: 'IT-TEST', subject: 'Test', department: 'IT', status: 'open', priority: 'normal',
      description: 'Camera issue', submitter_name: 'Taylor Submitter', submitter_email: 'taylor@example.test',
      assignee_name: 'Avery Technician', category_name: 'Hardware', subcategory_name: 'Cameras',
      requested_for: 'Maria Woods', building: 'Barber Hall', room: '12',
      created_at: '2026-10-26T12:00:00.000Z',
    } },
};
const service = load('netlify/functions/send-email.ts');
const rendered = service.renderQueuedEmail(email);
assert.ok(rendered.html.includes('&lt;script&gt;'));
for (const detail of ['Taylor Submitter', 'taylor@example.test', 'Hardware / Cameras', 'Maria Woods', 'Barber Hall / 12', 'Avery Technician', 'Camera issue']) {
  assert.ok(rendered.html.includes(detail), `HTML email should include ${detail}`);
  assert.ok(rendered.text.includes(detail), `Text email should include ${detail}`);
}
for (const failure of [false, true]) {
  const finishes = [];
  let sentTo;
  globalThis.fetch = async (url, options) => {
    if (url.includes('claim_ticket_emails')) return new Response(JSON.stringify([email]));
    if (url.includes('finish_ticket_email')) finishes.push(JSON.parse(options.body));
    if (url.includes('api.sendgrid.com')) {
      sentTo = JSON.parse(options.body).personalizations[0];
      return new Response(failure ? 'Rejected' : '', { status: failure ? 429 : 202, headers: { 'x-message-id': 'provider-test' } });
    }
    return new Response('');
  };
  const result = await service.drainTicketEmails();
  assert.equal(result.processed, 1);
  assert.equal(result.accepted, failure ? 0 : 1);
  assert.equal(finishes.length, 1);
  assert.equal(finishes[0].p_ok, !failure);
  assert.equal(sentTo.to[0].email, email.recipient);
  assert.equal(sentTo.custom_args.outbox_id, email.id);
}

const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
process.env.SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
const callback = load('netlify/functions/email-delivery-events.ts', { './send-email': service });
const timestamp = String(Math.floor(Date.now() / 1000));
const body = JSON.stringify([{ event: 'delivered', outbox_id: email.id, sg_event_id: 'test-event', timestamp: Number(timestamp) }]);
const signer = createSign('SHA256');
signer.update(timestamp + body);
const signature = signer.sign(privateKey).toString('base64');
const event = { httpMethod: 'POST', body, headers: {
  'x-twilio-email-event-webhook-signature': signature,
  'x-twilio-email-event-webhook-timestamp': timestamp,
} };
assert.equal((await callback.handler(event)).statusCode, 200);
assert.equal((await callback.handler({ ...event, body: '[]' })).statusCode, 401);
assert.equal((await callback.handler({ ...event, headers: {} })).statusCode, 401);
console.log('PASS: sending, retry persistence, recipient routing, HTML escaping, signed callbacks, and tamper rejection');