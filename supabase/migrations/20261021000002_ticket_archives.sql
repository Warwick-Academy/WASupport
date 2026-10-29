create table public.tickets_archive (
  like public.tickets including defaults including generated including constraints
);
alter table public.tickets_archive
  add constraint tickets_archive_pkey primary key (id),
  add constraint tickets_archive_ref_key unique (ref),
  add constraint tickets_archive_category_fk
    foreign key (category_id) references public.categories(id) on delete set null,
  add constraint tickets_archive_submitter_fk
    foreign key (submitter_id) references public.profiles(id) on delete restrict,
  add constraint tickets_archive_assignee_fk
    foreign key (assignee_id) references public.profiles(id) on delete set null,
  add constraint tickets_archive_location_fk
    foreign key (location_id) references public.locations(id) on delete set null,
  add constraint tickets_archive_triaged_by_fk
    foreign key (triaged_by) references public.profiles(id) on delete set null,
  add column archived_at timestamptz not null default now();
create table public.ticket_messages_archive (
  like public.ticket_messages including defaults
);
alter table public.ticket_messages_archive
  add constraint ticket_messages_archive_pkey primary key (id),
  add constraint ticket_messages_archive_author_fk
    foreign key (author_id) references public.profiles(id) on delete restrict,
  add constraint ticket_messages_archive_ticket_fk
  foreign key (ticket_id) references public.tickets_archive(id) on delete cascade;
create table public.attachments_archive (
  like public.attachments including defaults
);
alter table public.attachments_archive
  add constraint attachments_archive_pkey primary key (id),
  add constraint attachments_archive_ticket_fk
  foreign key (ticket_id) references public.tickets_archive(id) on delete cascade,
  add constraint attachments_archive_message_fk
  foreign key (message_id) references public.ticket_messages_archive(id) on delete cascade,
  add constraint attachments_archive_uploader_fk
    foreign key (uploaded_by) references public.profiles(id) on delete set null;
create table public.ticket_status_history_archive (
  like public.ticket_status_history including defaults including identity
);
alter table public.ticket_status_history_archive
  add constraint ticket_status_history_archive_pkey primary key (id),
  add constraint ticket_status_history_archive_ticket_fk
  foreign key (ticket_id) references public.tickets_archive(id) on delete cascade;
create table public.notifications_outbox_archive (
  like public.notifications_outbox including defaults
);
alter table public.notifications_outbox_archive
  add constraint notifications_outbox_archive_pkey primary key (id),
  add constraint notifications_outbox_archive_ticket_fk
    foreign key (ticket_id) references public.tickets_archive(id) on delete set null;
create table public.notifications_log_archive (
  like public.notifications_log including defaults
);
alter table public.notifications_log_archive
  add constraint notifications_log_archive_pkey primary key (id),
  add constraint notifications_log_archive_ticket_fk
    foreign key (ticket_id) references public.tickets_archive(id) on delete set null,
  add constraint notifications_log_archive_outbox_key unique (outbox_id),
  add constraint notifications_log_archive_outbox_fk
    foreign key (outbox_id) references public.notifications_outbox_archive(id) on delete set null;
create table public.email_delivery_events_archive (
  like public.email_delivery_events including defaults
);
alter table public.email_delivery_events_archive
  add constraint email_delivery_events_archive_pkey primary key (id),
  add constraint email_delivery_events_archive_outbox_fk
    foreign key (outbox_id) references public.notifications_outbox_archive(id) on delete cascade;
create index tickets_archive_closed_recent_idx
  on public.tickets_archive (coalesce(closed_at, resolved_at, created_at) desc, id desc);
create index tickets_archive_department_completion_idx
  on public.tickets_archive (department, coalesce(closed_at, resolved_at))
  where status in ('resolved', 'closed');
create index tickets_archive_time_spent_top_idx
  on public.tickets_archive (time_spent_minutes desc, id)
  where time_spent_minutes > 0;
create index ticket_messages_archive_ticket_idx
  on public.ticket_messages_archive (ticket_id, created_at);
create index attachments_archive_ticket_idx
  on public.attachments_archive (ticket_id, created_at);
create index attachments_archive_storage_path_idx
  on public.attachments_archive (storage_path);
create index ticket_status_history_archive_ticket_date_idx
  on public.ticket_status_history_archive (ticket_id, changed_at desc, id desc);
create index notifications_outbox_archive_ticket_idx
  on public.notifications_outbox_archive (ticket_id, created_at desc);
create index notifications_log_archive_created_idx
  on public.notifications_log_archive (created_at desc);
create index email_delivery_events_archive_outbox_idx
  on public.email_delivery_events_archive (outbox_id, happened_at);
