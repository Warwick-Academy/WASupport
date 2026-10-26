do $$
declare
  closed_count bigint;
begin
  update public.tickets
     set status = 'closed',
         closed_at = coalesce(closed_at, now()),
         resolved_at = coalesce(resolved_at, closed_at, now())
   where department = 'FAC'
     and status = 'awaiting_triage';

  get diagnostics closed_count = row_count;
  raise notice 'Closed % Facilities tickets previously marked Needs review', closed_count;

  if exists (
    select 1
      from public.tickets
     where department = 'FAC'
       and status = 'awaiting_triage'
  ) then
    raise exception 'Facilities Needs review cleanup did not complete';
  end if;
end;
$$;
