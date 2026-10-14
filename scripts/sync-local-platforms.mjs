import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'dotenv';

const root = fileURLToPath(new URL('..', import.meta.url));
const siteId = 'ff8aa325-67d1-4c01-a433-f7444d9fae32';
const projectRef = 'lpfayazlroudwnsgioou';
const envPath = path.join(root, '.env.local');
const useProduction = process.argv.includes('--use-production');
if (process.argv.slice(2).some((argument) => argument !== '--use-production')) {
  throw new Error('Usage: node scripts/sync-local-platforms.mjs [--use-production]');
}

async function optionalFile(filename) {
  try {
    return await readFile(filename, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return '';
  }
}

async function request(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) {
    // Provider responses can contain credentials or personal data.
    throw new Error(`${new URL(url).hostname}${new URL(url).pathname}: HTTP ${response.status}`);
  }
  return response;
}

async function main() {
  let token = process.env.NETLIFY_AUTH_TOKEN;
  if (!token) {
    const configPath = path.join(
      process.env.APPDATA || path.join(homedir(), '.config'),
      'netlify', 'Config', 'config.json',
    );
    const content = await optionalFile(configPath);
    if (!content) throw new Error('Run netlify login first, or set NETLIFY_AUTH_TOKEN.');
    const config = JSON.parse(content);
    token = config.users?.[config.userId]?.auth?.token;
  }
  if (!token) throw new Error('No active Netlify login. Run netlify login first.');

  const headers = { Authorization: `Bearer ${token}` };
  const site = await (await request(
    `https://api.netlify.com/api/v1/sites/${siteId}`, { headers },
  )).json();
  const repositoryUrls = [
    'https://github.com/Warwick-Academy/WASupport',
    'https://github.com/Markinbda/WASupport',
  ];
  if (!repositoryUrls.includes(site.build_settings?.repo_url)) {
    throw new Error('Netlify site is not connected to the expected WASupport repository.');
  }
  const variables = await (await request(
    `https://api.netlify.com/api/v1/accounts/${site.account_slug}/env?site_id=${siteId}`,
    { headers },
  )).json();
  const original = await optionalFile(envPath);
  const existing = parse(original);
  function value(key, allowProduction = useProduction) {
    const variable = variables.find((item) => item.key === key);
    if (variable?.is_secret) {
      console.log(`${key}: Netlify secret is write-only; using the existing local value.`);
      return existing[key];
    }
    const entries = (variable?.values || [])
      .filter((item) => item.value);
    const result = entries.find((item) => item.context === 'dev')
      || entries.find((item) => item.context === 'all')
      || (allowProduction && entries.find((item) => item.context === 'production'));
    return result?.value;
  }

  const settings = Object.fromEntries([
    'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY',
    'VITE_SUPABASE_URL', 'VITE_SUPABASE_ANON_KEY', 'SENDGRID_API_KEY',
  ].map((key) => [key, value(key)]));
  settings.SENDGRID_FROM_EMAIL = value('SENDGRID_FROM_EMAIL', true);
  for (const [key, setting] of Object.entries(settings)) {
    if (!setting || /^(your[-_]|<|SG\.\.\.)/i.test(setting) || setting.includes('***')) {
      throw new Error(`Missing usable setting: ${key}. Save a real value in Git-ignored .env.local; Netlify write-only secrets cannot be exported.`);
    }
  }
  const expectedUrl = `https://${projectRef}.supabase.co`;
  if (settings.SUPABASE_URL !== expectedUrl || settings.VITE_SUPABASE_URL !== expectedUrl) {
    throw new Error('Netlify development settings do not target the expected Supabase project.');
  }

  await request(`${expectedUrl}/rest/v1/`, {
    headers: {
      apikey: settings.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${settings.SUPABASE_SERVICE_ROLE_KEY}`,
    },
  });
  await request(`${expectedUrl}/auth/v1/settings`, {
    headers: { apikey: settings.VITE_SUPABASE_ANON_KEY },
  });
  console.log('PASS: Supabase service-role and browser-key access.');

  await request('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${settings.SENDGRID_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: settings.SENDGRID_FROM_EMAIL }] }],
      from: { email: settings.SENDGRID_FROM_EMAIL },
      subject: 'Local setup validation (sandbox only)',
      content: [{ type: 'text/plain', value: 'Sandbox validation. No message is delivered.' }],
      mail_settings: { sandbox_mode: { enable: true } },
    }),
  });
  console.log('PASS: SendGrid Mail Send sandbox accepted; no email sent.');

  if (existing.SUPABASE_URL && existing.SUPABASE_URL !== expectedUrl) {
    throw new Error('Existing local Supabase URL differs; refusing to replace it.');
  }
  settings.APP_URL = 'http://localhost:8888';
  const webhookKey = value('SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY');
  if (webhookKey) settings.SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY = webhookKey;
  const remaining = original.split(/\r?\n/).filter((line) => {
    const key = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/)?.[1];
    return !Object.hasOwn(settings, key);
  }).join('\n').trimEnd();
  const managed = Object.entries(settings).map(([key, setting]) => {
    if (/[\r\n]/.test(setting)) throw new Error(`Multiline setting not supported: ${key}`);
    if (/['"\\]/.test(setting)) throw new Error(`Unsupported quoting in setting: ${key}`);
    return `${key}='${setting}'`;
  }).join('\n');
  await writeFile(envPath, `${remaining}${remaining ? '\n' : ''}${managed}\n`, { mode: 0o600 });
  await mkdir(path.join(root, '.netlify'), { recursive: true });
  await writeFile(path.join(root, '.netlify', 'state.json'), `${JSON.stringify({ siteId }, null, 2)}\n`);
  console.log(`Linked local checkout to Netlify site: ${site.name}.`);
  console.log('Updated Git-ignored .env.local. No cloud settings or database records changed.');
  if (!webhookKey && !existing.SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY) {
    console.warn('NOT CONFIGURED: signed SendGrid delivery-event verification key.');
  }
}

main().catch((error) => {
  console.error(`Platform sync failed: ${error.message}`);
  process.exitCode = 1;
});
