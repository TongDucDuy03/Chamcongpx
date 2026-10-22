-- Kiểm thử "Lịch sử sửa đổi": bảng ot.audit_log do trigger tự ghi, app_audit_list, giữ 400 ngày, phân quyền,
-- chạy lại supabase_setup.sql / telegram_nhac_cham_cong.sql không nhân đôi trigger, thời gian 1000 ca có/không trigger.
--
-- Chạy trên database MỚI (xem tests/pg-stubs.sql), từ thư mục gốc dự án (file này dùng \i nên phải đứng ở thư mục gốc):
--   createdb -h 127.0.0.1 -p 55432 -U postgres ot_audit
--   psql -X -q -h 127.0.0.1 -p 55432 -U postgres -d ot_audit -v ON_ERROR_STOP=1 \
--        -f tests/pg-stubs.sql -f supabase_setup.sql -f telegram_nhac_cham_cong.sql -f tests/audit-log.sql | grep -v '^$'
-- Dòng cuối: "N đạt, M lỗi" (trước đó có vài dòng "TIMING ...").
\set ON_ERROR_STOP 1
\pset tuples_only on
\pset format unaligned

create temp table results (n serial, name text, ok boolean, detail text);
create temp table tk (u text primary key, tok text);
create temp table timing (n serial, label text, ms numeric);
create function pg_temp.t(p_name text, p_ok boolean, p_detail text default '') returns void language sql as
$$ insert into results (name, ok, detail) values (p_name, coalesce(p_ok, false), p_detail) $$;
create function pg_temp.login(p_user text, p_pw text) returns jsonb language plpgsql as $$
declare r jsonb;
begin
  r := public.app_login(p_user, p_pw);
  if (r ->> 'ok')::boolean then
    insert into tk values (p_user, r ->> 'token') on conflict (u) do update set tok = excluded.tok;
  end if;
  return r;
end $$;
create function pg_temp.tok(p_user text) returns text language sql as $$ select tok from tk where u = p_user $$;
-- Chạy app_push, trả về '' nếu được, hoặc nội dung lỗi
create function pg_temp.push(p_user text, p_ops jsonb) returns text language plpgsql as $$
begin
  perform public.app_push(pg_temp.tok(p_user), p_ops);
  return '';
exception when others then
  return sqlerrm;
end $$;
create function pg_temp.err(p_sql text) returns text language plpgsql as $$
begin
  execute p_sql;
  return '';
exception when others then
  return sqlerrm;
end $$;
create function pg_temp.hint(p_sql text) returns text language plpgsql as $$
declare h text;
begin
  execute p_sql;
  return '';
exception when others then
  get stacked diagnostics h = pg_exception_hint;
  return coalesce(h, '?');
end $$;
create function pg_temp.anon_err(p_sql text) returns text language plpgsql as $$
begin
  set local role anon;
  begin
    execute p_sql;
    reset role;
    return '';
  exception when others then
    reset role;
    return sqlerrm;
  end;
end $$;
-- Ca tăng ca: id, tên, lệch ngày so với hôm nay, giờ vào / ra
create function pg_temp.rec(p_id text, p_name text, p_off int, p_s text, p_e text, p_extra jsonb default '{}') returns jsonb language sql as $$
  select jsonb_build_object('recordsUpsert', jsonb_build_array(jsonb_build_object(
    'id', p_id, 'employeeName', p_name, 'jobContent', 'Làm theo kế hoạch', 'modifiedAfterLock', false,
    'startTime', to_char(ot.vn_today() + p_off, 'DD/MM/YYYY') || ' ' || p_s,
    'endTime', to_char(ot.vn_today() + p_off, 'DD/MM/YYYY') || ' ' || p_e,
    'workDate', to_char(ot.vn_today() + p_off, 'DD/MM/YYYY')) || p_extra))
$$;
create function pg_temp.dmy(p_off int) returns text language sql as $$ select to_char(ot.vn_today() + p_off, 'DD/MM/YYYY') $$;
create function pg_temp.n() returns bigint language sql as $$ select count(*) from ot.audit_log $$;
create function pg_temp.last(p_action text) returns jsonb language sql as $$
  select to_jsonb(a) from ot.audit_log a where a.action = p_action order by a.id desc limit 1
$$;
create function pg_temp.nsend() returns bigint language sql as $$ select count(*) from net.calls where url like '%/sendMessage' $$;
create function pg_temp.sent(p_chat text) returns text language sql as $$
  select coalesce(string_agg(body ->> 'text', ' | ' order by id), '') from net.calls
   where url like '%/sendMessage' and body ->> 'chat_id' = p_chat
$$;
create function pg_temp.list(p_user text, p_from date default null, p_to date default null, p_emp text default null,
                             p_before bigint default null, p_limit int default 100) returns jsonb language sql as $$
  select public.app_audit_list(pg_temp.tok(p_user), p_from, p_to, p_emp, p_before, p_limit)
$$;
create function pg_temp.audit_triggers() returns text language sql as $$
  select coalesce(string_agg(tgrelid::regclass::text || '.' || tgname, ',' order by tgrelid::regclass::text, tgname), '')
    from pg_trigger where not tgisinternal and tgname like 'audit\_%'
$$;
create function pg_temp.timed_push(p_label text, p_user text, p_ops jsonb) returns text language plpgsql as $$
declare t0 timestamptz := clock_timestamp(); r text;
begin
  r := pg_temp.push(p_user, p_ops);
  insert into timing (label, ms) values (p_label, extract(epoch from clock_timestamp() - t0) * 1000);
  return r;
end $$;
-- 1000 ca của Chi: 10 ca/ngày (mỗi ca 50 phút, cách nhau 1 giờ) từ ngày p_start
create function pg_temp.bulk_ops(p_prefix text, p_start date, p_n int) returns jsonb language sql as $$
  select jsonb_build_object('recordsUpsert', jsonb_agg(jsonb_build_object(
    'id', p_prefix || x.i, 'employeeName', 'Chi', 'jobContent', 'Làm theo kế hoạch', 'modifiedAfterLock', false,
    'startTime', to_char(x.d, 'DD/MM/YYYY') || ' ' || lpad((6 + x.h)::text, 2, '0') || ':00',
    'endTime', to_char(x.d, 'DD/MM/YYYY') || ' ' || lpad((6 + x.h)::text, 2, '0') || ':50',
    'workDate', to_char(x.d, 'DD/MM/YYYY'))))
  from (select i, p_start + (i / 10) as d, i % 10 as h from generate_series(0, p_n - 1) i) x
$$;

-- ===== Khởi tạo =====
do $$ begin perform ot.bootstrap_admin('admin123'); end $$;
select pg_temp.t('SQL Editor (bootstrap_admin): ghi account_create, source sql, không có người sửa',
  l ->> 'source' = 'sql' and l ->> 'actor_id' is null and l ->> 'actor_name' is null and l ->> 'target_name' = 'Quản trị viên'
  and l -> 'after' ->> 'username' = 'admin' and l -> 'after' ->> 'role' = 'admin' and l -> 'after' ->> 'hasTimesheet' = 'false'
  and (l -> 'after') ? 'startDate' and l -> 'before' = 'null'::jsonb and l ->> 'work_date' is null, l::text)
