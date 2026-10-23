-- Kiểm thử Telegram: kết nối theo tài khoản (link_start -> getUpdates giả -> link_status), ngắt kết nối, gửi thử,
-- báo cáo cho nhiều Quản đốc, nhắc cá nhân, thông báo sửa sau chốt / duyệt, đổi token, chạy lại 2 file SQL.
--
-- Chạy trên database MỚI (xem tests/pg-stubs.sql), từ thư mục gốc dự án:
--   createdb -h 127.0.0.1 -p 55432 -U postgres ot_tg
--   psql -X -q -h 127.0.0.1 -p 55432 -U postgres -d ot_tg -v ON_ERROR_STOP=1 \
--        -f tests/pg-stubs.sql -f supabase_setup.sql -f telegram_nhac_cham_cong.sql -f tests/telegram-link.sql | grep -v '^$'
-- Dòng cuối: "N đạt, M lỗi".
-- Telegram được giả lập: net.http_post chỉ ghi vào net.calls; phản hồi getUpdates do test chèn vào net._http_response.
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
-- Gọi RPC Telegram bằng tên người dùng đã đăng nhập, trả về lỗi ('' nếu được)
create function pg_temp.rpc_err(p_fn text, p_user text, p_name text default null) returns text language plpgsql as $$
begin
  if p_name is null then
    execute format('select public.%I(%L)', p_fn, pg_temp.tok(p_user));
  else
    execute format('select public.%I(%L, %L)', p_fn, pg_temp.tok(p_user), p_name);
  end if;
  return '';
exception when others then
  return sqlerrm;
end $$;
-- Một "update" của Telegram getUpdates
create function pg_temp.upd(p_id bigint, p_chat bigint, p_type text, p_text text, p_from jsonb default '{}', p_age_sec int default 0)
returns jsonb language sql as $$
  select jsonb_build_object('update_id', p_id, 'message', jsonb_build_object(
    'message_id', p_id, 'date', extract(epoch from now())::bigint - p_age_sec,
    'chat', jsonb_build_object('id', p_chat, 'type', p_type), 'from', p_from, 'text', p_text))
$$;
create function pg_temp.batch(variadic p jsonb[]) returns text language sql as
$$ select jsonb_build_object('ok', true, 'result', to_jsonb(p))::text $$;
-- Gọi link_status như web (bỏ giới hạn 2 giây để test chạy nhanh)
create function pg_temp.status(p_user text) returns jsonb language plpgsql as $$
begin
  update ot.telegram_config set last_poll_at = null where id = 1;
  return public.app_telegram_link_status(pg_temp.tok(p_user));
end $$;
-- Telegram "trả lời" yêu cầu getUpdates đang chờ rồi gọi link_status
create function pg_temp.round(p_user text, p_status int, p_content text) returns jsonb language plpgsql as $$
begin
  insert into net._http_response (id, status_code, content)
  select poll_request_id, p_status, p_content from ot.telegram_config where id = 1 and poll_request_id is not null;
  if not found then
    raise exception 'không có yêu cầu getUpdates nào đang chờ';
  end if;
  return pg_temp.status(p_user);
end $$;
create function pg_temp.sent(p_chat text) returns text language sql as $$
  select coalesce(string_agg(body ->> 'text', ' | ' order by id), '') from net.calls
   where url like '%/sendMessage' and body ->> 'chat_id' = p_chat
$$;
create function pg_temp.nsend() returns bigint language sql as $$ select count(*) from net.calls where url like '%/sendMessage' $$;
create function pg_temp.ncalls() returns bigint language sql as $$ select count(*) from net.calls $$;

-- ===== Khởi tạo tài khoản =====
do $$ begin perform ot.bootstrap_admin('admin123'); end $$;
select pg_temp.login('admin', 'admin123') \gset
select pg_temp.push('admin', jsonb_build_object('employeesUpsert', jsonb_build_array(
  jsonb_build_object('name', 'An', 'username', 'an', 'password', '1234'),
  jsonb_build_object('name', 'Bình', 'username', 'binh', 'password', '1234'),
  jsonb_build_object('name', 'Quản đốc 2', 'username', 'qd2', 'password', '123456', 'role', 'admin', 'hasTimesheet', false, 'notifyManager', true)))) as e \gset
select pg_temp.t('Khởi tạo 2 công nhân + 1 admin phụ', :'e' = '' and (select count(*) from ot.employees) = 4, :'e');
select pg_temp.login('an', '1234') \gset
select pg_temp.login('binh', '1234') \gset
select pg_temp.login('qd2', '123456') \gset

-- ===== Bot chưa cài =====
select pg_temp.t('Chưa cài bot: link_start báo cách cài (file + telegram_setup)',
  e like '%telegram_nhac_cham_cong.sql%' and e like '%telegram_setup%', e) from (select pg_temp.rpc_err('app_telegram_link_start', 'an') e) x;
select pg_temp.t('Chưa cài bot: app_telegram_test báo cách cài (khi đã có kết nối)', e like '%telegram_setup%', e)
from (select pg_temp.rpc_err('app_telegram_test', 'an') e) x;
select pg_temp.t('Chưa cài bot: link_status vẫn trả lời, chưa kết nối, không gọi Telegram',
  (public.app_telegram_link_status(pg_temp.tok('an')) ->> 'linked') = 'false' and pg_temp.ncalls() = 0);
-- Công nhân chỉ gửi được cảnh báo cho ngày đã chốt
insert into ot.locked_days (work_date) values ('2026-10-16');
-- Trigger sửa sau chốt khi bot chưa cài: không làm hỏng app_push, không gửi gì
select pg_temp.push('an', jsonb_build_object('alertsUpsert', jsonb_build_array(jsonb_build_object(
  'key', '16/10/2026::An', 'data', '{"beforeCode":"2h","afterCode":"3h"}'::jsonb)))) as e \gset
select pg_temp.t('Bot chưa cài: lưu cảnh báo sau chốt vẫn thành công, không gửi tin',
  :'e' = '' and (select count(*) from ot.mod_alerts) = 1 and pg_temp.ncalls() = 0, :'e');
select pg_temp.push('admin', '{"alertsDelete":["16/10/2026::An"]}') as e \gset
select pg_temp.t('Bot chưa cài: duyệt (xóa cảnh báo) vẫn thành công', :'e' = '' and (select count(*) from ot.mod_alerts) = 0, :'e');

