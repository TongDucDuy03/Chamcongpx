-- =====================================================================
-- BOT TELEGRAM NHẮC QUẢN ĐỐC: AI CHƯA BÁO TĂNG CA NGÀY HÔM TRƯỚC
--
-- Chạy SAU file supabase_setup.sql. Chạy lại nhiều lần vẫn an toàn, không mất cài đặt.
--
-- Cách dùng (chi tiết xem README, mục "Bot Telegram nhắc Quản đốc"):
--   1. Supabase -> SQL Editor -> New query -> dán TOÀN BỘ file này -> Run.
--   2. Lưu bot và hẹn giờ nhắc 14:00 hằng ngày:
--        select ot.telegram_setup('TOKEN_CUA_BOT', 'CHAT_ID');
--   3. Gửi thử ngay tin nhắc của hôm qua:   select ot.telegram_test();
--      Vài giây sau xem Telegram đã nhận chưa: select ot.telegram_check();
--   Đổi giờ nhắc:  select ot.telegram_set_time('15:30');
--   Tắt nhắc:      select ot.telegram_off();
--
-- Bot nhắc gì: công nhân đang làm việc mà ngày hôm trước chưa báo gì (không có ca tăng ca, không báo nghỉ / về sớm).
-- Người hôm đó không tăng ca thật cũng có tên trong danh sách, Quản đốc tự bỏ qua.
-- Hôm trước là Chủ nhật hoặc ngày lễ (trong Lịch nghỉ lễ của app) thì bot không nhắc.
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

alter table ot.telegram_config enable row level security;
revoke all on ot.telegram_config from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 2. SOẠN VÀ GỬI TIN NHẮC
-- ---------------------------------------------------------------------

-- Nội dung tin nhắc cho 1 ngày; trả về null khi ngày đó là Chủ nhật / ngày lễ (không nhắc)
create or replace function ot.telegram_build_message(p_date date) returns text
language plpgsql stable set search_path = '' as $$
declare
  v_day text := (array['Chủ nhật', 'Thứ Hai', 'Thứ Ba', 'Thứ Tư', 'Thứ Năm', 'Thứ Sáu', 'Thứ Bảy'])[extract(dow from p_date)::int + 1]
                || ' ' || to_char(p_date, 'DD/MM/YYYY');
  v_total int;
  v_missing text[];
  v_list text := '';
  v_line text;
  i int;
begin
  if extract(dow from p_date) = 0 or exists (select 1 from ot.holidays h where h.work_date = p_date) then
    return null;
  end if;

  select count(*),
         coalesce(array_agg(e.name order by e.name) filter (
           where not exists (select 1 from ot.records r where r.employee_id = e.id and r.work_date = p_date)
             and not exists (select 1 from ot.day_status s where s.employee_id = e.id and s.work_date = p_date)
         ), '{}')
    into v_total, v_missing
    from ot.employees e
   where e.role = 'worker'
     and (e.start_date is null or e.start_date <= p_date)
     and (e.end_date is null or e.end_date >= p_date);

  if v_total = 0 then
    return null;
  end if;
  if cardinality(v_missing) = 0 then
    return format('✅ %s: cả %s công nhân đều đã báo (tăng ca / nghỉ / về sớm).', v_day, v_total);
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
    E'⏰ Nhắc chấm công tăng ca – %s\nCó %s/%s công nhân chưa báo gì (tăng ca / nghỉ / về sớm):%s\n\nAi hôm đó đi làm bình thường, không tăng ca thì bỏ qua tên người đó.',
    v_day, cardinality(v_missing), v_total, v_list
  );
end $$;

-- Gửi 1 tin vào nhóm/người nhận đã cài (gửi nền qua pg_net, kết quả xem bằng ot.telegram_check())
create or replace function ot.telegram_send(p_text text) returns bigint
language plpgsql set search_path = '' as $$
declare
  c ot.telegram_config;
  v_req bigint;
begin
  select * into c from ot.telegram_config where id = 1;
  if coalesce(c.bot_token, '') = '' or coalesce(c.chat_id, '') = '' then
    raise exception 'Chưa cài bot. Chạy: select ot.telegram_setup(''TOKEN_CUA_BOT'', ''CHAT_ID'');';
  end if;
  v_req := net.http_post(
    url := 'https://api.telegram.org/bot' || c.bot_token || '/sendMessage',
    body := jsonb_build_object('chat_id', c.chat_id, 'text', p_text, 'disable_web_page_preview', true),
    params := '{}'::jsonb,
    headers := jsonb_build_object('Content-Type', 'application/json'),
    timeout_milliseconds := 10000
  );
  update ot.telegram_config set last_request_id = v_req where id = 1;
  return v_req;
end $$;

