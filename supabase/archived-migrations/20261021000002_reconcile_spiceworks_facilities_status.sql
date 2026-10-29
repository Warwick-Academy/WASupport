do $$
declare
  keep_open_refs text[] := array[
    '20174', '20169', '20164', '20114', '20101', '20098', '20085', '20051',
    '20043', '20027', '20011', '20005', '19985', '19957', '19954', '19909',
    '19906', '19893', '19880', '19879', '19878', '19872', '19869', '19868',
    '19867', '19845', '19821', '19799', '19798', '19796', '19795', '19693',
    '19667', '19659', '19630', '19586', '19567', '19497', '19465', '19394',
    '19254', '19211', '19019', '18895', '18824', '18805', '18263', '18052',
    '17914'
  ];
  missing_refs text[];
  open_count bigint;
begin
  select array_agg(ref order by ref)
    into missing_refs
    from unnest(keep_open_refs) as expected(ref)
   where not exists (
     select 1
       from public.tickets t
      where t.department = 'FAC'
        and t.imported_from = 'spiceworks'
        and t.legacy_ref = expected.ref
   );

  if missing_refs is not null then
    raise exception 'Cannot reconcile Facilities tickets; missing SpiceWorks references: %',
      array_to_string(missing_refs, ', ');
  end if;

  update public.tickets t
     set status = case
           when t.legacy_ref = any(keep_open_refs) then 'open'::public.ticket_status
           else 'closed'::public.ticket_status
         end,
         closed_at = case
           when t.legacy_ref = any(keep_open_refs) then null
           else coalesce(t.closed_at, t.resolved_at, now())
         end,
         resolved_at = case
           when t.legacy_ref = any(keep_open_refs) then null
           else coalesce(t.resolved_at, t.closed_at, now())
         end
   where t.department = 'FAC'
     and t.imported_from = 'spiceworks';

  select count(*)
    into open_count
    from public.tickets t
   where t.department = 'FAC'
     and t.imported_from = 'spiceworks'
     and t.status not in ('resolved', 'closed');

  if open_count <> cardinality(keep_open_refs) then
    raise exception 'Facilities status reconciliation expected % open SpiceWorks tickets; found %',
      cardinality(keep_open_refs), open_count;
  end if;
end;
$$;
