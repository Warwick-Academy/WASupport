create function public.normalize_assignee_name(p_name text)
returns text language sql immutable set search_path=public as $$
  select lower(regexp_replace(trim(
    case when position(',' in coalesce(p_name,''))>0
      then trim(split_part(p_name,',',2))||' '||trim(split_part(p_name,',',1))
      else coalesce(p_name,'') end
  ),'\s+',' ','g'));
$$;

create function public.resolve_spiceworks_assignee(p_name text,p_department public.department)
returns uuid language plpgsql stable security definer set search_path=public set row_security=off as $$
declare ids uuid[];
begin
  if nullif(trim(p_name),'') is null then return null; end if;
  select array_agg(p.id) into ids from public.profiles p
  where public.can_work_department(p.id,p_department)
    and (public.normalize_assignee_name(p.full_name)=public.normalize_assignee_name(p_name)
      or lower(trim(p.email))=lower(trim(p_name)));
  if array_length(ids,1)=1 then return ids[1]; end if;
  return null;
end;
$$;
revoke all on function public.resolve_spiceworks_assignee(text,public.department) from public,anon,authenticated;
grant execute on function public.resolve_spiceworks_assignee(text,public.department) to service_role;

create function public.assign_imported_ticket()
returns trigger language plpgsql security definer set search_path=public as $$
begin
  if new.imported_from='spiceworks' and new.assignee_id is null and (
    auth.role()='service_role' or public.is_admin()
    or (auth.uid() is null and session_user in ('postgres','supabase_admin'))
  ) then
    new.assignee_id := public.resolve_spiceworks_assignee(new.legacy_assignee_name,new.department);
  end if;
  return new;
end;
$$;
revoke all on function public.assign_imported_ticket() from public,anon,authenticated;
create trigger trg_assign_imported_ticket
  before insert on public.tickets for each row execute function public.assign_imported_ticket();

create or replace function public.capture_ticket_email()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  ticket public.tickets%rowtype;
  submitter_email text;
  owner_emails text[];
  owner_event text;
begin
  if tg_table_name='tickets' and current_setting('app.spiceworks_assignment_import',true)='on' then return new; end if;
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

create function public.import_spiceworks_tickets(p_tickets jsonb)
returns jsonb language plpgsql security definer set search_path=public set row_security=off as $$
declare
  item jsonb;
  existing public.tickets%rowtype;
  imported public.tickets%rowtype;
  legacy text;
  name text;
  candidate uuid;
  inserted integer := 0;
  skipped integer := 0;
  updated integer := 0;
  assigned integer := 0;
  unmatched jsonb := '[]'::jsonb;
  previous_setting text := current_setting('app.spiceworks_assignment_import',true);
begin
  if jsonb_typeof(p_tickets)<>'array' or jsonb_array_length(p_tickets)>200 then
    raise exception 'Import requires an array of up to 200 tickets';
  end if;
  perform set_config('app.spiceworks_assignment_import','on',true);
  for item in select value from jsonb_array_elements(p_tickets) loop
    legacy := nullif(trim(item->>'legacy_ref'),'');
    if legacy is null then raise exception 'Ticket Number is required'; end if;
    perform pg_advisory_xact_lock(hashtextextended('spiceworks:'||legacy,0));
    select * into existing from public.tickets where legacy_ref=legacy for update;
    if found then
      skipped := skipped+1;
      if existing.imported_from is distinct from 'spiceworks' or existing.assignee_id is not null then continue; end if;
      name := coalesce(nullif(trim(item->>'legacy_assignee_name'),''),existing.legacy_assignee_name);
      candidate := public.resolve_spiceworks_assignee(name,existing.department);
      if candidate is not null then
        update public.tickets set assignee_id=candidate,legacy_assignee_name=name
          where id=existing.id and assignee_id is null;
        if found then updated := updated+1; end if;
      elsif nullif(trim(name),'') is not null then
        if existing.legacy_assignee_name is null then
          update public.tickets set legacy_assignee_name=name where id=existing.id;
        end if;
        unmatched := unmatched||jsonb_build_array(jsonb_build_object('legacy_ref',legacy,'name',name,'department',existing.department));
      end if;
      continue;
    end if;
    imported := jsonb_populate_record(null::public.tickets,item);
    name := nullif(trim(imported.legacy_assignee_name),'');
    candidate := public.resolve_spiceworks_assignee(name,imported.department);
    insert into public.tickets (
      legacy_ref,department,subject,description,priority,status,submitter_id,assignee_id,
      legacy_submitter_name,legacy_assignee_name,legacy_subcategory,legacy_location,legacy_link,
      imported_from,imported_at,created_at,sla_due_at,resolved_at,closed_at
    ) values (
      legacy,imported.department,imported.subject,coalesce(imported.description,''),
      coalesce(imported.priority,'normal'),coalesce(imported.status,'open'),null,candidate,
      imported.legacy_submitter_name,name,imported.legacy_subcategory,imported.legacy_location,imported.legacy_link,
      'spiceworks',coalesce(imported.imported_at,now()),coalesce(imported.created_at,now()),
      imported.sla_due_at,imported.resolved_at,imported.closed_at
    );
    inserted := inserted+1;
    if candidate is not null then assigned := assigned+1;
    elsif name is not null then
      unmatched := unmatched||jsonb_build_array(jsonb_build_object('legacy_ref',legacy,'name',name,'department',imported.department));
    end if;
  end loop;
  perform set_config('app.spiceworks_assignment_import',coalesce(previous_setting,''),true);
  return jsonb_build_object('inserted',inserted,'skipped',skipped,'updated',updated,'assigned',assigned,'unmatched',unmatched);
end;
$$;
revoke all on function public.import_spiceworks_tickets(jsonb) from public,anon,authenticated;
grant execute on function public.import_spiceworks_tickets(jsonb) to service_role;

create function public.backfill_spiceworks_assignees()
returns integer language plpgsql security definer set search_path=public set row_security=off as $$
declare changed integer; previous_setting text := current_setting('app.spiceworks_assignment_import',true);
begin
  perform set_config('app.spiceworks_assignment_import','on',true);
  update public.tickets t set assignee_id=public.resolve_spiceworks_assignee(t.legacy_assignee_name,t.department)
    where t.imported_from='spiceworks' and t.assignee_id is null
      and public.resolve_spiceworks_assignee(t.legacy_assignee_name,t.department) is not null;
  get diagnostics changed = row_count;
  perform set_config('app.spiceworks_assignment_import',coalesce(previous_setting,''),true);
  return changed;
end;
$$;
revoke all on function public.backfill_spiceworks_assignees() from public,anon,authenticated;
grant execute on function public.backfill_spiceworks_assignees() to service_role;
notify pgrst,'reload schema';