drop function if exists public.dashboard_ticket_flow(date, date);

create function public.dashboard_ticket_flow(
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
  depts as (
    select unnest(enum_range(null::department))::text as department
  ),
  ticket_events as (
    select
      department,
      created_at,
      case
        when resolved_at is null then closed_at
        when closed_at is null then resolved_at
        else least(resolved_at, closed_at)
      end as finished_at
    from public.tickets
  ),
  opened as (
    select created_at::date as event_day, department::text as dept, count(*)::bigint as n
    from ticket_events
    where created_at::date between from_date and to_date
    group by 1, 2
  ),
  closed as (
    select finished_at::date as event_day, department::text as dept, count(*)::bigint as n
    from ticket_events
    where finished_at is not null
      and finished_at::date between from_date and to_date
    group by 1, 2
  ),
  backlog as (
    select d.day, dp.department, count(e.created_at)::bigint as n
    from days d
    cross join depts dp
    left join ticket_events e
      on e.department::text = dp.department
      and e.created_at < (d.day + 1)::timestamp
      and (e.finished_at is null or e.finished_at >= (d.day + 1)::timestamp)
    group by d.day, dp.department
  )
  select
    d.day,
    dp.department,
    coalesce(o.n, 0) as opened,
    coalesce(c.n, 0) as closed,
    coalesce(b.n, 0) as still_open
  from days d
  cross join depts dp
  left join opened o on o.event_day = d.day and o.dept = dp.department
  left join closed c on c.event_day = d.day and c.dept = dp.department
  left join backlog b on b.day = d.day and b.department = dp.department
  order by d.day, dp.department;
$$;

grant execute on function public.dashboard_ticket_flow(date, date)
  to authenticated;