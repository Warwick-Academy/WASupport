alter table public.tickets
  add column if not exists time_spent_minutes integer not null default 0
  check (time_spent_minutes >= 0);

create or replace function public.add_ticket_time(
  p_ticket_id uuid,
  p_minutes integer,
  p_close boolean default false
)
returns integer
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_total integer;
begin
  if p_minutes < 15 or p_minutes > 480 or p_minutes % 15 <> 0 then
    raise exception 'Time must be between 15 and 480 minutes in 15-minute increments';
  end if;

  update public.tickets
     set time_spent_minutes = time_spent_minutes + p_minutes,
         status = case when p_close then 'closed'::public.ticket_status else status end,
         closed_at = case when p_close then coalesce(closed_at, now()) else closed_at end
   where id = p_ticket_id
   returning time_spent_minutes into v_total;

  if not found then
    raise exception 'Ticket could not be updated';
  end if;

  return v_total;
end;
$$;

revoke all on function public.add_ticket_time(uuid, integer, boolean) from public, anon;
grant execute on function public.add_ticket_time(uuid, integer, boolean) to authenticated;