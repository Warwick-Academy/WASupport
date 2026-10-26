alter function public.dashboard_department_kpis(date, date) security definer;
alter function public.dashboard_department_kpis(date, date) set row_security = off;
revoke all on function public.dashboard_department_kpis(date, date) from public, anon;
grant execute on function public.dashboard_department_kpis(date, date) to authenticated;

alter function public.dashboard_ticket_flow(date, date) security definer;
alter function public.dashboard_ticket_flow(date, date) set row_security = off;
revoke all on function public.dashboard_ticket_flow(date, date) from public, anon;
grant execute on function public.dashboard_ticket_flow(date, date) to authenticated;

create or replace function public.ticket_status_counts()
returns table (
  open_tickets       bigint,
  closed_tickets     bigint,
  unassigned_tickets bigint
)
language sql
stable
security definer
set search_path = public
set row_security = off
as $$
  with scoped_tickets as (
    select t.status, t.assignee_id
    from public.tickets t
    where (
      t.department <> 'AV'
      and (
        public.current_role() in ('admin', 'leadership', 'support')
        or public.can_manage_department(t.department)
        or public.role_department(public.current_role()) = t.department
      )
    ) or (
      public.current_role() = 'submitter'
      and t.submitter_id = auth.uid()
    )
  )
  select
    count(*) filter (where status not in ('resolved', 'closed')),
    count(*) filter (where status in ('resolved', 'closed')),
    count(*) filter (
      where status not in ('resolved', 'closed')
        and assignee_id is null
    )
  from scoped_tickets;
$$;

revoke all on function public.ticket_status_counts() from public, anon;
grant execute on function public.ticket_status_counts() to authenticated;

notify pgrst, 'reload schema';
