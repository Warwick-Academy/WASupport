-- Clear the shared location catalogue now that Help Desk tickets use free-text
-- building and room fields. Preserve legacy ticket locations before the
-- location_id ON DELETE SET NULL foreign key clears their catalogue links.
update public.tickets as ticket
set
  building = coalesce(ticket.building, location.building),
  room = coalesce(ticket.room, location.room)
from public.locations as location
where ticket.location_id = location.id
  and (ticket.building is null or ticket.room is null);

delete from public.locations;
