do $$
begin
  if exists (
    select 1
      from public.categories c
     where c.parent_id is null
       and (
         (c.department = 'IT' and regexp_replace(lower(btrim(c.name)), '[[:space:]]+', ' ', 'g') in ('facilities', 'health and safety'))
         or (c.department = 'FAC' and regexp_replace(lower(btrim(c.name)), '[[:space:]]+', ' ', 'g') in ('it', 'health and safety'))
         or (c.department = 'HS' and regexp_replace(lower(btrim(c.name)), '[[:space:]]+', ' ', 'g') in ('it', 'facilities'))
       )
       and (
         exists (select 1 from public.tickets t where t.category_id = c.id or t.subcategory_id = c.id)
         or exists (select 1 from public.categories child where child.parent_id = c.id)
       )
  ) then
    raise exception 'Cross-department categories have ticket references or children; review before cleanup.';
  end if;
end $$;

delete from public.categories c
 where c.parent_id is null
   and (
     (c.department = 'IT' and regexp_replace(lower(btrim(c.name)), '[[:space:]]+', ' ', 'g') in ('facilities', 'health and safety'))
     or (c.department = 'FAC' and regexp_replace(lower(btrim(c.name)), '[[:space:]]+', ' ', 'g') in ('it', 'health and safety'))
     or (c.department = 'HS' and regexp_replace(lower(btrim(c.name)), '[[:space:]]+', ' ', 'g') in ('it', 'facilities'))
   );