from (select pg_temp.last('account_create') l) x;
select pg_temp.login('admin', 'admin123') \gset
select pg_temp.n() as n0 \gset
select pg_temp.push('admin', jsonb_build_object('employeesUpsert', jsonb_build_array(
  jsonb_build_object('name', 'An', 'username', 'an', 'password', '1234'),
  jsonb_build_object('name', 'Bình', 'username', 'binh', 'password', '1234'),
  jsonb_build_object('name', 'Chi', 'username', 'chi', 'password', '1234'),
  jsonb_build_object('name', 'Quản đốc 2', 'username', 'qd2', 'password', '123456', 'role', 'admin', 'hasTimesheet', false)))) as e \gset
select pg_temp.t('Khởi tạo 3 công nhân + 1 admin phụ: 4 dòng account_create (không thêm dòng nào khác)',
  :'e' = '' and pg_temp.n() = :n0 + 4 and (select count(*) from ot.audit_log where action = 'account_create' and source = 'web') = 4, :'e');
select pg_temp.t('account_create qua web: ghi đúng người sửa (Quản trị viên, admin) và JSON sau',
  l ->> 'actor_name' = 'Quản trị viên' and l ->> 'actor_role' = 'admin' and l ->> 'source' = 'web'
  and l -> 'after' ->> 'username' = 'qd2' and l -> 'after' ->> 'role' = 'admin' and l -> 'after' ->> 'hasTimesheet' = 'false',
  l::text)
from (select pg_temp.last('account_create') l) x;
select pg_temp.login('an', '1234') \gset
select pg_temp.login('binh', '1234') \gset
select pg_temp.login('chi', '1234') \gset
select pg_temp.login('qd2', '123456') \gset
select pg_temp.t('Không đâu có mật khẩu / băm mật khẩu trong nhật ký',
  not exists (select 1 from ot.audit_log a where a::text ~* '(\$2[aby]\$|password|1234|admin123|crypt)'), (select a::text from ot.audit_log a limit 1));

-- ===== Đăng nhập, bump rev, tg_* : KHÔNG ghi =====
select pg_temp.n() as n0 \gset
select pg_temp.login('an', 'sai-mat-khau') as r \gset
select pg_temp.login('an', '1234') as r \gset
update ot.employees set rev = rev + 1 where true;
update ot.employees set tg_chat_id = '700100100', tg_name = 'An TG', tg_linked_at = now() where username = 'an';
update ot.employees set tg_chat_id = null, tg_name = null, tg_linked_at = null where username = 'an';
update ot.employees set failed_attempts = 0, locked_until = null, must_change_password = false, updated_at = now();
select pg_temp.t('Đăng nhập sai / đúng, bump rev cả bảng, đổi tg_*, failed_attempts: không ghi dòng nào', pg_temp.n() = :n0);

-- ===== Ca tăng ca =====
select pg_temp.n() as n0 \gset
select pg_temp.push('an', pg_temp.rec('r-an-1', 'An', -5, '17:15', '19:15', '{"note":"ghi chú đầu","overtimeType":"Trong khoán"}')) as e \gset
select pg_temp.t('Công nhân thêm ca: 1 dòng record_add, đúng người sửa / đối tượng / ngày / JSON',
  :'e' = '' and pg_temp.n() = :n0 + 1
  and l ->> 'actor_name' = 'An' and l ->> 'actor_role' = 'worker' and l ->> 'source' = 'web' and l ->> 'target_name' = 'An'
  and (l ->> 'work_date')::date = ot.vn_today() - 5 and l -> 'before' = 'null'::jsonb
  and l -> 'after' ->> 'id' = 'r-an-1' and l -> 'after' ->> 'start' = pg_temp.dmy(-5) || ' 17:15' and l -> 'after' ->> 'end' = pg_temp.dmy(-5) || ' 19:15'
  and l -> 'after' ->> 'jobContent' = 'Làm theo kế hoạch' and l -> 'after' ->> 'note' = 'ghi chú đầu'
  and l -> 'after' ->> 'overtimeType' = 'Trong khoán' and l -> 'after' ->> 'workMode' = 'Tăng ca tại công ty'
  and (l -> 'after') ? 'overrideHours' and (l ->> 'txid') is not null, :'e' || l::text)
from (select pg_temp.last('record_add') l) x;
select pg_temp.n() as n0 \gset
select pg_temp.push('an', pg_temp.rec('r-an-1', 'An', -5, '17:15', '19:15', '{"note":"ghi chú đầu","overtimeType":"Trong khoán"}')) as e \gset
select pg_temp.t('Gửi lại ca không đổi gì: không ghi', :'e' = '' and pg_temp.n() = :n0, :'e');
select pg_temp.push('admin', pg_temp.rec('r-an-1', 'An', -5, '17:15', '19:15',
  jsonb_build_object('note', 'ghi chú đầu', 'overtimeType', 'Trong khoán', 'modifiedAfterLock', true, 'modifiedAt', '21/10/2026 16:05'))) as e \gset
select pg_temp.t('Chỉ đổi modified_after_lock / modified_at (duyệt / chốt): không ghi record_edit', :'e' = '' and pg_temp.n() = :n0
  and (select modified_after_lock from ot.records where id = 'r-an-1'), :'e');
select pg_temp.push('admin', pg_temp.rec('r-an-1', 'An', -5, '17:15', '20:15',
  '{"note":"ghi chú mới","overtimeType":"Trong khoán","modifiedAfterLock":false,"modifiedAt":""}')) as e \gset
select pg_temp.t('Quản đốc sửa giờ ra + ghi chú: 1 record_edit, before / after đúng, người sửa là Quản trị viên',
  :'e' = '' and pg_temp.n() = :n0 + 1 and l ->> 'actor_name' = 'Quản trị viên' and l ->> 'actor_role' = 'admin' and l ->> 'target_name' = 'An'
  and (l ->> 'work_date')::date = ot.vn_today() - 5
  and l -> 'before' ->> 'end' = pg_temp.dmy(-5) || ' 19:15' and l -> 'after' ->> 'end' = pg_temp.dmy(-5) || ' 20:15'
  and l -> 'before' ->> 'note' = 'ghi chú đầu' and l -> 'after' ->> 'note' = 'ghi chú mới'
  and l -> 'before' ->> 'id' = 'r-an-1' and l -> 'after' ->> 'id' = 'r-an-1', :'e' || l::text)
from (select pg_temp.last('record_edit') l) x;
select pg_temp.n() as n0 \gset
select pg_temp.push('admin', pg_temp.rec('r-an-1', 'An', -5, '17:15', '20:15',
  '{"note":"ghi chú mới","overtimeType":"Trong khoán","overrideHours":2.5,"workMode":"Tăng ca trưa","jobContent":"Việc khác"}')) as e \gset
