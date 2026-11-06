alter table public.tickets
  add column if not exists merged_into_ticket_id uuid
    references public.tickets(id) on delete restrict;

create index if not exists tickets_merged_into_ticket_idx
  on public.tickets (merged_into_ticket_id)
  where merged_into_ticket_id is not null;

create or replace function public.guard_ticket_merge_state()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.merged_into_ticket_id is distinct from old.merged_into_ticket_id
    and current_setting('app.ticket_merge', true) is distinct from 'on'
  then
    raise exception 'Tickets can only be merged using the merge action';
  end if;

  if old.merged_into_ticket_id is not null then
    if new.merged_into_ticket_id is distinct from old.merged_into_ticket_id then
      raise exception 'A merged ticket cannot be moved to another ticket';
    end if;
    if new.status is distinct from old.status and new.status <> 'closed' then
      raise exception 'A merged ticket cannot be reopened';
    end if;
  end if;

  return new;
end;
$$;
revoke all on function public.guard_ticket_merge_state() from public, anon, authenticated;

drop trigger if exists trg_guard_ticket_merge_state on public.tickets;
create trigger trg_guard_ticket_merge_state
  before update of status, merged_into_ticket_id on public.tickets
  for each row execute function public.guard_ticket_merge_state();

create or replace function public.reject_merged_ticket_reply()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not new.is_internal and exists (
    select 1
    from public.tickets
    where id = new.ticket_id
      and merged_into_ticket_id is not null
  ) then
    raise exception 'This ticket was merged; please reply on the current ticket';
  end if;

  return new;
end;
$$;
revoke all on function public.reject_merged_ticket_reply() from public, anon, authenticated;

drop trigger if exists trg_reject_merged_ticket_reply on public.ticket_messages;
create trigger trg_reject_merged_ticket_reply
  before insert on public.ticket_messages
  for each row execute function public.reject_merged_ticket_reply();

create or replace function public.enforce_ticket_category()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_changed boolean;
  v_required boolean;
begin
  if new.department = 'AV'
    or current_setting('app.spiceworks_assignment_import', true) = 'on' then
    return new;
  end if;

  if tg_op = 'INSERT' then
    v_required := auth.uid() is not null
      and new.imported_from is null
      and pg_trigger_depth() = 1;
    v_changed := true;
  else
    v_required := new.status in ('resolved', 'closed')
      and new.status is distinct from old.status
      and current_setting('app.ticket_merge', true) is distinct from 'on';
    v_changed := (new.category_id, new.subcategory_id, new.legacy_subcategory)
      is distinct from (old.category_id, old.subcategory_id, old.legacy_subcategory);
    if v_changed and auth.uid() is not null and not public.can_edit_ticket_category() then
      raise exception 'Only department members, managers, and administrators can change categories';
    end if;
  end if;

  if v_changed and new.subcategory_id is not null and not exists (
    select 1
    from public.categories c
    where c.id = new.subcategory_id
      and c.department = new.department
      and c.parent_id = new.category_id
  ) then
    raise exception 'Select a valid category for this ticket department';
  end if;

  if v_changed and tg_op = 'INSERT'
    and auth.uid() is not null
    and new.imported_from is null
    and pg_trigger_depth() = 1
    and nullif(btrim(new.legacy_subcategory), '') is not null
    and not public.can_edit_ticket_category()
  then
    raise exception 'Select a category from the dropdown';
  end if;

  if v_required
    and new.subcategory_id is null
    and nullif(btrim(new.legacy_subcategory), '') is null
    and not exists (
      select 1
      from public.categories c
      where c.id = new.category_id
        and c.department = new.department
        and c.parent_id is not null
    )
  then
    raise exception 'Select and save a category before submitting, resolving, or closing this ticket';
  end if;

  return new;
end;
$$;
revoke all on function public.enforce_ticket_category() from public, anon, authenticated;

