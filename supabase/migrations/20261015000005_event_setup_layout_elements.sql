alter table public.event_setup_requests
  add column podium_required boolean not null default false,
  add column layout_element_positions jsonb not null default '{}'::jsonb
    check (jsonb_typeof(layout_element_positions) = 'object');
