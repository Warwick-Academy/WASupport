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
  actor_department public.department;
begin
  select p.role, p.department
    into actor_role, actor_department
    from public.profiles p
   where p.id = auth.uid();

  if actor_role is null then
    raise exception 'A support profile is required to count tickets';
  end if;

  if actor_role in ('admin', 'leadership', 'support') then
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
  elsif actor_role = 'manager' then
    if actor_department is null or actor_department = 'AV' then
      raise exception 'A non-AV department is required to count tickets';
    end if;

    return query
      select
        count(*) filter (where t.status not in ('resolved', 'closed')),
        count(*) filter (where t.status in ('resolved', 'closed')),
        count(*) filter (
          where t.status not in ('resolved', 'closed')
            and t.assignee_id is null
        )
      from public.tickets t
      where t.department = actor_department;
  elsif public.role_department(actor_role) is not null
    and public.role_department(actor_role) <> 'AV' then
    return query
      select
        count(*) filter (where t.status not in ('resolved', 'closed')),
        count(*) filter (where t.status in ('resolved', 'closed')),
        count(*) filter (
          where t.status not in ('resolved', 'closed')
            and t.assignee_id is null
        )
      from public.tickets t
      where t.department = public.role_department(actor_role);
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