-- ===== Cài bot =====
select ot.telegram_setup('123456789:AAHabcdefghijklmnopqrstuvwxyz0123456') as r \gset
select pg_temp.t('telegram_setup chỉ cần token: chat id trống, bot mặc định pxkhuon_bot, bật nhắc',
  chat_id = '' and bot_username = 'pxkhuon_bot' and enabled and update_offset = 0, :'r') from ot.telegram_config;
select pg_temp.t('Lệnh cũ 3 tham số vẫn chạy (không sinh hàm trùng)',
  (select count(*) from pg_proc p where p.pronamespace = 'ot'::regnamespace and p.proname = 'telegram_setup') = 1
  and pg_temp.err('select ot.telegram_setup(''123456789:AAHabcdefghijklmnopqrstuvwxyz0123456'', '''', ''14:00'')') = '');
select pg_temp.t('Có lịch nhận liên kết mỗi phút + lịch nhắc 14:00',
  (select schedule from cron.job where jobname = 'telegram-nhan-lien-ket') = '* * * * *'
  and (select schedule from cron.job where jobname = 'nhac-cham-cong-telegram') = '0 7 * * *');

-- ===== Tạo liên kết =====
select public.app_telegram_link_start(pg_temp.tok('an')) as ls \gset
select :'ls'::jsonb ->> 'url' as url_a0 \gset
select substring(:'url_a0' from 'start=(.+)$') as code_a0 \gset
select public.app_telegram_link_start(pg_temp.tok('an')) ->> 'url' as url_a1 \gset
select substring(:'url_a1' from 'start=(.+)$') as code_a1 \gset
select pg_temp.t('link_start: url t.me/<bot>?start=<mã ≥22 ký tự [A-Za-z0-9_-]>', :'url_a1' ~ '^https://t\.me/pxkhuon_bot\?start=[A-Za-z0-9_-]{22,}$', :'url_a1');
select pg_temp.t('link_start trả botUsername, expiresAt ~15 phút',
  (:'ls'::jsonb ->> 'botUsername') = 'pxkhuon_bot' and (:'ls'::jsonb ->> 'ok') = 'true'
  and ((:'ls'::jsonb ->> 'expiresAt')::timestamptz - now()) between interval '14 minutes' and interval '16 minutes', :'ls');
select pg_temp.t('Mã chỉ lưu dạng băm; mỗi người 1 mã còn hiệu lực (mã cũ bị thay)',
  not exists (select 1 from ot.telegram_link_codes where code_hash = :'code_a1')
  and exists (select 1 from ot.telegram_link_codes where code_hash = ot.hash_token(:'code_a1'))
  and not exists (select 1 from ot.telegram_link_codes where code_hash = ot.hash_token(:'code_a0'))
  and (select count(*) from ot.telegram_link_codes where used_at is null) = 1);
select pg_temp.t('link_start: token sai bị từ chối', pg_temp.err('select public.app_telegram_link_start(''x'')') like '%Phiên đăng nhập%');
select public.app_telegram_link_start(pg_temp.tok('binh')) ->> 'url' as url_b1 \gset
select substring(:'url_b1' from 'start=(.+)$') as code_b1 \gset
select rev as rev_a0 from ot.employees where username = 'an' \gset
select version as mv0 from ot.meta \gset

-- ===== link_status: gọi Telegram (getUpdates) =====
select pg_temp.status('an') as st \gset
select pg_temp.t('link_status khi chưa bấm Start: chưa kết nối, đang chờ',
  (:'st'::jsonb ->> 'linked') = 'false' and (:'st'::jsonb ->> 'pending') = 'true' and (:'st'::jsonb -> 'pollError') = 'null'::jsonb, :'st');
select pg_temp.t('link_status gửi getUpdates: offset 0, limit 100, timeout 0, chỉ message',
  c.url like 'https://api.telegram.org/bot123456789:AAH%/getUpdates' and (c.body ->> 'offset')::int = 0 and (c.body ->> 'limit')::int = 100
  and (c.body ->> 'timeout')::int = 0 and c.body -> 'allowed_updates' = '["message"]'::jsonb
  and c.id = (select poll_request_id from ot.telegram_config), c.url)
from (select * from net.calls order by id desc limit 1) c;
select pg_temp.ncalls() as n0 \gset
update ot.telegram_config set last_poll_at = now();
select public.app_telegram_link_status(pg_temp.tok('an')) as st \gset
select pg_temp.t('Gọi lại trong vòng 2 giây: không hỏi Telegram thêm', pg_temp.ncalls() = :n0);
select pg_temp.status('an') as st \gset
select pg_temp.t('Yêu cầu trước chưa quá 30 giây: không gửi chồng', pg_temp.ncalls() = :n0);
select poll_request_id as req_old from ot.telegram_config \gset
update ot.telegram_config set poll_sent_at = now() - interval '31 seconds';
select pg_temp.status('an') as st \gset
select pg_temp.t('Quá 30 giây chưa có kết quả: coi như mất và gửi lại', pg_temp.ncalls() = :n0 + 1 and (select poll_request_id from ot.telegram_config) > :req_old);

-- ===== Trả lời của Telegram: tin độc hại / không phải tin liên kết bị bỏ qua, tin hợp lệ vẫn xử lý =====
select pg_temp.round('an', 200, pg_temp.batch(
  pg_temp.upd(500, -100777, 'group', '/start ' || :'code_a1', '{"id":1,"username":"grpuser"}'),
  pg_temp.upd(501, 555111222, 'private', 'hello'),
  '{"update_id":502,"message":"xxx"}'::jsonb,
  '{"update_id":503,"message":{"date":1,"chat":{"id":"abc","type":"private"},"text":"/start abc"}}'::jsonb,
  '12'::jsonb,
  '{"update_id":"x","message":{}}'::jsonb,
  pg_temp.upd(504, 555111222, 'private', '/start ' || :'code_a1', '{"id":555111222,"first_name":"An","username":"an_tg"}'),
  pg_temp.upd(505, 555333444, 'private', '/start ' || :'code_b1', '{"id":555333444,"first_name":"Bình"}', 1500)
)) as st \gset
select pg_temp.t('Mã hợp lệ trong chat riêng: kết nối thành công, tên @username',
  (:'st'::jsonb ->> 'linked') = 'true' and (:'st'::jsonb ->> 'telegramName') = '@an_tg' and (:'st'::jsonb ->> 'pending') = 'false'
  and (:'st'::jsonb ->> 'linkedAt') ~ '^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$', :'st');
select pg_temp.t('Chat id được lưu cho đúng tài khoản', tg_chat_id = '555111222' and tg_name = '@an_tg' and tg_linked_at is not null)
from ot.employees where username = 'an';
select pg_temp.t('Offset = update_id lớn nhất + 1 (tin lỗi / độc hại không chặn, không đọc lại)',
  update_offset = 506 and poll_error is null, update_offset::text) from ot.telegram_config;
select pg_temp.t('Bot nhắn xác nhận vào chat vừa kết nối', pg_temp.sent('555111222') like '✅ Đã kết nối Telegram với tài khoản An.%', pg_temp.sent('555111222'));
select pg_temp.t('Chat nhóm bị bỏ qua (không kết nối, không trả lời)', pg_temp.sent('-100777') = '');
select pg_temp.t('Tin quá 20 phút bị bỏ qua (không trả lời), mã của Bình vẫn còn hiệu lực',
  pg_temp.sent('555333444') = '' and exists (select 1 from ot.telegram_link_codes where code_hash = ot.hash_token(:'code_b1') and used_at is null)
  and (select tg_chat_id from ot.employees where username = 'binh') is null);
select pg_temp.t('Mã đã dùng được đánh dấu / xóa, không dùng lại được',
  not exists (select 1 from ot.telegram_link_codes where code_hash = ot.hash_token(:'code_a1') and used_at is null));
select pg_temp.t('Liên kết tăng rev của người đó và version chung (để web thấy thay đổi)',
  (select rev from ot.employees where username = 'an') > :rev_a0 and (select version from ot.meta) > :mv0);

-- Dùng lại mã đã dùng (chat khác): bị từ chối, trả lời hướng dẫn, liên kết cũ không đổi
select pg_temp.round('binh', 200, pg_temp.batch(pg_temp.upd(506, 555333444, 'private', '/start ' || :'code_a1', '{"id":555333444,"first_name":"Kẻ lạ"}'))) as st \gset
select pg_temp.t('Mã chỉ dùng được 1 lần: lần 2 bị từ chối + hướng dẫn bấm lại trên web',
  pg_temp.sent('555333444') like 'Mã kết nối không hợp lệ hoặc đã hết hạn%' and (select tg_chat_id from ot.employees where username = 'an') = '555111222'
  and (select tg_chat_id from ot.employees where username = 'binh') is null);
-- Mã đúng nhưng gửi từ chat nhóm
select pg_temp.round('binh', 200, pg_temp.batch(pg_temp.upd(507, -100888, 'group', '/start ' || :'code_b1', '{"id":9,"first_name":"X"}'))) as st \gset
select pg_temp.t('Mã đúng gửi trong nhóm: không kết nối, mã còn nguyên',
  (:'st'::jsonb ->> 'linked') = 'false' and (:'st'::jsonb ->> 'pending') = 'true' and pg_temp.sent('-100888') = ''
  and exists (select 1 from ot.telegram_link_codes where code_hash = ot.hash_token(:'code_b1') and used_at is null));
-- Tên Telegram chứa HTML / xuống dòng / quá dài
select pg_temp.round('binh', 200, pg_temp.batch(pg_temp.upd(508, 555333444, 'private', '/start ' || :'code_b1',
  jsonb_build_object('id', 555333444, 'first_name', '<b>Hùng</b>&', 'last_name', E'Nguyễn\nVăn ' || repeat('x', 100))))) as st \gset
select pg_temp.t('Bình kết nối; tên Telegram: ≤64 ký tự, không xuống dòng, giữ nguyên chữ HTML (web tự escape)',
  (:'st'::jsonb ->> 'linked') = 'true' and length(tg_name) <= 64 and tg_name like '<b>Hùng</b>&%' and tg_name !~ '[\r\n]', tg_name)
from ot.employees where username = 'binh';
select pg_temp.t('app_pull trả đúng tên Telegram đã làm sạch (không có chat id)',
  (public.app_pull(pg_temp.tok('admin')) -> 'employees')::text like '%<b>Hùng</b>&%' and public.app_pull(pg_temp.tok('admin'))::text !~ '555333444');

-- Mã hết hạn
select public.app_telegram_link_start(pg_temp.tok('binh')) ->> 'url' as url_b2 \gset
select substring(:'url_b2' from 'start=(.+)$') as code_b2 \gset
select pg_temp.status('binh') as st \gset
update ot.telegram_link_codes set expires_at = now() - interval '1 minute' where code_hash = ot.hash_token(:'code_b2');
insert into net._http_response (id, status_code, content)
select poll_request_id, 200, pg_temp.batch(pg_temp.upd(509, 555444555, 'private', '/start ' || :'code_b2', '{"id":555444555,"first_name":"B"}'))
  from ot.telegram_config where poll_request_id is not null;
select ot.telegram_poll();
select pg_temp.t('Mã hết hạn bị từ chối (lần xử lý bằng đường cron), trả lời hướng dẫn',
  pg_temp.sent('555444555') like 'Mã kết nối không hợp lệ hoặc đã hết hạn%' and (select tg_chat_id from ot.employees where username = 'binh') = '555333444'
  and (select update_offset from ot.telegram_config) = 510 and (select poll_request_id from ot.telegram_config) is null);
select pg_temp.ncalls() as n0 \gset
select ot.telegram_poll();
select pg_temp.t('Cron: không còn mã chờ thì không gọi Telegram', pg_temp.ncalls() = :n0);
select pg_temp.status('an') as st \gset
select pg_temp.t('link_status khi không chờ mã: không gọi Telegram, vẫn báo linked', pg_temp.ncalls() = :n0 and (:'st'::jsonb ->> 'linked') = 'true');

-- ===== Lỗi từ Telegram được lưu lại, không văng ra người dùng =====
select public.app_telegram_link_start(pg_temp.tok('an')) ->> 'url' as url_a2 \gset
select substring(:'url_a2' from 'start=(.+)$') as code_a2 \gset
select pg_temp.status('an') as st \gset
select pg_temp.round('an', 409, '{"ok":false,"error_code":409,"description":"Conflict: can''t use getUpdates method while webhook is active"}') as st \gset
select pg_temp.t('409 (webhook): báo pollError rõ ràng, vẫn đang chờ', (:'st'::jsonb ->> 'pollError') like '%409%' and (:'st'::jsonb ->> 'pending') = 'true', :'st');
select pg_temp.round('an', 200, 'day khong phai json') as st \gset
select pg_temp.t('200 nhưng không phải JSON: lưu lỗi, không ném exception', (:'st'::jsonb ->> 'pollError') like '%không đọc được%', :'st');
select pg_temp.round('an', 200, '{"ok":false,"description":"Unauthorized"}') as st \gset
select pg_temp.t('ok=false: lưu mô tả lỗi của Telegram', (:'st'::jsonb ->> 'pollError') like '%Unauthorized%', :'st');
select pg_temp.round('an', 401, '{}') as st \gset
select pg_temp.t('401: báo token sai', (:'st'::jsonb ->> 'pollError') like '%401%', :'st');
insert into net._http_response (id, status_code, timed_out, error_msg)
select poll_request_id, null, true, 'bi-mat-https://api.telegram.org/bot123456789:AAHabcdefghijklmnopqrstuvwxyz0123456' from ot.telegram_config;
select pg_temp.status('an') as st \gset
select pg_temp.t('Hết thời gian chờ: báo không kết nối được, không lộ nội dung lỗi gốc (có thể chứa token)',
  (:'st'::jsonb ->> 'pollError') like '%Không kết nối được Telegram%' and (:'st'::jsonb ->> 'pollError') not like '%bot123%', :'st');
select pg_temp.t('Các lỗi không làm đổi offset', update_offset = 510, update_offset::text) from ot.telegram_config;

-- ===== Liên kết mới đè chat cũ =====
select pg_temp.round('an', 200, pg_temp.batch(pg_temp.upd(510, 666222333, 'private', '/start ' || :'code_a2', '{"id":666222333,"first_name":"An","username":"an2"}'))) as st \gset
select pg_temp.t('Kết nối lại bằng Telegram khác: chat mới + tên mới, lỗi cũ được xóa',
  (:'st'::jsonb ->> 'telegramName') = '@an2' and (select tg_chat_id from ot.employees where username = 'an') = '666222333'
  and (select poll_error from ot.telegram_config) is null and (select update_offset from ot.telegram_config) = 511, :'st');
select pg_temp.t('Chat cũ được báo "vừa được kết nối với một Telegram khác"',
  pg_temp.sent('555111222') like '%Tài khoản An vừa được kết nối với một Telegram khác.%', pg_temp.sent('555111222'));

-- ===== Ngắt liên kết =====
select rev as rev_a1 from ot.employees where username = 'an' \gset
select version as mv1 from ot.meta \gset
select pg_temp.t('Công nhân không ngắt được Telegram của người khác', pg_temp.rpc_err('app_telegram_unlink', 'binh', 'An') like '%chính mình%');
select pg_temp.t('Admin ngắt tên không tồn tại: báo lỗi', pg_temp.rpc_err('app_telegram_unlink', 'admin', 'Không có') like '%Không tìm thấy%');
select pg_temp.rpc_err('app_telegram_unlink', 'an') as e \gset
select pg_temp.t('An tự ngắt liên kết của mình', :'e' = '' and tg_chat_id is null and tg_name is null and tg_linked_at is null, :'e')
from ot.employees where username = 'an';
select pg_temp.t('Ngắt liên kết tăng rev + version', (select rev from ot.employees where username = 'an') > :rev_a1 and (select version from ot.meta) > :mv1);
select pg_temp.t('Ngắt liên kết 2 lần không lỗi', pg_temp.rpc_err('app_telegram_unlink', 'an') = '');
select pg_temp.rpc_err('app_telegram_unlink', 'admin', 'Bình') as e \gset
select pg_temp.t('Admin ngắt liên kết của Bình theo tên', :'e' = '' and tg_chat_id is null, :'e') from ot.employees where username = 'binh';
select pg_temp.t('app_pull sau khi ngắt: telegramLinked=false',
  (x ->> 'telegramLinked') = 'false' and jsonb_typeof(x -> 'telegramName') = 'null' and jsonb_typeof(x -> 'telegramLinkedAt') = 'null', x::text)
from (select e x from jsonb_array_elements(public.app_pull(pg_temp.tok('admin')) -> 'employees') e where e ->> 'name' = 'An') s;
select public.app_telegram_link_start(pg_temp.tok('an')) as ls \gset
select pg_temp.rpc_err('app_telegram_unlink', 'an');
select pg_temp.t('Ngắt liên kết cũng hủy mã đang chờ', not exists (select 1 from ot.telegram_link_codes where used_at is null));

-- ===== Gửi thử cho tài khoản =====
select pg_temp.t('Gửi thử khi chưa kết nối: báo lỗi', pg_temp.rpc_err('app_telegram_test', 'an') like '%chưa kết nối Telegram%');
update ot.employees set tg_chat_id = '700100100', tg_name = '@an_tg', tg_linked_at = now() where username = 'an';
select pg_temp.t('Công nhân không gửi thử cho người khác', pg_temp.rpc_err('app_telegram_test', 'binh', 'An') like '%chính mình%');
select pg_temp.ncalls() as n0 \gset
select pg_temp.t('An gửi thử cho chính mình', pg_temp.rpc_err('app_telegram_test', 'an') = '' and pg_temp.sent('700100100') like '%Tin thử%', pg_temp.sent('700100100'));
select pg_temp.t('Admin gửi thử cho An theo tên', pg_temp.rpc_err('app_telegram_test', 'admin', 'An') = '' and pg_temp.ncalls() = :n0 + 2);
select pg_temp.t('Không lộ chat id qua app_pull / link_status',
  public.app_pull(pg_temp.tok('admin'))::text !~ '700100100' and public.app_pull(pg_temp.tok('an'))::text !~ '700100100'
  and public.app_telegram_link_status(pg_temp.tok('an'))::text !~ '700100100');

-- ===== Đổi token / tên bot =====
update ot.telegram_config set update_offset = 999, poll_request_id = 12345, poll_sent_at = now(), poll_error = 'x';
select ot.telegram_setup('123456789:AAHabcdefghijklmnopqrstuvwxyz0123456') as r \gset
select pg_temp.t('Cài lại CÙNG token: giữ offset / yêu cầu đang chờ / tên bot',
  update_offset = 999 and poll_request_id = 12345 and bot_username = 'pxkhuon_bot' and :'r' not like '%bot mới%', :'r') from ot.telegram_config;
select ot.telegram_setup('987654321:BBHabcdefghijklmnopqrstuvwxyz0123456', '', '14:00') as r \gset
select pg_temp.t('Đổi sang token KHÁC: reset offset / yêu cầu / lỗi, báo mọi người bấm Start lại',
  update_offset = 0 and poll_request_id is null and poll_sent_at is null and poll_error is null
  and bot_token = '987654321:BBHabcdefghijklmnopqrstuvwxyz0123456' and :'r' like '%bấm "Kết nối Telegram" lại%', :'r') from ot.telegram_config;
select pg_temp.t('Tên bot sai dạng bị từ chối', pg_temp.err('select ot.telegram_setup(''987654321:BBHabcdefghijklmnopqrstuvwxyz0123456'', '''', ''14:00'', ''a b'')') like '%Tên bot%');
select ot.telegram_setup('987654321:BBHabcdefghijklmnopqrstuvwxyz0123456', '', '14:00', '@khac_bot');
select pg_temp.t('Tên bot (tham số 4) đổi liên kết t.me', public.app_telegram_link_start(pg_temp.tok('an')) ->> 'url' like 'https://t.me/khac_bot?start=%');
select ot.telegram_setup('123456789:AAHabcdefghijklmnopqrstuvwxyz0123456', '', '14:00', 'pxkhuon_bot');
select pg_temp.rpc_err('app_telegram_unlink', 'an');
update ot.employees set tg_chat_id = '700100100', tg_name = '@an_tg', tg_linked_at = now() where username = 'an';

