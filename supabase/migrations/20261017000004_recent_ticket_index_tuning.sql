create index if not exists tickets_dashboard_open_recent_idx
  on public.tickets (created_at desc, id desc)
  where department <> 'AV'
    and status not in ('resolved', 'closed');
create index if not exists tickets_dashboard_closed_recent_idx
  on public.tickets ((coalesce(closed_at, resolved_at, created_at)) desc, id desc)
  where department <> 'AV'
    and status in ('resolved', 'closed');
create or replace function public.dashboard_recent_tickets(
  p_departments public.department[],
  p_view text default 'open',
  p_limit integer default 20
)
returns setof public.tickets
language plpgsql
stable
security invoker
set search_path = public
as $$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 20), 1), 100);
  v_departments public.department[] := coalesce(p_departments, '{}'::public.department[]);
begin
  if p_view = 'open' then
    return query
      select t.*
      from public.tickets t
      where t.department = any(v_departments)
        and t.status not in ('resolved', 'closed')
      order by t.created_at desc, t.id desc
      limit v_limit;
  elsif p_view = 'closed' then
    return query
      select t.*
      from public.tickets t
      where t.department = any(v_departments)
        and t.status in ('resolved', 'closed')
      order by coalesce(t.closed_at, t.resolved_at, t.created_at) desc, t.id desc
      limit v_limit;
  else
    raise exception 'Choose open or closed tickets';
  end if;
end;
$$;
notify pgrst, 'reload schema';
