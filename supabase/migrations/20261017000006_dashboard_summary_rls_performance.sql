alter function public.dashboard_summary(date, date) security definer;
alter function public.dashboard_summary(date, date) set row_security = off;
revoke all on function public.dashboard_summary(date, date) from public, anon;
grant execute on function public.dashboard_summary(date, date) to authenticated;