-- ===== Chạy lại 2 file SQL (và setup sau telegram) không mất gì =====
update ot.telegram_config set update_offset = 777;
select public.app_telegram_link_start(pg_temp.tok('binh')) ->> 'url' as url_b3 \gset
select count(*) as codes0 from ot.telegram_link_codes \gset
\ir ../telegram_nhac_cham_cong.sql
\ir ../supabase_setup.sql
\ir ../telegram_nhac_cham_cong.sql
\ir ../supabase_setup.sql
select pg_temp.t('Chạy lại: giữ token, tên bot, offset, giờ nhắc',
  bot_token = '123456789:AAHabcdefghijklmnopqrstuvwxyz0123456' and bot_username = 'pxkhuon_bot' and update_offset = 777 and remind_time = '14:00' and enabled,
  update_offset::text) from ot.telegram_config;
select pg_temp.t('Chạy lại: giữ liên kết Telegram và mã đang chờ',
  (select tg_chat_id from ot.employees where username = 'an') = '700100100'
  and (select count(*) from ot.telegram_link_codes) = :codes0 and :codes0 >= 1);
select pg_temp.t('Chạy lại: trigger mod_alerts còn đủ 3 cái, mỗi cron job đúng 1',
  (select count(*) from pg_trigger where tgrelid = 'ot.mod_alerts'::regclass and not tgisinternal and tgname like 'tg_%') = 3
  and (select count(*) from cron.job where jobname = 'telegram-nhan-lien-ket') = 1
  and (select count(*) from cron.job where jobname = 'nhac-cham-cong-telegram') = 1);
