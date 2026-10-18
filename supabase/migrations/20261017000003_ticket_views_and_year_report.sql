create index if not exists tickets_department_completion_idx
  on public.tickets (department, (coalesce(closed_at, resolved_at)) desc)
  where status in ('resolved', 'closed');
create or replace function public.dashboard_recent_tickets(
  p_departments public.department[],
  p_view text default 'open',
  p_limit integer default 20
)
returns setof public.tickets
language sql
stable
security invoker
set search_path = public
as $$
  select t.*
  from public.tickets t
  where t.department = any(coalesce(p_departments, '{}'::public.department[]))
    and (
      (p_view = 'open' and t.status not in ('resolved', 'closed'))
      or (p_view = 'closed' and t.status in ('resolved', 'closed'))
    )
  order by
    case when p_view = 'open' then t.created_at end desc,
    case when p_view = 'closed' then coalesce(t.closed_at, t.resolved_at) end desc nulls last,
    t.id desc
  limit least(greatest(coalesce(p_limit, 20), 1), 100);
$$;
revoke all on function public.dashboard_recent_tickets(public.department[], text, integer)
  from public, anon;
grant execute on function public.dashboard_recent_tickets(public.department[], text, integer)
  to authenticated;
drop function if exists public.ticket_year_department_category_report(integer, public.department);
create function public.ticket_year_department_category_report(
  p_year integer,
  p_department public.department default null
)
returns table (
  department text,
  category text,
  opened bigint,
  closed bigint,
  open_now bigint
)
language plpgsql
stable
security invoker
set search_path = public
as $$
begin
  if p_year < 2000 or p_year > extract(year from current_date)::integer then
    raise exception 'Choose a year between 2000 and the current year';
  end if;

  return query
  with bounds as (
    select make_timestamptz(p_year, 1, 1, 0, 0, 0, 'UTC') as year_start,
      make_timestamptz(p_year + 1, 1, 1, 0, 0, 0, 'UTC') as year_end
  ),
  departments as (
    select d.department
    from unnest(enum_range(null::public.department)) as d(department)
    where d.department <> 'AV'
      and (p_department is null or d.department = p_department)
      and (
        public.current_role() in ('admin', 'leadership', 'support')
        or public.can_manage_department(d.department)
        or public.role_department(public.current_role()) = d.department
      )
  ),
  scoped_tickets as (
    select
      t.department,
      coalesce(parent.name, leaf.name, 'Uncategorised') as category,
      t.status,
      t.created_at,
      coalesce(t.closed_at, t.resolved_at) as completed_at
    from public.tickets t
    join departments d on d.department = t.department
    cross join bounds b
    left join public.categories leaf on leaf.id = t.category_id
    left join public.categories parent on parent.id = leaf.parent_id
    where t.created_at < b.year_end
      and (
        (t.created_at >= b.year_start and t.created_at < b.year_end)
        or (coalesce(t.closed_at, t.resolved_at) >= b.year_start
          and coalesce(t.closed_at, t.resolved_at) < b.year_end)
      )
  )
  select
    t.department::text,
    t.category,
    count(*) filter (
      where t.created_at >= b.year_start and t.created_at < b.year_end
    )::bigint,
    count(*) filter (
      where t.completed_at >= b.year_start and t.completed_at < b.year_end
    )::bigint,
    count(*) filter (
      where t.created_at >= b.year_start
        and t.created_at < b.year_end
        and t.status not in ('resolved', 'closed')
    )::bigint
  from scoped_tickets t
  cross join bounds b
  group by t.department, t.category
  having count(*) filter (
    where (t.created_at >= b.year_start and t.created_at < b.year_end)
      or (t.completed_at >= b.year_start and t.completed_at < b.year_end)
      or (t.created_at >= b.year_start and t.created_at < b.year_end
        and t.status not in ('resolved', 'closed'))
  ) > 0
  order by t.department, t.category;
end;
$$;
revoke all on function public.ticket_year_department_category_report(integer, public.department)
  from public, anon;
grant execute on function public.ticket_year_department_category_report(integer, public.department)
  to authenticated;
notify pgrst, 'reload schema';