-- pg_cron gọi hàm này mỗi ngày đúng giờ nhắc
create or replace function ot.telegram_daily_remind() returns void
language plpgsql set search_path = '' as $$
declare
  v_msg text;
begin
  if not exists (
    select 1 from ot.telegram_config where id = 1 and enabled and bot_token <> '' and chat_id <> ''
  ) then
    return;
  end if;
  v_msg := ot.telegram_build_message(ot.vn_today() - 1);
  if v_msg is not null then
    perform ot.telegram_send(v_msg);
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 3. CÔNG CỤ CHO CHỦ DỰ ÁN (chỉ chạy trong SQL Editor)
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
  return format('Bot sẽ nhắc lúc %s mỗi ngày (giờ Việt Nam) về những người chưa báo tăng ca ngày hôm trước.', v_time);
end $$;

-- Lưu token bot + nơi nhận tin, rồi hẹn giờ nhắc (mặc định 14:00)
create or replace function ot.telegram_setup(p_token text, p_chat_id text, p_time text default '14:00') returns text
language plpgsql set search_path = '' as $$
declare
  v_token text := btrim(coalesce(p_token, ''));
  v_chat text := btrim(coalesce(p_chat_id, ''));
begin
  if v_token !~ '^\d+:[A-Za-z0-9_-]{30,}$' then
    raise exception 'TOKEN bot không đúng dạng. BotFather gửi token dạng 123456789:AAH...';
  end if;
  if v_chat !~ '^-?\d+$' and v_chat !~ '^@\w{5,}$' then
    raise exception 'CHAT_ID không đúng dạng. Chat riêng là số dương, nhóm là số âm (ví dụ -1001234567890).';
  end if;
  update ot.telegram_config set bot_token = v_token, chat_id = v_chat, updated_at = now() where id = 1;
  return ot.telegram_set_time(p_time) || ' Gửi thử ngay: select ot.telegram_test();';
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

-- Gửi thử ngay tin nhắc của 1 ngày (mặc định hôm qua), kể cả khi hôm đó là ngày nghỉ
create or replace function ot.telegram_test(p_date date default null) returns text
language plpgsql set search_path = '' as $$
declare
  d date := coalesce(p_date, ot.vn_today() - 1);
  v_msg text;
begin
  v_msg := ot.telegram_build_message(d);
  if v_msg is null then
    v_msg := format('Ngày %s là ngày nghỉ (hoặc chưa có công nhân) nên bot sẽ không nhắc ngày này.', to_char(d, 'DD/MM/YYYY'));
  end if;
  perform ot.telegram_send(E'[Gửi thử]\n' || v_msg);
  return 'Đã gửi thử. Đợi vài giây rồi chạy: select ot.telegram_check();';
end $$;

-- Xem lần gửi gần nhất Telegram trả lời thế nào
create or replace function ot.telegram_check() returns text
language plpgsql set search_path = '' as $$
declare
  c ot.telegram_config;
  v_status int;
  v_content text;
  v_err text;
  v_timeout boolean;
  v_job text;
begin
  select * into c from ot.telegram_config where id = 1;
  select format('Lịch nhắc: %s (%s).', c.remind_time, case when c.enabled then 'đang bật' else 'đang tắt' end) into v_job;
  if c.last_request_id is null then
    return v_job || ' Chưa gửi tin nào. Gửi thử: select ot.telegram_test();';
  end if;

  select r.status_code, r.content::text, r.error_msg, r.timed_out
    into v_status, v_content, v_err, v_timeout
    from net._http_response r
   where r.id = c.last_request_id;
  if not found then
    return v_job || ' Tin gần nhất đang gửi hoặc kết quả đã quá 6 giờ nên bị xóa. Đợi vài giây rồi chạy lại.';
  end if;

  return v_job || ' ' || case
    when v_status = 200 then 'Tin gần nhất: Telegram đã nhận.'
    when v_timeout or v_err is not null then 'Tin gần nhất: không kết nối được Telegram (' || coalesce(v_err, 'quá thời gian chờ') || ').'
    when v_status = 401 or v_status = 404 then 'Tin gần nhất: TOKEN bot sai. Lấy lại token ở @BotFather rồi chạy lại ot.telegram_setup(...).'
    when v_status = 400 and v_content ilike '%chat not found%' then
      'Tin gần nhất: CHAT_ID sai, hoặc chưa bấm Start với bot / chưa thêm bot vào nhóm.'
    when v_status = 403 then 'Tin gần nhất: bot bị chặn hoặc đã bị xóa khỏi nhóm.'
    else format('Tin gần nhất: lỗi %s: %s', v_status, left(coalesce(v_content, ''), 300))
  end;
end $$;

revoke all on all functions in schema ot from public, anon, authenticated;
