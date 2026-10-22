-- Kiểm thử máy chủ: phân quyền theo tài khoản (role, hasTimesheet, notify*), luật "còn ít nhất 1 admin",
-- app_pull / app_login field mới, reset_admin_password, chạy lại supabase_setup.sql.
--
-- Chạy trên database MỚI (xem tests/pg-stubs.sql), từ thư mục gốc dự án:
--   createdb -h 127.0.0.1 -p 55432 -U postgres ot_roles
--   psql -X -q -h 127.0.0.1 -p 55432 -U postgres -d ot_roles -v ON_ERROR_STOP=1 \
--        -f tests/pg-stubs.sql -f supabase_setup.sql -f telegram_nhac_cham_cong.sql -f tests/accounts-roles.sql | grep -v '^$'
-- Dòng cuối: "N đạt, M lỗi".
\set ON_ERROR_STOP 1
\pset tuples_only on
\pset format unaligned

create temp table results (n serial, name text, ok boolean, detail text);
create temp table tk (u text primary key, tok text);
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
create function pg_temp.pull_err(p_user text) returns text language plpgsql as $$
begin
  perform public.app_pull(pg_temp.tok(p_user));
  return '';
exception when others then
  return sqlerrm;
end $$;
create function pg_temp.emp(p_name text, p_user text, p_extra jsonb default '{}') returns jsonb language sql as
$$ select jsonb_build_object('employeesUpsert', jsonb_build_array(jsonb_build_object('name', p_name, 'username', p_user) || p_extra)) $$;
create function pg_temp.rec(p_id text, p_name text, p_off int) returns jsonb language sql as $$
  select jsonb_build_object('recordsUpsert', jsonb_build_array(jsonb_build_object(
    'id', p_id, 'employeeName', p_name, 'jobContent', 'Làm theo kế hoạch', 'modifiedAfterLock', false,
    'startTime', to_char(ot.vn_today() + p_off, 'DD/MM/YYYY') || ' 17:15',
    'endTime', to_char(ot.vn_today() + p_off, 'DD/MM/YYYY') || ' 19:15',
    'workDate', to_char(ot.vn_today() + p_off, 'DD/MM/YYYY'))))
$$;
create function pg_temp.err(p_sql text) returns text language plpgsql as $$
begin
  execute p_sql;
  return '';
exception when others then
  return sqlerrm;
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
create function pg_temp.pe(p_user text, p_name text) returns jsonb language sql as $$
  select x from jsonb_array_elements(public.app_pull(pg_temp.tok(p_user)) -> 'employees') x where x ->> 'name' = p_name
$$;

-- ===== Khởi tạo =====
do $$ begin perform ot.bootstrap_admin('admin123'); end $$;
select pg_temp.login('admin', 'admin123') \gset
select pg_temp.push('admin', pg_temp.emp('An', 'an', '{"password":"1234"}'));
select pg_temp.push('admin', pg_temp.emp('Bình', 'binh', '{"password":"1234"}'));
select pg_temp.push('admin', pg_temp.emp('Chi', 'chi', '{"password":"1234"}'));
select pg_temp.login('an', '1234') \gset
select pg_temp.login('binh', '1234') \gset
select pg_temp.login('chi', '1234') \gset

-- ===== Mặc định & di trú =====
select pg_temp.t('Admin tạo bằng bootstrap: không chấm công, nhận báo cáo quản lý',
  role = 'admin' and not has_timesheet and notify_manager and notify_personal, role || has_timesheet::text)
from ot.employees where username = 'admin';
select pg_temp.t('Công nhân mới: có chấm công, không nhận báo cáo quản lý, nhận nhắc cá nhân',
  role = 'worker' and has_timesheet and not notify_manager and notify_personal)
from ot.employees where username = 'an';
select pg_temp.t('app_login trả hasTimesheet', (pg_temp.login('an', '1234') ->> 'hasTimesheet') = 'true'
  and (pg_temp.login('admin', 'admin123') ->> 'hasTimesheet') = 'false'
  and (pg_temp.login('admin', 'admin123') ->> 'role') = 'admin');

