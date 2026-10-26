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
    join departments d on d.department = t.department
    where t.created_at < greatest(
      (to_date + 1)::timestamp,
      (current_date + 1)::timestamp
    )
  ),
  metrics as (
    select
      t.department,
      count(*) filter (
        where t.created_at >= from_date::timestamp
          and t.created_at < (to_date + 1)::timestamp
      )::bigint as new_tickets,
      count(*) filter (
        where t.created_at >= (select p_from from prev)::timestamp
          and t.created_at < ((select p_to from prev) + 1)::timestamp
      )::bigint as new_tickets_prev,
      count(*) filter (
        where t.created_at < (to_date + 1)::timestamp
          and case
            when to_date >= current_date then t.status not in ('resolved', 'closed')
            else t.finished_at is null or t.finished_at >= (to_date + 1)::timestamp
          end
      )::bigint as open_tickets,
      count(*) filter (
        where t.assignee_id is null
          and t.created_at < (to_date + 1)::timestamp
          and case
            when to_date >= current_date then t.status not in ('resolved', 'closed')
            else t.finished_at is null or t.finished_at >= (to_date + 1)::timestamp
          end
      )::bigint as unassigned,
      count(*) filter (
        where t.finished_at >= from_date::timestamp
          and t.finished_at < (to_date + 1)::timestamp
      )::bigint as resolved_tickets,
      count(*) filter (
        where t.finished_at >= (select p_from from prev)::timestamp
          and t.finished_at < ((select p_to from prev) + 1)::timestamp
      )::bigint as resolved_prev,
      count(*) filter (
        where t.category_id is null
          and t.created_at >= (current_date - interval '1 month')::date::timestamp
      )::bigint as uncategorized_tickets
    from tickets_with_finish t
    group by t.department
  )
  select
    d.department::text,
    coalesce(m.new_tickets, 0),
    coalesce(m.new_tickets_prev, 0),
    coalesce(m.open_tickets, 0),
    coalesce(m.unassigned, 0),
    coalesce(m.resolved_tickets, 0),
    coalesce(m.resolved_prev, 0),
    coalesce(m.uncategorized_tickets, 0)
  from departments d
  left join metrics m on m.department = d.department
  order by d.department;
$$;

grant execute on function public.dashboard_department_kpis(date, date)
  to authenticated;

create or replace function public.dashboard_ticket_flow(
  from_date date,
  to_date date
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
      t.status,
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
        or (to_date >= current_date and t.status not in ('resolved', 'closed'))
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
  )
  select
    days.day,
    departments.department::text,
    coalesce(daily_events.opened, 0)::bigint as opened,
    coalesce(daily_events.closed, 0)::bigint as closed,
    case
      when days.day >= current_date then (
        select count(*)::bigint
        from ticket_events t
        where t.department = departments.department
          and t.created_at < (days.day + 1)::timestamp
          and t.status not in ('resolved', 'closed')
      )
      else (
        coalesce(baseline.still_open, 0)
        + sum(coalesce(daily_events.opened, 0) - coalesce(daily_events.closed, 0))
          over (partition by departments.department order by days.day)
      )::bigint
    end as still_open
  from days
  cross join departments
  left join daily_events
    on daily_events.event_day = days.day
    and daily_events.department = departments.department
  left join baseline on baseline.department = departments.department
  order by days.day, departments.department;
$$;

grant execute on function public.dashboard_ticket_flow(date, date)
  to authenticated;

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
    (metric = 'new' and t.created_at::date between from_date and to_date)
    or (
      metric in ('open', 'unassigned')
      and t.created_at < (to_date + 1)::timestamp
      and case
        when to_date >= current_date then t.status not in ('resolved', 'closed')
        else (
          case
            when t.resolved_at is null then t.closed_at
            when t.closed_at is null then t.resolved_at
            else least(t.resolved_at, t.closed_at)
          end is null
          or case
            when t.resolved_at is null then t.closed_at
            when t.closed_at is null then t.resolved_at
            else least(t.resolved_at, t.closed_at)
          end >= (to_date + 1)::timestamp
        )
      end
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

notify pgrst, 'reload schema';
