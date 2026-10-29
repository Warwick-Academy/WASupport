drop policy if exists "tickets submitter update own open" on public.tickets;
create policy "tickets submitter update own open"
  on public.tickets for update to authenticated
  using (
    department <> 'AV'
    and submitter_id = auth.uid()
    and status not in ('resolved', 'closed')
  )
  with check (
    department <> 'AV'
    and submitter_id = auth.uid()
    and status not in ('resolved', 'closed')
  );
create or replace function public.restrict_submitter_ticket_edits()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if public.current_role() = 'submitter'
    and old.submitter_id = auth.uid()
  then
    if old.status in ('resolved', 'closed') then
      raise exception 'Only open tickets can be edited';
    end if;

    if (to_jsonb(new) - array['subject', 'description', 'updated_at'])
      is distinct from
       (to_jsonb(old) - array['subject', 'description', 'updated_at'])
    then
      raise exception 'Submitters may only edit the subject and description';
    end if;
  end if;

  return new;
end;
$$;
revoke all on function public.restrict_submitter_ticket_edits() from public, anon, authenticated;
drop trigger if exists trg_restrict_submitter_ticket_edits on public.tickets;
create trigger trg_restrict_submitter_ticket_edits
  before update on public.tickets
  for each row execute function public.restrict_submitter_ticket_edits();
notify pgrst, 'reload schema';