select pg_temp.t('Đổi giờ chốt / hình thức / nội dung: ghi record_edit với overrideHours, workMode, jobContent',
  :'e' = '' and pg_temp.n() = :n0 + 1 and (l -> 'after' ->> 'overrideHours')::numeric = 2.5 and l -> 'before' -> 'overrideHours' = 'null'::jsonb
  and l -> 'after' ->> 'workMode' = 'Tăng ca trưa' and l -> 'after' ->> 'jobContent' = 'Việc khác', :'e' || l::text)
from (select pg_temp.last('record_edit') l) x;
-- Chuyển ca sang người khác (cùng ngày) và sang ngày khác
select pg_temp.n() as n0 \gset
select pg_temp.push('admin', pg_temp.rec('r-an-1', 'Bình', -5, '17:15', '20:15',
  '{"note":"ghi chú mới","overtimeType":"Trong khoán","overrideHours":2.5,"workMode":"Tăng ca trưa","jobContent":"Việc khác"}')) as e \gset
select pg_temp.t('Chuyển ca sang người khác: record_move_out (An, ngày cũ, before + after {toEmployee,toDate}) + record_move_in (Bình, after + before {fromEmployee,fromDate}), cùng txid, không có record_edit',
  :'e' = '' and pg_temp.n() = :n0 + 2
  and o ->> 'target_name' = 'An' and (o ->> 'work_date')::date = ot.vn_today() - 5 and o -> 'before' ->> 'id' = 'r-an-1' and o -> 'after' = jsonb_build_object('toEmployee', 'Bình', 'toDate', pg_temp.dmy(-5))
  and i ->> 'target_name' = 'Bình' and (i ->> 'work_date')::date = ot.vn_today() - 5 and i -> 'after' ->> 'id' = 'r-an-1' and i -> 'before' = jsonb_build_object('fromEmployee', 'An', 'fromDate', pg_temp.dmy(-5))
  and o ->> 'txid' = i ->> 'txid' and (o ->> 'id')::bigint < (i ->> 'id')::bigint, :'e' || o::text || i::text)
from (select pg_temp.last('record_move_out') o, pg_temp.last('record_move_in') i) x;
select pg_temp.n() as n0 \gset
select pg_temp.push('admin', pg_temp.rec('r-an-1', 'Bình', -4, '17:15', '20:15',
  '{"note":"ghi chú mới","overtimeType":"Trong khoán","overrideHours":2.5,"workMode":"Tăng ca trưa","jobContent":"Việc khác"}')) as e \gset
select pg_temp.t('Chuyển ca sang ngày khác (cùng người): move_out ở ngày cũ + move_in ở ngày mới',
  :'e' = '' and pg_temp.n() = :n0 + 2
  and o ->> 'target_name' = 'Bình' and (o ->> 'work_date')::date = ot.vn_today() - 5
  and i ->> 'target_name' = 'Bình' and (i ->> 'work_date')::date = ot.vn_today() - 4
  and o -> 'after' = jsonb_build_object('toEmployee', 'Bình', 'toDate', pg_temp.dmy(-4)) and i -> 'before' = jsonb_build_object('fromEmployee', 'Bình', 'fromDate', pg_temp.dmy(-5))
  and i -> 'after' ->> 'start' = pg_temp.dmy(-4) || ' 17:15' and o -> 'before' ->> 'start' = pg_temp.dmy(-5) || ' 17:15', :'e' || o::text || i::text)
from (select pg_temp.last('record_move_out') o, pg_temp.last('record_move_in') i) x;
select pg_temp.n() as n0 \gset
select pg_temp.push('admin', jsonb_build_object('recordsDelete', jsonb_build_array('r-an-1'))) as e \gset
select pg_temp.t('Xóa ca: 1 record_delete với before (người / ngày hiện tại của ca)',
  :'e' = '' and pg_temp.n() = :n0 + 1 and l ->> 'target_name' = 'Bình' and (l ->> 'work_date')::date = ot.vn_today() - 4
  and l -> 'before' ->> 'id' = 'r-an-1' and l -> 'after' = 'null'::jsonb and l ->> 'actor_name' = 'Quản trị viên', :'e' || l::text)
from (select pg_temp.last('record_delete') l) x;
select pg_temp.n() as n0 \gset
select pg_temp.push('admin', jsonb_build_object('recordsDelete', jsonb_build_array('r-an-1', 'khong-co-ca-nay'))) as e \gset
select pg_temp.t('Xóa ca không tồn tại: không ghi', :'e' = '' and pg_temp.n() = :n0, :'e');

-- ===== Nghỉ (P) / về sớm =====
select pg_temp.n() as n0 \gset
select pg_temp.push('an', jsonb_build_object('statusUpsert', jsonb_build_array(
  jsonb_build_object('key', pg_temp.dmy(-3) || '::An', 'leave', 'MORNING', 'earlyHours', 0)))) as e \gset
select pg_temp.t('Báo nghỉ sáng: status_set, before null, after {leave, earlyHours}',
  :'e' = '' and pg_temp.n() = :n0 + 1 and l ->> 'actor_name' = 'An' and l ->> 'target_name' = 'An' and (l ->> 'work_date')::date = ot.vn_today() - 3
  and l -> 'before' = 'null'::jsonb and l -> 'after' ->> 'leave' = 'MORNING' and (l -> 'after' ->> 'earlyHours')::numeric = 0, :'e' || l::text)
from (select pg_temp.last('status_set') l) x;
select pg_temp.n() as n0 \gset
select pg_temp.push('an', jsonb_build_object('statusUpsert', jsonb_build_array(
  jsonb_build_object('key', pg_temp.dmy(-3) || '::An', 'leave', 'MORNING', 'earlyHours', 0)))) as e \gset
select pg_temp.t('Gửi lại đúng nghỉ / về sớm cũ: không ghi', :'e' = '' and pg_temp.n() = :n0, :'e');
select pg_temp.push('an', jsonb_build_object('statusUpsert', jsonb_build_array(
  jsonb_build_object('key', pg_temp.dmy(-3) || '::An', 'leave', 'MORNING', 'earlyHours', 1.5)))) as e \gset
select pg_temp.t('Thêm về sớm 1,5 giờ: status_set có before {MORNING, 0} và after {MORNING, 1.5}',
  :'e' = '' and pg_temp.n() = :n0 + 1 and l -> 'before' ->> 'leave' = 'MORNING' and (l -> 'before' ->> 'earlyHours')::numeric = 0
  and (l -> 'after' ->> 'earlyHours')::numeric = 1.5, :'e' || l::text)
from (select pg_temp.last('status_set') l) x;
select pg_temp.n() as n0 \gset
select pg_temp.push('an', jsonb_build_object('statusUpsert', jsonb_build_array(
  jsonb_build_object('key', pg_temp.dmy(-3) || '::An', 'leave', '', 'earlyHours', 0)))) as e \gset
