do $$
declare item record;
begin
  for item in
    select c.relname,t.tgname from pg_trigger t
    join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace
    join pg_proc p on p.oid=t.tgfoid
    where n.nspname='public' and c.relname in ('tickets','ticket_messages')
      and not t.tgisinternal and p.proname='http_request'
      and position('send-email' in encode(t.tgargs,'escape'))>0
  loop
    execute format('alter table public.%I disable trigger %I',item.relname,item.tgname);
  end loop;
end;
$$;

alter table public.notifications_outbox
  add column event_key uuid,
  add column ticket_id uuid references public.tickets(id) on delete set null,
  add column lease_id uuid,
  add column leased_at timestamptz,
  add column available_at timestamptz not null default now();
create unique index notifications_outbox_event_recipient_idx
  on public.notifications_outbox(event_key, recipient);

alter table public.notifications_log
  add column outbox_id uuid unique references public.notifications_outbox(id) on delete set null,
  add column ticket_ref text,
  add column subject text,
  add column provider_message_id text,
  add column attempts integer not null default 0,
  add column updated_at timestamptz not null default now();
alter table public.notifications_log drop constraint notifications_log_event_check;
alter table public.notifications_log drop constraint notifications_log_status_check;
alter table public.notifications_log add constraint notifications_log_status_check
  check (status in ('queued','processing','sent','delivered','bounced','deferred','skipped','error'));
drop policy if exists "notifications_log read for staff" on public.notifications_log;
create policy "notifications_log admin read" on public.notifications_log
  for select to authenticated using (public.is_admin());
grant select on public.notifications_log to authenticated;

create function public.queue_ticket_email(
  p_ticket jsonb, p_event text, p_emails text[], p_title text, p_intro text, p_body text
)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_event uuid := gen_random_uuid();
  v_outbox uuid;
  v_email text;
begin
  if coalesce(array_length(p_emails,1),0) = 0 then
    insert into public.notifications_log(ticket_id,ticket_ref,subject,event,status,error)
    values ((p_ticket->>'id')::uuid,p_ticket->>'ref',p_ticket->>'subject',p_event,'skipped','No recipient email available');
    return;
  end if;
  for v_email in select distinct lower(trim(email)) from unnest(p_emails) email where nullif(trim(email),'') is not null loop
    insert into public.notifications_outbox(channel,recipient,template,event_key,ticket_id,payload)
    values ('email',v_email,p_event,v_event,(p_ticket->>'id')::uuid,
      jsonb_build_object('ticket',p_ticket,'title',p_title,'intro',p_intro,'body',p_body))
    returning id into v_outbox;
    insert into public.notifications_log(outbox_id,ticket_id,ticket_ref,subject,event,recipients,status)
    values (v_outbox,(p_ticket->>'id')::uuid,p_ticket->>'ref',p_ticket->>'subject',p_event,array[v_email],'queued');
  end loop;
end;
$$;

create function public.capture_ticket_email()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  ticket public.tickets%rowtype;
  submitter_email text;
  owner_emails text[];
  owner_event text;
begin
  if tg_table_name = 'ticket_messages' then
    if new.is_internal then return new; end if;
    select * into ticket from public.tickets where id=new.ticket_id;
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
      perform public.queue_ticket_email(to_jsonb(ticket),'ticket.reply',owner_emails,'New reply on '||ticket.ref,'The submitter has added a reply.',new.body);
    else
      perform public.queue_ticket_email(to_jsonb(ticket),'ticket.reply',array_remove(array[submitter_email],null),'New reply on '||ticket.ref,'Support has replied to your ticket.',new.body);
    end if;
  elsif tg_op='INSERT' then
    perform public.queue_ticket_email(to_jsonb(ticket),'ticket.created',array_remove(array[submitter_email],null),'We received your request: '||ticket.ref,'Your ticket has been logged.',ticket.description);
    perform public.queue_ticket_email(to_jsonb(ticket),owner_event,array_remove(owner_emails,submitter_email),'New ticket: '||ticket.ref,'A new ticket needs your attention.',ticket.description);
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
revoke all on function public.queue_ticket_email(jsonb,text,text[],text,text,text) from public,anon,authenticated;
revoke all on function public.capture_ticket_email() from public,anon,authenticated;
create trigger trg_queue_ticket_email after insert or update on public.tickets
  for each row execute function public.capture_ticket_email();
create trigger trg_queue_reply_email after insert on public.ticket_messages
  for each row execute function public.capture_ticket_email();

create function public.claim_ticket_emails(p_limit integer default 10)
returns setof public.notifications_outbox
language plpgsql security definer set search_path = public as $$
begin
  update public.notifications_outbox set status='failed',last_error='Sending interrupted; delivery outcome unknown'
    where event_key is not null and status='pending' and attempts>=6 and leased_at < now()-interval '5 minutes';
  update public.notifications_log l set status='error',error=o.last_error,attempts=o.attempts,updated_at=now()
    from public.notifications_outbox o where l.outbox_id=o.id and o.status='failed' and l.status='processing';
  return query
    update public.notifications_outbox o set lease_id=gen_random_uuid(),leased_at=now(),attempts=o.attempts+1
    where o.id in (
      select id from public.notifications_outbox
      where event_key is not null and status='pending' and attempts<6 and available_at<=now()
        and (leased_at is null or leased_at<now()-interval '5 minutes')
      order by created_at,id for update skip locked limit least(greatest(p_limit,1),20)
    ) returning o.*;
