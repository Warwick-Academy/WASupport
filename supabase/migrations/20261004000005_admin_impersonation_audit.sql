create table public.admin_impersonation_audit (
  id uuid primary key default gen_random_uuid(),
  actor_user_id uuid not null,
  target_user_id uuid not null,
  target_role text not null,
  target_department text,
  reason text not null check (char_length(reason) between 5 and 500),
  restore_token_hash text not null,
  started_at timestamptz not null default now(),
  ended_at timestamptz
);

create index admin_impersonation_audit_actor_started_idx
  on public.admin_impersonation_audit (actor_user_id, started_at desc);

alter table public.admin_impersonation_audit enable row level security;
revoke all on public.admin_impersonation_audit from anon, authenticated;
grant all on public.admin_impersonation_audit to service_role;