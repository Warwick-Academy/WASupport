create or replace function public.ticket_submitter_exists(p_profile_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
set row_security = off
as $$
  select exists (
    select 1
    from public.profiles viewer
    join public.profiles target on target.id = p_profile_id
    where viewer.id = auth.uid()
      and viewer.role in ('admin', 'manager', 'it_tech', 'fac_tech', 'hs_officer', 'av_admin')
      and (
        target.id = viewer.id
        or target.role = 'submitter'
        or (
          target.role in ('manager', 'admin')
          and (
            viewer.role = 'admin'
            or (
              viewer.department is not null
              and viewer.department = coalesce(target.manager_department, target.department)
            )
          )
        )
      )
  );
$$;

create or replace function public.ticket_submitter_directory()
returns table (id uuid, label text)
language plpgsql
stable
security definer
set search_path = ''
set row_security = off
as $$
begin
  if not exists (
    select 1 from public.profiles
    where profiles.id = auth.uid()
      and profiles.role in ('admin', 'manager', 'it_tech', 'fac_tech', 'hs_officer', 'av_admin')
  ) then
    raise exception 'Only department staff and administrators can view the submitter directory';
  end if;

  return query
    select p.id, coalesce(nullif(btrim(p.full_name), ''), p.email) || ' (' || p.email || ')'
    from public.profiles p
    where public.ticket_submitter_exists(p.id)
    order by p.full_name nulls last, p.email;
end;
$$;

drop policy if exists "tickets submitter insert" on public.tickets;
create policy "tickets submitter insert"
  on public.tickets for insert
  with check (
    department <> 'AV'
    and (
      submitter_id = auth.uid()
      or (
        (
          public.can_manage_department(department)
          or public.role_department(public.current_role()) = department
        )
        and public.ticket_submitter_exists(submitter_id)
      )
    )
  );

notify pgrst, 'reload schema';
