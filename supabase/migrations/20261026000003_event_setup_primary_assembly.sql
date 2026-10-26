alter table public.event_setup_requests
  add column seat_back_row_chairs integer not null default 0
    check (seat_back_row_chairs between 0 and 100),
  add column equipment text[] not null default '{}'
    check (cardinality(equipment) <= 10);

do $$
declare
  constraint_name text;
begin
  for constraint_name in
    select conname
      from pg_constraint
     where conrelid = 'public.event_setup_requests'::regclass
       and contype = 'c'
        and (
          conname = 'event_setup_requests_total_seats_check'
          or pg_get_constraintdef(oid) ilike '%total_seats =%seat_rows%seat_sections%seats_per_section_row%'
        )
  loop
    execute format(
      'alter table public.event_setup_requests drop constraint %I',
      constraint_name
    );
  end loop;
end;
$$;

alter table public.event_setup_requests
  add constraint event_setup_requests_total_seats_check
  check (
    total_seats is null
    or (
      total_seats between 1 and 2000
      and seat_rows between 1 and 100
      and seat_sections between 1 and 20
      and seats_per_section_row between 1 and 100
      and total_seats = seat_rows * seat_sections * seats_per_section_row + seat_back_row_chairs
    )
  ),
  add constraint event_setup_requests_back_row_layout_check
  check (seat_back_row_chairs = 0 or total_seats is not null);

create or replace function public.event_setup_create_facilities_ticket()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_assignee uuid;
  v_ticket_id uuid;
  v_description text;
begin
  select p.id
    into v_assignee
    from public.profiles p
   where public.can_work_department(p.id, 'FAC'::public.department)
   order by case p.role
     when 'fac_tech' then 1
     when 'manager' then 2
     else 3
   end, p.created_at, p.id
   limit 1;

  v_description := concat_ws(
    E'\n',
    'Automatically created from an Event Setup request.',
    format('Event: %s', new.event_title),
    format('Date: %s at %s', new.event_date, new.setup_time),
    format('Location: %s', new.location),
    format('Setup type: %s', new.setup_type),
    case when new.total_seats is not null then
      format(
        '%s chairs/seats: %s sections, %s rows, %s per section per row; placement: %s',
        case when new.setup_type = 'event' then 'Event' else 'Requested' end,
        new.total_seats,
        new.seat_sections,
        new.seat_rows,
        new.seats_per_section_row,
        new.seat_placement
      )
    end,
    case when new.seat_back_row_chairs > 0 then
      format('Additional back row away from the stage: 1 row × %s chairs', new.seat_back_row_chairs)
    end,
    case when cardinality(new.equipment) > 0 then
      format('Equipment requested: %s', array_to_string(new.equipment, ', '))
    end,
    case when new.exam_front_rows is not null then
      format('Exam desks at front: %s rows × %s columns', new.exam_front_rows, new.exam_front_columns)
    end,
    case when new.exam_back_rows is not null then
      format('Exam desks at back: %s rows × %s columns', new.exam_back_rows, new.exam_back_columns)
    end,
    case when new.round_table_count > 0 then
      format(
        'Tables: %s %s tables, %s chairs each%s',
        new.round_table_count,
        new.table_type,
        new.chairs_per_table,
        case when new.tables_on_stage then ' (on stage)' else '' end
      )
    end,
    case when new.risers_required then format('Risers: %s rows', new.riser_rows) end,
    case when new.podium_required then 'Podium required' end,
    case when cardinality(new.recurrence_days) > 0 then
      format(
        'Repeats weekly on days %s through %s',
        array_to_string(
          array(
            select to_char(date '2000-01-02' + day, 'FMDay')
              from unnest(new.recurrence_days) as repeat_day(day)
             order by day
          ),
          ', '
        ),
        new.recurrence_end_date
      )
    when cardinality(new.recurrence_dates) > 0 then
      format(
        'Additional event dates: %s',
        array_to_string(new.recurrence_dates, ', ')
      )
    end,
    case when new.fast_turnaround then 'Fast turnaround / standby requested' end,
    case when nullif(trim(new.special_instructions), '') is not null then
      format('Special instructions: %s', new.special_instructions)
    end
  );

  insert into public.tickets (
    ref,
    department,
    subject,
    description,
    submitter_id,
    assignee_id
  )
  values (
    null,
    'FAC'::public.department,
    left('Event setup: ' || new.event_title, 200),
    v_description,
    new.requester_id,
    v_assignee
  )
  returning id into v_ticket_id;

  update public.tickets
     set assignee_id = v_assignee
   where id = v_ticket_id
     and assignee_id is distinct from v_assignee;

  update public.event_setup_requests
     set ticket_id = v_ticket_id
   where id = new.id;

  return new;
end;
$$;

notify pgrst, 'reload schema';
