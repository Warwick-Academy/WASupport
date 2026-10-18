drop policy if exists "categories read by manager department" on public.categories;
create policy "categories read all authenticated"
  on public.categories for select
  to authenticated
  using (true);