select pg_temp.t('Xóa nghỉ / về sớm (leave rỗng, 0 giờ): status_clear với before',
  :'e' = '' and pg_temp.n() = :n0 + 1 and l ->> 'action' = 'status_clear' and l -> 'before' ->> 'leave' = 'MORNING'
  and (l -> 'before' ->> 'earlyHours')::numeric = 1.5 and l -> 'after' = 'null'::jsonb and (l ->> 'work_date')::date = ot.vn_today() - 3, :'e' || l::text)
from (select pg_temp.last('status_clear') l) x;
select pg_temp.push('an', jsonb_build_object('statusUpsert', jsonb_build_array(
  jsonb_build_object('key', pg_temp.dmy(-3) || '::An', 'leave', 'FULL', 'earlyHours', 0)))) as e \gset
select pg_temp.n() as n0 \gset
select pg_temp.push('admin', jsonb_build_object('statusDelete', jsonb_build_array(pg_temp.dmy(-3) || '::An'))) as e \gset
select pg_temp.t('statusDelete: status_clear, người sửa là Quản trị viên',
  :'e' = '' and pg_temp.n() = :n0 + 1 and l -> 'before' ->> 'leave' = 'FULL' and l ->> 'actor_name' = 'Quản trị viên', :'e' || l::text)
from (select pg_temp.last('status_clear') l) x;

-- ===== Chốt / bỏ chốt ngày, duyệt ô vàng, Telegram =====
select ot.telegram_setup('123456789:AAHabcdefghijklmnopqrstuvwxyz0123456') as r \gset
update ot.employees set tg_chat_id = '700100100', tg_name = 'An TG', tg_linked_at = now() where username = 'an';
select pg_temp.n() as n0 \gset
select pg_temp.push('admin', jsonb_build_object('lockedUpsert', jsonb_build_array(
  jsonb_build_object('date', pg_temp.dmy(-2), 'data', '{"a":1}'::jsonb)))) as e \gset
select pg_temp.t('Chốt ngày: day_lock (ngày, không đối tượng)',
  :'e' = '' and pg_temp.n() = :n0 + 1 and (l ->> 'work_date')::date = ot.vn_today() - 2 and l ->> 'target_name' is null
  and l ->> 'actor_name' = 'Quản trị viên', :'e' || l::text)
from (select pg_temp.last('day_lock') l) x;
select pg_temp.n() as n0 \gset
select pg_temp.push('admin', jsonb_build_object('lockedUpsert', jsonb_build_array(
  jsonb_build_object('date', pg_temp.dmy(-2), 'data', '{"a":2}'::jsonb)))) as e \gset
select pg_temp.t('Chốt lại / làm mới ngày đã chốt (UPDATE): không ghi',
  :'e' = '' and pg_temp.n() = :n0 and (select data ->> 'a' from ot.locked_days where work_date = ot.vn_today() - 2) = '2', :'e');
-- Công nhân báo sửa sau chốt, quản đốc duyệt
select pg_temp.push('an', jsonb_build_object('alertsUpsert', jsonb_build_array(jsonb_build_object(
  'key', pg_temp.dmy(-2) || '::An', 'data', jsonb_build_object('beforeCode', repeat('b', 100), 'afterCode', '3h'))))) as e \gset
select pg_temp.t('Công nhân báo sửa sau chốt (mod_alerts INSERT): không ghi alert_approve', :'e' = '' and not exists (select 1 from ot.audit_log where action = 'alert_approve'), :'e');
delete from net.calls;
select pg_temp.n() as n0 \gset
select pg_temp.push('admin', jsonb_build_object('alertsDelete', jsonb_build_array(pg_temp.dmy(-2) || '::An'))) as e \gset
select pg_temp.t('Quản đốc duyệt (xóa cảnh báo, ngày vẫn chốt): alert_approve, before cắt 60 ký tự',
  :'e' = '' and pg_temp.n() = :n0 + 1 and l ->> 'target_name' = 'An' and (l ->> 'work_date')::date = ot.vn_today() - 2
  and l -> 'before' ->> 'beforeCode' = repeat('b', 60) and l -> 'before' ->> 'afterCode' = '3h' and l ->> 'actor_name' = 'Quản trị viên', :'e' || l::text)
from (select pg_temp.last('alert_approve') l) x;
select pg_temp.t('...và An nhận tin Telegram "đã duyệt" (1 tin)', pg_temp.nsend() = 1 and pg_temp.sent('700100100') like '%Quản đốc đã duyệt%', pg_temp.sent('700100100'));
-- Bỏ chốt ngày có ô vàng
select pg_temp.push('an', jsonb_build_object('alertsUpsert', jsonb_build_array(jsonb_build_object(
  'key', pg_temp.dmy(-2) || '::An', 'data', '{"beforeCode":"2h","afterCode":"4h"}'::jsonb)))) as e \gset
delete from net.calls;
select pg_temp.n() as n0 \gset
select pg_temp.push('admin', jsonb_build_object('lockedDelete', jsonb_build_array(pg_temp.dmy(-2)),
  'alertsDelete', jsonb_build_array(pg_temp.dmy(-2) || '::An'))) as e \gset
select pg_temp.t('Bỏ chốt ngày có ô vàng: chỉ 1 dòng day_unlock, KHÔNG có alert_approve',
  :'e' = '' and pg_temp.n() = :n0 + 1 and l ->> 'action' = 'day_unlock' and (l ->> 'work_date')::date = ot.vn_today() - 2
  and l ->> 'target_name' is null and l ->> 'actor_name' = 'Quản trị viên'
  and (select count(*) from ot.audit_log where action = 'alert_approve') = 1 and not exists (select 1 from ot.mod_alerts), :'e' || l::text)
from (select to_jsonb(a) l from ot.audit_log a order by id desc limit 1) x;
select pg_temp.t('Bỏ chốt ngày có ô vàng: KHÔNG gửi tin Telegram "đã duyệt"', pg_temp.nsend() = 0, pg_temp.sent('700100100'));
-- Xóa nhân viên kéo cascade xóa cảnh báo trên ngày đang chốt
insert into ot.employees (name, username, password_hash) values ('Xóa thử', 'xoathu', 'x');
insert into ot.locked_days (work_date) values (ot.vn_today() - 2);
insert into ot.mod_alerts (alert_key, work_date, employee_id, data)
  select pg_temp.dmy(-2) || '::Xóa thử', ot.vn_today() - 2, id, '{"beforeCode":"1h"}' from ot.employees where username = 'xoathu';
select pg_temp.n() as n0 \gset
select pg_temp.push('admin', jsonb_build_object('employeesDelete', jsonb_build_array('Xóa thử'))) as e \gset
select pg_temp.t('Xóa nhân viên (cascade xóa cảnh báo, ngày đang chốt): có account_delete, KHÔNG có alert_approve',
  :'e' = '' and pg_temp.n() = :n0 + 1 and l ->> 'action' = 'account_delete' and l -> 'before' ->> 'username' = 'xoathu'
  and l -> 'before' ->> 'role' = 'worker' and l ->> 'target_name' = 'Xóa thử' and l -> 'after' = 'null'::jsonb
  and (select count(*) from ot.audit_log where action = 'alert_approve') = 1, :'e' || l::text)
