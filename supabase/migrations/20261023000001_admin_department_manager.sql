alter table public.profiles
  add column if not exists manager_department public.department;
create or replace function public.profiles_enforce_role_department()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'UPDATE'
     and (new.role is distinct from old.role
       or new.department is distinct from old.department
       or new.manager_department is distinct from old.manager_department)
     and auth.uid() is not null
     and not public.is_admin()
  then
    raise exception 'only administrators can change role or department';
  end if;

  if new.role = 'submitter' then
    new.department := null;
  elsif public.role_department(new.role) is not null then
    new.department := public.role_department(new.role);
  end if;

  if new.role = 'manager' then
    new.manager_department := new.department;
  elsif new.role <> 'admin' then
    new.manager_department := null;
  end if;

  return new;
end;
$$;
create or replace function public.capture_ticket_email()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  ticket public.tickets%rowtype;
  submitter_email text;
  owner_emails text[];
  owner_event text;
begin
  if tg_table_name = 'tickets'
     and current_setting('app.spiceworks_assignment_import', true) = 'on' then
    return new;
  end if;

  if tg_table_name = 'ticket_messages' then
    if new.is_internal then return new; end if;
    select * into ticket from public.tickets where id = new.ticket_id;
  else
    ticket := new;
    if tg_op = 'INSERT' and ticket.imported_from is not null then return new; end if;
  end if;

  select coalesce(p.email, ticket.legacy_submitter_email) into submitter_email
    from (select 1) seed left join public.profiles p on p.id = ticket.submitter_id;
  select array_agg(email) into owner_emails
    from public.profiles
   where id = ticket.assignee_id;
  owner_event := 'ticket.assigned';
  if coalesce(array_length(owner_emails, 1), 0) = 0 then
    select array_agg(email) into owner_emails
      from public.profiles
     where (role = 'manager' and department = ticket.department)
        or (role = 'admin' and manager_department = ticket.department);
    owner_event := 'ticket.routed_to_manager';
  end if;

  if tg_table_name = 'ticket_messages' then
    if new.author_id = ticket.submitter_id then
      perform public.queue_ticket_email(
        to_jsonb(ticket), 'ticket.reply', owner_emails, 'New reply on ' || ticket.ref,
        'The submitter has added a reply.', new.body
      );
    else
      perform public.queue_ticket_email(
        to_jsonb(ticket), 'ticket.reply', array_remove(array[submitter_email], null),
        'New reply on ' || ticket.ref, 'Support has replied to your ticket.', new.body
      );
    end if;
  elsif tg_op = 'INSERT' then
    perform public.queue_ticket_email(
      to_jsonb(ticket), 'ticket.created', array_remove(array[submitter_email], null),
      'We received your request: ' || ticket.ref, 'Your ticket has been logged.', ticket.description
    );
    perform public.queue_ticket_email(
      to_jsonb(ticket), owner_event, array_remove(owner_emails, submitter_email),
      'New ticket: ' || ticket.ref, 'A new ticket needs your attention.', ticket.description
    );
  else
    if new.status is distinct from old.status then
      perform public.queue_ticket_email(
        to_jsonb(ticket), 'ticket.status_changed', array_remove(array[submitter_email], null),
        'Status updated: ' || ticket.ref,
        'Your ticket status changed from ' || old.status || ' to ' || new.status || '.', null
      );
    end if;
    if new.assignee_id is distinct from old.assignee_id then
      perform public.queue_ticket_email(
        to_jsonb(ticket), owner_event, owner_emails, 'Ticket assignment: ' || ticket.ref,
        'This ticket needs your attention.', ticket.description
      );
    end if;
  end if;
  return new;
end;
$$;
notify pgrst, 'reload schema';
