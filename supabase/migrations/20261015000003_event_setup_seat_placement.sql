alter table public.event_setup_requests
  add column seat_placement text not null default 'center'
  check (seat_placement in ('left', 'right', 'center'));
