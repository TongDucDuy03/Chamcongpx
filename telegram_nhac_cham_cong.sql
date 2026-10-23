-- =====================================================================
-- BOT TELEGRAM: NHẮC CHẤM CÔNG, BÁO CÁO CHO QUẢN ĐỐC, KẾT NỐI TELEGRAM THEO TỪNG TÀI KHOẢN
--
-- Chạy SAU file supabase_setup.sql. Chạy lại nhiều lần vẫn an toàn, không mất cài đặt
-- (token, giờ nhắc, các liên kết Telegram đã kết nối, vị trí đọc tin đều được giữ).
--
-- Cách dùng (chi tiết xem README, mục "Bot Telegram"):
--   1. Supabase -> SQL Editor -> New query -> dán TOÀN BỘ file này -> Run.
--   2. Lưu bot và hẹn giờ nhắc 14:00 hằng ngày (tên bot là phần sau t.me/, không có @):
--        select ot.telegram_setup('TOKEN_CUA_BOT');
--      Có nhóm Quản đốc dùng chung thì thêm chat id nhóm:  select ot.telegram_setup('TOKEN_CUA_BOT', 'CHAT_ID');
--      Bot khác tên mặc định pxkhuon_bot:                  select ot.telegram_setup('TOKEN_CUA_BOT', NULL, '14:00', 'ten_bot');
--      (Không ghi chat id = giữ chat id đã lưu; muốn xóa chat chung thì ghi '' .)
--   3. Mỗi người tự bấm "Kết nối Telegram" trong web (Nhân sự & Tài khoản hoặc trang cá nhân) để gắn Telegram của mình.
--   4. Gửi thử báo cáo cho Quản đốc:  select ot.telegram_test();   Xem kết quả:  select ot.telegram_check();
--   Đổi giờ nhắc:  select ot.telegram_set_time('15:30');
--   Tắt nhắc:      select ot.telegram_off();
--
-- Bot làm gì:
--   * Báo cáo hằng ngày cho mọi Admin bật "Nhận báo cáo quản lý" (và nhóm dùng chung nếu có): ai có chấm công
--     mà ngày hôm trước chưa báo công (không báo đi làm đủ, không có ca tăng ca, không báo nghỉ / về sớm).
--     Hôm trước là Chủ nhật / ngày lễ thì không gửi.
--   * Nhắc riêng từng người chưa báo công (nếu người đó bật "Nhận thông báo cá nhân" và đã kết nối Telegram).
--   * Báo ngay cho Quản đốc khi có người sửa sau chốt công; báo lại cho người đó khi Quản đốc duyệt.
-- =====================================================================

-- pg_net: gửi tin nhắn ra Telegram.  pg_cron: hẹn giờ chạy hằng ngày.
do $$
begin
  if to_regprocedure('net.http_post(text,jsonb,jsonb,jsonb,integer)') is null then
    begin
      create extension if not exists pg_net with schema extensions;
    exception when others then
      raise exception 'Cần bật pg_net: Database -> Extensions -> tìm "pg_net" -> Enable, rồi chạy lại file này. (Lỗi gốc: %)', sqlerrm;
    end;
  end if;
  if to_regnamespace('cron') is null then
    begin
      create extension if not exists pg_cron with schema pg_catalog;
    exception when others then
      raise exception 'Cần bật pg_cron: Database -> Extensions -> tìm "pg_cron" -> Enable, rồi chạy lại file này. (Lỗi gốc: %)', sqlerrm;
    end;
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 1. CÀI ĐẶT BOT (nằm trong schema "ot", web không đọc được)
-- ---------------------------------------------------------------------

create table if not exists ot.telegram_config (
  id int primary key default 1 check (id = 1),
  bot_token text not null default '',
  chat_id text not null default '',
  remind_time text not null default '14:00',
  enabled boolean not null default false,
  last_request_id bigint,
  updated_at timestamptz not null default now()
);
insert into ot.telegram_config (id) values (1) on conflict (id) do nothing;

-- Phần nhận liên kết Telegram (thêm cột, không đụng giá trị đã có)
alter table ot.telegram_config add column if not exists bot_username text not null default '';
alter table ot.telegram_config add column if not exists update_offset bigint not null default 0;
alter table ot.telegram_config add column if not exists poll_request_id bigint;
alter table ot.telegram_config add column if not exists poll_sent_at timestamptz;
alter table ot.telegram_config add column if not exists poll_error text;
alter table ot.telegram_config add column if not exists last_poll_at timestamptz;
alter table ot.telegram_config add column if not exists last_request_ids bigint[];
-- Cài đặt cũ (đã có token, chưa có tên bot): điền tên bot mặc định để không cần chạy thêm bước nào
update ot.telegram_config set bot_username = 'pxkhuon_bot' where bot_username = '' and bot_token <> '';

alter table ot.telegram_config enable row level security;
revoke all on ot.telegram_config from public, anon, authenticated;

