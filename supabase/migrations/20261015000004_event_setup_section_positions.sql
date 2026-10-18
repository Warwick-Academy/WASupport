alter table public.event_setup_requests
  add column seat_section_offsets jsonb not null default '{}'::jsonb
  check (jsonb_typeof(seat_section_offsets) = 'object');
