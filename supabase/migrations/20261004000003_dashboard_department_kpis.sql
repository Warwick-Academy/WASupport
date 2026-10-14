create or replace function public.dashboard_department_kpis(
  from_date date,
  to_date   date
)
returns table (
  department          text,
  new_tickets         bigint,
  new_tickets_prev    bigint,
  open_tickets         bigint,
  unassigned           bigint,
  resolved_tickets     bigint,
  resolved_prev        bigint,
  uncategorized_tickets bigint
)
language sql
stable
security invoker
set search_path = public
as $$
  with span as (
    select (to_date - from_date + 1) as days
  ),
  prev as (
    select
      (from_date - (select days from span))::date as p_from,
      (from_date - 1)::date as p_to
  ),
  departments as (
    select d.department
    from unnest(enum_range(null::department)) as d(department)
    where d.department <> 'AV'
      and (
        public.current_role() in ('admin', 'leadership', 'support')
        or public.can_manage_department(d.department)
        or public.role_department(public.current_role()) = d.department
      )
  ),
  tickets_with_finish as (
    select
      t.*,
      case
        when t.resolved_at is null then t.closed_at
        when t.closed_at is null then t.resolved_at
        else least(t.resolved_at, t.closed_at)
      end as finished_at
    from public.tickets t
  )
  select
    d.department::text,
    count(*) filter (
      where t.created_at::date between from_date and to_date
    )::bigint as new_tickets,
    count(*) filter (
      where t.created_at::date between (select p_from from prev) and (select p_to from prev)
    )::bigint as new_tickets_prev,
    count(*) filter (
      where t.created_at < (to_date + 1)::timestamp
        and (t.finished_at is null or t.finished_at >= (to_date + 1)::timestamp)
    )::bigint as open_tickets,
    count(*) filter (
      where t.created_at < (to_date + 1)::timestamp
        and (t.finished_at is null or t.finished_at >= (to_date + 1)::timestamp)
        and t.assignee_id is null
    )::bigint as unassigned,
    count(*) filter (
      where t.resolved_at is not null
        and t.resolved_at::date between from_date and to_date
    )::bigint as resolved_tickets,
    count(*) filter (
      where t.resolved_at is not null
        and t.resolved_at::date between (select p_from from prev) and (select p_to from prev)
    )::bigint as resolved_prev,
    count(t.id) filter (where t.category_id is null)::bigint as uncategorized_tickets
  from departments d
  left join tickets_with_finish t on t.department = d.department
  group by d.department
  order by d.department;
$$;

grant execute on function public.dashboard_department_kpis(date, date)
  to authenticated;