-- Mã kết nối dùng một lần (chỉ lưu bản băm), hết hạn sau 15 phút
create table if not exists ot.telegram_link_codes (
  code_hash text primary key,
  employee_id bigint not null references ot.employees (id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz
);
create index if not exists telegram_link_codes_emp_idx on ot.telegram_link_codes (employee_id);
alter table ot.telegram_link_codes enable row level security;
revoke all on ot.telegram_link_codes from public, anon, authenticated;

-- Lần gần nhất báo "sửa sau chốt" theo từng ô (người + ngày): chống gửi dồn dập quá 1 tin / 10 phút cho mỗi ô
create table if not exists ot.telegram_alert_sent (
  alert_key text primary key,
  sent_at timestamptz not null default now()
);
alter table ot.telegram_alert_sent enable row level security;
revoke all on ot.telegram_alert_sent from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 2. HÀM PHỤ
-- ---------------------------------------------------------------------

-- Làm sạch chữ do người ngoài đưa vào (tên Telegram, nội dung sửa công): bỏ xuống dòng / ký tự điều khiển, cắt độ dài
create or replace function ot.tg_clean(p text, p_max int) returns text
language sql immutable set search_path = '' as $$
  select left(btrim(regexp_replace(regexp_replace(coalesce(p, ''), '[\r\n\t]+', ' ', 'g'), '[[:cntrl:]]', '', 'g')), p_max)
$$;

-- "Thứ Sáu 16/10/2026"
create or replace function ot.tg_day_label(p date) returns text
language sql immutable set search_path = '' as $$
  select (array['Chủ nhật', 'Thứ Hai', 'Thứ Ba', 'Thứ Tư', 'Thứ Năm', 'Thứ Sáu', 'Thứ Bảy'])[extract(dow from p)::int + 1]
         || ' ' || to_char(p, 'DD/MM/YYYY')
$$;

create or replace function ot.tg_off_day(p date) returns boolean
language sql stable set search_path = '' as $$
  select extract(dow from p) = 0 or exists (select 1 from ot.holidays h where h.work_date = p)
$$;

-- Gửi 1 tin tới 1 chat (nền, qua pg_net). Không có token / chat thì bỏ qua, trả về null.
create or replace function ot.tg_post(p_chat text, p_text text) returns bigint
language plpgsql set search_path = '' as $$
declare
  v_token text;
begin
  select bot_token into v_token from ot.telegram_config where id = 1;
  if coalesce(v_token, '') = '' or coalesce(p_chat, '') = '' then
    return null;
  end if;
  return net.http_post(
    url := 'https://api.telegram.org/bot' || v_token || '/sendMessage',
    body := jsonb_build_object('chat_id', p_chat, 'text', left(coalesce(p_text, ''), 4000), 'disable_web_page_preview', true),
    params := '{}'::jsonb,
    headers := jsonb_build_object('Content-Type', 'application/json'),
    timeout_milliseconds := 10000
  );
end $$;

-- Bot đã cài chưa (token có, và có tên bot để tạo liên kết)
create or replace function ot.tg_require_bot(p_need_username boolean default false) returns void
language plpgsql stable set search_path = '' as $$
declare
  c ot.telegram_config;
begin
  select * into c from ot.telegram_config where id = 1;
  if not found or coalesce(c.bot_token, '') = '' then
    perform ot.fail('bot_not_ready', 'Bot Telegram chưa được cài. Nhờ quản trị hệ thống chạy file telegram_nhac_cham_cong.sql trong Supabase SQL Editor, rồi chạy: select ot.telegram_setup(''TOKEN_CUA_BOT'');');
  end if;
  if p_need_username and coalesce(c.bot_username, '') = '' then
    perform ot.fail('bot_not_ready', 'Bot Telegram chưa có tên bot. Nhờ quản trị hệ thống chạy: select ot.telegram_setup(''TOKEN_CUA_BOT'', NULL, ''14:00'', ''ten_bot'');  (NULL = giữ chat id đã lưu)');
  end if;
end $$;

-- Danh sách chat nhận báo cáo quản lý: mọi Admin đang làm, bật "Nhận báo cáo quản lý", đã kết nối; cộng chat dùng chung (nếu có). Bỏ trùng.
create or replace function ot.telegram_recipients() returns setof text
language sql stable set search_path = '' as $$
  select x.c from (
    select e.tg_chat_id as c
      from ot.employees e
     where e.role = 'admin' and e.notify_manager and e.tg_chat_id is not null
       and (e.end_date is null or e.end_date >= ot.vn_today())
    union
    select t.chat_id from ot.telegram_config t where t.id = 1 and t.chat_id <> ''
  ) x
  order by x.c
$$;

-- Ghi chú cho chủ dự án: Admin đã kết nối Telegram nhưng chưa tích "Nhận báo cáo quản lý" (nên không nhận báo cáo)
create or replace function ot.telegram_unticked_note() returns text
language sql stable set search_path = '' as $$
  select coalesce(
    ' Lưu ý: ' || string_agg(e.name, ', ' order by e.name)
      || ' đã kết nối Telegram nhưng CHƯA tích "Nhận báo cáo quản lý" nên không nhận báo cáo. Vào web -> Nhân sự & Tài khoản -> tích ô đó -> Lưu.',
    '')
    from ot.employees e
   where e.role = 'admin' and not e.notify_manager and e.tg_chat_id is not null
     and (e.end_date is null or e.end_date >= ot.vn_today())
$$;

-- Dòng thêm cuối báo cáo khi còn thay đổi sau chốt chưa duyệt
create or replace function ot.telegram_alert_line() returns text
language plpgsql stable set search_path = '' as $$
declare
  n int;
begin
  select count(*) into n from ot.mod_alerts;
  if n > 0 then
    return format(E'\n\n📝 Còn %s thay đổi sau chốt chưa duyệt. Vào trang Quản lý để duyệt.', n);
  end if;
  return '';
end $$;

-- ---------------------------------------------------------------------
-- 3. SOẠN VÀ GỬI TIN NHẮC
-- ---------------------------------------------------------------------

-- Nội dung báo cáo cho 1 ngày; trả về null khi ngày đó là Chủ nhật / ngày lễ (không nhắc)
create or replace function ot.telegram_build_message(p_date date) returns text
language plpgsql stable set search_path = '' as $$
declare
  v_day text := ot.tg_day_label(p_date);
  v_total int;
  v_missing text[];
  v_list text := '';
  v_line text;
  i int;
begin
  if ot.tg_off_day(p_date) then
    return null;
  end if;

  select count(*),
         coalesce(array_agg(e.name order by e.name) filter (
           where not exists (select 1 from ot.records r where r.employee_id = e.id and r.work_date = p_date)
             and not exists (select 1 from ot.day_status s where s.employee_id = e.id and s.work_date = p_date)
         ), '{}')
    into v_total, v_missing
    from ot.employees e
   where e.has_timesheet
     and (e.start_date is null or e.start_date <= p_date)
     and (e.end_date is null or e.end_date >= p_date);

  if v_total = 0 then
    return null;
  end if;
  if cardinality(v_missing) = 0 then
    return format('✅ %s: cả %s công nhân đều đã báo công.', v_day, v_total);
  end if;

  -- Telegram giới hạn 4096 ký tự/tin: danh sách quá dài thì ghi "... và N người nữa"
  for i in 1 .. cardinality(v_missing) loop
    v_line := format(E'\n%s. %s', i, v_missing[i]);
    if length(v_list) + length(v_line) > 3500 then
      v_list := v_list || format(E'\n... và %s người nữa', cardinality(v_missing) - i + 1);
      exit;
    end if;
    v_list := v_list || v_line;
  end loop;

  return format(
    E'⏰ Nhắc báo công – %s\nCó %s/%s công nhân chưa báo công:%s\n\nNgày chưa báo công thì bảng công để trống, chưa được tính công.',
    v_day, cardinality(v_missing), v_total, v_list
  );
end $$;

-- Gửi 1 tin cho mọi người nhận báo cáo quản lý (gửi nền qua pg_net, kết quả xem bằng ot.telegram_check()).
-- Trả về mã yêu cầu của tin cuối cùng.
create or replace function ot.telegram_send(p_text text) returns bigint
language plpgsql set search_path = '' as $$
declare
  v_chat text;
  v_req bigint;
  v_ids bigint[] := '{}';
begin
  if not exists (select 1 from ot.telegram_config where id = 1 and bot_token <> '') then
    raise exception 'Chưa cài bot. Chạy: select ot.telegram_setup(''TOKEN_CUA_BOT'');';
  end if;
  for v_chat in select ot.telegram_recipients() loop
    v_req := ot.tg_post(v_chat, p_text);
    if v_req is not null then
      v_ids := v_ids || v_req;
    end if;
  end loop;
  if cardinality(v_ids) = 0 then
    raise exception '%', 'Chưa có ai nhận báo cáo quản lý. Cho Admin bấm "Kết nối Telegram" trong web và bật "Nhận báo cáo quản lý", hoặc thêm chat id nhóm: select ot.telegram_setup(''TOKEN_CUA_BOT'', ''CHAT_ID'');'
                         || ot.telegram_unticked_note();
  end if;
  update ot.telegram_config set last_request_id = v_ids[cardinality(v_ids)], last_request_ids = v_ids where id = 1;
  return v_ids[cardinality(v_ids)];
end $$;

-- Nhắc riêng từng người (có chấm công, bật "Nhận thông báo cá nhân", đã kết nối) chưa báo gì trong ngày p_date
create or replace function ot.telegram_remind_personal(p_date date) returns int
language plpgsql set search_path = '' as $$
declare
  r ot.employees;
  n int := 0;
begin
  if ot.tg_off_day(p_date) then
    return 0;
  end if;
  for r in
    select e.* from ot.employees e
     where e.has_timesheet and e.notify_personal and e.tg_chat_id is not null
       and (e.start_date is null or e.start_date <= p_date)
       and (e.end_date is null or e.end_date >= p_date)
       and not exists (select 1 from ot.records x where x.employee_id = e.id and x.work_date = p_date)
       and not exists (select 1 from ot.day_status s where s.employee_id = e.id and s.work_date = p_date)
     order by e.id
  loop
    begin
      perform ot.tg_post(r.tg_chat_id, format(
        '⏰ %s ơi, bạn chưa báo công ngày %s. Đi làm bình thường cũng cần vào trang chấm công bấm báo công (đi làm đủ / tăng ca / nghỉ / về sớm), nếu không ngày đó sẽ không được tính công.',
        r.name, ot.tg_day_label(p_date)));
      n := n + 1;
    exception when others then
      null;
    end;
  end loop;
  return n;
end $$;

-- pg_cron gọi hàm này mỗi ngày đúng giờ nhắc
create or replace function ot.telegram_daily_remind() returns void
language plpgsql set search_path = '' as $$
declare
  d date := ot.vn_today() - 1;
  v_msg text;
begin
  if not exists (
    select 1 from ot.telegram_config where id = 1 and enabled and bot_token <> ''
  ) then
    return;
  end if;
  v_msg := ot.telegram_build_message(d);
  if v_msg is null then
    return;
  end if;
  if exists (select 1 from ot.telegram_recipients()) then
    perform ot.telegram_send(v_msg || ot.telegram_alert_line());
  end if;
  perform ot.telegram_remind_personal(d);
end $$;

-- ---------------------------------------------------------------------
-- 4. THÔNG BÁO KHI SỬA SAU CHỐT CÔNG / KHI ĐƯỢC DUYỆT
--    Các trigger này KHÔNG BAO GIỜ làm hỏng việc lưu của web (mọi lỗi đều bị nuốt).
-- ---------------------------------------------------------------------

create or replace function ot.tg_alert_changed() returns trigger
language plpgsql set search_path = '' as $$
declare
  v_name text;
  v_before text;
  v_after text;
  v_chat text;
  v_msg text;
begin
  begin
    if not exists (select 1 from ot.telegram_config where id = 1 and enabled and bot_token <> '') then
      return null;
    end if;
    -- Mỗi ô (người + ngày) tối đa 1 tin / 10 phút
    delete from ot.telegram_alert_sent where sent_at < now() - interval '1 day';
    insert into ot.telegram_alert_sent as a (alert_key, sent_at) values (new.alert_key, now())
    on conflict (alert_key) do update set sent_at = excluded.sent_at
      where a.sent_at < now() - interval '10 minutes';
    if not found then
      return null;
    end if;
    select e.name into v_name from ot.employees e where e.id = new.employee_id;
    v_before := ot.tg_clean(
      coalesce(nullif(new.data ->> 'beforeCode', ''), nullif(new.data ->> 'oldCode', ''), nullif(new.data ->> 'oldDetail', ''), 'không có')
      || coalesce(' (' || nullif(new.data ->> 'oldStatus', '') || ')', ''), 60);
    v_after := ot.tg_clean(
      coalesce(nullif(new.data ->> 'afterCode', ''), nullif(new.data ->> 'newCode', ''), nullif(new.data ->> 'newDetail', ''), 'không có')
      || coalesce(' (' || nullif(new.data ->> 'newStatus', '') || ')', ''), 60);
    v_msg := format('✏️ Sửa sau chốt – %s, ngày %s: %s → %s. Vào trang Quản lý để duyệt.',
                    ot.tg_clean(coalesce(v_name, '?'), 80), ot.tg_day_label(new.work_date), v_before, v_after);
    for v_chat in select ot.telegram_recipients() loop
      perform ot.tg_post(v_chat, v_msg);
    end loop;
  exception when others then
    null;
  end;
  return null;
end $$;

create or replace function ot.tg_alert_deleted() returns trigger
language plpgsql set search_path = '' as $$
declare
  e ot.employees;
begin
  begin
    if not exists (select 1 from ot.telegram_config where id = 1 and enabled and bot_token <> '') then
      return null;
    end if;
    delete from ot.telegram_alert_sent where alert_key = old.alert_key;   -- đã duyệt: lần sửa sau là sự kiện mới
    -- Xóa do xóa nhân viên (cascade) thì dòng nhân viên đã mất: không báo
    -- Bỏ chốt ngày (ngày không còn trong locked_days) cũng xóa cảnh báo nhưng KHÔNG phải là duyệt: không báo
    select * into e from ot.employees where id = old.employee_id;
    if found and e.notify_personal and e.tg_chat_id is not null
       and exists (select 1 from ot.locked_days d where d.work_date = old.work_date) then
      perform ot.tg_post(e.tg_chat_id, format('✅ Quản đốc đã duyệt thay đổi sau chốt ngày %s của bạn.', ot.tg_day_label(old.work_date)));
    end if;
  exception when others then
    null;
  end;
  return null;
end $$;

drop trigger if exists tg_mod_alert_ins on ot.mod_alerts;
create trigger tg_mod_alert_ins after insert on ot.mod_alerts
  for each row execute function ot.tg_alert_changed();
drop trigger if exists tg_mod_alert_upd on ot.mod_alerts;
create trigger tg_mod_alert_upd after update on ot.mod_alerts
  for each row when (old.data is distinct from new.data) execute function ot.tg_alert_changed();
drop trigger if exists tg_mod_alert_del on ot.mod_alerts;
create trigger tg_mod_alert_del after delete on ot.mod_alerts
  for each row execute function ot.tg_alert_deleted();

-- ---------------------------------------------------------------------
-- 5. NHẬN LIÊN KẾT TỪ TELEGRAM (người dùng bấm Start với mã kết nối)
-- ---------------------------------------------------------------------

-- Xử lý 1 tin Telegram. Chỉ nhận "/start <mã>" trong chat riêng, tin không cũ quá 20 phút.
create or replace function ot.tg_handle_update(u jsonb) returns void
language plpgsql set search_path = '' as $$
declare
  msg jsonb;
  chat jsonb;
  frm jsonb;
  v_chat text;
  v_text text;
  m text[];
  ce ot.telegram_link_codes;
  emp ot.employees;
  v_name text;
  v_ok boolean := false;
begin
  msg := u -> 'message';
  if jsonb_typeof(msg) is distinct from 'object' then return; end if;
  chat := msg -> 'chat';
  if jsonb_typeof(chat) is distinct from 'object' or chat ->> 'type' is distinct from 'private' then return; end if;
  v_chat := chat ->> 'id';
  if v_chat is null or v_chat !~ '^-?\d{1,20}$' then return; end if;
  if jsonb_typeof(msg -> 'text') is distinct from 'string' then return; end if;
  v_text := btrim(msg ->> 'text');
  m := regexp_match(v_text, '^/start(?:@\w+)?\s+(\S{1,100})$');
  if m is null then return; end if;
  if coalesce(msg ->> 'date', '') !~ '^\d{1,12}$'
     or to_timestamp((msg ->> 'date')::bigint) < now() - interval '20 minutes' then
    return;
  end if;

  select * into ce from ot.telegram_link_codes
   where code_hash = ot.hash_token(m[1]) and used_at is null and expires_at > now()
   for update;
  if found then
    select * into emp from ot.employees
     where id = ce.employee_id and (end_date is null or end_date >= ot.vn_today())
     for update;
    v_ok := found;
  end if;
  if not v_ok then
    perform ot.tg_post(v_chat, 'Mã kết nối không hợp lệ hoặc đã hết hạn. Hãy mở trang chấm công, bấm "Kết nối Telegram" để lấy liên kết mới rồi bấm lại.');
    return;
  end if;

  frm := coalesce(msg -> 'from', '{}'::jsonb);
  if jsonb_typeof(frm) <> 'object' then frm := '{}'::jsonb; end if;
  v_name := case
    when nullif(frm ->> 'username', '') is not null then '@' || (frm ->> 'username')
    when nullif(btrim(coalesce(frm ->> 'first_name', '') || ' ' || coalesce(frm ->> 'last_name', '')), '') is not null
      then btrim(coalesce(frm ->> 'first_name', '') || ' ' || coalesce(frm ->> 'last_name', ''))
    when nullif(chat ->> 'username', '') is not null then '@' || (chat ->> 'username')
    else btrim(coalesce(chat ->> 'first_name', '') || ' ' || coalesce(chat ->> 'last_name', ''))
  end;
  v_name := coalesce(nullif(ot.tg_clean(v_name, 64), ''), 'Telegram');

  -- Liên kết mới đè chat cũ: báo cho chat cũ biết
  if emp.tg_chat_id is not null and emp.tg_chat_id <> v_chat then
    perform ot.tg_post(emp.tg_chat_id, format('Tài khoản %s vừa được kết nối với một Telegram khác.', ot.tg_clean(emp.name, 80)));
  end if;

  update ot.employees
     set tg_chat_id = v_chat, tg_name = v_name, tg_linked_at = now(), rev = rev + 1, updated_at = now()
   where id = emp.id;
  update ot.telegram_link_codes set used_at = now() where code_hash = ce.code_hash;
  delete from ot.telegram_link_codes where employee_id = emp.id and used_at is null;
  update ot.meta set version = version + 1 where id = 1;

  perform ot.tg_post(v_chat, format(E'✅ Đã kết nối Telegram với tài khoản %s.\nTừ giờ bạn sẽ nhận thông báo chấm công tại đây. Bạn có thể ngắt kết nối bất cứ lúc nào trong trang Nhân sự & Tài khoản.', ot.tg_clean(emp.name, 80)));
end $$;

-- Hỏi Telegram có ai vừa bấm Start không (getUpdates, bất đồng bộ: gửi yêu cầu ở lần gọi này, đọc kết quả ở lần gọi sau).
-- Gọi từ pg_cron mỗi phút và từ web khi người dùng đang chờ kết nối. Không bao giờ ném lỗi ra ngoài.
create or replace function ot.telegram_poll(p_throttle boolean default false) returns void
language plpgsql set search_path = '' as $$
declare
  c ot.telegram_config;
  r record;
  v_json jsonb;
  v_upd jsonb;
  v_max bigint;
  v_err text;
  v_req bigint;
begin
  if not pg_try_advisory_xact_lock(727002) then
    return;
  end if;
  select * into c from ot.telegram_config where id = 1;
  if not found or coalesce(c.bot_token, '') = '' then
    return;
  end if;
  if p_throttle and c.last_poll_at is not null and c.last_poll_at > now() - interval '2 seconds' then
    return;
  end if;
  update ot.telegram_config set last_poll_at = now() where id = 1;

  begin
    -- 1. Đọc kết quả getUpdates của lần trước
    if c.poll_request_id is not null then
      select * into r from net._http_response where id = c.poll_request_id;
      if found then
        v_err := null;
        v_max := null;
        if r.status_code = 200 then
          begin
            v_json := r.content::jsonb;
          exception when others then
            v_json := null;
          end;
          if v_json is null or jsonb_typeof(v_json) <> 'object' then
            v_err := 'Phản hồi từ Telegram không đọc được.';
          elsif v_json -> 'ok' is distinct from 'true'::jsonb or jsonb_typeof(v_json -> 'result') is distinct from 'array' then
            v_err := 'Telegram báo lỗi: ' || ot.tg_clean(v_json ->> 'description', 120);
          else
            select max((x ->> 'update_id')::bigint) into v_max
              from jsonb_array_elements(v_json -> 'result') x
             where jsonb_typeof(x) = 'object' and (x ->> 'update_id') ~ '^\d{1,15}$';
            for v_upd in
              select x from jsonb_array_elements(v_json -> 'result') x
               where jsonb_typeof(x) = 'object' and (x ->> 'update_id') ~ '^\d{1,15}$'
               order by (x ->> 'update_id')::bigint
            loop
              begin
                perform ot.tg_handle_update(v_upd);
              exception when others then
                null;   -- 1 tin lỗi không chặn các tin khác; offset vẫn tăng nên không bị đọc lại
              end;
            end loop;
          end if;
        elsif r.status_code = 401 then
          v_err := 'Token bot sai hoặc đã bị thu hồi (Telegram báo 401).';
        elsif r.status_code = 409 then
          v_err := 'Bot đang đặt webhook hoặc có chương trình khác đang nhận tin của bot (Telegram báo 409).';
        elsif r.status_code is null or r.timed_out then
          v_err := 'Không kết nối được Telegram.';
        else
          v_err := 'Telegram trả lỗi ' || r.status_code || '.';
        end if;
        update ot.telegram_config
           set update_offset = case when v_max is not null then greatest(update_offset, v_max + 1) else update_offset end,
               poll_request_id = null, poll_sent_at = null, poll_error = v_err
         where id = 1;
        select * into c from ot.telegram_config where id = 1;
      elsif c.poll_sent_at is not null and c.poll_sent_at > now() - interval '30 seconds' then
        return;   -- vẫn đang chờ Telegram trả lời
      end if;
    end if;

    -- 2. Còn mã chưa dùng, chưa hết hạn thì hỏi tiếp
    if exists (select 1 from ot.telegram_link_codes where used_at is null and expires_at > now()) then
      v_req := net.http_post(
        url := 'https://api.telegram.org/bot' || c.bot_token || '/getUpdates',
        body := jsonb_build_object('offset', c.update_offset, 'limit', 100, 'timeout', 0,
                                   'allowed_updates', jsonb_build_array('message')),
        params := '{}'::jsonb,
        headers := jsonb_build_object('Content-Type', 'application/json'),
        timeout_milliseconds := 10000
      );
      update ot.telegram_config set poll_request_id = v_req, poll_sent_at = now() where id = 1;
    end if;
  exception when others then
    update ot.telegram_config
       set poll_error = 'Lỗi xử lý tin Telegram: ' || ot.tg_clean(sqlerrm, 120), poll_request_id = null, poll_sent_at = null
     where id = 1;
  end;
end $$;

-- Hẹn cron: mỗi phút hỏi Telegram (thoát ngay nếu không có ai đang chờ kết nối)
do $$
begin
  perform cron.schedule('telegram-nhan-lien-ket', '* * * * *', 'select ot.telegram_poll()');
end $$;

-- ---------------------------------------------------------------------
-- 6. HÀM CHO WEB (app_telegram_*): mỗi hàm tự kiểm tra phiên đăng nhập
-- ---------------------------------------------------------------------

-- Xác định tài khoản được thao tác: chính mình, hoặc (Admin) người khác theo tên
create or replace function ot.tg_target(v ot.employees, p_name text) returns ot.employees
language plpgsql stable set search_path = '' as $$
declare
  t ot.employees;
  v_name text := btrim(coalesce(p_name, ''));
begin
  if v_name = '' or v_name = v.name then
    select * into t from ot.employees where id = v.id;
    return t;
  end if;
  if v.role <> 'admin' then
    perform ot.fail('forbidden', 'Bạn chỉ thao tác được với Telegram của chính mình.');
  end if;
  select * into t from ot.employees where name = v_name;
  if not found then
    perform ot.fail('bad_employee', 'Không tìm thấy tài khoản: ' || v_name);
  end if;
  return t;
end $$;

-- Tạo liên kết kết nối: người dùng mở link, bấm Start trong Telegram
create or replace function public.app_telegram_link_start(p_token text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v ot.employees;
  c ot.telegram_config;
  v_code text;
  v_exp timestamptz := now() + interval '15 minutes';
begin
  v := ot.require_session(p_token);
  perform ot.tg_require_bot(true);
  select * into c from ot.telegram_config where id = 1;

  delete from ot.telegram_link_codes where expires_at < now() - interval '1 day';
  delete from ot.telegram_link_codes where employee_id = v.id and used_at is null;   -- mỗi người 1 mã còn hiệu lực
  v_code := translate(encode(extensions.gen_random_bytes(18), 'base64'), '+/', '-_');   -- 24 ký tự [A-Za-z0-9_-]
  insert into ot.telegram_link_codes (code_hash, employee_id, expires_at)
  values (ot.hash_token(v_code), v.id, v_exp);

  return jsonb_build_object(
    'ok', true,
    'url', 'https://t.me/' || c.bot_username || '?start=' || v_code,
    'botUsername', c.bot_username,
    'expiresAt', to_char(v_exp at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
  );
end $$;

-- Web hỏi "đã kết nối chưa" (gọi mỗi vài giây khi đang chờ). Nếu còn mã đang chờ thì tranh thủ hỏi Telegram luôn.
create or replace function public.app_telegram_link_status(p_token text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v ot.employees;
  e ot.employees;
  c ot.telegram_config;
  v_pending boolean;
begin
  v := ot.require_session(p_token);
  select exists (select 1 from ot.telegram_link_codes where employee_id = v.id and used_at is null and expires_at > now())
    into v_pending;
  if v_pending then
    begin
      perform ot.telegram_poll(true);
    exception when others then
      null;
    end;
  end if;
  select * into e from ot.employees where id = v.id;
  select * into c from ot.telegram_config where id = 1;
  select exists (select 1 from ot.telegram_link_codes where employee_id = v.id and used_at is null and expires_at > now())
    into v_pending;
  return jsonb_build_object(
    'ok', true,
    'linked', e.tg_chat_id is not null,
    'telegramName', e.tg_name,
    'linkedAt', case when e.tg_linked_at is null then null
                     else to_char(e.tg_linked_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') end,
    'pending', v_pending,
    'pollError', case when v_pending then c.poll_error else null end
  );
end $$;

-- Ngắt liên kết (mặc định: chính mình; Admin gỡ được của người khác)
create or replace function public.app_telegram_unlink(p_token text, p_name text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v ot.employees;
  t ot.employees;
begin
  v := ot.require_session(p_token);
  t := ot.tg_target(v, p_name);
  update ot.employees
     set tg_chat_id = null, tg_name = null, tg_linked_at = null, rev = rev + 1, updated_at = now()
   where id = t.id;
  delete from ot.telegram_link_codes where employee_id = t.id and used_at is null;
  update ot.meta set version = version + 1 where id = 1;
  return jsonb_build_object('ok', true);
end $$;

-- Gửi tin thử vào Telegram của tài khoản (mặc định: chính mình)
create or replace function public.app_telegram_test(p_token text, p_name text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v ot.employees;
  t ot.employees;
begin
  v := ot.require_session(p_token);
  t := ot.tg_target(v, p_name);
  perform ot.tg_require_bot(false);
  if t.tg_chat_id is null then
    perform ot.fail('not_linked', 'Tài khoản "' || t.name || '" chưa kết nối Telegram. Bấm "Kết nối Telegram" trước.');
  end if;
  perform ot.tg_post(t.tg_chat_id, format('🔔 Tin thử từ hệ thống chấm công: Telegram đã kết nối với tài khoản %s.', ot.tg_clean(t.name, 80)));
  return jsonb_build_object('ok', true);
end $$;

-- ---------------------------------------------------------------------
-- 7. CÔNG CỤ CHO CHỦ DỰ ÁN (chỉ chạy trong SQL Editor)
-- ---------------------------------------------------------------------

-- Hẹn giờ nhắc hằng ngày theo giờ Việt Nam (pg_cron chạy theo giờ UTC = giờ VN - 7)
create or replace function ot.telegram_set_time(p_time text) returns text
language plpgsql set search_path = '' as $$
declare
  h int;
  m int;
  v_time text;
begin
  if coalesce(p_time, '') !~ '^\d{1,2}:\d{2}$' then
    raise exception 'Giờ nhắc phải có dạng HH:MM, ví dụ ''14:00''.';
  end if;
  h := split_part(p_time, ':', 1)::int;
  m := split_part(p_time, ':', 2)::int;
  if h > 23 or m > 59 then
    raise exception 'Giờ nhắc không hợp lệ: %', p_time;
  end if;
  v_time := lpad(h::text, 2, '0') || ':' || lpad(m::text, 2, '0');

  perform cron.schedule('nhac-cham-cong-telegram', format('%s %s * * *', m, (h + 17) % 24), 'select ot.telegram_daily_remind()');
  update ot.telegram_config set remind_time = v_time, enabled = true, updated_at = now() where id = 1;
  return format('Bot sẽ nhắc lúc %s mỗi ngày (giờ Việt Nam) về những người chưa báo công ngày hôm trước.', v_time);
end $$;

-- Lưu token bot (+ chat id nhóm dùng chung nếu có), rồi hẹn giờ nhắc (mặc định 14:00).
-- Chat id có thể bỏ qua: không ghi thì GIỮ chat id đã lưu; ghi '' thì xóa. Mỗi Admin tự kết nối Telegram của mình trong web.
-- Đổi sang token KHÁC: đặt lại vị trí đọc tin, mọi người cần bấm "Kết nối Telegram" lại với bot mới.
drop function if exists ot.telegram_setup(text, text, text);
drop function if exists ot.telegram_setup(text, text, text, text);
create or replace function ot.telegram_setup(p_token text, p_chat_id text default null, p_time text default '14:00',
                                             p_bot_username text default null) returns text
language plpgsql set search_path = '' as $$
declare
  -- Bỏ khoảng trắng, xuống dòng, ký tự ẩn, dấu < > và dấu nháy hay dính vào khi sao chép
  v_junk constant text := '[[:space:]<>"'' ​-‍﻿‘’“”]';
  v_token text := regexp_replace(coalesce(p_token, ''), v_junk, '', 'g');
  v_chat text := regexp_replace(coalesce(p_chat_id, ''), v_junk, '', 'g');
  v_bot text := regexp_replace(coalesce(p_bot_username, ''), v_junk, '', 'g');
  c ot.telegram_config;
  v_changed boolean;
  v_note text := '';
begin
  -- Chép token từ đường link getUpdates thì hay dính chữ "bot" ở đầu
  v_token := regexp_replace(v_token, '^bot', '', 'i');
  if v_token !~ '^\d+:[A-Za-z0-9_-]{30,}$' then
    raise exception '%', case
      when v_token = '' then
        'Chưa nhập TOKEN. Chạy: select ot.telegram_setup(''TOKEN''); thay TOKEN bằng token BotFather gửi.'
      when upper(v_token) like '%TOKEN%' then
        'Đang để chữ mẫu TOKEN. Thay chữ TOKEN bằng token thật BotFather gửi (dạng 123456789:AAH...), giữ 2 dấu nháy đơn hai bên.'
      when v_token ~ '^-?\d+$' then
        'Ô thứ nhất đang là một con số (giống CHAT_ID). Thứ tự đúng: TOKEN trước, CHAT_ID sau.'
      else format(
        'TOKEN bot không đúng dạng (nhận được %s ký tự, bắt đầu bằng "%s"). Token đúng có dạng 123456789:AAH..., dài khoảng 46 ký tự. Chép lại nguyên dòng token BotFather gửi.',
        length(v_token), left(v_token, 6))
    end;
  end if;
  if v_chat <> '' and v_chat !~ '^-?\d+$' and v_chat !~ '^@\w{5,}$' then
    raise exception '%', case
      when upper(v_chat) like '%CHAT%' then
        'Đang để chữ mẫu CHAT_ID. Thay bằng số chat id lấy từ getUpdates (chat riêng là số dương, nhóm là số âm, ví dụ -1001234567890), hoặc bỏ trống nếu không có nhóm chung.'
      when v_chat ~ '^\d+:' then
        'Ô thứ hai đang là TOKEN. Thứ tự đúng: TOKEN trước, CHAT_ID sau.'
      else 'CHAT_ID không đúng dạng. Chat riêng là số dương, nhóm là số âm (ví dụ -1001234567890).'
    end;
  end if;
  v_bot := ltrim(v_bot, '@');
  if v_bot <> '' and v_bot !~ '^[A-Za-z0-9_]{3,64}$' then
    raise exception 'Tên bot không đúng dạng. Ghi tên bot như trong link t.me/ten_bot, ví dụ pxkhuon_bot.';
  end if;

  select * into c from ot.telegram_config where id = 1;
  v_changed := coalesce(c.bot_token, '') <> '' and c.bot_token <> v_token;
  -- Không ghi tên bot: giữ tên đã lưu, lần đầu dùng pxkhuon_bot
  if v_bot = '' then
    v_bot := coalesce(nullif(c.bot_username, ''), 'pxkhuon_bot');
  end if;

  -- p_chat_id không ghi (null) = giữ chat id đã lưu; ghi '' = xóa chat chung
  update ot.telegram_config
     set bot_token = v_token, chat_id = case when p_chat_id is null then chat_id else v_chat end,
         bot_username = v_bot, updated_at = now()
   where id = 1;
  if v_changed then
    update ot.telegram_config
       set update_offset = 0, poll_request_id = null, poll_sent_at = null, poll_error = null, last_poll_at = null
     where id = 1;
    v_note := ' Đã đổi sang bot mới: mọi người cần bấm "Kết nối Telegram" lại với bot mới (bot hiện dùng: ' || v_bot
              || '; nếu sai tên, chạy lại với tên bot ở tham số thứ 4).';
    raise notice '%', v_note;
  end if;
  return ot.telegram_set_time(p_time) || ' Gửi thử ngay: select ot.telegram_test();' || v_note;
end $$;

-- Tắt nhắc (giữ nguyên token; bật lại bằng ot.telegram_set_time('14:00'))
create or replace function ot.telegram_off() returns text
language plpgsql set search_path = '' as $$
begin
  if exists (select 1 from cron.job where jobname = 'nhac-cham-cong-telegram') then
    perform cron.unschedule('nhac-cham-cong-telegram');
  end if;
  update ot.telegram_config set enabled = false, updated_at = now() where id = 1;
  return 'Đã tắt bot nhắc. Bật lại: select ot.telegram_set_time(''14:00'');';
end $$;

-- Gửi thử ngay báo cáo của 1 ngày (mặc định hôm qua) cho mọi người nhận báo cáo quản lý, kể cả khi hôm đó là ngày nghỉ
create or replace function ot.telegram_test(p_date date default null) returns text
language plpgsql set search_path = '' as $$
declare
  d date := coalesce(p_date, ot.vn_today() - 1);
  v_msg text;
  v_to text;
begin
  v_msg := ot.telegram_build_message(d);
  if v_msg is null then
    v_msg := format('Ngày %s là ngày nghỉ (hoặc chưa có công nhân) nên bot sẽ không nhắc ngày này.', to_char(d, 'DD/MM/YYYY'));
  else
    v_msg := v_msg || ot.telegram_alert_line();
  end if;
  perform ot.telegram_send(E'[Gửi thử]\n' || v_msg);
  -- Ghi rõ đã gửi cho ai để dễ kiểm tra
  select concat_ws(', ',
           (select string_agg(e.name, ', ' order by e.name) from ot.employees e
             where e.role = 'admin' and e.notify_manager and e.tg_chat_id is not null
               and (e.end_date is null or e.end_date >= ot.vn_today())),
           (select 'nhóm chung' from ot.telegram_config t where t.id = 1 and t.chat_id <> ''))
    into v_to;
  return 'Đã gửi thử báo cáo ngày ' || to_char(d, 'DD/MM/YYYY') || ' tới: ' || v_to
         || '. Đợi vài giây rồi chạy: select ot.telegram_check();' || ot.telegram_unticked_note();
end $$;

-- Xem lần gửi gần nhất Telegram trả lời thế nào
create or replace function ot.telegram_check() returns text
language plpgsql set search_path = '' as $$
declare
  c ot.telegram_config;
  v_ids bigint[];
  v_got int;
  v_status int;
  v_content text;
  v_err text;
  v_timeout boolean;
  v_job text;
  v_bad boolean;
  v_tail text := '';
begin
  select * into c from ot.telegram_config where id = 1;
  select format('Lịch nhắc: %s (%s).', c.remind_time, case when c.enabled then 'đang bật' else 'đang tắt' end) into v_job;
  if c.poll_error is not null then
    v_tail := ' Nhận liên kết Telegram đang lỗi: ' || c.poll_error;
  end if;
  v_ids := coalesce(c.last_request_ids, case when c.last_request_id is null then '{}'::bigint[] else array[c.last_request_id] end);
  if cardinality(v_ids) = 0 then
    return v_job || ' Chưa gửi tin nào. Gửi thử: select ot.telegram_test();' || v_tail;
  end if;

  select count(*) into v_got from net._http_response r where r.id = any (v_ids);
  if v_got = 0 then
    return v_job || ' Tin gần nhất đang gửi hoặc kết quả đã quá 6 giờ nên bị xóa. Đợi vài giây rồi chạy lại.' || v_tail;
  end if;

  -- Có tin lỗi thì báo tin lỗi đầu tiên
  select r.status_code, r.content::text, r.error_msg, r.timed_out, true
    into v_status, v_content, v_err, v_timeout, v_bad
    from net._http_response r
   where r.id = any (v_ids) and r.status_code is distinct from 200
   order by r.id
   limit 1;
  if found then
    return v_job || ' ' || case
      when v_timeout or v_err is not null then 'Tin gần nhất: không kết nối được Telegram (' || coalesce(v_err, 'quá thời gian chờ') || ').'
      when v_status = 401 or v_status = 404 then 'Tin gần nhất: TOKEN bot sai. Lấy lại token ở @BotFather rồi chạy lại ot.telegram_setup(...).'
      when v_status = 400 and v_content ilike '%chat not found%' then
        'Tin gần nhất: CHAT_ID sai, hoặc người nhận chưa bấm Start với bot / chưa thêm bot vào nhóm.'
      when v_status = 403 then 'Tin gần nhất: bot bị chặn hoặc đã bị xóa khỏi nhóm.'
      else format('Tin gần nhất: lỗi %s: %s', v_status, left(coalesce(v_content, ''), 300))
    end || v_tail;
  end if;

  if v_got < cardinality(v_ids) then
    return v_job || format(' Telegram đã nhận %s/%s tin, còn lại đang gửi. Đợi vài giây rồi chạy lại.', v_got, cardinality(v_ids)) || v_tail;
  end if;
  return v_job || ' ' || case when cardinality(v_ids) = 1 then 'Tin gần nhất: Telegram đã nhận.'
                               else format('Tin gần nhất: Telegram đã nhận cả %s tin.', cardinality(v_ids)) end || v_tail;
end $$;

-- ---------------------------------------------------------------------
-- 8. PHÂN QUYỀN
-- ---------------------------------------------------------------------

revoke all on all functions in schema ot from public, anon, authenticated;

revoke all on function public.app_telegram_link_start(text) from public;
revoke all on function public.app_telegram_link_status(text) from public;
revoke all on function public.app_telegram_unlink(text, text) from public;
revoke all on function public.app_telegram_test(text, text) from public;

grant execute on function public.app_telegram_link_start(text) to anon, authenticated;
grant execute on function public.app_telegram_link_status(text) to anon, authenticated;
grant execute on function public.app_telegram_unlink(text, text) to anon, authenticated;
grant execute on function public.app_telegram_test(text, text) to anon, authenticated;

notify pgrst, 'reload schema';
