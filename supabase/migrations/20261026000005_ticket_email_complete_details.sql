create or replace function public.queue_ticket_email(
  p_ticket jsonb, p_event text, p_emails text[], p_title text, p_intro text, p_body text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_event uuid := gen_random_uuid();
  v_outbox uuid;
  v_email text;
  v_ticket jsonb := p_ticket;
  v_submitter_name text;
  v_submitter_email text;
  v_assignee_name text;
  v_category_name text;
  v_subcategory_name text;
  v_location_label text;
begin
  select full_name, email
    into v_submitter_name, v_submitter_email
    from public.profiles
   where id = nullif(p_ticket->>'submitter_id', '')::uuid;

  select full_name
    into v_assignee_name
    from public.profiles
   where id = nullif(p_ticket->>'assignee_id', '')::uuid;

  select name
    into v_category_name
    from public.categories
   where id = nullif(p_ticket->>'category_id', '')::uuid;

  select name
    into v_subcategory_name
    from public.categories
   where id = nullif(p_ticket->>'subcategory_id', '')::uuid;

  select label
    into v_location_label
    from public.locations
   where id = nullif(p_ticket->>'location_id', '')::uuid;

  v_ticket := p_ticket || jsonb_build_object(
    'submitter_name', coalesce(
      nullif(trim(v_submitter_name), ''),
      nullif(trim(p_ticket->>'legacy_submitter_name'), ''),
      nullif(trim(v_submitter_email), ''),
      nullif(trim(p_ticket->>'legacy_submitter_email'), ''),
      'Unknown'
    ),
    'submitter_email', coalesce(v_submitter_email, p_ticket->>'legacy_submitter_email'),
    'assignee_name', coalesce(
      nullif(trim(v_assignee_name), ''),
      nullif(trim(p_ticket->>'legacy_assignee_name'), '')
    ),
    'category_name', v_category_name,
    'subcategory_name', v_subcategory_name,
    'location_label', coalesce(
      nullif(
        trim(
          concat_ws(
            ' / ',
            nullif(trim(p_ticket->>'building'), ''),
            nullif(trim(p_ticket->>'room'), '')
          )
        ),
        ''
      ),
      v_location_label,
      nullif(trim(p_ticket->>'legacy_location'), '')
    )
  );

  if coalesce(array_length(p_emails, 1), 0) = 0 then
    insert into public.notifications_log(ticket_id, ticket_ref, subject, event, status, error)
    values (
      (v_ticket->>'id')::uuid,
      v_ticket->>'ref',
      v_ticket->>'subject',
      p_event,
      'skipped',
      'No recipient email available'
    );
    return;
  end if;

  for v_email in
    select distinct lower(trim(email))
      from unnest(p_emails) email
     where nullif(trim(email), '') is not null
  loop
    insert into public.notifications_outbox(channel, recipient, template, event_key, ticket_id, payload)
    values (
      'email',
      v_email,
      p_event,
      v_event,
      (v_ticket->>'id')::uuid,
      jsonb_build_object('ticket', v_ticket, 'title', p_title, 'intro', p_intro, 'body', p_body)
    )
    returning id into v_outbox;

    insert into public.notifications_log(outbox_id, ticket_id, ticket_ref, subject, event, recipients, status)
    values (
      v_outbox,
      (v_ticket->>'id')::uuid,
      v_ticket->>'ref',
      v_ticket->>'subject',
      p_event,
      array[v_email],
      'queued'
    );
  end loop;
end;
$$;