-- ===== Cờ: thiếu = giữ nguyên; công nhân không bao giờ nhận báo cáo quản lý =====
select pg_temp.push('admin', pg_temp.emp('Bình', 'binh', '{"notifyManager":true}')) as e \gset
select pg_temp.t('Công nhân bật notifyManager: lưu thành false', not notify_manager, :'e')
from ot.employees where username = 'binh';
select pg_temp.push('admin', pg_temp.emp('Chi', 'chi', '{"hasTimesheet":false,"notifyPersonal":false}')) as e \gset
select pg_temp.t('Đặt hasTimesheet=false, notifyPersonal=false', not has_timesheet and not notify_personal, :'e')
from ot.employees where username = 'chi';
select pg_temp.push('admin', pg_temp.emp('Chi', 'chi')) as e \gset
select pg_temp.t('Thiếu field khi cập nhật: giữ nguyên', not has_timesheet and not notify_personal and role = 'worker', :'e')
from ot.employees where username = 'chi';
select pg_temp.t('Field cờ sai kiểu bị từ chối', pg_temp.push('admin', pg_temp.emp('Chi', 'chi', '{"hasTimesheet":"yes"}')) like '%Có chấm công%');
select pg_temp.t('Quyền lạ bị từ chối', pg_temp.push('admin', pg_temp.emp('Chi', 'chi', '{"role":"boss"}')) like '%Quyền không hợp lệ%');
select rev as rev0 from ot.employees where username = 'binh' \gset
select pg_temp.push('admin', pg_temp.emp('Bình', 'binh', '{"notifyPersonal":false}')) as e \gset
select pg_temp.t('Đổi cờ tăng rev của người đó (để web thấy thay đổi)', rev > :rev0, :'e') from ot.employees where username = 'binh';
select pg_temp.push('admin', pg_temp.emp('Bình', 'binh', '{"notifyPersonal":true}')) as e \gset

-- ===== Công nhân không đổi được quyền / cờ =====
select pg_temp.t('Công nhân gọi employeesUpsert bị từ chối', pg_temp.push('binh', pg_temp.emp('Bình', 'binh', '{"role":"admin"}')) like '%không có quyền%');
select pg_temp.t('Công nhân không tự nâng quyền', role = 'worker') from ot.employees where username = 'binh';
select pg_temp.t('Công nhân không xóa được ai', pg_temp.push('binh', '{"employeesDelete":["An"]}') like '%không có quyền%');

-- ===== Nâng công nhân lên admin: xóa session =====
select pg_temp.login('an', '1234') \gset
select pg_temp.push('admin', pg_temp.emp('An', 'an', '{"role":"admin","notifyManager":true}')) as e \gset
select pg_temp.t('Nâng An lên admin (+ nhận báo cáo quản lý)', role = 'admin' and notify_manager, :'e')
from ot.employees where username = 'an';
select pg_temp.t('Đổi quyền xóa session cũ của An', pg_temp.pull_err('an') like '%đăng nhập%');
select pg_temp.t('An đăng nhập lại: role admin, vẫn có chấm công',
  (pg_temp.login('an', '1234') ->> 'role') = 'admin' and (pg_temp.login('an', '1234') ->> 'hasTimesheet') = 'true');
select pg_temp.t('Nâng quyền không xóa dữ liệu khác: Admin An thấy mọi tài khoản',
  jsonb_array_length(public.app_pull(pg_temp.tok('an')) -> 'employees') = 4);

-- ===== Admin không tự hạ quyền / tự nghỉ / tự xóa =====
select pg_temp.t('Admin tự hạ quyền bị chặn', pg_temp.push('an', pg_temp.emp('An', 'an', '{"role":"worker"}')) like '%tự đổi quyền%');
select pg_temp.t('Admin tự cho nghỉ việc bị chặn',
  pg_temp.push('an', pg_temp.emp('An', 'an', jsonb_build_object('endDate', to_char(ot.vn_today(), 'YYYY-MM-DD')))) like '%tự cho chính mình nghỉ%');
select pg_temp.t('Admin tự xóa mình bị chặn', pg_temp.push('an', '{"employeesDelete":["An"]}') like '%hạ quyền%');
select pg_temp.t('Vẫn là admin sau các lần thử', role = 'admin' and end_date is null) from ot.employees where username = 'an';
-- (Kiểm tra ở câu lệnh riêng: truy vấn con trong cùng câu lệnh chạy trước lệnh push)
select pg_temp.push('an', pg_temp.emp('An', 'an', '{"role":"admin","defaultOvertimeType":"Trong khoán"}')) as e \gset
select pg_temp.t('Admin tự sửa thông tin của mình (không đổi quyền) được', :'e' = '' and default_overtime_type = 'Trong khoán', :'e')
from ot.employees where username = 'an';
select pg_temp.t('Đổi mật khẩu của chính mình qua employeesUpsert giữ phiên hiện tại',
  pg_temp.push('an', pg_temp.emp('An', 'an', '{"password":"1234"}')) = '' and pg_temp.pull_err('an') = '');

-- ===== Xóa tài khoản admin: phải hạ quyền trước =====
select pg_temp.t('Không xóa được tài khoản Admin', pg_temp.push('an', '{"employeesDelete":["Quản trị viên"]}') like '%hạ quyền%');
select pg_temp.t('Xóa công nhân chưa có dữ liệu được (nhận Bình)', pg_temp.push('an', pg_temp.emp('Tạm', 'tam', '{"password":"1234"}')) = ''
  and pg_temp.push('an', '{"employeesDelete":["Tạm"]}') = '' and not exists (select 1 from ot.employees where name = 'Tạm'));

