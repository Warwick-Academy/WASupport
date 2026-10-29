create or replace function public.capture_ticket_email()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  ticket public.tickets%rowtype;
  submitter_email text;
  owner_emails text[];
  owner_event text;
  reopened boolean := false;
begin
  if tg_table_name='tickets' and current_setting('app.spiceworks_assignment_import',true)='on' then return new; end if;
  if tg_table_name = 'ticket_messages' then
    if new.is_internal then return new; end if;
    select * into ticket from public.tickets where id=new.ticket_id;
    if new.author_id=ticket.submitter_id and ticket.status='closed' then
      update public.tickets
      set status='open',
          resolved_at=null,
          closed_at=null,
          triaged_at=now(),
          sla_due_at=now()+public.sla_window(ticket.priority),
          sla_reminder_approaching_sent=false,
          sla_reminder_overdue_sent=false
      where id=ticket.id and status='closed'
      returning * into ticket;
      reopened := found;
    end if;
  else
    ticket := new;
    if tg_op='INSERT' and ticket.imported_from is not null then return new; end if;
  end if;
  select coalesce(p.email,ticket.legacy_submitter_email) into submitter_email
    from (select 1) seed left join public.profiles p on p.id=ticket.submitter_id;
  select array_agg(email) into owner_emails from public.profiles where id=ticket.assignee_id;
  owner_event := 'ticket.assigned';
  if coalesce(array_length(owner_emails,1),0)=0 then
    select array_agg(email) into owner_emails from public.profiles where role='manager' and department=ticket.department;
    owner_event := 'ticket.routed_to_manager';
  end if;
  if tg_table_name='ticket_messages' then
    if new.author_id = ticket.submitter_id then
      if reopened then
        perform public.queue_ticket_email(to_jsonb(ticket),'ticket.created',owner_emails,'Ticket reopened: '||ticket.ref,'The submitter reopened this ticket and added information.',new.body);
      else
        perform public.queue_ticket_email(to_jsonb(ticket),'ticket.reply',owner_emails,'New reply on '||ticket.ref,'The submitter has added a reply.',new.body);
      end if;
    else
      perform public.queue_ticket_email(to_jsonb(ticket),'ticket.reply',array_remove(array[submitter_email],null),'New reply on '||ticket.ref,'Support has replied to your ticket.',new.body);
    end if;
  elsif tg_op='INSERT' then
    perform public.queue_ticket_email(to_jsonb(ticket),'ticket.created',array_remove(array[submitter_email],null),'We received your request: '||ticket.ref,'Your ticket has been logged.',ticket.description);
    perform public.queue_ticket_email(to_jsonb(ticket),owner_event,owner_emails,'New ticket: '||ticket.ref,'A new ticket needs your attention.',ticket.description);
  else
    if new.status is distinct from old.status then
      perform public.queue_ticket_email(to_jsonb(ticket),'ticket.status_changed',array_remove(array[submitter_email],null),'Status updated: '||ticket.ref,'Your ticket status changed from '||old.status||' to '||new.status||'.',null);
    end if;
    if new.assignee_id is distinct from old.assignee_id then
      perform public.queue_ticket_email(to_jsonb(ticket),owner_event,owner_emails,'Ticket assignment: '||ticket.ref,'This ticket needs your attention.',ticket.description);
    end if;
  end if;
  return new;
end;
$$;
notify pgrst,'reload schema';
