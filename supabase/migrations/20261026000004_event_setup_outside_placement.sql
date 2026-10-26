alter table public.event_setup_requests
  drop constraint if exists event_setup_requests_seat_placement_check;

alter table public.event_setup_requests
  add constraint event_setup_requests_seat_placement_check
  check (seat_placement in ('left', 'right', 'center', 'outside'));