alter table public.tickets_archive enable row level security;
alter table public.ticket_messages_archive enable row level security;
alter table public.attachments_archive enable row level security;
alter table public.ticket_status_history_archive enable row level security;
alter table public.notifications_outbox_archive enable row level security;
alter table public.notifications_log_archive enable row level security;
alter table public.email_delivery_events_archive enable row level security;
create policy "archived tickets read by ticket access"
  on public.tickets_archive for select to authenticated
  using (
    department <> 'AV'
    and (
      submitter_id = auth.uid()
      or public.is_admin()
      or public.current_role() = 'leadership'
      or public.is_support()
      or public.can_manage_department(department)
      or public.role_department(public.current_role()) = department
    )
  );
create policy "archived messages read by ticket access"
  on public.ticket_messages_archive for select to authenticated
  using (
    exists (
      select 1 from public.tickets_archive t
      where t.id = ticket_messages_archive.ticket_id
        and (
          public.is_admin()
          or public.current_role() = 'leadership'
          or public.is_support()
          or public.can_manage_department(t.department)
          or public.role_department(public.current_role()) = t.department
          or (t.submitter_id = auth.uid() and ticket_messages_archive.is_internal = false)
        )
    )
  );
create policy "archived attachments read by ticket access"
  on public.attachments_archive for select to authenticated
  using (
    exists (
      select 1 from public.tickets_archive t
      where t.id = coalesce(
        attachments_archive.ticket_id,
        (select m.ticket_id
         from public.ticket_messages_archive m
         where m.id = attachments_archive.message_id)
      )
        and (
          t.submitter_id = auth.uid()
          or public.is_admin()
          or public.current_role() = 'leadership'
          or public.is_support()
          or public.can_manage_department(t.department)
          or public.role_department(public.current_role()) = t.department
        )
    )
    and (
      attachments_archive.message_id is null
      or exists (
        select 1 from public.ticket_messages_archive m
        where m.id = attachments_archive.message_id
          and (m.is_internal = false or public.is_staff())
      )
    )
  );
create policy "archived status history read by ticket access"
  on public.ticket_status_history_archive for select to authenticated
  using (
    exists (
      select 1 from public.tickets_archive t
      where t.id = ticket_status_history_archive.ticket_id
        and (
          public.is_admin()
          or public.can_manage_department(t.department)
          or public.role_department(public.current_role()) = t.department
        )
    )
  );
create policy "archived notification log read by admins"
  on public.notifications_log_archive for select to authenticated
  using (public.is_admin());
grant select on public.tickets_archive, public.ticket_messages_archive,
  public.attachments_archive, public.ticket_status_history_archive,
  public.notifications_log_archive to authenticated;
revoke insert, update, delete on public.tickets_archive, public.ticket_messages_archive,
  public.attachments_archive, public.ticket_status_history_archive from anon, authenticated;
create view public.ticket_history with (security_invoker = true) as
  select t.*, null::timestamptz as archived_at from public.tickets t
  union all
  select a.* from public.tickets_archive a;
create view public.ticket_messages_history with (security_invoker = true) as
  select * from public.ticket_messages
  union all
  select * from public.ticket_messages_archive;
create view public.attachments_history with (security_invoker = true) as
  select * from public.attachments
  union all
  select * from public.attachments_archive;
create view public.ticket_status_history_history with (security_invoker = true) as
  select * from public.ticket_status_history
  union all
  select * from public.ticket_status_history_archive;
create view public.notifications_log_history with (security_invoker = true) as
  select * from public.notifications_log
  union all
  select * from public.notifications_log_archive;
grant select on public.ticket_history, public.ticket_messages_history,
  public.attachments_history, public.ticket_status_history_history,
  public.notifications_log_history to authenticated;
-- Keep historical email-log links valid after the active ticket row is moved.
alter table public.notifications_log
  drop constraint if exists notifications_log_ticket_id_fkey;
alter table public.notifications_outbox
  drop constraint if exists notifications_outbox_ticket_id_fkey;
drop policy if exists "attachments storage read" on storage.objects;
create policy "attachments storage read"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'attachments'
    and exists (
      select 1 from public.attachments_history a
      where a.storage_path = storage.objects.name
    )
  );
drop policy if exists "attachments storage insert" on storage.objects;
create policy "attachments storage insert"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'attachments'
    and name like 'tickets/%/%'
    and exists (
      select 1 from public.tickets t
      where t.id = public.attachment_ticket_id(storage.objects.name)
    )
  );
drop policy if exists "attachments storage delete" on storage.objects;
create policy "attachments storage delete"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'attachments'
    and exists (
      select 1 from public.tickets t
      where t.id = public.attachment_ticket_id(storage.objects.name)
    )
  );
