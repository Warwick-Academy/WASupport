create or replace function public.dashboard_ticket_drilldown(
  metric text,
  from_date date,
  to_date date
)
returns setof public.tickets
language plpgsql
stable
security definer
set search_path = public
set row_security = off
as $$
declare
  v_user_id uuid := auth.uid();
  v_role user_role := public.current_role();
  v_user_department department;
  v_all_departments boolean;
  v_role_department department;
begin
  if v_user_id is null then
    raise exception 'Authentication is required.'
      using errcode = '42501';
  end if;

  if metric is null or metric not in ('new', 'open', 'unassigned', 'resolved') then
    raise exception 'Unsupported dashboard metric: %', metric
      using errcode = '22023';
  end if;

  if from_date is null or to_date is null or from_date > to_date then
    raise exception 'A valid dashboard date range is required.'
      using errcode = '22023';
  end if;

  select p.department
    into v_user_department
    from public.profiles p
   where p.id = v_user_id;

  v_all_departments := v_role in ('admin', 'leadership', 'support');
  v_role_department := public.role_department(v_role);

  if metric = 'new' then
    return query
      select t.*
        from public.tickets t
       where t.created_at >= from_date::timestamp
         and t.created_at < (to_date + 1)::timestamp
         and (
           t.submitter_id = v_user_id
           or v_all_departments
           or (v_role = 'manager' and t.department = v_user_department)
           or t.department = v_role_department
         )
         and t.department <> 'AV';
  elsif metric = 'resolved' then
    return query
      select t.*
        from public.tickets t
       where t.resolved_at >= from_date::timestamp
         and t.resolved_at < (to_date + 1)::timestamp
         and (
           t.submitter_id = v_user_id
           or v_all_departments
           or (v_role = 'manager' and t.department = v_user_department)
           or t.department = v_role_department
         )
         and t.department <> 'AV';
  elsif metric = 'unassigned' then
    return query
      select t.*
        from public.tickets t
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
         and (
           t.submitter_id = v_user_id
           or v_all_departments
           or (v_role = 'manager' and t.department = v_user_department)
           or t.department = v_role_department
         )
         and t.department <> 'AV';
  else
    return query
      select t.*
        from public.tickets t
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
         and (
           t.submitter_id = v_user_id
           or v_all_departments
           or (v_role = 'manager' and t.department = v_user_department)
           or t.department = v_role_department
         )
         and t.department <> 'AV';
  end if;
end;
$$;
revoke all on function public.dashboard_ticket_drilldown(text, date, date)
  from public, anon;
grant execute on function public.dashboard_ticket_drilldown(text, date, date)
  to authenticated;