from (select to_jsonb(a) l from ot.audit_log a order by id desc limit 1) x;
delete from ot.locked_days where work_date = ot.vn_today() - 2;

-- ===== Ngày lễ =====
select pg_temp.n() as n0 \gset
select pg_temp.push('admin', jsonb_build_object('holidaysUpsert', jsonb_build_array(
  jsonb_build_object('date', pg_temp.dmy(-1), 'name', 'Lễ thử')))) as e \gset
select pg_temp.t('Thêm ngày lễ: holiday_set (after {name}), không đối tượng; bump rev cả bảng không sinh dòng account_*',
  :'e' = '' and pg_temp.n() = :n0 + 1 and (l ->> 'work_date')::date = ot.vn_today() - 1 and l -> 'after' ->> 'name' = 'Lễ thử'
  and l ->> 'target_name' is null, :'e' || l::text)
from (select pg_temp.last('holiday_set') l) x;
select pg_temp.n() as n0 \gset
select pg_temp.push('admin', jsonb_build_object('holidaysUpsert', jsonb_build_array(
  jsonb_build_object('date', pg_temp.dmy(-1), 'name', 'Lễ thử')))) as e \gset
select pg_temp.t('Lưu lại ngày lễ không đổi tên: không ghi', :'e' = '' and pg_temp.n() = :n0, :'e');
select pg_temp.push('admin', jsonb_build_object('holidaysUpsert', jsonb_build_array(
  jsonb_build_object('date', pg_temp.dmy(-1), 'name', 'Lễ đổi tên')))) as e \gset
select pg_temp.t('Đổi tên ngày lễ: holiday_set tên mới', :'e' = '' and pg_temp.n() = :n0 + 1 and l -> 'after' ->> 'name' = 'Lễ đổi tên', :'e')
from (select pg_temp.last('holiday_set') l) x;
select pg_temp.push('admin', jsonb_build_object('holidaysDelete', jsonb_build_array(pg_temp.dmy(-1)))) as e \gset
select pg_temp.t('Xóa ngày lễ: holiday_delete (before {name})',
  :'e' = '' and pg_temp.n() = :n0 + 2 and l -> 'before' ->> 'name' = 'Lễ đổi tên' and (l ->> 'work_date')::date = ot.vn_today() - 1, :'e' || l::text)
from (select pg_temp.last('holiday_delete') l) x;

-- ===== Tài khoản =====
select pg_temp.n() as n0 \gset
select pg_temp.push('admin', jsonb_build_object('employeesUpsert', jsonb_build_array(
  jsonb_build_object('name', 'An', 'username', 'an'),
  jsonb_build_object('name', 'Bình', 'username', 'binh')))) as e \gset
select pg_temp.t('Lưu lại tài khoản không đổi gì: không ghi', :'e' = '' and pg_temp.n() = :n0, :'e');
select pg_temp.push('admin', jsonb_build_object('employeesUpsert', jsonb_build_array(
  jsonb_build_object('name', 'Bình', 'username', 'binh', 'role', 'admin', 'hasTimesheet', false, 'notifyManager', true,
                     'startDate', '2026-01-02', 'defaultOvertimeType', 'Trong khoán')))) as e \gset
select pg_temp.t('Đổi quyền + các cờ: account_update chỉ chứa các khóa đã đổi (role, hasTimesheet, notifyManager, startDate, defaultOvertimeType)',
  :'e' = '' and pg_temp.n() = :n0 + 1 and l ->> 'target_name' = 'Bình'
  and l -> 'before' = '{"role":"worker","hasTimesheet":true,"notifyManager":false,"startDate":null,"defaultOvertimeType":"Ngoài khoán"}'::jsonb
  and l -> 'after' = '{"role":"admin","hasTimesheet":false,"notifyManager":true,"startDate":"2026-01-02","defaultOvertimeType":"Trong khoán"}'::jsonb,
  :'e' || l::text)
from (select pg_temp.last('account_update') l) x;
select pg_temp.push('admin', jsonb_build_object('employeesUpsert', jsonb_build_array(
  jsonb_build_object('name', 'Bình', 'username', 'binh', 'role', 'worker', 'hasTimesheet', true,
                     'startDate', '2026-01-02', 'defaultOvertimeType', 'Trong khoán')))) as e \gset
select pg_temp.n() as n0 \gset
select pg_temp.push('admin', jsonb_build_object('employeesUpsert', jsonb_build_array(
  jsonb_build_object('name', 'Bình', 'username', 'binh2', 'password', 'matkhau-moi')))) as e \gset
select pg_temp.t('Đổi tên đăng nhập + đặt lại mật khẩu: account_update (username) + password_reset (actor khác chủ), không có hash',
  :'e' = '' and pg_temp.n() = :n0 + 2
  and u -> 'before' ->> 'username' = 'binh' and u -> 'after' ->> 'username' = 'binh2'
  and p ->> 'actor_name' = 'Quản trị viên' and p ->> 'target_name' = 'Bình' and p -> 'before' = 'null'::jsonb and p -> 'after' = 'null'::jsonb
  and (select count(*) from ot.audit_log where action in ('password_reset', 'password_change')) = 1, :'e' || u::text || p::text)
from (select pg_temp.last('account_update') u, pg_temp.last('password_reset') p) x;
select pg_temp.push('admin', jsonb_build_object('employeesUpsert', jsonb_build_array(
  jsonb_build_object('name', 'Bình', 'username', 'binh', 'defaultOvertimeType', 'Ngoài khoán')))) as e \gset
select pg_temp.login('chi', '1234') as r \gset
select pg_temp.n() as n0 \gset
select public.app_change_password(pg_temp.tok('chi'), '1234', 'chi-mat-khau-moi') ->> 'ok' as okpw \gset
select pg_temp.t('Tự đổi mật khẩu: password_change (người sửa = chính chủ), không ghi hash',
  :'okpw' = 'true' and pg_temp.n() = :n0 + 1 and l ->> 'actor_name' = 'Chi' and l ->> 'target_name' = 'Chi' and l ->> 'actor_role' = 'worker'
  and l -> 'before' = 'null'::jsonb and l -> 'after' = 'null'::jsonb and l ->> 'source' = 'web', :'okpw' || l::text)
from (select pg_temp.last('password_change') l) x;
select pg_temp.n() as n0 \gset
select pg_temp.t('Đổi mật khẩu sai mật khẩu cũ: không ghi', (public.app_change_password(pg_temp.tok('chi'), 'sai', 'xxxxxxxx') ->> 'ok') = 'false' and pg_temp.n() = :n0);
select ot.reset_admin_password('admin-moi-123') \gset
select pg_temp.t('SQL Editor reset_admin_password: password_reset, source sql, không người sửa',
  l ->> 'source' = 'sql' and l ->> 'actor_id' is null and l ->> 'target_name' = 'Quản trị viên', l::text)
