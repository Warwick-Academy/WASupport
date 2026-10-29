drop policy if exists "tickets staff read all departments" on public.tickets;
drop policy if exists "tickets staff read" on public.tickets;
create policy "tickets staff read all departments"
  on public.tickets for select
  using (department <> 'AV' and public.is_staff());

create or replace function public.ticket_status_counts()
returns table (
  open_tickets       bigint,
  closed_tickets     bigint,
  unassigned_tickets bigint
)
language plpgsql
stable
security definer
set search_path = public
set row_security = off
as $$
declare
  actor_role public.user_role;
begin
  select p.role
    into actor_role
    from public.profiles p
   where p.id = auth.uid();

  if actor_role is null then
    raise exception 'A support profile is required to count tickets';
  end if;

  if public.is_staff() then
    return query
      select
        count(*) filter (where t.status not in ('resolved', 'closed')),
        count(*) filter (where t.status in ('resolved', 'closed')),
        count(*) filter (
          where t.status not in ('resolved', 'closed')
            and t.assignee_id is null
        )
      from public.tickets t
      where t.department <> 'AV';
  else
    return query
      select
        count(*) filter (where t.status not in ('resolved', 'closed')),
        count(*) filter (where t.status in ('resolved', 'closed')),
        count(*) filter (
          where t.status not in ('resolved', 'closed')
            and t.assignee_id is null
        )
      from public.tickets t
      where t.department <> 'AV'
        and t.submitter_id = auth.uid();
  end if;
end;
$$;

revoke all on function public.ticket_status_counts() from public, anon;
grant execute on function public.ticket_status_counts() to authenticated;

notify pgrst, 'reload schema';
