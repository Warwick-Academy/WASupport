/**
 * Admin-only: invite a new user by email.
 *
 * POST /api/admin-create-user
 * Headers:
 *   Authorization: Bearer <caller-jwt>     (admin's Supabase access token)
 * Body:
 *   { email: string; full_name?: string; role: UserRole }
 *
 * Required env:
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */
import type { Handler } from '@netlify/functions';

type UserRole =
  | 'submitter'
  | 'it_tech'
  | 'fac_tech'
  | 'hs_officer'
  | 'av_admin'
  | 'support'
  | 'manager'
  | 'admin'
  | 'leadership';

const VALID_ROLES: UserRole[] = [
  'submitter',
  'it_tech',
  'fac_tech',
  'hs_officer',
  'av_admin',
  'support',
  'manager',
  'admin',
  'leadership',
];

const VALID_DEPARTMENTS = ['IT', 'FAC', 'AV', 'HS'];

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

function json(status: number, body: unknown) {
  return {
    statusCode: status,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

async function findAuthUserByEmail(supabaseUrl: string, serviceKey: string, email: string) {
  const perPage = 1000;
  for (let page = 1; page <= 100; page += 1) {
    const params = new URLSearchParams({ page: String(page), per_page: String(perPage) });
    const response = await fetch(`${supabaseUrl}/auth/v1/admin/users?${params}`, {
      headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
    });
    if (!response.ok) throw new Error(`Could not search existing auth users: ${await response.text()}`);
    const body = await response.json() as { users?: Array<{ id: string; email?: string }> };
    const match = (body.users ?? []).find((user) => user.email?.toLowerCase() === email);
    if (match) return match;
    if ((body.users ?? []).length < perPage) return null;
  }
  return null;
}

export const handler: Handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

  const auth = event.headers.authorization ?? event.headers.Authorization;
  if (!auth?.startsWith('Bearer ')) return json(401, { error: 'Missing bearer token' });
  const callerJwt = auth.slice(7);

  let body: { email?: string; full_name?: string; role?: string; department?: string };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { error: 'Invalid JSON' });
  }

  const email = body.email?.trim().toLowerCase();
  const full_name = body.full_name?.trim() || null;
  const role = body.role as UserRole | undefined;

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return json(400, { error: 'Valid email required' });
  }
  if (!role || !VALID_ROLES.includes(role)) {
    return json(400, { error: 'Valid role required' });
  }
  const department = body.department || null;
  if (department && !VALID_DEPARTMENTS.includes(department)) {
    return json(400, { error: 'Invalid department' });
  }

  const supabaseUrl = env('SUPABASE_URL').replace(/\/$/, '');
  const serviceKey = env('SUPABASE_SERVICE_ROLE_KEY');

  // 1. Identify caller from their JWT.
  const meRes = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: { apikey: serviceKey, Authorization: `Bearer ${callerJwt}` },
  });
  if (!meRes.ok) return json(401, { error: 'Invalid session' });
  const me = (await meRes.json()) as { id: string };

  // 2. Verify caller is admin (via service role to bypass RLS).
  const profRes = await fetch(
    `${supabaseUrl}/rest/v1/profiles?id=eq.${me.id}&select=role`,
    { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } },
  );
  const prof = (await profRes.json()) as { role: UserRole }[];
  if (prof[0]?.role !== 'admin') return json(403, { error: 'Admin only' });

  // 3. Invite a new Auth user, or recover an existing Auth user by email.
  const inviteRes = await fetch(`${supabaseUrl}/auth/v1/invite`, {
    method: 'POST',
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ email, data: full_name ? { full_name } : undefined }),
  });
  const inviteBody = await inviteRes.text();
  let authUser: { id: string; email?: string } | null = null;
  let existingAuthUser = false;
  if (inviteRes.ok) {
    try {
      authUser = JSON.parse(inviteBody) as { id: string; email?: string };
    } catch {
      return json(502, { error: 'Invite returned an invalid response' });
    }
  } else {
    const duplicate = inviteRes.status === 409 || inviteRes.status === 422 ||
      /already registered|already exists|email_exists/i.test(inviteBody);
    if (!duplicate) return json(inviteRes.status, { error: 'Invite failed', detail: inviteBody });
    try {
      authUser = await findAuthUserByEmail(supabaseUrl, serviceKey, email);
    } catch (searchError) {
      return json(502, {
        error: 'The email is already registered, but the existing account could not be found',
        detail: searchError instanceof Error ? searchError.message : String(searchError),
      });
    }
    if (!authUser) return json(409, { error: 'The email is already registered in Auth but no user record was found' });
    existingAuthUser = true;
  }

  if (!authUser?.id) return json(502, { error: 'Auth did not return a user id' });

  // Auth may predate the profile trigger or the user may have been invited before
  // profile creation failed. Repair the profile and assign the requested role.
  const profileUrl = `${supabaseUrl}/rest/v1/profiles?id=eq.${authUser.id}&select=id`;
  const existingProfileResponse = await fetch(profileUrl, {
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
  });
  if (!existingProfileResponse.ok) {
    return json(502, { error: 'Could not check the profile record', detail: await existingProfileResponse.text() });
  }
  const existingProfiles = await existingProfileResponse.json() as Array<{ id: string }>;
  const profileFields: Record<string, unknown> = {
    role,
    department: role === 'manager' ? department : null,
  };
  if (full_name) profileFields.full_name = full_name;

  const profileResponse = existingProfiles.length
    ? await fetch(`${supabaseUrl}/rest/v1/profiles?id=eq.${authUser.id}`, {
        method: 'PATCH',
        headers: {
          apikey: serviceKey,
          Authorization: `Bearer ${serviceKey}`,
          'content-type': 'application/json',
          Prefer: 'return=minimal',
        },
        body: JSON.stringify(profileFields),
      })
    : await fetch(`${supabaseUrl}/rest/v1/profiles?on_conflict=id`, {
        method: 'POST',
        headers: {
          apikey: serviceKey,
          Authorization: `Bearer ${serviceKey}`,
          'content-type': 'application/json',
          Prefer: 'resolution=merge-duplicates,return=minimal',
        },
        body: JSON.stringify({
          id: authUser.id,
          email: authUser.email ?? email,
          full_name: full_name ?? authUser.email ?? email,
          ...profileFields,
        }),
      });
  if (!profileResponse.ok) {
    return json(500, {
      error: existingProfiles.length ? 'User found, but profile update failed' : 'User found, but profile repair failed',
      detail: await profileResponse.text(),
    });
  }

  return json(200, { ok: true, id: authUser.id, email, existing: existingAuthUser });
};
