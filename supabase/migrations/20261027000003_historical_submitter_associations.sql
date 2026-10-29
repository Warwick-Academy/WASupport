create or replace function public.normalize_submitter_name(p_name text)
returns text
language sql
immutable
parallel safe
as $$
  select lower(regexp_replace(btrim(coalesce(p_name, '')), '\s+', ' ', 'g'));
$$;
create table public.ticket_submitter_aliases (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles(id) on delete cascade,
  alias text not null check (btrim(alias) <> ''),
  alias_normalized text generated always as (public.normalize_submitter_name(alias)) stored,
  created_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  unique (alias_normalized)
);
create index profiles_submitter_name_match_idx
  on public.profiles (public.normalize_submitter_name(full_name))
  where role = 'submitter' and full_name is not null;
create index tickets_legacy_submitter_name_match_idx
  on public.tickets (public.normalize_submitter_name(legacy_submitter_name))
  where submitter_id is null and legacy_submitter_name is not null;
create index tickets_legacy_submitter_email_match_idx
  on public.tickets (lower(btrim(legacy_submitter_email)))
  where submitter_id is null and legacy_submitter_email is not null;
alter table public.ticket_submitter_aliases enable row level security;
create policy "ticket submitter aliases admin access"
  on public.ticket_submitter_aliases for all
  using (public.is_admin())
  with check (public.is_admin());
create or replace function public.associate_historical_ticket_submitter(p_ticket_id uuid)
returns void
language plpgsql
security definer
set search_path = public
set row_security = off
as $$
declare
  ticket public.tickets%rowtype;
  matched_profile uuid;
  match_count bigint;
begin
  select * into ticket from public.tickets where id = p_ticket_id;
  if not found or ticket.submitter_id is not null then
    return;
  end if;

  if nullif(btrim(ticket.legacy_submitter_email), '') is not null then
    select count(*), (array_agg(p.id order by p.id))[1]
      into match_count, matched_profile
      from public.profiles p
     where p.role = 'submitter'
       and lower(btrim(p.email)) = lower(btrim(ticket.legacy_submitter_email));
    if match_count = 1 then
      update public.tickets set submitter_id = matched_profile
       where id = ticket.id and submitter_id is null;
      return;
    end if;
  end if;

  if nullif(btrim(ticket.legacy_submitter_name), '') is null then
    return;
  end if;

  select a.profile_id into matched_profile
    from public.ticket_submitter_aliases a
    join public.profiles p on p.id = a.profile_id and p.role = 'submitter'
   where a.alias_normalized = public.normalize_submitter_name(ticket.legacy_submitter_name);
  if found then
    update public.tickets set submitter_id = matched_profile
     where id = ticket.id and submitter_id is null;
    return;
  end if;

  select count(*), (array_agg(p.id order by p.id))[1]
    into match_count, matched_profile
    from public.profiles p
   where p.role = 'submitter'
     and public.normalize_submitter_name(p.full_name)
         = public.normalize_submitter_name(ticket.legacy_submitter_name);
  if match_count = 1 then
    update public.tickets set submitter_id = matched_profile
     where id = ticket.id and submitter_id is null;
  end if;
end;
$$;
create or replace function public.associate_ticket_on_legacy_identity_change()
returns trigger
language plpgsql
security definer
set search_path = public
set row_security = off
as $$
begin
  perform public.associate_historical_ticket_submitter(new.id);
  return new;
end;
$$;
create trigger trg_associate_ticket_legacy_submitter
  after insert or update of legacy_submitter_name, legacy_submitter_email
  on public.tickets
  for each row execute function public.associate_ticket_on_legacy_identity_change();
create or replace function public.associate_tickets_on_submitter_profile_insert()
returns trigger
language plpgsql
security definer
set search_path = public
set row_security = off
as $$
declare
  ticket_id uuid;
begin
  if new.role <> 'submitter' then
    return new;
  end if;

  for ticket_id in
    select t.id
      from public.tickets t
     where t.submitter_id is null
       and (
         (
           nullif(btrim(t.legacy_submitter_email), '') is not null
           and lower(btrim(t.legacy_submitter_email)) = lower(btrim(new.email))
         )
         or (
           nullif(btrim(t.legacy_submitter_name), '') is not null
           and public.normalize_submitter_name(t.legacy_submitter_name)
               = public.normalize_submitter_name(new.full_name)
         )
         or exists (
           select 1
             from public.ticket_submitter_aliases a
            where a.profile_id = new.id
              and a.alias_normalized
                  = public.normalize_submitter_name(t.legacy_submitter_name)
         )
       )
  loop
    perform public.associate_historical_ticket_submitter(ticket_id);
  end loop;
  return new;
end;
$$;
create trigger trg_associate_tickets_on_submitter_profile_insert
  after insert on public.profiles
  for each row execute function public.associate_tickets_on_submitter_profile_insert();
create or replace function public.apply_ticket_submitter_alias()
returns trigger
language plpgsql
security definer
set search_path = public
set row_security = off
as $$
declare
  ticket_id uuid;
begin
  if not public.is_admin() then
    raise exception 'Only administrators can approve submitter name matches';
  end if;
  if not exists (
    select 1 from public.profiles
     where id = new.profile_id and role = 'submitter'
  ) then
    raise exception 'Name matches can only be associated with submitter accounts';
  end if;

  for ticket_id in
    select t.id
      from public.tickets t
     where t.submitter_id is null
       and public.normalize_submitter_name(t.legacy_submitter_name) = new.alias_normalized
  loop
    perform public.associate_historical_ticket_submitter(ticket_id);
  end loop;
  return new;
end;
$$;
create trigger trg_apply_ticket_submitter_alias
  after insert on public.ticket_submitter_aliases
  for each row execute function public.apply_ticket_submitter_alias();
create or replace function public.admin_unmatched_submitter_names()
returns table (legacy_name text, ticket_count bigint)
language plpgsql
security definer
set search_path = public
set row_security = off
as $$
begin
  if not public.is_admin() then
    raise exception 'Administrator access required';
  end if;

  return query
    select min(t.legacy_submitter_name), count(*)
      from public.tickets t
     where t.submitter_id is null
       and nullif(btrim(t.legacy_submitter_name), '') is not null
     group by public.normalize_submitter_name(t.legacy_submitter_name)
     order by count(*) desc, min(t.legacy_submitter_name);
end;
$$;
revoke all on function public.normalize_submitter_name(text) from public, anon, authenticated;
revoke all on function public.associate_historical_ticket_submitter(uuid) from public, anon, authenticated;
revoke all on function public.associate_ticket_on_legacy_identity_change() from public, anon, authenticated;
revoke all on function public.associate_tickets_on_submitter_profile_insert() from public, anon, authenticated;
revoke all on function public.apply_ticket_submitter_alias() from public, anon, authenticated;
revoke all on function public.admin_unmatched_submitter_names() from public, anon;
grant execute on function public.admin_unmatched_submitter_names() to authenticated;
grant execute on function public.normalize_submitter_name(text) to authenticated, service_role;
do $$
declare
  ticket_id uuid;
begin
  for ticket_id in
    select id
      from public.tickets
     where submitter_id is null
       and (
         nullif(btrim(legacy_submitter_email), '') is not null
         or nullif(btrim(legacy_submitter_name), '') is not null
       )
  loop
    perform public.associate_historical_ticket_submitter(ticket_id);
  end loop;
end;
$$;
notify pgrst, 'reload schema';
