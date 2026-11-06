create or replace function public.ticket_submitter_directory()
returns table (id uuid, label text)
language plpgsql
stable
security definer
set search_path = ''
set row_security = off
as $$
begin
  if not public.is_manager() then
    raise exception 'Only administrators and department managers can view the submitter directory';
  end if;

  return query
    select p.id, coalesce(nullif(btrim(p.full_name), ''), p.email) || ' (' || p.email || ')'
    from public.profiles p
    where p.role = 'submitter'
    order by p.full_name nulls last, p.email;
end;
$$;

revoke all on function public.ticket_submitter_directory() from public, anon;
grant execute on function public.ticket_submitter_directory() to authenticated;

create or replace function public.ticket_submitter_exists(p_profile_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
set row_security = off
as $$
  select public.is_manager()
    and exists (
      select 1
      from public.profiles p
      where p.id = p_profile_id
        and p.role = 'submitter'
    );
$$;

revoke all on function public.ticket_submitter_exists(uuid) from public, anon;
grant execute on function public.ticket_submitter_exists(uuid) to authenticated;

drop policy if exists "tickets submitter insert" on public.tickets;
create policy "tickets submitter insert"
  on public.tickets for insert
  with check (
    department <> 'AV'
    and (
      submitter_id = auth.uid()
      or (
        public.can_manage_department(department)
        and public.ticket_submitter_exists(tickets.submitter_id)
      )
    )
  );