select pg_temp.t('Chạy lại: link_status / link_start vẫn dùng được', pg_temp.rpc_err('app_telegram_link_start', 'an') = '' and pg_temp.rpc_err('app_telegram_link_status', 'an') = '');
select pg_temp.rpc_err('app_telegram_unlink', 'an');
update ot.employees set tg_chat_id = '700100100', tg_name = '@an_tg', tg_linked_at = now() where username = 'an';
delete from ot.telegram_link_codes;

-- ===== Báo cáo hằng ngày cho nhiều Quản đốc + nhắc cá nhân =====
create or replace function ot.vn_today() returns date language sql stable as $$ select date '2026-10-17' $$;

-- Cài đặt CŨ (có token + chat id, chưa có tên bot) chạy lại file rồi telegram_setup('TOKEN'): giữ chat id, điền tên bot
update ot.telegram_config set bot_username = '', chat_id = '-1009';
\ir ../telegram_nhac_cham_cong.sql
select pg_temp.t('Cài đặt cũ chạy lại file: tự điền tên bot mặc định, giữ token và chat id',
  bot_username = 'pxkhuon_bot' and chat_id = '-1009' and bot_token = '123456789:AAHabcdefghijklmnopqrstuvwxyz0123456') from ot.telegram_config;
delete from net.calls;
select ot.telegram_daily_remind();
select pg_temp.t('Báo cáo hằng ngày vẫn gửi cho chat chung cũ (chưa ai kết nối)',
  pg_temp.sent('-1009') like '⏰ Nhắc báo công – Thứ Sáu 16/10/2026%' and pg_temp.sent('-1009') like '%Có 2/2 công nhân%', pg_temp.sent('-1009'));
