-- Allow staff to resolve submitter names for tickets already visible to them.
-- Ticket row-level security continues to limit which submitter profiles are visible.
create policy "profiles read visible ticket submitters"
  on public.profiles for select
  using (
    exists (
      select 1
      from public.tickets t
      where t.submitter_id = profiles.id
    )
  );
