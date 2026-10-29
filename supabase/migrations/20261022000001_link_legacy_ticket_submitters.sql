create extension if not exists pg_trgm with schema extensions;
create or replace function public.resolve_spiceworks_submitter(p_name text)
returns uuid
language plpgsql
stable
security definer
set search_path = public, extensions
set row_security = off
as $$
declare
  normalized_name text;
  exact_ids uuid[];
  best_id uuid;
  best_score real;
  next_score real;
begin
  if nullif(trim(p_name), '') is null then
    return null;
  end if;

  normalized_name := public.normalize_assignee_name(p_name);

  select array_agg(p.id)
  into exact_ids
  from public.profiles p
  where public.normalize_assignee_name(p.full_name) = normalized_name
     or lower(trim(p.email)) = lower(trim(p_name));

  if cardinality(exact_ids) = 1 then
    return exact_ids[1];
  elsif cardinality(exact_ids) > 1 then
    return null;
  end if;

  with candidate_scores as (
    select
      p.id,
      similarity(
        split_part(public.normalize_assignee_name(p.full_name), ' ', 1),
        split_part(normalized_name, ' ', 1)
      ) as score
    from public.profiles p
    where array_length(regexp_split_to_array(normalized_name, '\s+'), 1) >= 2
      and array_length(regexp_split_to_array(public.normalize_assignee_name(p.full_name), '\s+'), 1) >= 2
      and length(split_part(public.normalize_assignee_name(p.full_name), ' ', 1)) >= 3
      and length(split_part(normalized_name, ' ', 1)) >= 3
      and split_part(public.normalize_assignee_name(p.full_name), ' ', -1) =
          split_part(normalized_name, ' ', -1)
  )
  select candidate_scores.id, candidate_scores.score
  into best_id, best_score
  from candidate_scores
  where candidate_scores.score >= 0.35
  order by candidate_scores.score desc, candidate_scores.id
  limit 1;

  if best_id is null then
    return null;
  end if;

  with candidate_scores as (
    select
      p.id,
      similarity(
        split_part(public.normalize_assignee_name(p.full_name), ' ', 1),
        split_part(normalized_name, ' ', 1)
      ) as score
    from public.profiles p
    where array_length(regexp_split_to_array(normalized_name, '\s+'), 1) >= 2
      and array_length(regexp_split_to_array(public.normalize_assignee_name(p.full_name), '\s+'), 1) >= 2
      and length(split_part(public.normalize_assignee_name(p.full_name), ' ', 1)) >= 3
      and length(split_part(normalized_name, ' ', 1)) >= 3
      and split_part(public.normalize_assignee_name(p.full_name), ' ', -1) =
          split_part(normalized_name, ' ', -1)
  )
  select max(candidate_scores.score)
  into next_score
  from candidate_scores
  where candidate_scores.id <> best_id;

  if next_score is null or best_score - next_score >= 0.1 then
    return best_id;
  end if;

  return null;
end;
$$;
revoke all on function public.resolve_spiceworks_submitter(text) from public, anon, authenticated;
grant execute on function public.resolve_spiceworks_submitter(text) to service_role;
create or replace function public.assign_imported_ticket_submitter()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.imported_from = 'spiceworks'
    and new.submitter_id is null
    and (
      auth.role() = 'service_role'
      or public.is_admin()
      or (auth.uid() is null and session_user in ('postgres', 'supabase_admin'))
    )
  then
    new.submitter_id := public.resolve_spiceworks_submitter(new.legacy_submitter_name);
  end if;

  return new;
end;
$$;
revoke all on function public.assign_imported_ticket_submitter() from public, anon, authenticated;
create trigger trg_assign_imported_ticket_submitter
  before insert on public.tickets
  for each row execute function public.assign_imported_ticket_submitter();
with resolved_tickets as materialized (
  select
    t.id,
    public.resolve_spiceworks_submitter(t.legacy_submitter_name) as submitter_id
  from public.tickets t
  where t.submitter_id is null
    and t.legacy_submitter_name is not null
)
update public.tickets t
set submitter_id = resolved.submitter_id
from resolved_tickets resolved
where t.id = resolved.id
  and resolved.submitter_id is not null;