create index tickets_archive_candidates_idx
  on public.tickets (coalesce(closed_at, resolved_at, created_at), id)
  where status in ('resolved', 'closed');
create index tickets_active_recent_idx
  on public.tickets (created_at desc, id desc)
  where status not in ('resolved', 'closed');
create index tickets_time_spent_top_idx
  on public.tickets (time_spent_minutes desc, id)
  where time_spent_minutes > 0;
create index tickets_closed_at_recent_idx
  on public.tickets (closed_at, id)
  where status in ('resolved', 'closed') and closed_at is not null;
create index tickets_resolved_at_recent_idx
  on public.tickets (resolved_at, id)
  where status in ('resolved', 'closed') and closed_at is null and resolved_at is not null;
create index tickets_archive_created_idx
  on public.tickets_archive (created_at desc, id desc);
create index tickets_archive_submitter_recent_idx
  on public.tickets_archive (submitter_id, created_at desc, id desc);
create index tickets_archive_assignee_recent_idx
  on public.tickets_archive (assignee_id, created_at desc, id desc);
create index tickets_archive_closed_at_idx
  on public.tickets_archive (closed_at, id)
  where closed_at is not null;
create index tickets_archive_resolved_at_idx
  on public.tickets_archive (resolved_at, id)
  where closed_at is null and resolved_at is not null;
create index attachments_active_storage_path_idx
  on public.attachments (storage_path);
create index tickets_closed_created_fallback_idx
  on public.tickets (created_at desc, id desc)
  where status in ('resolved', 'closed') and closed_at is null and resolved_at is null;
create function public.archive_closed_tickets(
  p_before timestamptz default now() - interval '365 days',
  p_batch_size integer default 250
)
returns integer
language plpgsql
security definer
set search_path = public
set row_security = off
as $$
declare
  v_ids uuid[];
  v_count integer;
begin
  if p_before is null or p_batch_size is null or p_batch_size < 1 then
    raise exception 'A cutoff and positive batch size are required';
  end if;

  select array_agg(c.id)
    into v_ids
    from (
      select t.id
      from public.tickets t
      where t.status in ('resolved', 'closed')
        and coalesce(t.closed_at, t.resolved_at, t.created_at) < p_before
      order by coalesce(t.closed_at, t.resolved_at, t.created_at), t.id
      limit least(p_batch_size, 1000)
      for update skip locked
    ) c;

  if coalesce(cardinality(v_ids), 0) = 0 then
    return 0;
  end if;

  insert into public.tickets_archive
  select t.*, transaction_timestamp()
  from public.tickets t
  where t.id = any(v_ids);

  insert into public.ticket_messages_archive
  select m.*
  from public.ticket_messages m
  where m.ticket_id = any(v_ids);

  insert into public.attachments_archive
    (id, ticket_id, message_id, storage_path, mime_type, size_bytes, uploaded_by, created_at)
  select a.id, coalesce(a.ticket_id, m.ticket_id), a.message_id, a.storage_path,
    a.mime_type, a.size_bytes, a.uploaded_by, a.created_at
  from public.attachments a
  left join public.ticket_messages m on m.id = a.message_id
  where a.ticket_id = any(v_ids) or m.ticket_id = any(v_ids);

  insert into public.ticket_status_history_archive
    (id, ticket_id, status, department, assignee_id, changed_at)
  overriding system value
  select h.id, h.ticket_id, h.status, h.department, h.assignee_id, h.changed_at
  from public.ticket_status_history h
  where h.ticket_id = any(v_ids);

  insert into public.notifications_outbox_archive
  select o.*
  from public.notifications_outbox o
  where o.ticket_id = any(v_ids)
    and o.status in ('sent', 'failed');

  insert into public.email_delivery_events_archive
  select e.*
  from public.email_delivery_events e
  where e.outbox_id in (
    select o.id from public.notifications_outbox_archive o
    where o.ticket_id = any(v_ids)
  );

  insert into public.notifications_log_archive
  select l.*
  from public.notifications_log l
  where l.ticket_id = any(v_ids)
    and (
      l.outbox_id is null
      or l.outbox_id in (
        select o.id from public.notifications_outbox_archive o
        where o.ticket_id = any(v_ids)
      )
    );

  delete from public.attachments a
  where a.ticket_id = any(v_ids)
     or a.message_id in (
       select m.id from public.ticket_messages m where m.ticket_id = any(v_ids)
     );
  delete from public.ticket_messages where ticket_id = any(v_ids);
  delete from public.ticket_status_history where ticket_id = any(v_ids);
  delete from public.email_delivery_events e
  where e.outbox_id in (
    select o.id from public.notifications_outbox_archive o
    where o.ticket_id = any(v_ids)
  );
  delete from public.notifications_log l
  where l.ticket_id = any(v_ids)
    and (
      l.outbox_id is null
      or l.outbox_id in (
        select o.id from public.notifications_outbox_archive o
        where o.ticket_id = any(v_ids)
      )
    );
  delete from public.notifications_outbox o
  where o.id in (
    select archived.id from public.notifications_outbox_archive archived
    where archived.ticket_id = any(v_ids)
  );
  delete from public.tickets where id = any(v_ids);

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;
revoke all on function public.archive_closed_tickets(timestamptz, integer)
  from public, anon, authenticated;
