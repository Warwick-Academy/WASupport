create or replace function public.dashboard_summary(
  from_date date,
  to_date date
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = public
as $$
declare
  result jsonb;
begin
  if from_date is null or to_date is null or from_date > to_date or to_date - from_date > 180 then
    raise exception 'Choose a valid date range of up to 181 days';
  end if;

  with span as (
    select (to_date - from_date + 1) as days
  ),
  prev as (
    select (from_date - (select days from span))::date as p_from
  ),
  departments as (
    select d.department
    from unnest(enum_range(null::public.department)) as d(department)
    where d.department <> 'AV'
      and (
        public.current_role() in ('admin', 'leadership', 'support')
        or public.can_manage_department(d.department)
        or public.role_department(public.current_role()) = d.department
      )
  ),
  scoped_tickets as materialized (
    select
      t.id,
      t.department,
      t.category_id,
      t.created_at,
      t.resolved_at,
      t.closed_at,
      t.assignee_id,
      case
        when t.resolved_at is null then t.closed_at
        when t.closed_at is null then t.resolved_at
        else least(t.resolved_at, t.closed_at)
      end as finished_at
    from public.tickets t
    join departments d on d.department = t.department
    where t.created_at < (to_date + 1)::timestamp
      and (
        t.created_at >= (select p_from from prev)::timestamp
        or t.resolved_at >= (select p_from from prev)::timestamp
        or t.closed_at >= (select p_from from prev)::timestamp
        or (t.resolved_at is null and t.closed_at is null)
        or (t.category_id is null
          and t.created_at >= (current_date - interval '1 month')::date::timestamp)
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
          and t.created_at < from_date::timestamp
      )::bigint as new_tickets_prev,
      count(*) filter (
        where t.created_at < (to_date + 1)::timestamp
          and (t.finished_at is null or t.finished_at >= (to_date + 1)::timestamp)
      )::bigint as open_tickets,
      count(*) filter (
        where t.assignee_id is null
          and t.created_at < (to_date + 1)::timestamp
          and (t.finished_at is null or t.finished_at >= (to_date + 1)::timestamp)
      )::bigint as unassigned,
      count(*) filter (
        where t.resolved_at >= from_date::timestamp
          and t.resolved_at < (to_date + 1)::timestamp
      )::bigint as resolved_tickets,
      count(*) filter (
        where t.resolved_at >= (select p_from from prev)::timestamp
          and t.resolved_at < from_date::timestamp
      )::bigint as resolved_prev,
      count(*) filter (
        where t.category_id is null
          and t.created_at >= (current_date - interval '1 month')::date::timestamp
      )::bigint as uncategorized_tickets
    from scoped_tickets t
    group by t.department
  ),
  event_rows as (
    select department, created_at::date as event_day, 1::bigint as opened, 0::bigint as closed
    from scoped_tickets
    where created_at >= from_date::timestamp
    union all
    select department, finished_at::date as event_day, 0::bigint as opened, 1::bigint as closed
    from scoped_tickets
    where finished_at >= from_date::timestamp
      and finished_at < (to_date + 1)::timestamp
  ),
  daily_events as (
    select event_day, department, sum(opened)::bigint as opened, sum(closed)::bigint as closed
    from event_rows
    group by event_day, department
  ),
  baseline as (
    select department, count(*)::bigint as still_open
    from scoped_tickets
    where created_at < from_date::timestamp
      and (finished_at is null or finished_at >= from_date::timestamp)
    group by department
  ),
  days as (
    select generate_series(from_date, to_date, interval '1 day')::date as day
  ),
  flow_rows as (
    select
      days.day,
      departments.department,
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
  ),
  category_rows as (
    select
      coalesce(parent.name, leaf.name, 'Uncategorised') as category,
      t.department,
      count(*)::bigint as n
    from scoped_tickets t
    left join public.categories leaf on leaf.id = t.category_id
    left join public.categories parent on parent.id = leaf.parent_id
    where t.created_at >= from_date::timestamp
      and t.created_at < (to_date + 1)::timestamp
    group by 1, 2
  )
  select jsonb_build_object(
    'kpis', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'department', d.department::text,
        'new_tickets', coalesce(m.new_tickets, 0),
        'new_tickets_prev', coalesce(m.new_tickets_prev, 0),
        'open_tickets', coalesce(m.open_tickets, 0),
        'unassigned', coalesce(m.unassigned, 0),
        'resolved_tickets', coalesce(m.resolved_tickets, 0),
        'resolved_prev', coalesce(m.resolved_prev, 0),
        'uncategorized_tickets', coalesce(m.uncategorized_tickets, 0)
      ) order by d.department), '[]'::jsonb)
      from departments d
      left join metrics m on m.department = d.department
    ),
    'flow', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'day', day,
        'department', department::text,
        'opened', opened,
        'closed', closed,
        'still_open', still_open
      ) order by day, department), '[]'::jsonb)
      from flow_rows
    ),
    'categories', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'category', category,
        'department', department::text,
        'n', n
      ) order by n desc, department, category), '[]'::jsonb)
      from category_rows
    )
  ) into result;

  return result;
end;
$$;
revoke all on function public.dashboard_summary(date, date) from public, anon;
grant execute on function public.dashboard_summary(date, date) to authenticated;
notify pgrst, 'reload schema';
