create table public.event_setup_requests (
  id uuid primary key default gen_random_uuid(),
  requester_id uuid not null references public.profiles(id) on delete restrict,
  requester_name text not null,
  requester_email text not null,
  event_title text not null check (length(trim(event_title)) > 0),
  setup_type text not null check (setup_type in ('exam', 'event', 'custom')),
  event_date date not null,
  setup_time time not null,
  location text not null check (length(trim(location)) > 0),
  exam_front_rows integer check (exam_front_rows >= 0),
  exam_front_columns integer check (exam_front_columns >= 0),
  exam_back_rows integer check (exam_back_rows >= 0),
  exam_back_columns integer check (exam_back_columns >= 0),
  total_seats integer check (total_seats > 0),
  seat_rows integer check (seat_rows > 0),
  seat_sections integer check (seat_sections > 0),
  seats_per_section_row integer check (seats_per_section_row > 0),
  round_table_count integer not null default 0 check (round_table_count between 0 and 200),
  chairs_per_table integer not null default 0 check (chairs_per_table between 0 and 100),
  tables_on_stage boolean not null default false,
  risers_required boolean not null default false,
  riser_rows integer,
  recurrence_days smallint[] not null default '{}',
  recurrence_end_date date,
  fast_turnaround boolean not null default false,
  special_instructions text,
  status text not null default 'pending'
    check (status in ('pending', 'scheduled', 'declined', 'completed')),
  created_at timestamptz not null default now(),
  check (
    (exam_front_rows is null and exam_front_columns is null)
    or (exam_front_rows is not null and exam_front_columns is not null and exam_front_rows between 1 and 100 and exam_front_columns between 1 and 100)
  ),
  check (
    (exam_back_rows is null and exam_back_columns is null)
    or (exam_back_rows is not null and exam_back_columns is not null and exam_back_rows between 1 and 100 and exam_back_columns between 1 and 100)
  ),
  check (
    total_seats is null
    or (
      total_seats between 1 and 2000
      and seat_rows between 1 and 100
      and seat_sections between 1 and 20
      and seats_per_section_row > 0
      and total_seats = seat_rows * seat_sections * seats_per_section_row
    )
  ),
  check (round_table_count = 0 or chairs_per_table > 0),
  check (
    (setup_type = 'exam' and (coalesce(exam_front_rows, 0) + coalesce(exam_back_rows, 0)) > 0)
    or (setup_type <> 'exam' and exam_front_rows is null and exam_front_columns is null and exam_back_rows is null and exam_back_columns is null)
  ),
  check (
    (setup_type = 'custom' and total_seats is not null and seat_rows is not null and seat_sections is not null and seats_per_section_row is not null)
    or (setup_type <> 'custom' and total_seats is null and seat_rows is null and seat_sections is null and seats_per_section_row is null)
  ),
  check (
    (risers_required and riser_rows is not null and riser_rows between 1 and 30)
    or (not risers_required and riser_rows is null)
  ),
  check (
    (cardinality(recurrence_days) = 0 and recurrence_end_date is null)
    or (
      cardinality(recurrence_days) between 1 and 7
      and recurrence_end_date is not null
      and recurrence_end_date >= event_date
      and recurrence_days <@ array[0, 1, 2, 3, 4, 5, 6]::smallint[]
    )
  )
);

create index event_setup_requests_date_idx
  on public.event_setup_requests(event_date, setup_time);
create index event_setup_requests_requester_idx
  on public.event_setup_requests(requester_id, event_date);

create or replace function public.can_manage_event_setup()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(public.current_role() in ('fac_tech', 'manager', 'admin'), false);
$$;

create or replace function public.event_setup_set_requester()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  select coalesce(p.full_name, p.email), p.email
    into new.requester_name, new.requester_email
    from public.profiles p
   where p.id = new.requester_id;
  return new;
end;
$$;

create trigger trg_event_setup_set_requester
  before insert on public.event_setup_requests
  for each row execute function public.event_setup_set_requester();

alter table public.event_setup_requests enable row level security;

create policy "event setup requests read own or managed"
  on public.event_setup_requests for select to authenticated
  using (requester_id = auth.uid() or public.can_manage_event_setup());

create policy "event setup requests insert own"
  on public.event_setup_requests for insert to authenticated
  with check (requester_id = auth.uid() and status = 'pending');

create policy "event setup requests update managed"
  on public.event_setup_requests for update to authenticated
  using (public.can_manage_event_setup())
  with check (public.can_manage_event_setup());

grant select, insert, update on public.event_setup_requests to authenticated;

notify pgrst, 'reload schema';
