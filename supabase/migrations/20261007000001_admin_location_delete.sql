-- Managers may create and update locations, but only administrators may delete them.
drop policy if exists "locations manager write" on public.locations;

create policy "locations manager insert"
  on public.locations for insert
  with check (public.is_manager());

create policy "locations manager update"
  on public.locations for update
  using (public.is_manager())
  with check (public.is_manager());

create policy "locations admin delete"
  on public.locations for delete
  using (public.is_admin());