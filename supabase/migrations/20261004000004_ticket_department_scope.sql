create or replace function public.can_manage_department(p_department department)
returns boolean
language plpgsql
stable
security definer
set search_path = public
set row_security = off
as $$
declare
  v_role user_role;
  v_department department;
begin
  select role, department
    into v_role, v_department
    from public.profiles
   where id = auth.uid();

  return coalesce(
    p_department <> 'AV'
    and (
      v_role = 'admin'
      or (v_role = 'manager' and v_department = p_department)
    ),
    false
  );
end;
$$;

revoke all on function public.can_manage_department(department) from public, anon;
grant execute on function public.can_manage_department(department) to authenticated, service_role;

create or replace function public.dashboard_department_kpis(
  from_date date,
  to_date   date
)
returns table (
  department           text,
  new_tickets          bigint,
  new_tickets_prev     bigint,
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
    count(t.id) filter (
      where t.created_at::date between from_date and to_date
    )::bigint as new_tickets,
    count(t.id) filter (
      where t.created_at::date between (select p_from from prev) and (select p_to from prev)
    )::bigint as new_tickets_prev,
    count(t.id) filter (
      where t.created_at < (to_date + 1)::timestamp
        and (t.finished_at is null or t.finished_at >= (to_date + 1)::timestamp)
    )::bigint as open_tickets,
    count(t.id) filter (
      where t.created_at < (to_date + 1)::timestamp
        and (t.finished_at is null or t.finished_at >= (to_date + 1)::timestamp)
        and t.assignee_id is null
    )::bigint as unassigned,
    count(t.id) filter (
      where t.resolved_at is not null
        and t.resolved_at::date between from_date and to_date
    )::bigint as resolved_tickets,
    count(t.id) filter (
      where t.resolved_at is not null
        and t.resolved_at::date between (select p_from from prev) and (select p_to from prev)
    )::bigint as resolved_prev,
    count(t.id) filter (where t.category_id is null)::bigint as uncategorized_tickets
  from departments d
  left join tickets_with_finish t on t.department = d.department
  group by d.department
  order by d.department;
$$;

grant execute on function public.dashboard_department_kpis(date, date) to authenticated;

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
  depts as (
    select d.department::text as department
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

grant execute on function public.dashboard_ticket_flow(date, date) to authenticated;

drop policy if exists "categories manager write" on public.categories;
drop policy if exists "categories read all" on public.categories;
create policy "categories read by manager department"
  on public.categories for select
  using (
    public.current_role() <> 'manager'
    or public.can_manage_department(department)
  );

create policy "categories department manager write"
  on public.categories for all
  using (public.can_manage_department(department))
  with check (public.can_manage_department(department));

drop policy if exists "profiles read own or staff" on public.profiles;
create policy "profiles read own or scoped staff"
  on public.profiles for select
  using (
    id = auth.uid()
    or public.is_admin()
    or public.current_role() = 'leadership'
    or public.is_support()
    or public.can_manage_department(department)
    or public.role_department(public.current_role()) = department
  );

drop policy if exists "tickets submitter read own" on public.tickets;
create policy "tickets submitter read own"
  on public.tickets for select
  using (department <> 'AV' and submitter_id = auth.uid());

drop policy if exists "tickets staff read" on public.tickets;
create policy "tickets staff read"
  on public.tickets for select
  using (
    department <> 'AV'
    and (
      public.is_admin()
      or public.current_role() = 'leadership'
      or public.can_manage_department(department)
      or public.is_support()
      or public.role_department(public.current_role()) = department
    )
  );

drop policy if exists "tickets submitter insert" on public.tickets;
create policy "tickets submitter insert"
  on public.tickets for insert
  with check (department <> 'AV' and submitter_id = auth.uid());

drop policy if exists "tickets manager update" on public.tickets;
create policy "tickets manager update"
  on public.tickets for update
  using (department <> 'AV' and public.can_manage_department(department))
  with check (department <> 'AV' and public.can_manage_department(department));

drop policy if exists "tickets dept tech update" on public.tickets;
create policy "tickets dept tech update"
  on public.tickets for update
  using (department <> 'AV' and public.role_department(public.current_role()) = department)
  with check (department <> 'AV' and public.role_department(public.current_role()) = department);

drop policy if exists "tickets support close" on public.tickets;
create policy "tickets support close"
  on public.tickets for update
  using (department <> 'AV' and public.is_support())
  with check (department <> 'AV' and public.is_support());

create or replace function public.reject_av_support_ticket()
returns trigger
language plpgsql
as $$
begin
  if new.department = 'AV' then
    raise exception 'Audio Visual requests must use the AV request form.';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_reject_av_support_ticket on public.tickets;
create trigger trg_reject_av_support_ticket
  before insert on public.tickets
  for each row execute function public.reject_av_support_ticket();

drop policy if exists "ticket_messages read" on public.ticket_messages;
create policy "ticket_messages read scoped staff"
  on public.ticket_messages for select
  using (
    exists (
      select 1 from public.tickets t
      where t.id = ticket_messages.ticket_id
        and (
          public.is_admin()
          or public.current_role() = 'leadership'
          or public.is_support()
          or public.can_manage_department(t.department)
          or public.role_department(public.current_role()) = t.department
          or (t.submitter_id = auth.uid() and ticket_messages.is_internal = false)
        )
    )
  );