select ot.telegram_setup('123456789:AAHabcdefghijklmnopqrstuvwxyz0123456');
select pg_temp.t('telegram_setup chỉ token: GIỮ chat id đã lưu', chat_id = '-1009' and bot_username = 'pxkhuon_bot') from ot.telegram_config;
select ot.telegram_setup('123456789:AAHabcdefghijklmnopqrstuvwxyz0123456', NULL, '15:00');
select pg_temp.t('Gọi 3 tham số với chat id NULL: vẫn giữ chat id, đổi giờ', chat_id = '-1009' and remind_time = '15:00') from ot.telegram_config;
select ot.telegram_setup('123456789:AAHabcdefghijklmnopqrstuvwxyz0123456', '-1008');
select pg_temp.t('Ghi chat id mới (2 tham số): thay chat chung', chat_id = '-1008') from ot.telegram_config;
select ot.telegram_setup('123456789:AAHabcdefghijklmnopqrstuvwxyz0123456', '');
select pg_temp.t('Ghi chat id rỗng: xóa chat chung', chat_id = '') from ot.telegram_config;
select pg_temp.t('Chỉ có 1 hàm ot.telegram_setup (không sinh overload trùng)',
  (select count(*) from pg_proc p where p.pronamespace = 'ot'::regnamespace and p.proname = 'telegram_setup') = 1);