create or replace function public.merge_tickets(
  p_source_ticket_id uuid,
  p_target_ticket_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = ''
set row_security = off
as $$
declare
  v_source public.tickets%rowtype;
  v_target public.tickets%rowtype;
  v_actor_name text;
  v_submitter_name text;
  v_assignee_name text;
  v_category_name text;
  v_location text;
  v_messages text;
  v_attachment_count bigint;
  v_now timestamptz := clock_timestamp();
  v_note text;
begin
  if auth.uid() is null then
    raise exception 'Sign in to merge tickets';
  end if;
  if p_source_ticket_id is null or p_target_ticket_id is null
    or p_source_ticket_id = p_target_ticket_id
  then
    raise exception 'Select two different tickets';
  end if;

  perform 1
  from public.tickets
  where id in (p_source_ticket_id, p_target_ticket_id)
  order by id
  for update;

  select * into v_source
  from public.tickets
  where id = p_source_ticket_id;
  if not found then
    raise exception 'The ticket to merge was not found';
  end if;

  select * into v_target
  from public.tickets
  where id = p_target_ticket_id;
  if not found then
    raise exception 'The ticket to keep was not found';
  end if;

  if v_source.merged_into_ticket_id is not null then
    raise exception 'This ticket has already been merged';
  end if;
  if v_target.merged_into_ticket_id is not null then
    raise exception 'The ticket to keep has already been merged into another ticket';
  end if;
  if v_source.department is distinct from v_target.department then
    raise exception 'Tickets must belong to the same department to be merged';
  end if;
  if public.current_role() is distinct from 'admin'
    and not public.can_manage_department(v_source.department)
  then
    raise exception 'Only this department''s manager or an administrator can merge tickets';
  end if;

  select coalesce(nullif(btrim(full_name), ''), email)
    into v_actor_name
  from public.profiles
  where id = auth.uid();
  v_actor_name := coalesce(v_actor_name, 'A manager');

  select coalesce(
    nullif(btrim(p.full_name), ''),
    p.email,
    v_source.legacy_submitter_name,
    v_source.legacy_submitter_email,
    'Not recorded'
  )
    into v_submitter_name
  from (select 1) seed
  left join public.profiles p on p.id = v_source.submitter_id;

  select coalesce(
    nullif(btrim(p.full_name), ''),
    p.email,
    v_source.legacy_assignee_name,
    'Unassigned'
  )
    into v_assignee_name
  from (select 1) seed
  left join public.profiles p on p.id = v_source.assignee_id;

  select coalesce(
    subcategory.name,
    category.name,
    nullif(v_source.legacy_subcategory, ''),
    'Not recorded'
  )
    into v_category_name
  from (select 1) seed
  left join public.categories category on category.id = v_source.category_id
  left join public.categories subcategory on subcategory.id = v_source.subcategory_id;

  v_location := coalesce(
    nullif(concat_ws(' / ', nullif(v_source.building, ''), nullif(v_source.room, '')), ''),
    nullif(v_source.legacy_location, ''),
    'Not recorded'
  );

  select string_agg(
    format(
      '%s — %s%s:%s%s',
      to_char(m.created_at, 'YYYY-MM-DD HH24:MI:SS TZ'),
      coalesce(nullif(btrim(p.full_name), ''), p.email, 'Unknown author'),
      case when m.is_internal then ' (internal note)' else '' end,
      E'\n',
      m.body
    ),
    E'\n\n'
    order by m.created_at, m.id
  )
    into v_messages
  from public.ticket_messages m
  left join public.profiles p on p.id = m.author_id
  where m.ticket_id = v_source.id;

  select count(*) into v_attachment_count
  from public.attachments
  where ticket_id = v_source.id;

  v_note := format(
    'Ticket %s was merged into %s by %s on %s.%s',
    v_source.ref,
    v_target.ref,
    v_actor_name,
    to_char(v_now, 'YYYY-MM-DD HH24:MI:SS TZ'),
    E'\n\nPrevious ticket details:\n'
      || format(
        '- Subject: %s\n- Department: %s\n- Category: %s\n- Requested for: %s\n- Submitted by: %s\n- Priority: %s\n- Status before merge: %s\n- Opened: %s\n- Resolved: %s\n- Previously closed: %s\n- Location: %s\n- Assignee: %s\n- Time spent: %s minutes\n- Legacy reference: %s\n- Imported from: %s\n\nOriginal description:\n%s\n\nExisting replies and internal notes (chronological):\n%s\n\nAttachments: %s image(s). Original attachments remain on ticket %s.',
        v_source.subject,
        v_source.department,
        v_category_name,
        coalesce(nullif(v_source.requested_for, ''), 'Not recorded'),
        v_submitter_name,
        v_source.priority,
        v_source.status,
        to_char(v_source.created_at, 'YYYY-MM-DD HH24:MI:SS TZ'),
        coalesce(to_char(v_source.resolved_at, 'YYYY-MM-DD HH24:MI:SS TZ'), 'Not recorded'),
        coalesce(to_char(v_source.closed_at, 'YYYY-MM-DD HH24:MI:SS TZ'), 'Not recorded'),
        v_location,
        v_assignee_name,
        v_source.time_spent_minutes,
        coalesce(v_source.legacy_ref, 'Not recorded'),
        coalesce(v_source.imported_from, 'Not recorded'),
        v_source.description,
        coalesce(v_messages, 'No replies or internal notes.'),
        v_attachment_count,
        v_source.ref
      )
  );

  insert into public.ticket_messages (ticket_id, author_id, body, is_internal)
  values (v_target.id, auth.uid(), v_note, true);

  insert into public.ticket_messages (ticket_id, author_id, body, is_internal)
  values (
    v_source.id,
    auth.uid(),
    format(
      'This ticket was merged into %s (%s) by %s. The ticket is now closed. Its description, conversation, and attachment count were recorded in an internal note on the destination ticket.',
      v_target.ref,
      v_target.subject,
      v_actor_name
    ),
    true
  );

  perform set_config('app.ticket_merge', 'on', true);
  update public.tickets
  set status = 'closed',
      closed_at = v_now,
      merged_into_ticket_id = v_target.id
  where id = v_source.id;
  perform set_config('app.ticket_merge', 'off', true);

  return v_target.id;
end;
$$;

revoke all on function public.merge_tickets(uuid, uuid) from public, anon;
grant execute on function public.merge_tickets(uuid, uuid) to authenticated;

notify pgrst, 'reload schema';
