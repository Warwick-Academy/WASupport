insert into public.categories (department, parent_id, name)
select department, id, 'Other'
from public.categories
where parent_id is null
  and (department, name) in (
    ('IT'::public.department, 'IT'),
    ('FAC'::public.department, 'Facilities'),
    ('HS'::public.department, 'Health and Safety')
  )
on conflict (department, parent_id, name) do update set is_active = true;

create or replace function public.can_edit_ticket_category()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(public.current_role() in (
    'admin', 'manager', 'it_tech', 'fac_tech', 'hs_officer', 'av_admin'
  ), false);
$$;
revoke all on function public.can_edit_ticket_category() from public, anon;
grant execute on function public.can_edit_ticket_category() to authenticated;

create or replace function public.create_ticket_category(p_parent_id uuid, p_name text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_parent public.categories%rowtype;
  v_name text := btrim(regexp_replace(p_name, '[[:space:]]+', ' ', 'g'));
  v_id uuid;
begin
  if not public.can_edit_ticket_category() then
    raise exception 'Only department members, managers, and administrators can add categories';
  end if;
  if v_name is null or length(v_name) = 0 or length(v_name) > 200 then
    raise exception 'Enter a category name between 1 and 200 characters';
  end if;
  select * into v_parent from public.categories
  where id = p_parent_id and parent_id is null and is_active and department <> 'AV';
  if not found then raise exception 'Select a valid department category'; end if;

  perform pg_advisory_xact_lock(hashtextextended(p_parent_id::text || lower(v_name), 0));
  select id into v_id from public.categories
  where parent_id = p_parent_id
    and lower(regexp_replace(btrim(name), '[[:space:]]+', ' ', 'g')) = lower(v_name)
  order by is_active desc, id limit 1;
  if v_id is null then
    insert into public.categories (department, parent_id, name)
    values (v_parent.department, p_parent_id, v_name) returning id into v_id;
  else
    update public.categories set is_active = true where id = v_id;
  end if;
  return v_id;
end;
$$;
revoke all on function public.create_ticket_category(uuid, text) from public, anon;
grant execute on function public.create_ticket_category(uuid, text) to authenticated;

create or replace function public.set_ticket_category(
  p_ticket_id uuid,
  p_category_id uuid default null,
  p_other_name text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ticket public.tickets%rowtype;
  v_category public.categories%rowtype;
  v_root uuid;
  v_category_id uuid := p_category_id;
begin
  if not public.can_edit_ticket_category() then
    raise exception 'Only department members, managers, and administrators can change categories';
  end if;
  select * into v_ticket from public.tickets where id = p_ticket_id and department <> 'AV' for update;
  if not found then raise exception 'Ticket not found'; end if;
  if p_other_name is not null then
    if p_category_id is not null then raise exception 'Select a category or enter a new name, not both'; end if;
    select id into v_root from public.categories
    where department = v_ticket.department and parent_id is null and is_active
      and name = case v_ticket.department
        when 'IT' then 'IT' when 'FAC' then 'Facilities' when 'HS' then 'Health and Safety' end
    order by id limit 1;
    v_category_id := public.create_ticket_category(v_root, p_other_name);
  end if;
  select * into v_category from public.categories
  where id = v_category_id and department = v_ticket.department and parent_id is not null
    and (is_active or id = v_ticket.subcategory_id or id = v_ticket.category_id);
  if not found then raise exception 'Select a valid category for this ticket department'; end if;
  update public.tickets
  set category_id = v_category.parent_id, subcategory_id = v_category.id, legacy_subcategory = null
  where id = p_ticket_id;
end;
$$;
revoke all on function public.set_ticket_category(uuid, uuid, text) from public, anon;
grant execute on function public.set_ticket_category(uuid, uuid, text) to authenticated;

create or replace function public.enforce_ticket_category()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_changed boolean;
  v_required boolean;
begin
  if new.department = 'AV'
    or current_setting('app.spiceworks_assignment_import', true) = 'on' then return new; end if;
  if tg_op = 'INSERT' then
    -- Imports and tickets created by request triggers keep their existing workflows.
    v_required := auth.uid() is not null and new.imported_from is null and pg_trigger_depth() = 1;
    v_changed := true;
  else
    v_required := new.status in ('resolved', 'closed') and new.status is distinct from old.status;
    v_changed := (new.category_id, new.subcategory_id, new.legacy_subcategory)
      is distinct from (old.category_id, old.subcategory_id, old.legacy_subcategory);
    if v_changed and auth.uid() is not null and not public.can_edit_ticket_category() then
      raise exception 'Only department members, managers, and administrators can change categories';
    end if;
  end if;
  if v_changed and new.subcategory_id is not null and not exists (
    select 1 from public.categories c
    where c.id = new.subcategory_id and c.department = new.department and c.parent_id = new.category_id
  ) then raise exception 'Select a valid category for this ticket department'; end if;
  if v_changed and tg_op = 'INSERT' and auth.uid() is not null
    and new.imported_from is null and pg_trigger_depth() = 1
    and nullif(btrim(new.legacy_subcategory), '') is not null
    and not public.can_edit_ticket_category()
  then raise exception 'Select a category from the dropdown'; end if;
  if v_required and new.subcategory_id is null
    and nullif(btrim(new.legacy_subcategory), '') is null
    and not exists (
      select 1 from public.categories c
      where c.id = new.category_id and c.department = new.department and c.parent_id is not null
    )
  then
    raise exception 'Select and save a category before submitting, resolving, or closing this ticket';
  end if;
  return new;
end;
$$;
revoke all on function public.enforce_ticket_category() from public, anon, authenticated;
drop trigger if exists trg_enforce_ticket_category on public.tickets;
create trigger trg_enforce_ticket_category
  before insert or update on public.tickets
  for each row execute function public.enforce_ticket_category();

notify pgrst, 'reload schema';