from (select pg_temp.last('password_reset') l) x;
select pg_temp.login('admin', 'admin-moi-123') \gset

-- ===== R3: biến người sửa không "dính" sang giao dịch sau =====
select pg_temp.n() as n0 \gset
insert into ot.holidays (work_date, name) values (ot.vn_today() - 40, 'Sửa tay');
update ot.records set note = 'sửa tay' where false;
select pg_temp.t('Sau app_push, sửa trực tiếp trong giao dịch MỚI cùng phiên: source sql, không người sửa',
  pg_temp.n() = :n0 + 1 and l ->> 'source' = 'sql' and l ->> 'actor_id' is null and l ->> 'actor_name' is null
  and l ->> 'action' = 'holiday_set', l::text)
from (select pg_temp.last('holiday_set') l) x;
select pg_temp.push('an', pg_temp.rec('r-sql-1', 'An', -6, '17:15', '18:15')) as e \gset
update ot.records set note = 'sửa bằng SQL' where id = 'r-sql-1';
select pg_temp.t('Sửa ca bằng SQL Editor sau đó: record_edit source sql',
  l ->> 'source' = 'sql' and l ->> 'actor_name' is null and l -> 'after' ->> 'note' = 'sửa bằng SQL' and l -> 'before' ->> 'note' = '', l::text)
from (select pg_temp.last('record_edit') l) x;
select pg_temp.t('current_setting(ot.actor_id) ngoài giao dịch app_*: rỗng hoặc null', coalesce(current_setting('ot.actor_id', true), '') = '', current_setting('ot.actor_id', true));
delete from ot.holidays where work_date = ot.vn_today() - 40;
delete from ot.records where id = 'r-sql-1';

-- ===== app_audit_list: quyền =====
select pg_temp.t('Công nhân gọi app_audit_list: forbidden',
  pg_temp.hint(format('select public.app_audit_list(%L)', pg_temp.tok('an'))) = 'forbidden');
select pg_temp.t('Admin phụ (qd2) xem được', (pg_temp.list('qd2') ->> 'ok') = 'true');
select pg_temp.t('Token sai: lỗi phiên đăng nhập, không phải permission denied',
  pg_temp.anon_err('select public.app_audit_list(''khong-hop-le-khong-hop-le-khong-hop-le'')') like '%Phiên đăng nhập%');
select pg_temp.t('anon không đọc được ot.audit_log', pg_temp.anon_err('select * from ot.audit_log') like '%permission denied%');
select pg_temp.t('anon không ghi / xóa ot.audit_log',
  pg_temp.anon_err('insert into ot.audit_log (action) values (''x'')') like '%permission denied%'
  and pg_temp.anon_err('delete from ot.audit_log') like '%permission denied%');
select pg_temp.t('anon không dùng được sequence ot.audit_log_id_seq', pg_temp.anon_err('select nextval(''ot.audit_log_id_seq'')') like '%permission denied%');
select pg_temp.t('anon không gọi được hàm trigger ot.audit_write', pg_temp.anon_err('select ot.audit_write(''x'', null, null, null, null, null)') like '%permission denied%');
select pg_temp.t('ot.audit_log bật RLS và không cấp quyền cho anon / authenticated',
  (select relrowsecurity from pg_class where oid = 'ot.audit_log'::regclass)
  and not has_table_privilege('anon', 'ot.audit_log', 'select') and not has_table_privilege('authenticated', 'ot.audit_log', 'select')
  and not has_sequence_privilege('anon', 'ot.audit_log_id_seq', 'usage') and not has_sequence_privilege('authenticated', 'ot.audit_log_id_seq', 'usage'));
select pg_temp.t('app_audit_list: anon / authenticated có quyền execute, public thì không',
  has_function_privilege('anon', 'public.app_audit_list(text,date,date,text,bigint,int)', 'execute')
  and has_function_privilege('authenticated', 'public.app_audit_list(text,date,date,text,bigint,int)', 'execute')
  and not has_function_privilege('public', 'public.app_audit_list(text,date,date,text,bigint,int)', 'execute'));
select pg_temp.t('app_audit_list là SECURITY DEFINER với search_path rỗng',
  (select prosecdef and proconfig::text like '%search_path%' from pg_proc where oid = 'public.app_audit_list(text,date,date,text,bigint,int)'::regprocedure));

-- ===== app_audit_list: nội dung, thứ tự, bộ lọc, phân trang =====
select pg_temp.push('an', pg_temp.rec('r-list-1', 'An', -9, '17:15', '18:15')) as e \gset
select pg_temp.push('an', pg_temp.rec('r-list-2', 'An', -9, '18:30', '19:30')) as e \gset
select pg_temp.push('admin', jsonb_build_object('recordsDelete', jsonb_build_array('r-list-2'))) as e \gset
select pg_temp.list('admin', ot.vn_today() - 9, ot.vn_today() - 9, 'An') as r \gset
select pg_temp.t('Lọc 1 ngày + 1 người: đúng 3 dòng (thêm, thêm, xóa), mới nhất trước',
  jsonb_array_length(:'r'::jsonb -> 'entries') = 3 and :'r'::jsonb ->> 'more' = 'false'
  and :'r'::jsonb -> 'entries' -> 0 ->> 'action' = 'record_delete' and :'r'::jsonb -> 'entries' -> 2 ->> 'action' = 'record_add', left(:'r', 300));
select pg_temp.t('Mỗi dòng có đủ khóa theo hợp đồng, định dạng at / atVn / workDate',
  (select bool_and(
      (e ?& array['id', 'txid', 'at', 'atVn', 'actorName', 'actorRole', 'source', 'action', 'targetName', 'workDate', 'before', 'after'])
      and (select count(*) from jsonb_object_keys(e)) = 12
      and e ->> 'at' ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$'
      and e ->> 'atVn' ~ '^\d{2}/\d{2}/\d{4} \d{2}:\d{2}$'
      and e ->> 'workDate' = pg_temp.dmy(-9)
      and e ->> 'source' = 'web' and e ->> 'actorRole' in ('admin', 'worker') and jsonb_typeof(e -> 'id') = 'number')
   from jsonb_array_elements(:'r'::jsonb -> 'entries') e), left(:'r', 300));
select pg_temp.t('atVn đúng giờ Việt Nam (UTC+7) của at',
  (select bool_and(e ->> 'atVn' = to_char(((e ->> 'at')::timestamptz) at time zone 'Asia/Ho_Chi_Minh', 'DD/MM/YYYY HH24:MI'))
   from jsonb_array_elements(:'r'::jsonb -> 'entries') e));
