-- Allow requesters to edit current/future AV requests and AV admins to manage all requests.

drop policy if exists "av requests update own future" on public.av_requests;
create policy "av requests update own future"
  on public.av_requests for update to authenticated
  using (requester_id = auth.uid() and requested_date >= current_date)
  with check (requester_id = auth.uid() and requested_date >= current_date);

drop policy if exists "av requests update admin" on public.av_requests;
create policy "av requests update admin"
  on public.av_requests for update to authenticated
  using (public.current_role() in ('av_admin', 'admin'))
  with check (public.current_role() in ('av_admin', 'admin'));

drop policy if exists "av requests delete admin" on public.av_requests;
create policy "av requests delete admin"
  on public.av_requests for delete to authenticated
  using (public.current_role() in ('av_admin', 'admin'));

grant update, delete on public.av_requests to authenticated;
notify pgrst, 'reload schema';