grant execute on function public.archive_closed_tickets(timestamptz, integer)
  to service_role;
create function public.archive_terminal_ticket_emails(p_batch_size integer default 250)
returns integer
language plpgsql
security definer
set search_path = public
set row_security = off
as $$
declare
  v_ids uuid[];
  v_count integer;
begin
  if p_batch_size is null or p_batch_size < 1 then
    raise exception 'A positive batch size is required';
  end if;

  select array_agg(c.id)
    into v_ids
    from (
      select o.id
      from public.notifications_outbox o
      join public.tickets_archive t on t.id = o.ticket_id
      where o.status in ('sent', 'failed')
        and not exists (
          select 1 from public.notifications_outbox_archive a where a.id = o.id
        )
      order by o.created_at, o.id
      limit least(p_batch_size, 1000)
      for update of o skip locked
    ) c;

  if coalesce(cardinality(v_ids), 0) = 0 then
    return 0;
  end if;

  insert into public.notifications_outbox_archive
  select o.* from public.notifications_outbox o where o.id = any(v_ids);

  insert into public.email_delivery_events_archive
  select e.* from public.email_delivery_events e where e.outbox_id = any(v_ids);

  insert into public.notifications_log_archive
  select l.* from public.notifications_log l where l.outbox_id = any(v_ids);

  delete from public.email_delivery_events where outbox_id = any(v_ids);
  delete from public.notifications_log where outbox_id = any(v_ids);
  delete from public.notifications_outbox where id = any(v_ids);

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;
revoke all on function public.archive_terminal_ticket_emails(integer)
  from public, anon, authenticated;
grant execute on function public.archive_terminal_ticket_emails(integer)
  to service_role;
create or replace function public.ticket_year_department_category_report(
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
    from public.ticket_history t
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
create or replace function public.search_email_log(
  p_search text default '',
  p_status text default '',
  p_event text default '',
  p_from date default null,
  p_to date default null,
  p_offset integer default 0
)
returns table (
  id uuid,
  ticket_id uuid,
  ticket_ref text,
  subject text,
  event text,
  recipients text[],
  status text,
  error text,
  attempts integer,
  created_at timestamptz,
  total_count bigint,
  outbox_id uuid
)
language sql
stable
security invoker
set search_path = public
set timezone = 'UTC'
as $$
  select l.id,l.ticket_id,l.ticket_ref,l.subject,l.event,l.recipients,l.status,l.error,
    l.attempts,l.created_at,count(*) over(),l.outbox_id
  from public.notifications_log_history l
  where public.is_admin()
    and (p_status='' or l.status=p_status)
    and (p_event='' or l.event=p_event)
    and (p_from is null or l.created_at>=p_from::timestamptz)
    and (p_to is null or l.created_at<(p_to+1)::timestamptz)
    and (p_search='' or concat_ws(' ',l.ticket_ref,l.subject,array_to_string(l.recipients,' '))
      ilike '%'||p_search||'%')
  order by l.created_at desc,l.id
  limit 50 offset greatest(p_offset,0);
$$;
create or replace function public.department_report_timeline(
  p_from date,
  p_to date,
  p_department public.department default null,
  p_assignee uuid default null,
  p_unassigned boolean default false
)
returns table (
  day date,
  open_count bigint,
  closed_count bigint,
  pending_count bigint,
  tracking_since timestamptz
)
language plpgsql
stable
security invoker
set search_path = public
set timezone = 'UTC'
as $$
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
    select t.* from public.ticket_history t
    where t.department <> 'AV'
      and (public.is_admin() or public.can_manage_department(t.department)
        or public.role_department(public.current_role()) = t.department)
      and (p_department is null or t.department = p_department)
  )
  select d.date,
    case when d.date < tr.started_at::date then null else (
      select count(*) from accessible t
      cross join lateral (
        select h.status, h.assignee_id from public.ticket_status_history_history h
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
        select h.status, h.assignee_id from public.ticket_status_history_history h
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
notify pgrst, 'reload schema';
