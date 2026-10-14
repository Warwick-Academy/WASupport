do $$
declare
  v_department public.department;
  v_root_name text;
  v_root_id uuid;
  v_category record;
  v_child record;
  v_existing_child_id uuid;
begin
  update public.categories
     set is_active = false
   where regexp_replace(replace(lower(btrim(name)), '&', 'and'), '[[:space:]]+', ' ', 'g')
         in ('it coordinator', 'web design');

  for v_department, v_root_name in
    select * from (values
      ('IT'::public.department, 'IT'),
      ('FAC'::public.department, 'Facilities'),
      ('HS'::public.department, 'Health and Safety')
    ) as roots(department, root_name)
  loop
    select id into v_root_id
      from public.categories
     where department = v_department
       and parent_id is null
       and regexp_replace(replace(lower(btrim(name)), '&', 'and'), '[[:space:]]+', ' ', 'g')
           = lower(v_root_name)
     limit 1;

    if v_root_id is null then
      insert into public.categories (department, name, parent_id, is_active)
      values (v_department, v_root_name, null, true)
      returning id into v_root_id;
    else
      update public.categories
         set name = v_root_name,
             is_active = true
       where id = v_root_id;
    end if;

    for v_category in
      select id, name
        from public.categories
       where department = v_department
         and parent_id is null
         and id <> v_root_id
    loop
      for v_child in
        select id, name
          from public.categories
         where parent_id = v_category.id
      loop
        select id into v_existing_child_id
          from public.categories
         where department = v_department
           and parent_id = v_root_id
           and name = v_child.name
         limit 1;

        if v_existing_child_id is null then
          update public.categories
             set parent_id = v_root_id
           where id = v_child.id;
        else
          update public.tickets
             set category_id = v_existing_child_id
           where category_id = v_child.id;
          update public.tickets
             set subcategory_id = v_existing_child_id
           where subcategory_id = v_child.id;
          delete from public.categories where id = v_child.id;
        end if;
      end loop;

      select id into v_existing_child_id
        from public.categories
       where department = v_department
         and parent_id = v_root_id
         and name = v_category.name
       limit 1;

      if v_existing_child_id is null then
        update public.categories
           set parent_id = v_root_id
         where id = v_category.id;
      else
        update public.tickets
           set category_id = v_existing_child_id
         where category_id = v_category.id;
        update public.tickets
           set subcategory_id = v_existing_child_id
         where subcategory_id = v_category.id;
        delete from public.categories where id = v_category.id;
      end if;
    end loop;

    v_root_id := null;
  end loop;
end $$;

notify pgrst, 'reload schema';