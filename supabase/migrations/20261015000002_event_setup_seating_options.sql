alter table public.event_setup_requests
  add column table_type text not null default 'round';

alter table public.event_setup_requests
  add constraint event_setup_requests_table_type_check
  check (table_type in ('round', 'long'));

alter table public.event_setup_requests
  drop constraint event_setup_requests_setup_type_check;

alter table public.event_setup_requests
  add constraint event_setup_requests_setup_type_check
  check (setup_type in ('exam', 'event', 'assembly', 'custom'));

do $$
declare
  existing_constraint text;
begin
  for existing_constraint in
    select conname
      from pg_constraint
     where conrelid = 'public.event_setup_requests'::regclass
       and contype = 'c'
       and pg_get_constraintdef(oid) like '%setup_type = ''custom''%'
  loop
    execute format(
      'alter table public.event_setup_requests drop constraint %I',
      existing_constraint
    );
  end loop;
end;
$$;

alter table public.event_setup_requests
  add constraint event_setup_requests_seating_layout_check
  check (
    (
      setup_type in ('custom', 'assembly')
      and total_seats is not null
      and seat_rows is not null
      and seat_sections is not null
      and seats_per_section_row is not null
    )
    or (
      setup_type not in ('custom', 'assembly')
      and total_seats is null
      and seat_rows is null
      and seat_sections is null
      and seats_per_section_row is null
    )
  );
