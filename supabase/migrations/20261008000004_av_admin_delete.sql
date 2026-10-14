drop policy if exists "av requests delete admin" on public.av_requests;
create policy "av requests delete admin"
  on public.av_requests for delete to authenticated
  using (public.current_role() in ('av_admin','admin'));
grant delete on public.av_requests to authenticated;
notify pgrst,'reload schema';