-- ===== Hạ quyền admin khác (còn An); dùng admin phụ "Phó" =====
select pg_temp.push('an', pg_temp.emp('Phó', 'pho', '{"password":"123456","role":"admin","hasTimesheet":false,"notifyManager":true}')) as e \gset
select pg_temp.login('pho', '123456') \gset
select pg_temp.t('Tạo admin phụ "Phó"', :'e' = '' and (select role = 'admin' and notify_manager from ot.employees where username = 'pho'), :'e');
select pg_temp.push('an', pg_temp.emp('Phó', 'pho', '{"role":"worker"}')) as e \gset
select pg_temp.t('An hạ quyền "Phó" xuống công nhân (nhận báo cáo bị tắt)', role = 'worker' and not notify_manager, :'e')
from ot.employees where username = 'pho';
select pg_temp.t('Hạ quyền xóa session của người bị hạ', pg_temp.pull_err('pho') like '%đăng nhập%');
select pg_temp.push('an', pg_temp.emp('Phó', 'pho', '{"role":"admin","notifyManager":true}')) as e \gset
select pg_temp.t('Nâng lại "Phó" lên admin', role = 'admin' and notify_manager and not has_timesheet, :'e')
from ot.employees where username = 'pho';
select pg_temp.login('pho', '123456') \gset

-- ===== Tài khoản gốc "admin" là đường cứu hộ: không hạ quyền / cho nghỉ / xóa =====
select pg_temp.t('Không hạ quyền được tài khoản gốc admin', pg_temp.push('an', pg_temp.emp('Quản trị viên', 'admin', '{"role":"worker"}')) like '%quản trị gốc%');
select pg_temp.t('Không cho tài khoản gốc admin nghỉ việc (kể cả ngày tương lai)',
  pg_temp.push('an', pg_temp.emp('Quản trị viên', 'admin', jsonb_build_object('endDate', to_char(ot.vn_today() + 30, 'YYYY-MM-DD')))) like '%quản trị gốc%');
select pg_temp.t('Không xóa được tài khoản gốc admin', pg_temp.push('an', '{"employeesDelete":["Quản trị viên"]}') like '%quản trị gốc%');
select pg_temp.t('Tài khoản gốc vẫn nguyên (admin, không nghỉ)', role = 'admin' and end_date is null) from ot.employees where username = 'admin';
select pg_temp.t('Vẫn sửa được thông tin khác của tài khoản gốc', pg_temp.push('an', pg_temp.emp('Quản trị viên', 'admin', '{"role":"admin"}')) = '');

-- ===== Luật "còn ít nhất 1 admin đang làm" =====
select pg_temp.push('an', pg_temp.emp('Phó', 'pho', jsonb_build_object('endDate', to_char(ot.vn_today() + 30, 'YYYY-MM-DD')))) as e \gset
select pg_temp.t('Đặt ngày nghỉ việc TƯƠNG LAI cho admin khác: không đá khỏi phiên', :'e' = '' and pg_temp.pull_err('pho') = '', :'e');
-- An và "Quản trị viên" (gốc) còn làm: hạ An vẫn được; để thử luật cuối cùng, tạm cho gốc có end_date bằng SQL
update ot.employees set end_date = ot.vn_today() + 30 where username = 'admin';
select pg_temp.t('Hạ admin cuối cùng (những admin khác đã có ngày nghỉ) bị chặn',
  pg_temp.push('pho', pg_temp.emp('An', 'an', '{"role":"worker"}')) like '%ít nhất một tài khoản Admin%');
select pg_temp.t('Cho admin cuối cùng nghỉ việc bị chặn',
  pg_temp.push('pho', pg_temp.emp('An', 'an', jsonb_build_object('endDate', to_char(ot.vn_today() - 1, 'YYYY-MM-DD')))) like '%ít nhất một tài khoản Admin%');
