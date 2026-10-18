create index if not exists tickets_created_at_idx
  on public.tickets (created_at);
create index if not exists tickets_department_created_at_idx
  on public.tickets (department, created_at desc);
create index if not exists tickets_department_resolved_at_idx
  on public.tickets (department, resolved_at)
  where resolved_at is not null;
create index if not exists tickets_department_uncategorized_created_at_idx
  on public.tickets (department, created_at)
  where category_id is null;
create or replace function public.dashboard_department_kpis(
  from_date date,
  to_date   date
)
returns table (
  department            text,
  new_tickets           bigint,
  new_tickets_prev      bigint,
  open_tickets          bigint,
  unassigned            bigint,
  resolved_tickets      bigint,
  resolved_prev         bigint,
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
  )
  select
    d.department::text,
    (select count(*) from public.tickets t
      where t.department = d.department
        and t.created_at >= from_date::timestamp
        and t.created_at < (to_date + 1)::timestamp),
    (select count(*) from public.tickets t
      where t.department = d.department
        and t.created_at >= (select p_from from prev)::timestamp
        and t.created_at < ((select p_to from prev) + 1)::timestamp),
    (select count(*) from public.tickets t
      where t.department = d.department
        and t.created_at < (to_date + 1)::timestamp
        and (t.resolved_at is null or t.resolved_at >= (to_date + 1)::timestamp)
        and (t.closed_at is null or t.closed_at >= (to_date + 1)::timestamp)),
    (select count(*) from public.tickets t
      where t.department = d.department
        and t.assignee_id is null
        and t.created_at < (to_date + 1)::timestamp
        and (t.resolved_at is null or t.resolved_at >= (to_date + 1)::timestamp)
        and (t.closed_at is null or t.closed_at >= (to_date + 1)::timestamp)),
    (select count(*) from public.tickets t
      where t.department = d.department
        and t.resolved_at >= from_date::timestamp
        and t.resolved_at < (to_date + 1)::timestamp),
    (select count(*) from public.tickets t
      where t.department = d.department
        and t.resolved_at >= (select p_from from prev)::timestamp
        and t.resolved_at < ((select p_to from prev) + 1)::timestamp),
    (select count(*) from public.tickets t
      where t.department = d.department
        and t.category_id is null
        and t.created_at >= (current_date - interval '1 month')::date::timestamp)
  from departments d
  order by d.department;
$$;
grant execute on function public.dashboard_department_kpis(date, date)
  to authenticated;
create or replace function public.dashboard_ticket_flow(
  from_date date,
  to_date   date
)
returns table (
  day        date,
  department text,
  opened     bigint,
  closed     bigint,
  still_open bigint
)
language sql
stable
security invoker
set search_path = public
as $$
  with days as (
    select generate_series(from_date, to_date, interval '1 day')::date as day
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
  ticket_events as (
    select
      t.department,
      t.created_at,
      case
        when t.resolved_at is null then t.closed_at
        when t.closed_at is null then t.resolved_at
        else least(t.resolved_at, t.closed_at)
      end as finished_at
    from public.tickets t
    join departments d on d.department = t.department
    where t.created_at < (to_date + 1)::timestamp
      and (
        case
          when t.resolved_at is null then t.closed_at
          when t.closed_at is null then t.resolved_at
          else least(t.resolved_at, t.closed_at)
        end is null
        or case
          when t.resolved_at is null then t.closed_at
          when t.closed_at is null then t.resolved_at
          else least(t.resolved_at, t.closed_at)
        end >= from_date::timestamp
      )
  ),
  events as (
    select department, created_at::date as event_day, 1::bigint as opened, 0::bigint as closed
    from ticket_events
    where created_at >= from_date::timestamp
    union all
    select department, finished_at::date as event_day, 0::bigint as opened, 1::bigint as closed
    from ticket_events
    where finished_at >= from_date::timestamp
      and finished_at < (to_date + 1)::timestamp
  ),
  daily_events as (
    select event_day, department, sum(opened)::bigint as opened, sum(closed)::bigint as closed
    from events
    group by event_day, department
  ),
  baseline as (
    select department, count(*)::bigint as still_open
    from ticket_events
    where created_at < from_date::timestamp
    group by department
  ),
  balances as (
    select
      days.day,
      departments.department::text as department,
      coalesce(daily_events.opened, 0)::bigint as opened,
      coalesce(daily_events.closed, 0)::bigint as closed,
      (coalesce(baseline.still_open, 0)
        + sum(coalesce(daily_events.opened, 0) - coalesce(daily_events.closed, 0))
          over (partition by departments.department order by days.day))::bigint as still_open
    from days
    cross join departments
    left join daily_events
      on daily_events.event_day = days.day
      and daily_events.department = departments.department
    left join baseline on baseline.department = departments.department
  )
  select balances.day, balances.department, balances.opened, balances.closed, balances.still_open
  from balances
  order by balances.day, balances.department;
$$;
grant execute on function public.dashboard_ticket_flow(date, date)
  to authenticated;
create or replace function public.dashboard_category_breakdown(
  from_date date,
  to_date   date
)
returns table (
  category   text,
  department text,
  n          bigint
)
language sql
stable
security invoker
set search_path = public
as $$
  select
    coalesce(parent.name, leaf.name, 'Uncategorised') as category,
    t.department::text as department,
    count(*)::bigint as n
  from public.tickets t
  left join public.categories leaf on leaf.id = t.category_id
  left join public.categories parent on parent.id = leaf.parent_id
  where t.created_at >= from_date::timestamp
    and t.created_at < (to_date + 1)::timestamp
  group by 1, 2
  order by n desc;
$$;
grant execute on function public.dashboard_category_breakdown(date, date)
  to authenticated;
