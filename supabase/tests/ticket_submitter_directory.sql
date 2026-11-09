-- Run only against a disposable local Supabase database after applying migrations.
begin;

insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-000000000101', 'picker-it@example.test'),
  ('00000000-0000-4000-8000-000000000102', 'picker-fac@example.test'),
  ('00000000-0000-4000-8000-000000000103', 'picker-it-manager@example.test'),
  ('00000000-0000-4000-8000-000000000104', 'picker-fac-manager@example.test'),
  ('00000000-0000-4000-8000-000000000105', 'picker-it-admin@example.test'),
  ('00000000-0000-4000-8000-000000000106', 'picker-admin@example.test'),
  ('00000000-0000-4000-8000-000000000107', 'picker-submitter@example.test'),
  ('00000000-0000-4000-8000-000000000108', 'picker-av@example.test');

update public.profiles set role = 'it_tech' where id = '00000000-0000-4000-8000-000000000101';
update public.profiles set role = 'fac_tech' where id = '00000000-0000-4000-8000-000000000102';
update public.profiles set role = 'manager', department = 'IT' where id = '00000000-0000-4000-8000-000000000103';
update public.profiles set role = 'manager', department = 'FAC' where id = '00000000-0000-4000-8000-000000000104';
update public.profiles set role = 'admin', manager_department = 'IT' where id = '00000000-0000-4000-8000-000000000105';
update public.profiles set role = 'admin' where id = '00000000-0000-4000-8000-000000000106';
update public.profiles set role = 'av_admin' where id = '00000000-0000-4000-8000-000000000108';

set local role authenticated;
select set_config('app.spiceworks_assignment_import', 'on', true);
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000101', true);

do $$
declare
  target uuid;
  expected boolean;
  actual boolean;
begin
  for target, expected in
    select * from (values
      ('00000000-0000-4000-8000-000000000101'::uuid, true),
      ('00000000-0000-4000-8000-000000000102'::uuid, false),
      ('00000000-0000-4000-8000-000000000103'::uuid, true),
      ('00000000-0000-4000-8000-000000000104'::uuid, false),
      ('00000000-0000-4000-8000-000000000105'::uuid, true),
      ('00000000-0000-4000-8000-000000000106'::uuid, false),
      ('00000000-0000-4000-8000-000000000107'::uuid, true)
    ) cases(id, visible)
  loop
    select exists(select 1 from public.ticket_submitter_directory() d where d.id = target) into actual;
    if actual is distinct from expected or public.ticket_submitter_exists(target) is distinct from expected then
      raise exception 'IT staff visibility mismatch for %', target;
    end if;
  end loop;

  insert into public.tickets (ref, department, subject, description, submitter_id)
    values ('picker-own', 'IT', 'Test', 'Test', '00000000-0000-4000-8000-000000000101');
  insert into public.tickets (ref, department, subject, description, submitter_id)
    values ('picker-manager', 'IT', 'Test', 'Test', '00000000-0000-4000-8000-000000000103');
  begin
    insert into public.tickets (ref, department, subject, description, submitter_id)
      values ('picker-hidden', 'IT', 'Test', 'Test', '00000000-0000-4000-8000-000000000104');
    raise exception 'Cross-department manager was accepted';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.tickets (ref, department, subject, description, submitter_id)
      values ('picker-cross-department', 'FAC', 'Test', 'Test', '00000000-0000-4000-8000-000000000107');
    raise exception 'Cross-department submission on behalf was accepted';
  exception when insufficient_privilege then null;
  end;
end;
$$;

select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000103', true);
do $$
begin
  if not public.ticket_submitter_exists('00000000-0000-4000-8000-000000000105')
    or public.ticket_submitter_exists('00000000-0000-4000-8000-000000000106')
    or public.ticket_submitter_exists('00000000-0000-4000-8000-000000000104')
  then raise exception 'Manager visibility mismatch'; end if;
end;
$$;

select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000106', true);
do $$
begin
  if not public.ticket_submitter_exists('00000000-0000-4000-8000-000000000104')
    or not public.ticket_submitter_exists('00000000-0000-4000-8000-000000000105')
    or not public.ticket_submitter_exists('00000000-0000-4000-8000-000000000106')
    or public.ticket_submitter_exists('00000000-0000-4000-8000-000000000101')
  then raise exception 'Administrator visibility mismatch'; end if;
  insert into public.tickets (ref, department, subject, description, submitter_id)
    values ('picker-admin-cross', 'FAC', 'Test', 'Test', '00000000-0000-4000-8000-000000000103');
end;
$$;

select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000108', true);
do $$
begin
  if not public.ticket_submitter_exists('00000000-0000-4000-8000-000000000108')
    or public.ticket_submitter_exists('00000000-0000-4000-8000-000000000103')
  then raise exception 'AV member visibility mismatch'; end if;
end;
$$;

select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000107', true);
do $$
begin
  if public.ticket_submitter_exists('00000000-0000-4000-8000-000000000103') then
    raise exception 'Submitter can probe manager profiles';
  end if;
  begin
    perform * from public.ticket_submitter_directory();
    raise exception 'Submitter can access the directory';
  exception when raise_exception then
    if sqlerrm = 'Submitter can access the directory' then raise; end if;
  end;
end;
$$;

rollback;