select pg_temp.t('Lần bị chặn không làm đổi dữ liệu (giao dịch hoàn tác)', role = 'admin' and end_date is null) from ot.employees where username = 'an';
update ot.employees set end_date = null where username = 'admin';
select pg_temp.push('an', pg_temp.emp('Phó', 'pho', jsonb_build_object('endDate', to_char(ot.vn_today(), 'YYYY-MM-DD')))) as e \gset
select pg_temp.t('Đặt ngày nghỉ việc = hôm nay: xóa session của người đó', :'e' = '' and pg_temp.pull_err('pho') like '%đăng nhập%', :'e');
select pg_temp.push('an', pg_temp.emp('Phó', 'pho')) as e \gset
select pg_temp.t('Gỡ ngày nghỉ việc (thiếu endDate = bỏ trống)', end_date is null, :'e') from ot.employees where username = 'pho';
-- Dọn "Phó": hạ quyền rồi xóa
select pg_temp.t('Không xóa thẳng admin "Phó"', pg_temp.push('an', '{"employeesDelete":["Phó"]}') like '%hạ quyền%');
select pg_temp.push('an', pg_temp.emp('Phó', 'pho', '{"role":"worker"}')) as e \gset
select pg_temp.push('an', '{"employeesDelete":["Phó"]}') as e2 \gset
select pg_temp.t('Hạ quyền rồi xóa "Phó" được', :'e' = '' and :'e2' = '' and not exists (select 1 from ot.employees where username = 'pho'), :'e' || :'e2');
-- Sau cùng đặt lại trạng thái chuẩn
select pg_temp.t('Khóa trễ do end_date: admin có end_date quá khứ không dùng được phiên cũ',
  (select pg_temp.err('update ot.employees set end_date = ot.vn_today() - 1 where username = ''admin''')) = ''
  and pg_temp.pull_err('admin') like '%ngừng sử dụng%'
  and (public.app_login('admin', 'admin123') ->> 'error') = 'inactive');
select pg_temp.t('Khóa trễ do end_date: công nhân cũng vậy',
  (select pg_temp.err('update ot.employees set end_date = ot.vn_today() - 1 where username = ''binh''')) = ''
  and pg_temp.pull_err('binh') like '%ngừng sử dụng%'
  and (public.app_login('binh', '1234') ->> 'error') = 'inactive');
update ot.employees set end_date = null where username in ('admin', 'binh');
select pg_temp.login('admin', 'admin123') \gset
select pg_temp.login('binh', '1234') \gset

-- ===== Tên đăng nhập dành riêng =====
select pg_temp.t('Không đặt username "admin" cho người mới', pg_temp.push('an', pg_temp.emp('Mới', 'admin', '{"password":"1234"}')) like '%dành riêng%');
select pg_temp.t('Không đặt username "quantri" cho người mới', pg_temp.push('an', pg_temp.emp('Mới', 'quantri', '{"password":"1234"}')) like '%dành riêng%');
select pg_temp.t('Không đổi username của người khác thành admin', pg_temp.push('an', pg_temp.emp('Bình', 'admin')) like '%dành riêng%');
select pg_temp.t('Dòng admin sẵn có giữ username "admin" thì cập nhật được',
  pg_temp.push('an', pg_temp.emp('Quản trị viên', 'admin', '{"hasTimesheet":false}')) = '');
select pg_temp.t('Không đổi tên đăng nhập của dòng "admin" (đường cứu hộ)', pg_temp.push('an', pg_temp.emp('Quản trị viên', 'ql')) like '%Không đổi tên đăng nhập%');

-- ===== Chấm công cá nhân =====
select pg_temp.t('Admin không chấm công: không ghi được ca',
  pg_temp.push('an', pg_temp.rec('REC_Q_001', 'Quản trị viên', -2)) like '%không chấm công cá nhân%');
select pg_temp.t('Admin không chấm công: không ghi được nghỉ / về sớm',
  pg_temp.push('an', jsonb_build_object('statusUpsert', jsonb_build_array(jsonb_build_object(
    'key', to_char(ot.vn_today() - 1, 'DD/MM/YYYY') || '::Quản trị viên', 'leave', 'FULL')))) like '%không chấm công cá nhân%');
select pg_temp.t('Admin không chấm công: không ghi được cảnh báo sửa sau chốt',
  pg_temp.push('an', jsonb_build_object('alertsUpsert', jsonb_build_array(jsonb_build_object(
    'key', to_char(ot.vn_today() - 1, 'DD/MM/YYYY') || '::Quản trị viên', 'data', '{"beforeCode":"1h"}')))) like '%không chấm công cá nhân%');
select pg_temp.t('Công nhân bị tắt chấm công không tự ghi được ca của mình',
  pg_temp.push('chi', pg_temp.rec('REC_C_001', 'Chi', -2)) like '%không chấm công cá nhân%');
select pg_temp.t('Admin cũng không ghi được ca cho người đã tắt chấm công',
  pg_temp.push('an', pg_temp.rec('REC_C_002', 'Chi', -2)) like '%không chấm công cá nhân%');
select pg_temp.push('an', pg_temp.rec('REC_A_001', 'An', -2)) as e \gset
select pg_temp.t('Admin có chấm công ghi được ca của chính mình', :'e' = '' and exists (select 1 from ot.records where id = 'REC_A_001'), :'e');
select pg_temp.t('Admin khác ghi được ca cho An', pg_temp.push('admin', pg_temp.rec('REC_A_002', 'An', -3)) = '');
select pg_temp.t('Admin ghi được ca cho công nhân', pg_temp.push('admin', pg_temp.rec('REC_B_001', 'Bình', -2)) = '');
select pg_temp.t('Công nhân vẫn chỉ ghi được cho chính mình', pg_temp.push('binh', pg_temp.rec('REC_A_003', 'An', -2)) like '%chính mình%');
-- R17: xóa dữ liệu của người đã tắt chấm công vẫn được
select pg_temp.push('an', jsonb_build_object('statusUpsert', jsonb_build_array(jsonb_build_object(
  'key', to_char(ot.vn_today() - 1, 'DD/MM/YYYY') || '::An', 'leave', 'MORNING')))) as e \gset
