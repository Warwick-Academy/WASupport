-- =====================================================================
-- Department routing
-- =====================================================================
-- - Department staff (IT / Facilities / AV / H&S) vs submitters:
--     tech roles imply their department (it_tech→IT, fac_tech→FAC,
--     av_admin→AV, hs_officer→HS); submitters have no department;
--     role 'manager' + department = that department's manager
--     (manager with no department = all-department manager).
-- - Only admins may change role/department (closes self-promotion via
--   the "profiles update own" policy).
-- - categories.default_assignee_id: owner for a category/subcategory.
-- - New tickets are auto-assigned: subcategory owner → category owner.
--   If neither resolves, the ticket stays unassigned and send-email
--   routes it to the department manager(s).
-- - AV tickets: ref sequence, RLS for av_admin, seed taxonomy.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. AV ticket refs
-- ---------------------------------------------------------------------
create sequence if not exists public.ticket_seq_av start 1;

create or replace function public.set_ticket_ref()
returns trigger
language plpgsql
as $$
declare
  prefix text;
  seq    text;
  n      bigint;
  candidate text;
  i int := 0;
begin
  if new.ref is not null and new.ref <> '' then
    return new;
  end if;

  case new.department
    when 'IT'  then prefix := 'IT-';  seq := 'public.ticket_seq_it';
    when 'FAC' then prefix := 'FAC-'; seq := 'public.ticket_seq_fac';
    when 'HS'  then prefix := 'HS-';  seq := 'public.ticket_seq_hs';
    when 'AV'  then prefix := 'AV-';  seq := 'public.ticket_seq_av';
  end case;

  loop
    n := nextval(seq);
    candidate := prefix || case when n < 10000 then lpad(n::text, 4, '0') else n::text end;
    if not exists (select 1 from public.tickets where ref = candidate) then
      new.ref := candidate;
      exit;
    end if;
    i := i + 1;
    if i > 100000 then
      raise exception 'ticket ref generation exhausted for department %', new.department;
    end if;
  end loop;

  return new;
end;
$$;

-- ---------------------------------------------------------------------
-- 2. Role ↔ department
-- ---------------------------------------------------------------------
create or replace function public.role_department(r user_role)
returns department
language sql
immutable
as $$
  select case r
    when 'it_tech'    then 'IT'::department
    when 'fac_tech'   then 'FAC'::department
    when 'hs_officer' then 'HS'::department
    when 'av_admin'   then 'AV'::department
  end;
$$;

create or replace function public.is_staff()
returns boolean
language sql
stable
as $$
  select coalesce(public.current_role() in
    ('it_tech','fac_tech','hs_officer','av_admin','support','manager','admin','leadership'), false);
$$;

create or replace function public.profiles_enforce_role_department()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'UPDATE'
     and (new.role is distinct from old.role or new.department is distinct from old.department)
     and auth.uid() is not null
     and not public.is_admin()
  then
    raise exception 'only administrators can change role or department';
  end if;

  if new.role = 'submitter' then
    new.department := null;
  elsif public.role_department(new.role) is not null then
    new.department := public.role_department(new.role);
  end if;

  return new;
end;
$$;

drop trigger if exists trg_profiles_role_department on public.profiles;
create trigger trg_profiles_role_department
  before insert or update on public.profiles
  for each row execute function public.profiles_enforce_role_department();

-- Backfill: the trigger normalises department on any touch.
update public.profiles
   set department = public.role_department(role)
 where public.role_department(role) is not null
   and department is distinct from public.role_department(role);

update public.profiles
   set department = null
 where role = 'submitter'
   and department is not null;

-- ---------------------------------------------------------------------
-- 3. Category owners + auto-assignment
-- ---------------------------------------------------------------------
alter table public.categories
  add column if not exists default_assignee_id uuid references public.profiles(id) on delete set null;

create index if not exists categories_default_assignee_idx
  on public.categories (default_assignee_id);

