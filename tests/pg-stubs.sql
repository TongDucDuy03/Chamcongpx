-- Giả lập môi trường Supabase cho test cục bộ trên PostgreSQL trống: role anon/authenticated, pg_net, pg_cron.
-- Chạy TRƯỚC supabase_setup.sql trên một database mới (dropdb/createdb mỗi lần):
--   psql -d <db> -f tests/pg-stubs.sql -f supabase_setup.sql -f telegram_nhac_cham_cong.sql -f tests/<file>.sql
--
--  net.http_post     : không gọi mạng, chỉ ghi vào net.calls (id = mã yêu cầu trả về).
--  net._http_response: bảng trống; test tự chèn phản hồi giả (id = net.calls.id) để mô phỏng Telegram trả lời.
--  cron.schedule     : ghi vào cron.job (ghi đè nếu trùng tên, giống pg_cron thật).

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
end $$;

create schema if not exists net;
create table if not exists net.calls (id bigserial primary key, url text, body jsonb, headers jsonb, timeout int);
create table if not exists net._http_response (id bigint, status_code int, content_type text, headers jsonb, content text, timed_out boolean, error_msg text, created timestamptz default now());
create or replace function net.http_post(url text, body jsonb default '{}', params jsonb default '{}', headers jsonb default '{"Content-Type": "application/json"}', timeout_milliseconds int default 5000)
returns bigint language sql as $$ insert into net.calls (url, body, headers, timeout) values (url, body, headers, timeout_milliseconds) returning id $$;

create schema if not exists cron;
create table if not exists cron.job (jobid bigserial primary key, jobname text unique, schedule text, command text);
create or replace function cron.schedule(job_name text, schedule text, command text) returns bigint language sql as $$
  insert into cron.job (jobname, schedule, command) values (job_name, schedule, command)
  on conflict (jobname) do update set schedule = excluded.schedule, command = excluded.command returning jobid $$;
create or replace function cron.unschedule(job_name text) returns boolean language plpgsql as $$
begin delete from cron.job where jobname = job_name; if not found then raise exception 'could not find valid entry for job %', job_name; end if; return true; end $$;