select pg_temp.t('An (admin có chấm công) báo nghỉ sáng được', :'e' = '' and exists (select 1 from ot.day_status), :'e');
select pg_temp.push('admin', pg_temp.emp('An', 'an', '{"hasTimesheet":false}')) as e \gset
select pg_temp.t('Tắt chấm công của An', not has_timesheet, :'e') from ot.employees where username = 'an';
select pg_temp.t('Tắt chấm công không xóa dữ liệu cũ, hasRecords vẫn true',
  (pg_temp.pe('admin', 'An') ->> 'hasRecords') = 'true' and exists (select 1 from ot.records where id = 'REC_A_001'));
select pg_temp.push('admin', '{"recordsDelete":["REC_A_001"]}') as e \gset
select pg_temp.t('recordsDelete không đòi hasTimesheet', :'e' = '' and not exists (select 1 from ot.records where id = 'REC_A_001'), :'e');
select pg_temp.push('admin', jsonb_build_object('statusDelete', jsonb_build_array(to_char(ot.vn_today() - 1, 'DD/MM/YYYY') || '::An'))) as e \gset
select pg_temp.t('statusDelete không âm thầm bỏ qua người đã tắt chấm công (và đang là admin)', :'e' = '' and not exists (select 1 from ot.day_status), :'e');
select pg_temp.push('admin', pg_temp.emp('An', 'an', '{"hasTimesheet":true}')) as e \gset

-- ===== Người đã tắt chấm công: sửa dữ liệu CŨ vẫn được (duyệt ô vàng), thêm MỚI thì không =====
select pg_temp.push('admin', jsonb_set(pg_temp.rec('REC_B_LOCK', 'Bình', -4), '{recordsUpsert,0,modifiedAfterLock}', 'true')) as e \gset
select pg_temp.push('admin', jsonb_build_object('statusUpsert', jsonb_build_array(jsonb_build_object(
  'key', to_char(ot.vn_today() - 4, 'DD/MM/YYYY') || '::Bình', 'leave', 'AFTERNOON')))) as e2 \gset
select pg_temp.push('admin', jsonb_build_object('alertsUpsert', jsonb_build_array(jsonb_build_object(
  'key', to_char(ot.vn_today() - 4, 'DD/MM/YYYY') || '::Bình', 'data', '{"beforeCode":"1h"}'::jsonb)))) as e3 \gset
select pg_temp.push('admin', pg_temp.emp('Bình', 'binh', '{"hasTimesheet":false}')) as e4 \gset
select pg_temp.t('Chuẩn bị: Bình có ca đang bị đánh dấu sửa sau chốt rồi bị tắt chấm công',
  :'e' = '' and :'e2' = '' and :'e3' = '' and :'e4' = '' and not (select has_timesheet from ot.employees where username = 'binh')
  and (select modified_after_lock from ot.records where id = 'REC_B_LOCK'), :'e' || :'e2' || :'e3' || :'e4');
select pg_temp.push('admin', pg_temp.rec('REC_B_LOCK', 'Bình', -4)) as e \gset
select pg_temp.t('Duyệt ô vàng (upsert lại ca CÓ SẴN, modifiedAfterLock=false) cho người tắt chấm công: được',
  :'e' = '' and not (select modified_after_lock from ot.records where id = 'REC_B_LOCK'), :'e');
select pg_temp.t('Thêm ca MỚI cho người tắt chấm công: no_timesheet', pg_temp.push('admin', pg_temp.rec('REC_B_NEW', 'Bình', -4)) like '%không chấm công cá nhân%');
select pg_temp.t('Không "cướp" ca của người khác bằng cách dùng id của họ cho người tắt chấm công',
  pg_temp.push('admin', pg_temp.rec('REC_A_002', 'Bình', -3)) like '%không chấm công cá nhân%');
select pg_temp.t('Sửa nghỉ / về sớm CÓ SẴN của người tắt chấm công: được',
  pg_temp.push('admin', jsonb_build_object('statusUpsert', jsonb_build_array(jsonb_build_object(
    'key', to_char(ot.vn_today() - 4, 'DD/MM/YYYY') || '::Bình', 'leave', 'MORNING')))) = '');
select pg_temp.t('Thêm nghỉ / về sớm MỚI cho người tắt chấm công: no_timesheet',
  pg_temp.push('admin', jsonb_build_object('statusUpsert', jsonb_build_array(jsonb_build_object(
    'key', to_char(ot.vn_today() - 5, 'DD/MM/YYYY') || '::Bình', 'leave', 'FULL')))) like '%không chấm công cá nhân%');