select pg_temp.t('before / after là null (JSON) khi không có; có nội dung khi có',
  :'r'::jsonb -> 'entries' -> 0 -> 'after' = 'null'::jsonb and :'r'::jsonb -> 'entries' -> 0 -> 'before' ->> 'id' = 'r-list-2'
  and :'r'::jsonb -> 'entries' -> 2 -> 'before' = 'null'::jsonb and :'r'::jsonb -> 'entries' -> 2 -> 'after' ->> 'id' = 'r-list-1');
select pg_temp.t('Lọc ngày: cùng người nhưng ngày khác -> không lẫn',
  jsonb_array_length(pg_temp.list('admin', ot.vn_today() - 8, ot.vn_today() - 8, 'An') -> 'entries') = 0);
select pg_temp.t('Lọc người: tên khác -> không có dòng nào của An (so khớp chính xác)',
  jsonb_array_length(pg_temp.list('admin', ot.vn_today() - 9, ot.vn_today() - 9, 'A') -> 'entries') = 0
  and (select bool_and(e ->> 'targetName' = 'Bình') from jsonb_array_elements(pg_temp.list('admin', null, null, 'Bình') -> 'entries') e));
select pg_temp.t('Lọc khoảng ngày (chỉ p_from / chỉ p_to / cả hai)',
  (select count(*) from jsonb_array_elements(pg_temp.list('admin', ot.vn_today() - 9, null, null, null, 200) -> 'entries') e where (e ->> 'workDate')::text is not null
     and to_date(e ->> 'workDate', 'DD/MM/YYYY') < ot.vn_today() - 9) = 0
  and (select count(*) from jsonb_array_elements(pg_temp.list('admin', null, ot.vn_today() - 9, null, null, 200) -> 'entries') e where (e ->> 'workDate')::text is not null
     and to_date(e ->> 'workDate', 'DD/MM/YYYY') > ot.vn_today() - 9) = 0
  and jsonb_array_length(pg_temp.list('admin', ot.vn_today() - 9, ot.vn_today() - 9, null, null, 200) -> 'entries') >= 3);
-- Dòng không có work_date (đổi tài khoản) lọc theo ngày VN của lúc ghi
insert into ot.audit_log (at, action, target_name, source) values (now() - interval '10 days', 'account_update', 'Người cũ', 'sql');
select pg_temp.t('Dòng không có work_date lọc theo ngày VN của lúc ghi: có trong khoảng 12..9 ngày trước, không có trong khoảng hôm nay',
  jsonb_array_length(pg_temp.list('admin', ot.vn_today() - 12, ot.vn_today() - 9, 'Người cũ') -> 'entries') = 1
  and not exists (select 1 from jsonb_array_elements(pg_temp.list('admin', ot.vn_today() - 2, ot.vn_today(), 'Người cũ') -> 'entries') e where e ->> 'targetName' = 'Người cũ')
  and pg_temp.list('admin', null, null, 'Người cũ') -> 'entries' -> 0 -> 'workDate' = 'null'::jsonb);
select pg_temp.t('1 ngày + 1 người: dòng tài khoản (không work_date) của người đó lọc theo ngày VN của lúc ghi',
  jsonb_array_length(pg_temp.list('admin', ot.vn_today() - 10, ot.vn_today() - 10, 'Người cũ') -> 'entries') = 1);
delete from ot.audit_log where target_name = 'Người cũ';
-- Một quy tắc lọc: 1 ngày + 1 người = ca của người đó + sự kiện cấp ngày (chốt / bỏ chốt / lễ) + đổi tài khoản của người đó trong ngày
insert into ot.audit_log (at, action, target_name, work_date, source) values
  (now(), 'record_add', 'Kiểm', ot.vn_today() - 30, 'sql'),
  (now(), 'day_lock', null, ot.vn_today() - 30, 'sql'),
  (now(), 'day_unlock', null, ot.vn_today() - 30, 'sql'),
  (now(), 'holiday_set', null, ot.vn_today() - 29, 'sql'),
  (now(), 'record_add', 'Khác', ot.vn_today() - 30, 'sql');
insert into ot.audit_log (at, action, target_name, source) values
  (((ot.vn_today() - 30) + time '12:00') at time zone 'Asia/Ho_Chi_Minh', 'account_update', 'Kiểm', 'sql'),
  (((ot.vn_today() - 30) + time '12:00') at time zone 'Asia/Ho_Chi_Minh', 'account_update', 'Khác', 'sql'),
  (((ot.vn_today() - 33) + time '12:00') at time zone 'Asia/Ho_Chi_Minh', 'account_update', 'Kiểm', 'sql');
select pg_temp.list('admin', ot.vn_today() - 30, ot.vn_today() - 30, 'Kiểm') as d1 \gset
select pg_temp.list('admin', ot.vn_today() - 36, ot.vn_today() - 20, 'Kiểm') as mo \gset
select pg_temp.t('1 ngày + 1 người: ca của người đó + day_lock + day_unlock + đổi tài khoản trong ngày (4 dòng), không có người khác / ngày khác',
  jsonb_array_length(:'d1'::jsonb -> 'entries') = 4
  and (select array_agg(e ->> 'action' order by e ->> 'action') from jsonb_array_elements(:'d1'::jsonb -> 'entries') e)
      = array['account_update', 'day_lock', 'day_unlock', 'record_add']
  and not exists (select 1 from jsonb_array_elements(:'d1'::jsonb -> 'entries') e where e ->> 'targetName' = 'Khác' or e ->> 'action' = 'holiday_set'), :'d1');
select pg_temp.t('Tháng + người: tập con ở trên (4 dòng) cộng thêm lễ ngày kế và đổi tài khoản 3 ngày trước (6 dòng), vẫn không có người khác',
  jsonb_array_length(:'mo'::jsonb -> 'entries') = 6
  and not exists (select 1 from jsonb_array_elements(:'d1'::jsonb -> 'entries') d where d -> 'id' not in (select e -> 'id' from jsonb_array_elements(:'mo'::jsonb -> 'entries') e))
  and not exists (select 1 from jsonb_array_elements(:'mo'::jsonb -> 'entries') e where e ->> 'targetName' = 'Khác'), :'mo');
delete from ot.audit_log where target_name in ('Kiểm', 'Khác') or (target_name is null and work_date in (ot.vn_today() - 30, ot.vn_today() - 29));
-- Phân trang
select count(*) as total from ot.audit_log \gset
select pg_temp.t('Phân trang limit 7 + p_before_id: nối lại đúng toàn bộ, không trùng, giảm dần, more đúng',
  (with recursive pg(i, before_id, ids, more) as (
     select 0, null::bigint, '{}'::bigint[], true
     union all
     select i + 1, (p.x ->> 'minid')::bigint, ids || p.arr, (p.x ->> 'more')::boolean
       from pg, lateral (
         select r as x, array(select (e ->> 'id')::bigint from jsonb_array_elements(r -> 'entries') e) as arr
           from (select pg_temp.list('admin', null, null, null, pg.before_id, 7) r) q
       ) p0, lateral (select jsonb_build_object('minid', (select min((e ->> 'id')::bigint) from jsonb_array_elements(p0.x -> 'entries') e),
                                                 'more', p0.x -> 'more') as x, p0.arr as arr) p
      where pg.more and i < 100)
   select cardinality(ids) = :total and (select count(distinct v) from unnest(ids) v) = :total
          and ids = array(select id from ot.audit_log order by id desc) and not more
     from pg order by i desc limit 1));
