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
    t.department::text                                 as department,
    count(*)::bigint                                   as n
  from public.tickets t
  left join public.categories leaf   on leaf.id = t.category_id
  left join public.categories parent on parent.id = leaf.parent_id
  where t.created_at::date between from_date and to_date
  group by 1, 2
  order by n desc;
$$;

grant execute on function public.dashboard_category_breakdown(date, date)
  to authenticated;