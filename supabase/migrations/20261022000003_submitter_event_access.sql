alter table public.profiles
  add column if not exists can_access_events boolean not null default false;
create or replace function public.restrict_submitter_event_access()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.role <> 'submitter' then
    new.can_access_events := false;
  elsif old.id = auth.uid() and not public.is_admin()
    and new.can_access_events is distinct from old.can_access_events
  then
    raise exception 'Only an administrator can change submitter event access';
  end if;

  return new;
end;
$$;
revoke all on function public.restrict_submitter_event_access() from public, anon, authenticated;
drop trigger if exists trg_restrict_submitter_event_access on public.profiles;
create trigger trg_restrict_submitter_event_access
  before update on public.profiles
  for each row execute function public.restrict_submitter_event_access();
notify pgrst, 'reload schema';
