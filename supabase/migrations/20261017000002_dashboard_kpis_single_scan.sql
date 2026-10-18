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
            end >= (to_date + 1)::timestamp
          )
      )::bigint as open_tickets,
      count(*) filter (
        where t.assignee_id is null
          and t.created_at < (to_date + 1)::timestamp
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
            end >= (to_date + 1)::timestamp
          )
      )::bigint as unassigned,
      count(*) filter (
        where t.resolved_at >= from_date::timestamp
          and t.resolved_at < (to_date + 1)::timestamp
      )::bigint as resolved_tickets,
      count(*) filter (
        where t.resolved_at >= (select p_from from prev)::timestamp
          and t.resolved_at < ((select p_to from prev) + 1)::timestamp
      )::bigint as resolved_prev,
      count(*) filter (
        where t.category_id is null
          and t.created_at >= (current_date - interval '1 month')::date::timestamp
      )::bigint as uncategorized_tickets
    from public.tickets t
    join departments d on d.department = t.department
    where t.created_at < greatest(
      (to_date + 1)::timestamp,
      (current_date + 1)::timestamp
    )
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
