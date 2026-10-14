create table public.ticket_report_tracking (
  id boolean primary key default true check (id),
  started_at timestamptz not null default now()
);
insert into public.ticket_report_tracking (id) values (true);
alter table public.ticket_report_tracking enable row level security;
create policy "report tracking read" on public.ticket_report_tracking
  for select to authenticated using (public.is_staff());
grant select on public.ticket_report_tracking to authenticated;

create table public.ticket_status_history (
  id bigint generated always as identity primary key,
  ticket_id uuid not null references public.tickets(id) on delete cascade,
  status public.ticket_status not null,
  department public.department not null,
  assignee_id uuid,
  changed_at timestamptz not null default now()
);
create index ticket_status_history_ticket_date_idx
  on public.ticket_status_history (ticket_id, changed_at desc, id desc);
alter table public.ticket_status_history enable row level security;
create policy "department status history read" on public.ticket_status_history
  for select to authenticated using (
    exists (select 1 from public.tickets t where t.id = ticket_id)
    and (public.is_admin() or public.can_manage_department(department)
      or public.role_department(public.current_role()) = department)
  );
grant select on public.ticket_status_history to authenticated;

insert into public.ticket_status_history (ticket_id, status, department, assignee_id, changed_at)
select id, status, department, assignee_id,
  (select started_at from public.ticket_report_tracking where id)
from public.tickets;

create function public.record_ticket_report_status()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    insert into public.ticket_status_history (ticket_id, status, department, assignee_id)
    values (new.id, new.status, new.department, new.assignee_id);
  elsif new.status is distinct from old.status
    or new.department is distinct from old.department
    or new.assignee_id is distinct from old.assignee_id then
    insert into public.ticket_status_history (ticket_id, status, department, assignee_id)
    values (new.id, new.status, new.department, new.assignee_id);
  end if;
  return new;
end;
$$;
revoke all on function public.record_ticket_report_status() from public, anon, authenticated;
create trigger trg_ticket_report_status
  after insert or update on public.tickets
  for each row execute function public.record_ticket_report_status();

create function public.department_report_timeline(
  p_from date,
  p_to date,
  p_department public.department default null,
  p_assignee uuid default null,
  p_unassigned boolean default false
)
returns table (day date, open_count bigint, closed_count bigint, pending_count bigint, tracking_since timestamptz)
language plpgsql stable security invoker set search_path = public set timezone = 'UTC' as $$
begin
  if p_from is null or p_to is null or p_from > p_to or p_to - p_from > 365 then
    raise exception 'Choose a valid date range of up to 366 days';
  end if;
  if auth.uid() is null or not coalesce((
    public.is_admin() or public.current_role() = 'manager'
    or public.role_department(public.current_role()) in ('IT', 'FAC', 'HS')
  ), false) then
    raise exception 'Department report access required';
  end if;
  return query
  with days as (
    select generate_series(p_from::timestamp, least(p_to, current_date)::timestamp, interval '1 day')::date as date
  ), tracking as (
    select started_at from public.ticket_report_tracking where id
  ), accessible as (
    select t.* from public.tickets t
    where t.department <> 'AV'
      and (public.is_admin() or public.can_manage_department(t.department)
        or public.role_department(public.current_role()) = t.department)
      and (p_department is null or t.department = p_department)
  )
  select d.date,
    case when d.date < tr.started_at::date then null else (
      select count(*) from accessible t
      cross join lateral (
        select h.status, h.assignee_id from public.ticket_status_history h
        where h.ticket_id = t.id and h.changed_at < (d.date + 1)::timestamptz
        order by h.changed_at desc, h.id desc limit 1
      ) state
      where state.status in ('open', 'in_progress')
        and (p_assignee is null or state.assignee_id = p_assignee)
        and (not p_unassigned or state.assignee_id is null)
    ) end,
    (select count(*) from accessible t
      where coalesce(t.closed_at, t.resolved_at) >= p_from::timestamptz
        and coalesce(t.closed_at, t.resolved_at) < (d.date + 1)::timestamptz
        and (p_assignee is null or t.assignee_id = p_assignee)
        and (not p_unassigned or t.assignee_id is null)),
    case when d.date < tr.started_at::date then null else (
      select count(*) from accessible t
      cross join lateral (
        select h.status, h.assignee_id from public.ticket_status_history h
        where h.ticket_id = t.id and h.changed_at < (d.date + 1)::timestamptz
        order by h.changed_at desc, h.id desc limit 1
      ) state
      where state.status in ('on_hold', 'awaiting_triage')
        and (p_assignee is null or state.assignee_id = p_assignee)
        and (not p_unassigned or state.assignee_id is null)
    ) end,
    tr.started_at
  from days d cross join tracking tr
  order by d.date;
end;
$$;
revoke all on function public.department_report_timeline(date,date,public.department,uuid,boolean) from public, anon;
grant execute on function public.department_report_timeline(date,date,public.department,uuid,boolean) to authenticated;
notify pgrst, 'reload schema';