create or replace function public.can_work_department(p_user uuid, p_dept department)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_role user_role;
  v_dept department;
begin
  select role, department into v_role, v_dept from public.profiles where id = p_user;
  return coalesce(
    v_role = 'admin'
    or (v_role = 'manager' and (v_dept is null or v_dept = p_dept))
    or public.role_department(v_role) = p_dept,
    false
  );
end;
$$;

create or replace function public.tickets_auto_assign()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_candidate uuid;
begin
  if new.imported_from is not null then
    return new;
  end if;

  -- Submitters may not pick their own assignee.
  if auth.uid() is not null and not public.is_staff() then
    new.assignee_id := null;
  end if;

  if new.assignee_id is not null then
    return new;
  end if;

  if new.subcategory_id is not null then
    select default_assignee_id into v_candidate
      from public.categories where id = new.subcategory_id;
    if v_candidate is not null and public.can_work_department(v_candidate, new.department) then
      new.assignee_id := v_candidate;
      return new;
    end if;
  end if;

  if new.category_id is not null then
    select default_assignee_id into v_candidate
      from public.categories where id = new.category_id;
    if v_candidate is not null and public.can_work_department(v_candidate, new.department) then
      new.assignee_id := v_candidate;
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_tickets_auto_assign on public.tickets;
create trigger trg_tickets_auto_assign
  before insert on public.tickets
  for each row execute function public.tickets_auto_assign();

-- ---------------------------------------------------------------------
-- 4. RLS: department staff scoped via role_department (adds AV)
-- ---------------------------------------------------------------------
drop policy if exists "tickets staff read" on public.tickets;
create policy "tickets staff read"
  on public.tickets for select
  using (
    public.is_admin()
    or public.current_role() = 'leadership'
    or public.is_manager()
    or public.is_support()
    or public.role_department(public.current_role()) = department
  );

drop policy if exists "tickets dept tech update" on public.tickets;
create policy "tickets dept tech update"
  on public.tickets for update
  using (public.role_department(public.current_role()) = department)
  with check (public.role_department(public.current_role()) = department);

drop policy if exists "ticket_messages read" on public.ticket_messages;
create policy "ticket_messages read"
  on public.ticket_messages for select
  using (
    exists (
      select 1 from public.tickets t
      where t.id = ticket_messages.ticket_id
        and (
          public.is_admin()
          or public.current_role() in ('leadership', 'manager')
          or public.role_department(public.current_role()) = t.department
          or (t.submitter_id = auth.uid() and ticket_messages.is_internal = false)
        )
    )
  );

-- ---------------------------------------------------------------------
-- 5. Notification log events used by send-email / sla-reminders
-- ---------------------------------------------------------------------
alter table public.notifications_log drop constraint if exists notifications_log_event_check;
alter table public.notifications_log
  add constraint notifications_log_event_check check (event in (
    'ticket.created',
    'ticket.assigned',
    'ticket.routed_to_manager',
    'ticket.reply',
    'ticket.status_changed',
    'sla.approaching',
    'sla.overdue'
  ));

-- ---------------------------------------------------------------------
-- 6. AV taxonomy seed
-- ---------------------------------------------------------------------
do $$
declare
  av_parent uuid;
begin
  select id into av_parent from public.categories
   where department = 'AV' and parent_id is null and name = 'Audio Visual' limit 1;
  if av_parent is null then
    insert into public.categories (department, name)
    values ('AV', 'Audio Visual')
    returning id into av_parent;
  end if;

  insert into public.categories (department, parent_id, name)
  select 'AV', av_parent, v.name
    from (values
      ('Projector / Display'),
      ('Sound system / Microphone'),
      ('Video conferencing / Teams Room'),
      ('Event / Assembly support'),
      ('Recording / Live stream'),
      ('Other AV')
    ) as v(name)
   where not exists (
     select 1 from public.categories c
      where c.department = 'AV' and c.parent_id = av_parent and c.name = v.name
   );
end$$;

notify pgrst, 'reload schema';
