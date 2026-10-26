alter table public.profiles
  add column show_event_setup boolean not null default false;

create or replace function public.profiles_enforce_event_setup_visibility()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.show_event_setup is distinct from old.show_event_setup
     and auth.uid() is not null
     and not public.is_admin()
  then
    raise exception 'only administrators can change Event Setup tile visibility';
  end if;

  return new;
end;
$$;

create trigger trg_profiles_event_setup_visibility
  before update of show_event_setup on public.profiles
  for each row execute function public.profiles_enforce_event_setup_visibility();
