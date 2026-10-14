drop policy if exists "attachments read" on public.attachments;
create policy "attachments read"
  on public.attachments for select
  using (
    exists (
      select 1
      from public.tickets t
      where t.id = attachments.ticket_id
        and (t.submitter_id = auth.uid() or public.is_staff())
    )
    and (
      attachments.message_id is null
      or exists (
        select 1
        from public.ticket_messages m
        where m.id = attachments.message_id
          and (m.is_internal = false or public.is_staff())
      )
    )
  );

drop policy if exists "attachments storage read" on storage.objects;
create policy "attachments storage read"
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'attachments'
    and exists (
      select 1
      from public.attachments a
      where a.storage_path = storage.objects.name
    )
  );