select pg_temp.t('Cập nhật cảnh báo CÓ SẴN của người tắt chấm công: được',
  pg_temp.push('admin', jsonb_build_object('alertsUpsert', jsonb_build_array(jsonb_build_object(
    'key', to_char(ot.vn_today() - 4, 'DD/MM/YYYY') || '::Bình', 'data', '{"beforeCode":"2h"}'::jsonb)))) = '');
select pg_temp.t('Cảnh báo MỚI cho người tắt chấm công: no_timesheet',
  pg_temp.push('admin', jsonb_build_object('alertsUpsert', jsonb_build_array(jsonb_build_object(
    'key', to_char(ot.vn_today() - 5, 'DD/MM/YYYY') || '::Bình', 'data', '{"beforeCode":"2h"}'::jsonb)))) like '%không chấm công cá nhân%');
select pg_temp.push('admin', pg_temp.emp('Bình', 'binh', '{"hasTimesheet":true}')) as e \gset
delete from ot.mod_alerts;
delete from ot.day_status;
select pg_temp.t('Dọn: bật lại chấm công cho Bình', has_timesheet, :'e') from ot.employees where username = 'binh';

-- ===== Cảnh báo sau chốt: giới hạn số lượng + chỉ cho ngày đã chốt (công nhân) =====
select pg_temp.t('Công nhân gửi > 40 cảnh báo trong 1 lần: bị từ chối (tính chung giới hạn với ca / nghỉ)',
  pg_temp.push('binh', jsonb_build_object('alertsUpsert', (select jsonb_agg(jsonb_build_object(
    'key', to_char(ot.vn_today() - 6, 'DD/MM/YYYY') || '::Bình', 'data', '{"beforeCode":"1h"}'::jsonb)) from generate_series(1, 41)))) like '%quá nhiều%');
select pg_temp.push('binh', jsonb_build_object('alertsUpsert', jsonb_build_array(jsonb_build_object(
  'key', to_char(ot.vn_today() - 6, 'DD/MM/YYYY') || '::Bình', 'data', '{"beforeCode":"1h"}'::jsonb)))) as e \gset
select pg_temp.t('Công nhân gửi cảnh báo cho ngày CHƯA chốt: bỏ qua êm (không lỗi, không lưu)', :'e' = '' and not exists (select 1 from ot.mod_alerts), :'e');
insert into ot.locked_days (work_date) values (ot.vn_today() - 6);
select pg_temp.push('binh', jsonb_build_object('alertsUpsert', jsonb_build_array(jsonb_build_object(
  'key', to_char(ot.vn_today() - 6, 'DD/MM/YYYY') || '::Bình', 'data', '{"beforeCode":"1h"}'::jsonb)))) as e \gset
select pg_temp.t('Ngày đã chốt: công nhân lưu được cảnh báo của mình', :'e' = '' and (select count(*) from ot.mod_alerts) = 1, :'e');
select pg_temp.push('admin', jsonb_build_object('alertsUpsert', jsonb_build_array(jsonb_build_object(
  'key', to_char(ot.vn_today() - 7, 'DD/MM/YYYY') || '::Bình', 'data', '{"beforeCode":"1h"}'::jsonb)))) as e \gset
select pg_temp.t('Admin không bị ràng buộc ngày chốt', :'e' = '' and (select count(*) from ot.mod_alerts) = 2, :'e');
delete from ot.mod_alerts;
delete from ot.locked_days;

-- ===== Báo cáo Telegram đếm theo hasTimesheet =====
select (ot.vn_today() - min(g)) as wd from generate_series(5, 12) g
 where extract(dow from ot.vn_today() - g) between 1 and 5 \gset
select pg_temp.t('Báo cáo: chỉ đếm người hasTimesheet (An, Bình; không Chi, không Quản trị viên)',
  ot.telegram_build_message(:'wd') like '%Có 2/2 công nhân%' and ot.telegram_build_message(:'wd') like E'%1. An\n2. Bình%'
  and ot.telegram_build_message(:'wd') not like '%Chi%' and ot.telegram_build_message(:'wd') not like '%Quản trị%',
  ot.telegram_build_message(:'wd'));
select pg_temp.push('admin', jsonb_build_object('recordsUpsert', jsonb_build_array(jsonb_build_object(
  'id', 'REC_B_WD', 'employeeName', 'Bình', 'jobContent', 'Làm', 'modifiedAfterLock', false,
  'startTime', to_char(:'wd'::date, 'DD/MM/YYYY') || ' 17:15', 'endTime', to_char(:'wd'::date, 'DD/MM/YYYY') || ' 19:15',
  'workDate', to_char(:'wd'::date, 'DD/MM/YYYY'))))) as e \gset