select ot.telegram_setup('123456789:AAHabcdefghijklmnopqrstuvwxyz0123456', '-1001', '14:00');
insert into ot.employees (name, username, password_hash, role, end_date, has_timesheet, notify_manager, notify_personal, tg_chat_id, tg_name, tg_linked_at) values
  ('Trưởng ca', 'truongca', 'x', 'admin', null, false, false, true, '9003', '@tc', now()),
  ('Cũ nghỉ', 'cunghi', 'x', 'admin', '2026-10-01', false, true, true, '9004', '@cu', now()),
  ('Trùng', 'trung', 'x', 'admin', null, false, true, true, '-1001', '@nhom', now()),
  ('Chi', 'chi', 'x', 'worker', null, true, false, true, '7003', '@chi', now()),
  ('Dũng', 'dung', 'x', 'worker', null, false, false, true, '7004', '@dung', now());
update ot.employees set tg_chat_id = '9001', tg_name = '@qd2', tg_linked_at = now() where username = 'qd2';
update ot.employees set tg_chat_id = '9002', tg_name = '@qt', tg_linked_at = now() where username = 'admin';
update ot.employees set tg_chat_id = '7002', tg_name = '@binh', tg_linked_at = now(), notify_personal = false where username = 'binh';
insert into ot.records (id, employee_id, job_content, start_time, end_time, start_ts, end_ts, work_date, receipt_id)
select 'rec-chi-1610', id, 'Làm', '16/10/2026 17:15', '16/10/2026 19:15', timestamp '2026-10-16 17:15', timestamp '2026-10-16 19:15', date '2026-10-16', 'rc'
  from ot.employees where username = 'chi';
delete from net.calls;
select pg_temp.t('Người nhận báo cáo: admin bật nhận + đã kết nối + còn làm, cộng chat chung, bỏ trùng',
  array(select ot.telegram_recipients()) = array['-1001', '9001', '9002'], array_to_string(array(select ot.telegram_recipients()), ','));
select ot.telegram_daily_remind();
select pg_temp.t('Báo cáo gửi cho 2 Quản đốc + chat chung (có chấm công: An, Bình, Chi; Chi đã báo)',
  pg_temp.sent('9001') like E'⏰ Nhắc báo công – Thứ Sáu 16/10/2026\nCó 2/3 công nhân%1. An\n2. Bình%'
  and pg_temp.sent('9002') = pg_temp.sent('9001') and pg_temp.sent('-1001') = pg_temp.sent('9001') and pg_temp.sent('9001') not like '%📝%',
  pg_temp.sent('9001'));
select pg_temp.t('Không gửi báo cáo cho admin tắt nhận, đã nghỉ việc', pg_temp.sent('9003') = '' and pg_temp.sent('9004') = '');
select pg_temp.t('Nhắc cá nhân đúng nội dung cho người thiếu báo công (An)',
  pg_temp.sent('700100100') = '⏰ An ơi, bạn chưa báo công ngày Thứ Sáu 16/10/2026. Đi làm bình thường cũng cần vào trang chấm công bấm báo công (đi làm đủ / tăng ca / nghỉ / về sớm), nếu không ngày đó sẽ không được tính công.',
  pg_temp.sent('700100100'));
select pg_temp.t('Không nhắc: người tắt nhận thông báo cá nhân, người đã báo, người không chấm công, admin',
  pg_temp.sent('7002') = '' and pg_temp.sent('7003') = '' and pg_temp.sent('7004') = '' and pg_temp.sent('9001') not like '%ơi, bạn chưa báo%');
select pg_temp.t('Tổng 4 tin (3 báo cáo + 1 nhắc cá nhân)', pg_temp.nsend() = 4, pg_temp.nsend()::text);
select pg_temp.t('Người nhận chat chung là một Quản đốc cũng không bị gửi 2 lần', (select count(*) from net.calls where body ->> 'chat_id' = '-1001') = 1);

-- telegram_check cho nhiều tin
select pg_temp.t('telegram_check: chưa có phản hồi thì báo đang gửi', ot.telegram_check() like '%đang gửi%', ot.telegram_check());
insert into net._http_response (id, status_code, content) select unnest(last_request_ids), 200, '{"ok":true}' from ot.telegram_config;
select pg_temp.t('telegram_check: 3/3 đã nhận', cardinality(last_request_ids) = 3 and ot.telegram_check() like '%Telegram đã nhận cả 3 tin%', ot.telegram_check()) from ot.telegram_config;
update net._http_response set status_code = 400, content = '{"ok":false,"description":"Bad Request: chat not found"}' where id = (select last_request_ids[2] from ot.telegram_config);
select pg_temp.t('telegram_check: 1 tin lỗi chat not found thì báo CHAT_ID sai', ot.telegram_check() like '%CHAT_ID sai%', ot.telegram_check());

-- telegram_test gửi báo cáo [Gửi thử] cho mọi người nhận báo cáo
delete from net.calls;
select ot.telegram_test('2026-10-16');
select pg_temp.t('telegram_test gửi báo cáo [Gửi thử] cho cả 3 người nhận',
  pg_temp.nsend() = 3 and pg_temp.sent('9001') like E'[Gửi thử]\n⏰ Nhắc báo công – Thứ Sáu 16/10/2026%' and pg_temp.sent('9002') <> '' and pg_temp.sent('-1001') <> '');
select pg_temp.t('Báo cáo không còn câu "đi làm bình thường thì bỏ qua"', pg_temp.sent('9001') not like '%bỏ qua%', pg_temp.sent('9001'));

