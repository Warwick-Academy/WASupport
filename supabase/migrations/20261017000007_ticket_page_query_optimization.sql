alter function public.dashboard_department_kpis(date, date) security definer;
alter function public.dashboard_department_kpis(date, date) set row_security = off;
revoke all on function public.dashboard_department_kpis(date, date) from public, anon;
grant execute on function public.dashboard_department_kpis(date, date) to authenticated;
create or replace function public.dashboard_ticket_drilldown(
  metric text,
  from_date date,
  to_date date
)
returns setof public.tickets
language sql
stable
security invoker
set search_path = public
as $$
  select t.*
  from public.tickets t
  where
    (metric = 'new' and t.created_at >= from_date::timestamp
      and t.created_at < (to_date + 1)::timestamp)
    or (
      metric in ('open', 'unassigned')
      and t.created_at < (to_date + 1)::timestamp
      and (
        coalesce(t.closed_at, t.resolved_at) is null
        or coalesce(t.closed_at, t.resolved_at) >= (to_date + 1)::timestamp
      )
      and (metric <> 'unassigned' or t.assignee_id is null)
    )
    or (
      metric = 'resolved'
      and case
        when t.resolved_at is null then t.closed_at
        when t.closed_at is null then t.resolved_at
        else least(t.resolved_at, t.closed_at)
      end >= from_date::timestamp
      and case
        when t.resolved_at is null then t.closed_at
        when t.closed_at is null then t.resolved_at
        else least(t.resolved_at, t.closed_at)
      end < (to_date + 1)::timestamp
    )
  order by t.created_at desc;
$$;
grant execute on function public.dashboard_ticket_drilldown(text, date, date)
  to authenticated;
