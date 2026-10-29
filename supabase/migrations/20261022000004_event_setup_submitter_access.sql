create or replace function public.can_access_event_setup()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    public.current_role() <> 'submitter'
    or exists (
      select 1
        from public.profiles p
       where p.id = auth.uid()
         and p.can_access_events
    ),
    false
  );
$$;
revoke all on function public.can_access_event_setup() from public, anon;
grant execute on function public.can_access_event_setup() to authenticated;
drop policy if exists "event setup requests read own or managed"
  on public.event_setup_requests;
create policy "event setup requests read own or managed"
  on public.event_setup_requests for select to authenticated
  using (
    (requester_id = auth.uid() and public.can_access_event_setup())
    or public.can_manage_event_setup()
  );
drop policy if exists "event setup requests insert own"
  on public.event_setup_requests;
create policy "event setup requests insert own"
  on public.event_setup_requests for insert to authenticated
  with check (
    requester_id = auth.uid()
    and status = 'pending'
    and public.can_access_event_setup()
  );