-- An báo "đi làm đủ" (dòng day_status rỗng): coi như đã báo công, không còn trong danh sách
insert into ot.day_status (employee_id, work_date, leave, early_hours)
select id, date '2026-10-16', '', 0 from ot.employees where name = 'An';
delete from net.calls;
select ot.telegram_test('2026-10-16');
select pg_temp.t('Đi làm đủ (không tăng ca) = đã báo công: chỉ còn Bình chưa báo',
  pg_temp.sent('9001') like E'%Có 1/3 công nhân chưa báo công:\n1. Bình%' and pg_temp.sent('9001') not like '%An%', pg_temp.sent('9001'));
delete from ot.day_status where work_date = date '2026-10-16' and employee_id = (select id from ot.employees where name = 'An');

-- Ngày nghỉ: không gửi gì (cả báo cáo lẫn nhắc cá nhân)
delete from net.calls;
insert into ot.holidays values ('2026-10-16', 'Nghỉ lễ thử');
select ot.telegram_daily_remind();
select pg_temp.t('Hôm trước là ngày lễ: không gửi báo cáo, không nhắc cá nhân', pg_temp.nsend() = 0);
delete from ot.holidays;
create or replace function ot.vn_today() returns date language sql stable as $$ select date '2026-10-19' $$;
select ot.telegram_daily_remind();
select pg_temp.t('Hôm trước là Chủ nhật: không gửi gì', pg_temp.nsend() = 0);
create or replace function ot.vn_today() returns date language sql stable as $$ select date '2026-10-17' $$;

-- ===== Thông báo sửa sau chốt / duyệt =====
select pg_temp.login('an', '1234') \gset
delete from net.calls;
select pg_temp.push('an', jsonb_build_object('alertsUpsert', jsonb_build_array(jsonb_build_object(
  'key', '16/10/2026::An', 'data', '{"beforeCode":"2h","afterCode":"3h"}'::jsonb)))) as e \gset
select pg_temp.t('Sửa sau chốt: báo cho 3 người nhận báo cáo quản lý, đúng nội dung',
  :'e' = '' and pg_temp.nsend() = 3
  and pg_temp.sent('9001') = '✏️ Sửa sau chốt – An, ngày Thứ Sáu 16/10/2026: 2h → 3h. Vào trang Quản lý để duyệt.'
  and pg_temp.sent('9002') = pg_temp.sent('9001') and pg_temp.sent('-1001') = pg_temp.sent('9001'), :'e' || pg_temp.sent('9001'));
select pg_temp.t('Tin báo không dùng parse_mode', not exists (select 1 from net.calls where url like '%/sendMessage' and body ? 'parse_mode'));
select pg_temp.push('an', jsonb_build_object('alertsUpsert', jsonb_build_array(jsonb_build_object(
  'key', '16/10/2026::An', 'data', '{"beforeCode":"2h","afterCode":"3h"}'::jsonb)))) as e \gset
select pg_temp.t('Lưu lại đúng dữ liệu cũ: không báo lại', :'e' = '' and pg_temp.nsend() = 3);
select pg_temp.push('an', jsonb_build_object('alertsUpsert', jsonb_build_array(jsonb_build_object(
  'key', '16/10/2026::An', 'data', '{"beforeCode":"2h","afterCode":"9h"}'::jsonb)))) as e \gset
select pg_temp.t('Sửa tiếp cùng ô trong vòng 10 phút: không báo lại (chống dồn dập), nhưng dữ liệu vẫn lưu',
  :'e' = '' and pg_temp.nsend() = 3 and (select data ->> 'afterCode' from ot.mod_alerts where alert_key = '16/10/2026::An') = '9h', :'e');
select pg_temp.t('Ô khác (người + ngày khác) không bị ảnh hưởng bởi giới hạn', (select count(*) from ot.telegram_alert_sent) = 1);
update ot.telegram_alert_sent set sent_at = now() - interval '11 minutes';
select pg_temp.push('an', jsonb_build_object('alertsUpsert', jsonb_build_array(jsonb_build_object(
  'key', '16/10/2026::An', 'data', jsonb_build_object('beforeCode', repeat('a', 500), 'afterCode', E'4h\nx', 'oldStatus', 'Nghỉ sáng'))))) as e \gset
select pg_temp.t('Sau 10 phút dữ liệu đổi: báo lại, phần trước/sau cắt ≤60 ký tự, bỏ xuống dòng',
  :'e' = '' and pg_temp.nsend() = 6 and pg_temp.sent('9001') like '%' || repeat('a', 60) || '%' and pg_temp.sent('9001') not like '%' || repeat('a', 61) || '%'
  and pg_temp.sent('9001') like '%4h x%', length(pg_temp.sent('9001'))::text);
select pg_temp.t('Còn 1 thay đổi chưa duyệt -> báo cáo hằng ngày có dòng nhắc', ot.telegram_alert_line() like E'%📝 Còn 1 thay đổi sau chốt chưa duyệt%');
delete from net.calls;
select ot.telegram_daily_remind();
select pg_temp.t('Báo cáo hằng ngày kèm dòng "Còn N thay đổi sau chốt chưa duyệt"', pg_temp.sent('9001') like E'%\n\n📝 Còn 1 thay đổi sau chốt chưa duyệt.%', pg_temp.sent('9001'));
-- Duyệt (chỉ tính là duyệt khi ngày vẫn đang chốt)
insert into ot.locked_days (work_date) values (date '2026-10-16') on conflict do nothing;
delete from net.calls;
select pg_temp.push('admin', '{"alertsDelete":["16/10/2026::An"]}') as e \gset
select pg_temp.t('Quản đốc duyệt: báo cho người bị sửa (An)',
  :'e' = '' and pg_temp.sent('700100100') = '✅ Quản đốc đã duyệt thay đổi sau chốt ngày Thứ Sáu 16/10/2026 của bạn.' and pg_temp.nsend() = 1, :'e' || pg_temp.sent('700100100'));
-- Người tắt nhận thông báo cá nhân (Bình) không nhận tin duyệt
select pg_temp.push('binh', jsonb_build_object('alertsUpsert', jsonb_build_array(jsonb_build_object(
  'key', '16/10/2026::Bình', 'data', '{"beforeCode":"0","afterCode":"1h"}'::jsonb)))) as e \gset
