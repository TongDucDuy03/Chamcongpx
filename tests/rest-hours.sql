-- Run ONLY in an isolated test database after supabase_setup.sql.
\set ON_ERROR_STOP on
begin;
insert into ot.employees(name, username, password_hash, role)
values ('Rest Test Worker', 'rest_test_worker', extensions.crypt('test-only-password', extensions.gen_salt('bf')), 'worker'),
       ('Rest Test Other', 'rest_test_other', extensions.crypt('test-only-password', extensions.gen_salt('bf')), 'worker');
select public.app_login('rest_test_worker', 'test-only-password')->>'token' as worker_token \gset
select set_config('test.worker_token', :'worker_token', true) as ignored \gset

create function pg_temp.save_shift(p_id text, p_date text, p_hours jsonb, p_name text default 'Rest Test Worker') returns void
language plpgsql as $$ begin
  perform public.app_push(current_setting('test.worker_token'), jsonb_build_object('recordsUpsert', jsonb_build_array(
    jsonb_build_object('id', p_id, 'employeeName', p_name, 'jobContent', 'Test work',
      'startTime', p_date || ' 07:15', 'endTime', p_date || ' 17:15', 'workDate', p_date,
      'overrideHours', p_hours, 'modifiedAfterLock', false)
  )));
end $$;

do $$
declare bad jsonb; rejected boolean; payload jsonb;
begin
  perform pg_temp.save_shift('TEST_REST', '18/10/2020', '8');
  assert (select override_hours = 8 from ot.records where id = 'TEST_REST'), 'Worker insert 8h failed';
  perform pg_temp.save_shift('TEST_REST', '18/10/2020', '10');
  assert (select override_hours = 10 from ot.records where id = 'TEST_REST'), 'Worker edit to 10h failed';
  perform pg_temp.save_shift('TEST_REST', '18/10/2020', '8.5');
  assert (select override_hours = 8.5 from ot.records where id = 'TEST_REST'), 'Fractional hours failed';
  payload := public.app_pull(current_setting('test.worker_token'), '2020-10-18', '2020-10-19');
  assert payload ->> 'supportsRestHours' = 'true', 'Missing capability flag';
  perform pg_temp.save_shift('TEST_REST', '18/10/2020', 'null');
  assert (select override_hours is null from ot.records where id = 'TEST_REST'), 'Clear override failed';
  foreach bad in array array['0'::jsonb, '-1'::jsonb, '11'::jsonb, '8.123'::jsonb, '"NaN"'::jsonb] loop
    rejected := false;
    begin
      perform pg_temp.save_shift('TEST_REST', '18/10/2020', bad);
    exception when sqlstate 'P0001' then rejected := true;
    end;
    assert rejected, 'Invalid hours accepted: ' || bad::text;
    assert (select override_hours is null from ot.records where id = 'TEST_REST'), 'Rejected update changed data';
  end loop;

  insert into ot.holidays(work_date,name) values ('2020-10-20','Test holiday');
  perform pg_temp.save_shift('TEST_HOLIDAY', '20/10/2020', '8');
  assert (select override_hours = 8 from ot.records where id = 'TEST_HOLIDAY'), 'Holiday hours failed';

  perform pg_temp.save_shift('TEST_WEEKDAY', '19/10/2020', '8');
  assert (select override_hours is null from ot.records where id = 'TEST_WEEKDAY'), 'Worker changed weekday override';
  update ot.records set override_hours = 6 where id = 'TEST_WEEKDAY';
  perform pg_temp.save_shift('TEST_WEEKDAY', '19/10/2020', '9');
  assert (select override_hours = 6 from ot.records where id = 'TEST_WEEKDAY'), 'Worker overwrote admin weekday hours';
  rejected := false;
  begin
    perform pg_temp.save_shift('TEST_OTHER', '18/10/2020', '8', 'Rest Test Other');
  exception when sqlstate 'P0001' then rejected := true;
  end;
  assert rejected, 'Worker could edit another employee';
  raise notice 'PASS: insert, update, fractional, clear, invalid values, holiday, weekday permissions, ownership and capability';
end $$;
rollback;