select pg_temp.t('Trang đầu limit 7 khi còn nhiều hơn: more = true, đúng 7 dòng',
  :total > 7 and (pg_temp.list('admin', null, null, null, null, 7) ->> 'more') = 'true' and jsonb_array_length(pg_temp.list('admin', null, null, null, null, 7) -> 'entries') = 7);
select pg_temp.t('limit đúng bằng số dòng còn lại: more = false',
  (pg_temp.list('admin', null, null, null, null, :total) ->> 'more') = 'false' and jsonb_array_length(pg_temp.list('admin', null, null, null, null, :total) -> 'entries') = :total);
select pg_temp.t('Mặc định (p_limit null) và limit <= 0 -> kẹp về 1', jsonb_array_length(pg_temp.list('admin', null, null, null, null, 0) -> 'entries') = 1
  and jsonb_array_length(pg_temp.list('admin', null, null, null, null, -5) -> 'entries') = 1
  and jsonb_array_length(pg_temp.list('admin', null, null, null, null, null) -> 'entries') = least(:total, 100));
insert into ot.audit_log (action, target_name, source, work_date) select 'record_add', 'Lô', 'sql', ot.vn_today() - 200 from generate_series(1, 250);
select pg_temp.t('limit 1000 -> kẹp về 200 và more = true', jsonb_array_length(pg_temp.list('admin', null, null, null, null, 1000) -> 'entries') = 200
  and (pg_temp.list('admin', null, null, null, null, 1000) ->> 'more') = 'true');
select pg_temp.t('Phân trang theo người: Lô, limit 100 -> trang sau còn 50 dòng, more = false',
  jsonb_array_length(pg_temp.list('admin', null, null, 'Lô', null, 100) -> 'entries') = 100
  and jsonb_array_length(pg_temp.list('admin', null, null, 'Lô', (select min(id) from (select id from ot.audit_log where target_name = 'Lô' order by id desc limit 100) z), 100) -> 'entries') = 100
  and (pg_temp.list('admin', null, null, 'Lô', (select min(id) from (select id from ot.audit_log where target_name = 'Lô' order by id desc limit 200) z), 100) ->> 'more') = 'false');
delete from ot.audit_log where target_name = 'Lô';

-- ===== Giữ 400 ngày (xóa ở cuối app_push) =====
insert into ot.audit_log (at, action, target_name, source) values (now() - interval '401 days', 'record_add', 'Rất cũ', 'sql'),
  (now() - interval '399 days', 'record_add', 'Gần cũ', 'sql');
select pg_temp.push('an', pg_temp.rec('r-prune-1', 'An', -7, '17:15', '18:15')) as e \gset
select pg_temp.t('Sau app_push: dòng > 400 ngày bị xóa, dòng 399 ngày còn',
  :'e' = '' and not exists (select 1 from ot.audit_log where target_name = 'Rất cũ') and exists (select 1 from ot.audit_log where target_name = 'Gần cũ'), :'e');
delete from ot.audit_log where target_name = 'Gần cũ';

-- ===== Chạy lại các file cài đặt: không lỗi, không nhân đôi trigger =====
select pg_temp.audit_triggers() as trg0 \gset
select count(*) as trgn0 from pg_trigger where not tgisinternal \gset
\i supabase_setup.sql
\i supabase_setup.sql
\i telegram_nhac_cham_cong.sql
\i supabase_setup.sql
\i telegram_nhac_cham_cong.sql
select pg_temp.t('Chạy lại setup x3 + telegram x2 (xen kẽ): danh sách trigger audit_* và tổng trigger giữ nguyên',
  pg_temp.audit_triggers() = :'trg0' and (select count(*) from pg_trigger where not tgisinternal) = :trgn0, pg_temp.audit_triggers());
select pg_temp.t('Có đủ 15 trigger audit_* (records 3, day_status 3, locked_days 2, mod_alerts 1, holidays 3, employees 3)',
  (select count(*) from pg_trigger where not tgisinternal and tgname like 'audit\_%') = 15, pg_temp.audit_triggers());
select pg_temp.n() as n0 \gset
select pg_temp.push('an', pg_temp.rec('r-rerun-1', 'An', -8, '17:15', '18:15')) as e \gset
select pg_temp.t('Sau khi chạy lại: thêm 1 ca chỉ ghi đúng 1 dòng (không nhân đôi)', :'e' = '' and pg_temp.n() = :n0 + 1, :'e');
select pg_temp.t('Sau khi chạy lại: app_audit_list và token cũ vẫn dùng được', (pg_temp.list('admin', null, null, null, null, 5) ->> 'ok') = 'true');

-- ===== Thời gian 1000 ca (có / không trigger audit) =====
alter table ot.records disable trigger user;
select pg_temp.timed_push('1000 ca MỚI, tắt audit', 'admin', pg_temp.bulk_ops('bk-b-', date '2026-05-01', 1000)) as e \gset
select pg_temp.timed_push('1000 ca GỬI LẠI không đổi, tắt audit', 'admin', pg_temp.bulk_ops('bk-b-', date '2026-05-01', 1000)) as e2 \gset
alter table ot.records enable trigger user;
select pg_temp.n() as n0 \gset
select pg_temp.timed_push('1000 ca MỚI, có audit', 'admin', pg_temp.bulk_ops('bk-a-', date '2026-01-01', 1000)) as e3 \gset
select pg_temp.t('1000 ca mới: 1000 dòng record_add', :'e3' = '' and pg_temp.n() = :n0 + 1000, :'e3' || ' n=' || (pg_temp.n() - :n0));
select pg_temp.n() as n0 \gset
select pg_temp.timed_push('1000 ca GỬI LẠI không đổi, có audit', 'admin', pg_temp.bulk_ops('bk-a-', date '2026-01-01', 1000)) as e4 \gset
select pg_temp.t('Gửi lại 1000 ca không đổi: không dòng nào', :'e4' = '' and pg_temp.n() = :n0, :'e4');
select pg_temp.t('Đo thời gian: cả 4 lần đều thành công và trigger đã bật lại',
  :'e' = '' and :'e2' = '' and (select count(*) from pg_trigger where tgrelid = 'ot.records'::regclass and tgname like 'audit\_%' and tgenabled = 'O') = 3, :'e' || :'e2');

\echo ===== THỜI GIAN (ms) =====
select 'TIMING ' || label || ': ' || round(ms) || ' ms' from timing order by n;
\echo ===== KẾT QUẢ =====
select case when ok then 'OK  ' else 'FAIL' end || ' ' || name || case when ok then '' else ' => ' || detail end from results order by n;
select count(*) filter (where ok) || ' đạt, ' || count(*) filter (where not ok) || ' lỗi' from results;