delete from net.calls;
select pg_temp.push('admin', '{"alertsDelete":["16/10/2026::Bình"]}') as e \gset
select pg_temp.t('Duyệt cho người tắt thông báo cá nhân: không gửi', :'e' = '' and pg_temp.nsend() = 0, :'e');
-- Bỏ chốt ngày (lockedDelete + alertsDelete cùng lần lưu) cũng xóa cảnh báo nhưng KHÔNG phải duyệt: không báo
select pg_temp.push('an', jsonb_build_object('alertsUpsert', jsonb_build_array(jsonb_build_object(
  'key', '16/10/2026::An', 'data', '{"beforeCode":"2h","afterCode":"3h"}'::jsonb)))) as e \gset
delete from net.calls;
select pg_temp.push('admin', '{"lockedDelete":["16/10/2026"],"alertsDelete":["16/10/2026::An"]}') as e \gset
select pg_temp.t('Bỏ chốt ngày có ô vàng: không gửi tin "đã duyệt"',
  :'e' = '' and pg_temp.nsend() = 0 and not exists (select 1 from ot.mod_alerts where alert_key = '16/10/2026::An')
  and not exists (select 1 from ot.locked_days where work_date = date '2026-10-16'), :'e' || pg_temp.nsend());
-- Xóa nhân viên kéo theo xóa cảnh báo: không báo
insert into ot.employees (name, username, password_hash) values ('Xóa thử', 'xoathu', 'x');
insert into ot.mod_alerts (alert_key, work_date, employee_id, data) select '16/10/2026::Xóa thử', date '2026-10-16', id, '{"beforeCode":"1h"}' from ot.employees where username = 'xoathu';
insert into ot.locked_days (work_date) values (date '2026-10-16') on conflict do nothing;   -- ngày đang chốt: chỉ còn lý do "nhân viên đã mất" để không báo
delete from net.calls;
delete from ot.employees where username = 'xoathu';
select pg_temp.t('Xóa nhân viên (cascade xóa cảnh báo): không gửi tin duyệt, không lỗi', pg_temp.nsend() = 0 and not exists (select 1 from ot.mod_alerts));
-- Mạng hỏng: trigger vẫn không làm hỏng app_push
create or replace function net.http_post(url text, body jsonb default '{}', params jsonb default '{}', headers jsonb default '{"Content-Type": "application/json"}', timeout_milliseconds int default 5000)
returns bigint language plpgsql as $$ begin raise exception 'mạng hỏng'; end $$;
select pg_temp.push('an', jsonb_build_object('alertsUpsert', jsonb_build_array(jsonb_build_object(
  'key', '16/10/2026::An', 'data', '{"beforeCode":"5h","afterCode":"6h"}'::jsonb)))) as e \gset
select pg_temp.t('pg_net lỗi: app_push vẫn thành công, cảnh báo vẫn được lưu',
  :'e' = '' and (select data ->> 'afterCode' from ot.mod_alerts where alert_key = '16/10/2026::An') = '6h', :'e');
select pg_temp.push('admin', '{"alertsDelete":["16/10/2026::An"]}') as e \gset
select pg_temp.t('pg_net lỗi: duyệt vẫn thành công', :'e' = '' and not exists (select 1 from ot.mod_alerts), :'e');
create or replace function net.http_post(url text, body jsonb default '{}', params jsonb default '{}', headers jsonb default '{"Content-Type": "application/json"}', timeout_milliseconds int default 5000)
returns bigint language sql as $$ insert into net.calls (url, body, headers, timeout) values (url, body, headers, timeout_milliseconds) returning id $$;
-- Bot tắt: trigger im lặng
select ot.telegram_off();
delete from net.calls;
select pg_temp.push('an', jsonb_build_object('alertsUpsert', jsonb_build_array(jsonb_build_object(
  'key', '16/10/2026::An', 'data', '{"beforeCode":"7h","afterCode":"8h"}'::jsonb)))) as e \gset
select ot.telegram_daily_remind();
select pg_temp.t('Đã tắt bot: trigger và báo cáo hằng ngày đều im lặng', :'e' = '' and pg_temp.nsend() = 0, :'e');
select ot.telegram_set_time('14:00');
delete from ot.mod_alerts;

-- telegram_test khi chưa ai nhận báo cáo
update ot.employees set notify_manager = false where role = 'admin';
update ot.telegram_config set chat_id = '';
select pg_temp.t('telegram_test khi chưa có người nhận báo cáo: báo cách xử lý', pg_temp.err('select ot.telegram_test()') like '%Chưa có ai nhận báo cáo quản lý%');
select pg_temp.t('Daily không lỗi khi chưa có người nhận', pg_temp.err('select ot.telegram_daily_remind()') = '');

-- ===== anon không đụng được vào phần bot =====
select pg_temp.t('anon không gọi được ot.telegram_poll', pg_temp.anon_err('select ot.telegram_poll()') like '%permission denied%');
select pg_temp.t('anon không gọi được ot.tg_post', pg_temp.anon_err('select ot.tg_post(''1'', ''x'')') like '%permission denied%');
select pg_temp.t('anon không gọi được ot.telegram_send', pg_temp.anon_err('select ot.telegram_send(''x'')') like '%permission denied%');
select pg_temp.t('anon không đọc được ot.telegram_config (token)', pg_temp.anon_err('select bot_token from ot.telegram_config') like '%permission denied%');
select pg_temp.t('anon không đọc được ot.telegram_link_codes', pg_temp.anon_err('select * from ot.telegram_link_codes') like '%permission denied%');
select pg_temp.t('anon gọi app_telegram_* với token sai: lỗi nghiệp vụ "Phiên đăng nhập"',
  pg_temp.anon_err('select public.app_telegram_link_start(''x'')') like '%Phiên đăng nhập%'
  and pg_temp.anon_err('select public.app_telegram_link_status(''x'')') like '%Phiên đăng nhập%'
  and pg_temp.anon_err('select public.app_telegram_unlink(''x'')') like '%Phiên đăng nhập%'
  and pg_temp.anon_err('select public.app_telegram_test(''x'', ''An'')') like '%Phiên đăng nhập%');

\echo ===== KẾT QUẢ =====
select case when ok then 'OK  ' else 'FAIL' end || ' ' || name || case when ok then '' else ' => ' || detail end from results order by n;
select count(*) filter (where ok) || ' đạt, ' || count(*) filter (where not ok) || ' lỗi' from results;
