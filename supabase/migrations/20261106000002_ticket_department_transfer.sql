create or replace function public.transfer_ticket_department(
  p_ticket_id uuid,
  p_department public.department
)
returns public.department
language plpgsql
security definer
set search_path = ''
set row_security = off
as $$
declare
  v_ticket public.tickets%rowtype;
  v_actor_name text;
  v_note text;
  v_manager_emails text[];
  v_assignee_was_empty boolean;
begin
  if auth.uid() is null then
    raise exception 'Sign in to transfer tickets';
  end if;
  if p_ticket_id is null or p_department is null then
    raise exception 'Select a ticket and destination department';
  end if;

  select * into v_ticket
  from public.tickets
  where id = p_ticket_id
  for update;
  if not found then
    raise exception 'Ticket not found';
  end if;
  if v_ticket.merged_into_ticket_id is not null then
    raise exception 'A merged ticket cannot be transferred';
  end if;
  if v_ticket.department = p_department then
    raise exception 'Ticket is already in that department';
  end if;
  if public.current_role() is distinct from 'admin'
    and (
      public.current_role() is distinct from 'manager'
      or p_department = 'AV'
      or (
        not public.can_manage_department(v_ticket.department)
        and not public.can_manage_department(p_department)
      )
    )
  then
    raise exception 'Only an administrator or a manager of the current or destination department can transfer this ticket; only administrators can transfer tickets to Audio Visual';
  end if;

  select coalesce(nullif(btrim(full_name), ''), email, 'A manager')
    into v_actor_name
  from public.profiles
  where id = auth.uid();
  v_actor_name := coalesce(v_actor_name, 'A manager');
  v_note := format(
    'Ticket %s was transferred from %s to %s by %s on %s. Its category and assignee were cleared so the destination department can review and route it.',
    v_ticket.ref,
    v_ticket.department,
    p_department,
    v_actor_name,
    to_char(clock_timestamp(), 'YYYY-MM-DD HH24:MI:SS TZ')
  );

  insert into public.ticket_messages (ticket_id, author_id, body, is_internal)
  values (v_ticket.id, auth.uid(), v_note, true);

  v_assignee_was_empty := v_ticket.assignee_id is null;
  update public.tickets
  set department = p_department,
      category_id = null,
      subcategory_id = null,
      legacy_subcategory = null,
      assignee_id = null,
      legacy_assignee_name = null
  where id = v_ticket.id
  returning * into v_ticket;

  if v_assignee_was_empty then
    select array_agg(email) into v_manager_emails
    from public.profiles
    where role = 'manager' and department = p_department;

    perform public.queue_ticket_email(
      to_jsonb(v_ticket),
      'ticket.routed_to_manager',
      v_manager_emails,
      'Ticket transferred to your department: ' || v_ticket.ref,
      'A manager transferred this ticket to your department. Please review and assign it.',
      v_note
    );
  end if;

  return p_department;
end;
$$;

revoke all on function public.transfer_ticket_department(uuid, public.department) from public, anon;
grant execute on function public.transfer_ticket_department(uuid, public.department) to authenticated;

notify pgrst, 'reload schema';
