create or replace function public.can_manage_department(p_department department)
returns boolean
language plpgsql
stable
security definer
set search_path = public
set row_security = off
as $$
declare
  v_role user_role;
  v_department department;
begin
  select role, department
    into v_role, v_department
    from public.profiles
   where id = auth.uid();

  return coalesce(
    p_department <> 'AV'
    and (
      v_role = 'admin'
      or (v_role = 'manager' and v_department = p_department)
    ),
    false
  );
end;
$$;
revoke all on function public.can_manage_department(department) from public, anon;
grant execute on function public.can_manage_department(department) to authenticated, service_role;