end;
$$;

create function public.finish_ticket_email(p_id uuid,p_lease uuid,p_ok boolean,p_error text default null,p_provider text default null)
returns void language plpgsql security definer set search_path = public as $$
declare v_attempts integer;
begin
  update public.notifications_outbox set
    status=case when p_ok then 'sent'::public.notification_status when attempts>=6 then 'failed'::public.notification_status else 'pending'::public.notification_status end,
    sent_at=case when p_ok then now() else null end,
    last_error=p_error,lease_id=null,leased_at=null,
    available_at=now()+make_interval(secs=>least(3600,(30*power(2,attempts))::integer))
  where id=p_id and lease_id=p_lease returning attempts into v_attempts;
  if not found then raise exception 'Email lease no longer valid'; end if;
  update public.notifications_log set
    status=case when status in ('delivered','bounced') then status when p_ok then 'sent' when v_attempts>=6 then 'error' else 'queued' end,
    error=p_error,attempts=v_attempts,provider_message_id=p_provider,updated_at=now()
  where outbox_id=p_id;
end;
$$;
revoke all on function public.claim_ticket_emails(integer) from public,anon,authenticated;
revoke all on function public.finish_ticket_email(uuid,uuid,boolean,text,text) from public,anon,authenticated;
grant execute on function public.claim_ticket_emails(integer) to service_role;
grant execute on function public.finish_ticket_email(uuid,uuid,boolean,text,text) to service_role;

create table public.email_delivery_events (
  id text primary key,
  outbox_id uuid not null references public.notifications_outbox(id) on delete cascade,
  event text not null,
  happened_at timestamptz not null
);
alter table public.email_delivery_events enable row level security;

create function public.record_email_delivery(p_events jsonb)
returns integer language plpgsql security definer set search_path=public as $$
declare item jsonb; inserted integer; total integer := 0; state text; oid uuid;
begin
  for item in select value from jsonb_array_elements(p_events) loop
    if item->>'outbox_id' is null or item->>'sg_event_id' is null then continue; end if;
    begin oid := (item->>'outbox_id')::uuid; exception when invalid_text_representation then continue; end;
    if not exists(select 1 from public.notifications_outbox where id=oid) then continue; end if;
    state := case item->>'event' when 'delivered' then 'delivered' when 'bounce' then 'bounced' when 'dropped' then 'bounced' when 'deferred' then 'deferred' else null end;
    if state is null then continue; end if;
    insert into public.email_delivery_events(id,outbox_id,event,happened_at)
    values(item->>'sg_event_id',oid,item->>'event',to_timestamp((item->>'timestamp')::double precision)) on conflict do nothing;
    get diagnostics inserted = row_count;
    if inserted=0 then continue; end if;
    total := total+1;
    update public.notifications_log set status=state,
      error=case when state='delivered' then null else left(item->>'reason',1000) end,updated_at=now()
    where outbox_id=oid and (status not in ('delivered','bounced') or status=state);
    update public.notifications_outbox set status='sent',sent_at=coalesce(sent_at,now()),lease_id=null,leased_at=null
      where id=oid;
  end loop;
  return total;
end;
$$;
revoke all on function public.record_email_delivery(jsonb) from public,anon,authenticated;
grant execute on function public.record_email_delivery(jsonb) to service_role;

update public.notifications_log l set ticket_ref=t.ref,subject=t.subject
  from public.tickets t where t.id=l.ticket_id;

create function public.search_email_log(
  p_search text default '', p_status text default '', p_event text default '',
  p_from date default null, p_to date default null, p_offset integer default 0
)
returns table(id uuid,ticket_id uuid,ticket_ref text,subject text,event text,recipients text[],status text,error text,attempts integer,created_at timestamptz,total_count bigint,outbox_id uuid)
language sql stable security invoker set search_path=public set timezone='UTC' as $$
  select l.id,l.ticket_id,l.ticket_ref,l.subject,l.event,l.recipients,l.status,l.error,l.attempts,l.created_at,count(*) over(),l.outbox_id
  from public.notifications_log l
  where public.is_admin()
    and (p_status='' or l.status=p_status) and (p_event='' or l.event=p_event)
    and (p_from is null or l.created_at>=p_from::timestamptz)
    and (p_to is null or l.created_at<(p_to+1)::timestamptz)
    and (p_search='' or concat_ws(' ',l.ticket_ref,l.subject,array_to_string(l.recipients,' ')) ilike '%'||p_search||'%')
  order by l.created_at desc,l.id limit 50 offset greatest(p_offset,0);
$$;
revoke all on function public.search_email_log(text,text,text,date,date,integer) from public,anon;
grant execute on function public.search_email_log(text,text,text,date,date,integer) to authenticated;

create function public.retry_ticket_email(p_id uuid)
returns void language plpgsql security definer set search_path=public as $$
begin
  if not coalesce(public.is_admin(),false) then raise exception 'Admin access required'; end if;
  update public.notifications_outbox set status='pending',attempts=0,last_error=null,
    lease_id=null,leased_at=null,available_at=now()
    where id=p_id and event_key is not null and status='failed';
  if not found then raise exception 'Only failed queued emails can be retried'; end if;
  update public.notifications_log set status='queued',error=null,attempts=0,updated_at=now() where outbox_id=p_id;
end;
$$;
revoke all on function public.retry_ticket_email(uuid) from public,anon;
grant execute on function public.retry_ticket_email(uuid) to authenticated;
notify pgrst,'reload schema';