create policy "ticket_messages admin delete"
  on public.ticket_messages for delete
  using (public.is_admin());
