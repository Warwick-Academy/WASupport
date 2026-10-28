create or replace function public.assignable_staff()
returns table (
  id uuid,
  full_name text,
  email text,
  role public.user_role,
  department public.department
)
language sql
stable
security definer
set search_path = public
set row_security = off
as $$
  select p.id, p.full_name, p.email, p.role, p.department
  from public.profiles p
  where public.is_staff()
    and p.role in ('it_tech', 'fac_tech', 'av_admin', 'hs_officer', 'manager', 'admin')
  order by p.full_name nulls last, p.email;
$$;

revoke all on function public.assignable_staff() from public, anon;
grant execute on function public.assignable_staff() to authenticated;
