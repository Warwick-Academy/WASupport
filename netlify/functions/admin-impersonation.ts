import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import type { Handler } from '@netlify/functions';

type TargetRole = 'submitter' | 'it_tech' | 'fac_tech' | 'hs_officer' | 'av_admin' | 'manager';
type RequestBody = {
  action?: 'start' | 'stop';
  target_user_id?: string;
  reason?: string;
  audit_id?: string;
  restore_token?: string;
};

const TARGET_ROLES: TargetRole[] = [
  'submitter',
  'it_tech',
  'fac_tech',
  'hs_officer',
  'av_admin',
  'manager',
];

function json(statusCode: number, body: unknown) {
  return {
    statusCode,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing env: ${name}`);
  return value;
}

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export const handler: Handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });
  const authorization = event.headers.authorization ?? event.headers.Authorization;
  if (!authorization?.startsWith('Bearer ')) return json(401, { error: 'Missing bearer token' });

  let body: RequestBody;
  try {
    body = JSON.parse(event.body ?? '{}') as RequestBody;
  } catch {
    return json(400, { error: 'Invalid JSON' });
  }

  const supabaseUrl = requiredEnv('SUPABASE_URL').replace(/\/$/, '');
  const serviceKey = requiredEnv('SUPABASE_SERVICE_ROLE_KEY');
  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data: callerData, error: callerError } = await admin.auth.getUser(authorization.slice(7));
  if (callerError || !callerData.user) return json(401, { error: 'Invalid session' });

  if (body.action === 'start') {
    const reason = body.reason?.trim();
    if (!body.target_user_id || !reason || reason.length < 5 || reason.length > 500) {
      return json(400, {
        error: 'Target user and an audit reason of 5–500 characters are required',
      });
    }

    const { data: actor, error: actorError } = await admin
      .from('profiles')
      .select('role')
      .eq('id', callerData.user.id)
      .maybeSingle();
    if (actorError) return json(500, { error: 'Could not verify administrator' });
    if (actor?.role !== 'admin') return json(403, { error: 'Admin only' });

    const { data: target, error: targetError } = await admin
      .from('profiles')
      .select('id,email,role,department')
      .eq('id', body.target_user_id)
      .maybeSingle();
    if (targetError) return json(500, { error: 'Could not load target account' });
    if (!target || !TARGET_ROLES.includes(target.role as TargetRole)) {
      return json(400, {
        error: 'Only submitters, department members, and managers can be emulated',
      });
    }
    if (target.id === callerData.user.id)
      return json(400, { error: 'Cannot emulate your own account' });

    const { data: link, error: linkError } = await admin.auth.admin.generateLink({
      type: 'magiclink',
      email: target.email,
    });
    if (linkError || !link.properties?.hashed_token) {
      return json(500, { error: 'Could not create the temporary target session' });
    }

    const restoreToken = randomBytes(32).toString('base64url');
    const { data: audit, error: auditError } = await admin
      .from('admin_impersonation_audit')
      .insert({
        actor_user_id: callerData.user.id,
        target_user_id: target.id,
        target_role: target.role,
        target_department: target.department,
        reason,
        restore_token_hash: tokenHash(restoreToken),
      })
      .select('id')
      .single();
    if (auditError) return json(500, { error: 'Could not create the impersonation audit record' });

    return json(200, {
      audit_id: audit.id,
      restore_token: restoreToken,
      token_hash: link.properties.hashed_token,
      target_email: target.email,
    });
  }

  if (body.action === 'stop') {
    if (!body.audit_id || !body.restore_token) {
      return json(400, { error: 'Audit id and restore token are required' });
    }
    const { data: audit, error: auditError } = await admin
      .from('admin_impersonation_audit')
      .select('actor_user_id,target_user_id,restore_token_hash,ended_at')
      .eq('id', body.audit_id)
      .maybeSingle();
    if (auditError) return json(500, { error: 'Could not verify the impersonation session' });
    if (
      !audit ||
      audit.ended_at ||
      ![audit.target_user_id, audit.actor_user_id].includes(callerData.user.id)
    ) {
      return json(403, { error: 'Invalid or expired impersonation session' });
    }

    const expected = Buffer.from(audit.restore_token_hash, 'hex');
    const supplied = Buffer.from(tokenHash(body.restore_token), 'hex');
    if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) {
      return json(403, { error: 'Invalid or expired impersonation session' });
    }

    const { error: endError } = await admin
      .from('admin_impersonation_audit')
      .update({ ended_at: new Date().toISOString() })
      .eq('id', body.audit_id)
      .is('ended_at', null);
    if (endError) return json(500, { error: 'Could not close the impersonation audit record' });
    return json(200, { ok: true });
  }

  return json(400, { error: 'Action must be start or stop' });
};