select pg_temp.t('Báo cáo: Bình đã báo thì không còn trong danh sách thiếu, tổng vẫn 2',
  ot.telegram_build_message(:'wd') like '%Có 1/2 công nhân%' and ot.telegram_build_message(:'wd') like E'%\n1. An%'
  and ot.telegram_build_message(:'wd') not like '%Bình%', :'e');

-- ===== app_pull =====
update ot.employees set tg_chat_id = '555111999', tg_name = '@an_tg', tg_linked_at = now() where username = 'an';
select pg_temp.t('Admin thấy MỌI tài khoản (cả admin) với đủ field mới',
  jsonb_array_length(public.app_pull(pg_temp.tok('admin')) -> 'employees') = 4
  and (select bool_and(x ?& array['role', 'hasTimesheet', 'notifyManager', 'notifyPersonal', 'telegramLinked', 'telegramName', 'telegramLinkedAt',
                                  'name', 'username', 'defaultOvertimeType', 'defaultWorkMode', 'startDate', 'endDate', 'mustChangePassword', 'hasRecords'])
         from jsonb_array_elements(public.app_pull(pg_temp.tok('admin')) -> 'employees') x));
select pg_temp.t('Field của An: admin, có chấm công, đã kết nối Telegram',
  (pe ->> 'role') = 'admin' and (pe ->> 'hasTimesheet') = 'true' and (pe ->> 'telegramLinked') = 'true'
  and (pe ->> 'telegramName') = '@an_tg' and (pe ->> 'telegramLinkedAt') ~ '^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$', pe::text)
from (select pg_temp.pe('admin', 'An') pe) x;
select pg_temp.t('Field của Quản trị viên: không chấm công, chưa kết nối (telegramName / telegramLinkedAt = null)',
  (pe ->> 'hasTimesheet') = 'false' and (pe ->> 'telegramLinked') = 'false' and jsonb_typeof(pe -> 'telegramName') = 'null'
  and jsonb_typeof(pe -> 'telegramLinkedAt') = 'null', pe::text)
from (select pg_temp.pe('admin', 'Quản trị viên') pe) x;
select pg_temp.t('Công nhân chỉ thấy chính mình', jsonb_array_length(d -> 'employees') = 1 and (d -> 'employees' -> 0 ->> 'name') = 'Bình', d -> 'employees' ->> 0)
from (select public.app_pull(pg_temp.tok('binh')) d) x;
select pg_temp.t('Không lộ chat id (admin, công nhân, admin được xem chính mình)',
  public.app_pull(pg_temp.tok('admin'))::text not like '%555111999%' and public.app_pull(pg_temp.tok('an'))::text not like '%555111999%'
  and public.app_pull(pg_temp.tok('binh'))::text not like '%555111999%' and public.app_pull(pg_temp.tok('admin'))::text not like '%tg_chat%');
select pg_temp.t('Có "me" ở cấp trên cùng',
  (d -> 'me') = jsonb_build_object('name', 'An', 'role', 'admin', 'hasTimesheet', true, 'telegramLinked', true, 'telegramName', '@an_tg'), (d -> 'me')::text)
from (select public.app_pull(pg_temp.tok('an')) d) x;
select pg_temp.t('Field cũ còn nguyên (role, name, username, window, supportsRestHours...)',
  d ?& array['ok', 'role', 'name', 'username', 'mustChangePassword', 'serverTime', 'vnToday', 'sig', 'window', 'records', 'holidays',
             'lockedDays', 'dayModAlerts', 'dayStatuses', 'supportsRestHours'], (select string_agg(k, ',') from jsonb_object_keys(d) k))
from (select public.app_pull(pg_temp.tok('admin')) d) x;
-- R11: admin có chấm công nhận thêm ca của chính mình ngoài cửa sổ
select pg_temp.push('admin', pg_temp.rec('REC_A_OLD', 'An', -100)) as e1 \gset
select pg_temp.push('admin', pg_temp.rec('REC_B_OLD', 'Bình', -100)) as e2 \gset
select pg_temp.t('R11: admin có chấm công: cửa sổ hẹp vẫn nhận ca cũ của CHÍNH MÌNH, không nhận ca cũ người khác',
  d::text like '%REC_A_OLD%' and d::text not like '%REC_B_OLD%' and d::text like '%REC_A_002%', :'e1' || :'e2')
from (select public.app_pull(pg_temp.tok('an'), ot.vn_today() - 1, ot.vn_today()) d) x;
select pg_temp.t('R11: admin không chấm công không nhận ca cũ', d::text not like '%REC_A_OLD%' and d::text not like '%REC_B_OLD%')
from (select public.app_pull(pg_temp.tok('admin'), ot.vn_today() - 1, ot.vn_today()) d) x;

