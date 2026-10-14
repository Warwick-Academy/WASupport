alter table public.tickets
  add column if not exists requested_for text;