-- ===== reset_admin_password chỉ áp cho username 'admin' =====
update ot.employees set failed_attempts = 4, locked_until = now() + interval '10 minutes', end_date = ot.vn_today() + 5, role = 'worker' where username = 'admin';
select pg_temp.login('an', '1234') \gset
select ot.reset_admin_password('matkhaumoi1') as r \gset
select pg_temp.t('reset_admin_password: dòng "admin" đổi mật khẩu, mở khóa, bỏ ngày nghỉ, trả lại quyền admin',
  (public.app_login('admin', 'matkhaumoi1') ->> 'ok') = 'true' and role = 'admin' and end_date is null and locked_until is null and failed_attempts = 0, :'r')
from ot.employees where username = 'admin';
select pg_temp.t('reset_admin_password: Admin khác (An) giữ nguyên mật khẩu và phiên',
  (public.app_login('an', '1234') ->> 'ok') = 'true' and pg_temp.pull_err('an') = '');
select pg_temp.t('reset_admin_password: xóa phiên cũ của dòng "admin"', pg_temp.pull_err('admin') like '%đăng nhập%');
select pg_temp.t('reset_admin_password: mật khẩu cũ của "admin" không còn dùng được', (public.app_login('admin', 'admin123') ->> 'ok') = 'false');
select pg_temp.t('reset_admin_password: mật khẩu ngắn bị từ chối', pg_temp.err('select ot.reset_admin_password(''abc'')') like '%6 ký tự%');
select pg_temp.login('admin', 'matkhaumoi1') \gset

-- ===== Chạy lại supabase_setup.sql: không ghi đè giá trị đã chỉnh =====
update ot.employees set has_timesheet = true, notify_manager = false where username = 'admin';
update ot.employees set has_timesheet = false, notify_personal = false where username = 'binh';
\ir ../supabase_setup.sql
select pg_temp.t('Chạy lại supabase_setup.sql: admin đã chỉnh (có chấm công, tắt nhận báo cáo) không bị reset',
  has_timesheet and not notify_manager and role = 'admin') from ot.employees where username = 'admin';
select pg_temp.t('Chạy lại supabase_setup.sql: cờ của công nhân giữ nguyên', not has_timesheet and not notify_personal and role = 'worker')
from ot.employees where username = 'binh';
select pg_temp.t('Chạy lại supabase_setup.sql: liên kết Telegram và phiên đăng nhập còn nguyên',
  (select tg_chat_id from ot.employees where username = 'an') = '555111999' and pg_temp.pull_err('an') = '');

-- Di trú 1 lần: bảng kiểu cũ (chưa có cột) -> admin = không chấm công + nhận báo cáo; công nhân = mặc định
alter table ot.employees drop column has_timesheet cascade, drop column notify_manager cascade, drop column notify_personal cascade;   -- cascade: bỏ luôn trigger audit_employees_upd (setup tạo lại)
\ir ../supabase_setup.sql
select pg_temp.t('Di trú lần đầu: admin -> không chấm công, nhận báo cáo quản lý',
  count(*) = 2 and bool_and(not has_timesheet and notify_manager and notify_personal), count(*)::text)
from ot.employees where role = 'admin';
select pg_temp.t('Di trú lần đầu: công nhân -> có chấm công, không nhận báo cáo quản lý',
  count(*) = 2 and bool_and(has_timesheet and not notify_manager and notify_personal)) from ot.employees where role = 'worker';
update ot.employees set has_timesheet = true where username = 'an';
\ir ../supabase_setup.sql
select pg_temp.t('Chạy lại sau di trú: không di trú lần nữa', has_timesheet) from ot.employees where username = 'an';

-- ===== anon không gọi trực tiếp ot.* =====
select pg_temp.t('anon không gọi được ot.require_session', pg_temp.anon_err('select ot.require_session(''x'')') like '%permission denied%');
select pg_temp.t('anon không đọc được ot.employees', pg_temp.anon_err('select * from ot.employees') like '%permission denied%');
select pg_temp.t('anon không đọc được ot.sessions', pg_temp.anon_err('select * from ot.sessions') like '%permission denied%');
select pg_temp.t('anon không gọi được ot.bootstrap_admin / reset_admin_password',
  pg_temp.anon_err('select ot.reset_admin_password(''matkhau123'')') like '%permission denied%');
select pg_temp.t('anon gọi app_pull với token sai: lỗi nghiệp vụ, không phải permission denied',
  pg_temp.anon_err('select public.app_pull(''khong-hop-le'')') like '%Phiên đăng nhập%');
select pg_temp.t('anon gọi được app_login', pg_temp.anon_err('select public.app_login(''x'', ''y'')') = '');

\echo ===== KẾT QUẢ =====
select case when ok then 'OK  ' else 'FAIL' end || ' ' || name || case when ok then '' else ' => ' || detail end from results order by n;
select count(*) filter (where ok) || ' đạt, ' || count(*) filter (where not ok) || ' lỗi' from results;
