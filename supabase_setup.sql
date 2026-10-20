-- =====================================================================
-- CHẤM CÔNG TĂNG CA - CÀI ĐẶT CƠ SỞ DỮ LIỆU SUPABASE
--
-- Cách dùng: Supabase -> SQL Editor -> New query -> dán TOÀN BỘ file này -> Run.
-- Chạy lại nhiều lần vẫn an toàn, không mất dữ liệu.
--
-- Thiết kế bảo mật:
--  * Toàn bộ bảng nằm trong schema riêng "ot" (không mở ra ngoài API).
--  * Trình duyệt chỉ gọi 6 hàm app_* bên dưới; mỗi hàm tự kiểm tra phiên đăng nhập.
--  * Mật khẩu được băm (bcrypt), không ai đọc lại được, kể cả quản trị viên.
--  * Công nhân chỉ đọc/ghi được dữ liệu của chính mình; quản trị viên được tất cả.
--  * Mỗi lần lưu chỉ thêm/sửa/xóa đúng dòng thay đổi, nhiều người báo cùng lúc không mất dữ liệu.
-- =====================================================================

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

do $$
begin
  if not exists (
    select 1 from pg_extension e join pg_namespace n on n.oid = e.extnamespace
    where e.extname = 'pgcrypto' and n.nspname = 'extensions'
  ) then
    raise exception 'Cần bật pgcrypto: Database -> Extensions -> tìm "pgcrypto" -> Enable (schema extensions), rồi chạy lại.';
  end if;
end $$;

create schema if not exists ot;

-- ---------------------------------------------------------------------
-- 1. BẢNG DỮ LIỆU
-- ---------------------------------------------------------------------

create table if not exists ot.employees (
  id bigserial primary key,
  name text not null,
  username text not null,
  password_hash text not null,
  role text not null default 'worker' check (role in ('worker', 'admin')),
  default_overtime_type text not null default 'Ngoài khoán',
  default_work_mode text not null default 'Tăng ca tại công ty',
  start_date date,
  end_date date,
  must_change_password boolean not null default false,
  failed_attempts int not null default 0,
  locked_until timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint employees_name_key unique (name),
  constraint employees_username_key unique (username),
  constraint employees_username_lower check (username = lower(username))
);

create table if not exists ot.sessions (
  token_hash text primary key,
  employee_id bigint not null references ot.employees (id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  last_seen timestamptz not null default now()
);
create index if not exists sessions_employee_idx on ot.sessions (employee_id);
create index if not exists sessions_expires_idx on ot.sessions (expires_at);

create table if not exists ot.records (
  id text primary key,
  employee_id bigint not null references ot.employees (id) on delete restrict,
  job_content text not null check (length(btrim(job_content)) > 0 and length(job_content) <= 300),
  start_time text not null,
  end_time text not null,
  start_ts timestamp not null,
  end_ts timestamp not null,
  work_date date not null,
  override_hours numeric(5, 2) check (override_hours is null or (override_hours >= 0 and override_hours <= 24)),
  overtime_type text not null default 'Ngoài khoán',
  work_mode text not null default 'Tăng ca tại công ty',
  note text not null default '' check (length(note) <= 300),
  modified_after_lock boolean not null default false,
  modified_at text not null default '',
  receipt_id text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint records_time_order check (end_ts > start_ts)
);
create index if not exists records_emp_date_idx on ot.records (employee_id, work_date);
create index if not exists records_date_idx on ot.records (work_date);

create table if not exists ot.holidays (
  work_date date primary key,
  name text not null check (length(btrim(name)) > 0 and length(name) <= 100)
);

create table if not exists ot.locked_days (
  work_date date primary key,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create table if not exists ot.mod_alerts (
  alert_key text primary key,
  work_date date not null,
  employee_id bigint not null references ot.employees (id) on delete cascade,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- Nghỉ (P) / về sớm theo ngày: mỗi người mỗi ngày tối đa 1 dòng, tách riêng khỏi ca tăng ca
create table if not exists ot.day_status (
  employee_id bigint not null references ot.employees (id) on delete restrict,
  work_date date not null,
  leave text not null default '' check (leave in ('', 'MORNING', 'AFTERNOON', 'FULL')),
  early_hours numeric(4, 2) not null default 0 check (early_hours >= 0 and early_hours <= 8),
  updated_at timestamptz not null default now(),
  primary key (employee_id, work_date)
);
create index if not exists day_status_date_idx on ot.day_status (work_date);

-- Số phiên bản thay đổi dữ liệu: để máy khách hỏi nhanh "có gì mới không" thay vì tải lại toàn bộ (tiết kiệm lưu lượng)
create table if not exists ot.meta (
  id int primary key default 1 check (id = 1),
  version bigint not null default 0
);
insert into ot.meta (id) values (1) on conflict (id) do nothing;
alter table ot.employees add column if not exists rev bigint not null default 0;

alter table ot.employees enable row level security;
alter table ot.meta enable row level security;
alter table ot.sessions enable row level security;
alter table ot.records enable row level security;
alter table ot.holidays enable row level security;
alter table ot.locked_days enable row level security;
alter table ot.mod_alerts enable row level security;
alter table ot.day_status enable row level security;

revoke all on schema ot from public, anon, authenticated;
revoke all on all tables in schema ot from public, anon, authenticated;
revoke all on all sequences in schema ot from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 2. HÀM PHỤ (nội bộ, không mở ra ngoài)
-- ---------------------------------------------------------------------

create or replace function ot.fail(p_hint text, p_msg text) returns void
language plpgsql as $$
begin
  raise exception '%', p_msg using errcode = 'P0001', hint = p_hint;
end $$;

create or replace function ot.vn_today() returns date
language sql stable set search_path = '' as $$
  select (now() at time zone 'Asia/Ho_Chi_Minh')::date
$$;

create or replace function ot.parse_vn_date(p text) returns date
language plpgsql stable set search_path = '' as $$
declare m text[];
begin
  m := regexp_match(btrim(coalesce(p, '')), '^(\d{2})/(\d{2})/(\d{4})$');
  if m is null then
    perform ot.fail('bad_date', 'Ngày phải theo dạng dd/mm/yyyy: ' || coalesce(p, ''));
  end if;
  return make_date(m[3]::int, m[2]::int, m[1]::int);
exception when datetime_field_overflow or invalid_datetime_format then
  perform ot.fail('bad_date', 'Ngày không hợp lệ: ' || coalesce(p, ''));
  return null;
end $$;

create or replace function ot.parse_vn_ts(p text) returns timestamp
language plpgsql stable set search_path = '' as $$
declare m text[];
begin
  m := regexp_match(btrim(coalesce(p, '')), '^(\d{2})/(\d{2})/(\d{4}) (\d{2}):(\d{2})$');
  if m is null then
    perform ot.fail('bad_time', 'Giờ phải theo dạng dd/mm/yyyy hh:mm: ' || coalesce(p, ''));
  end if;
  return make_timestamp(m[3]::int, m[2]::int, m[1]::int, m[4]::int, m[5]::int, 0);
exception when datetime_field_overflow or invalid_datetime_format then
  perform ot.fail('bad_time', 'Giờ không hợp lệ: ' || coalesce(p, ''));
  return null;
end $$;

create or replace function ot.parse_iso_date(p text) returns date
language plpgsql stable set search_path = '' as $$
begin
  if p is null or btrim(p) = '' then
    return null;
  end if;
  if btrim(p) !~ '^\d{4}-\d{2}-\d{2}$' then
    perform ot.fail('bad_date', 'Ngày không hợp lệ: ' || p);
  end if;
  return btrim(p)::date;
exception when datetime_field_overflow or invalid_datetime_format then
  perform ot.fail('bad_date', 'Ngày không hợp lệ: ' || p);
  return null;
end $$;

create or replace function ot.hash_token(p text) returns text
language sql immutable set search_path = '' as $$
  select encode(extensions.digest(coalesce(p, ''), 'sha256'), 'hex')
$$;

create or replace function ot.arr(p jsonb, k text) returns jsonb
language plpgsql stable set search_path = '' as $$
declare x jsonb := p -> k;
begin
  if x is null or jsonb_typeof(x) = 'null' then
    return '[]'::jsonb;
  end if;
  if jsonb_typeof(x) <> 'array' then
    perform ot.fail('bad_request', 'Dữ liệu gửi lên không hợp lệ (' || k || ').');
  end if;
  return x;
end $$;

create or replace function ot.record_json(r ot.records, p_name text) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'id', r.id,
    'employeeName', p_name,
    'jobContent', r.job_content,
    'startTime', r.start_time,
    'endTime', r.end_time,
    'workDate', to_char(r.work_date, 'DD/MM/YYYY'),
    'overrideHours', r.override_hours,
    'overtimeType', r.overtime_type,
    'workMode', r.work_mode,
    'note', r.note,
    'isDriverNoTime', false,
    'modifiedAfterLock', r.modified_after_lock,
    'modifiedAt', r.modified_at,
    'receiptId', r.receipt_id,
    'serverTimestamp', to_char(r.created_at at time zone 'Asia/Ho_Chi_Minh', 'DD/MM/YYYY HH24:MI:SS'),
    'createdAt', to_char(r.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
  )
$$;

-- Kiểm tra phiên đăng nhập, trả về dòng nhân viên tương ứng (báo lỗi nếu hết hạn)
create or replace function ot.require_session(p_token text) returns ot.employees
language plpgsql set search_path = '' as $$
declare
  s ot.sessions;
  e ot.employees;
begin
  if p_token is null or length(p_token) < 32 then
    perform ot.fail('unauthorized', 'Phiên đăng nhập không hợp lệ. Vui lòng đăng nhập lại.');
  end if;
  select * into s from ot.sessions where token_hash = ot.hash_token(p_token);
  if not found or s.expires_at <= now() then
    perform ot.fail('unauthorized', 'Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.');
  end if;
  select * into e from ot.employees where id = s.employee_id;
  if e.role = 'worker' and e.end_date is not null and e.end_date < ot.vn_today() then
    perform ot.fail('inactive', 'Tài khoản đã ngừng sử dụng.');
  end if;
  if s.last_seen < now() - interval '1 hour' then
    update ot.sessions
       set last_seen = now(),
           expires_at = greatest(expires_at, now() + case when e.role = 'admin' then interval '12 hours' else interval '30 days' end)
     where token_hash = s.token_hash;
  end if;
  return e;
end $$;

-- ---------------------------------------------------------------------
-- 3. CÁC HÀM MÀ TRÌNH DUYỆT ĐƯỢC GỌI
-- ---------------------------------------------------------------------

-- Đăng nhập: trả về mã phiên (token). Sai 5 lần liên tiếp thì khóa 15 phút.
create or replace function public.app_login(p_username text, p_password text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v ot.employees;
  v_user text := lower(btrim(coalesce(p_username, '')));
  v_token text;
  v_invalid jsonb := jsonb_build_object('ok', false, 'error', 'invalid',
    'message', 'Tên đăng nhập hoặc mật khẩu chưa đúng.');
begin
  if v_user = '' or coalesce(p_password, '') = '' then
    return jsonb_build_object('ok', false, 'error', 'invalid',
      'message', 'Vui lòng nhập tên đăng nhập và mật khẩu.');
  end if;

  delete from ot.sessions where expires_at < now();

  select * into v from ot.employees where username = v_user for update;
  if not found then
    perform extensions.crypt(p_password, extensions.gen_salt('bf', 10));
    return v_invalid;
  end if;

  if v.locked_until is not null and v.locked_until > now() then
    return jsonb_build_object('ok', false, 'error', 'locked',
      'message', 'Nhập sai nhiều lần. Vui lòng thử lại sau ' ||
        ceil(extract(epoch from (v.locked_until - now())) / 60)::int || ' phút.');
  end if;

  if v.password_hash = extensions.crypt(p_password, v.password_hash) then
    if v.role = 'worker' and v.end_date is not null and v.end_date < ot.vn_today() then
      return jsonb_build_object('ok', false, 'error', 'inactive',
        'message', 'Tài khoản này đã ngừng sử dụng. Vui lòng liên hệ Quản đốc.');
    end if;
    update ot.employees set failed_attempts = 0, locked_until = null where id = v.id;
    v_token := encode(extensions.gen_random_bytes(32), 'hex');
    insert into ot.sessions (token_hash, employee_id, expires_at)
    values (ot.hash_token(v_token), v.id,
            now() + case when v.role = 'admin' then interval '12 hours' else interval '30 days' end);
    return jsonb_build_object('ok', true, 'token', v_token, 'role', v.role, 'name', v.name,
      'username', v.username, 'mustChangePassword', v.must_change_password);
  end if;

  update ot.employees
     set failed_attempts = case when failed_attempts + 1 >= 5 then 0 else failed_attempts + 1 end,
         locked_until = case when failed_attempts + 1 >= 5 then now() + interval '15 minutes' else locked_until end
   where id = v.id;
  return v_invalid;
end $$;

create or replace function public.app_logout(p_token text) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  delete from ot.sessions where token_hash = ot.hash_token(p_token);
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.app_change_password(p_token text, p_old text, p_new text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v ot.employees;
  v_min int;
begin
  v := ot.require_session(p_token);
  if v.password_hash <> extensions.crypt(coalesce(p_old, ''), v.password_hash) then
    return jsonb_build_object('ok', false, 'error', 'bad_old', 'message', 'Mật khẩu hiện tại chưa đúng.');
  end if;
  v_min := case when v.role = 'admin' then 6 else 4 end;
  if length(coalesce(p_new, '')) < v_min then
    return jsonb_build_object('ok', false, 'error', 'too_short',
      'message', 'Mật khẩu mới phải có ít nhất ' || v_min || ' ký tự.');
  end if;
  if p_new = p_old then
    return jsonb_build_object('ok', false, 'error', 'same', 'message', 'Mật khẩu mới phải khác mật khẩu cũ.');
  end if;
  update ot.employees
     set password_hash = extensions.crypt(p_new, extensions.gen_salt('bf', 10)),
         must_change_password = false, failed_attempts = 0, locked_until = null, updated_at = now()
   where id = v.id;
  delete from ot.sessions where employee_id = v.id and token_hash <> ot.hash_token(p_token);
  return jsonb_build_object('ok', true);
end $$;

-- Tải dữ liệu. Quản trị viên: tất cả nhân viên + ca của khoảng ngày chọn (mặc định tháng hiện tại).
-- Công nhân: chỉ thông tin và các ca của chính mình.
create or replace function public.app_pull(p_token text, p_from date default null, p_to date default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v ot.employees;
  today date := ot.vn_today();
  d_from date;
  d_to date;
  v_employees jsonb;
  v_records jsonb;
  v_holidays jsonb;
  v_locked jsonb;
  v_alerts jsonb;
  v_statuses jsonb;
  v_sig text;
begin
  v := ot.require_session(p_token);

  if v.role = 'admin' then
    d_from := coalesce(p_from, date_trunc('month', today::timestamp)::date);
    d_to := coalesce(p_to, (date_trunc('month', today::timestamp) + interval '1 month - 1 day')::date);
    if d_to < d_from then d_to := d_from; end if;
    if d_to - d_from > 400 then d_from := d_to - 400; end if;
  else
    d_from := today - 400;
    d_to := today + 60;
  end if;
  v_sig := case when v.role = 'admin' then (select m.version from ot.meta m where m.id = 1)::text else v.rev::text end;

  select coalesce(jsonb_agg(jsonb_build_object(
           'name', e.name,
           'username', e.username,
           'defaultOvertimeType', e.default_overtime_type,
           'defaultWorkMode', e.default_work_mode,
           'startDate', e.start_date,
           'endDate', e.end_date,
           'mustChangePassword', e.must_change_password,
           'hasRecords', exists (select 1 from ot.records r where r.employee_id = e.id)
                         or exists (select 1 from ot.day_status s where s.employee_id = e.id)
         ) order by e.name), '[]'::jsonb)
    into v_employees
    from ot.employees e
   where e.role = 'worker' and (v.role = 'admin' or e.id = v.id);

  select coalesce(jsonb_agg(ot.record_json(r, e.name) order by r.start_ts, r.id), '[]'::jsonb)
    into v_records
    from ot.records r join ot.employees e on e.id = r.employee_id
   where r.work_date between d_from and d_to
     and (v.role = 'admin' or r.employee_id = v.id);

  select coalesce(jsonb_object_agg(to_char(h.work_date, 'DD/MM/YYYY'), h.name), '{}'::jsonb)
    into v_holidays from ot.holidays h;

  select coalesce(jsonb_object_agg(to_char(l.work_date, 'DD/MM/YYYY'),
           case when v.role = 'admin' or jsonb_typeof(l.data -> 'snapshot') is distinct from 'object' then l.data
                else jsonb_set(l.data, '{snapshot}',
                       coalesce((select jsonb_object_agg(s.key, s.value)
                                   from jsonb_each(l.data -> 'snapshot') s where s.key = v.name), '{}'::jsonb))
           end), '{}'::jsonb)
    into v_locked
    from ot.locked_days l
   where l.work_date between d_from and d_to;

  select coalesce(jsonb_object_agg(a.alert_key, a.data), '{}'::jsonb)
    into v_alerts
    from ot.mod_alerts a
   where v.role = 'admin' or a.employee_id = v.id;

  select coalesce(jsonb_object_agg(to_char(s.work_date, 'DD/MM/YYYY') || '::' || e.name,
           jsonb_build_object('leave', s.leave, 'earlyHours', s.early_hours)), '{}'::jsonb)
    into v_statuses
    from ot.day_status s join ot.employees e on e.id = s.employee_id
   where s.work_date between d_from and d_to
     and (v.role = 'admin' or s.employee_id = v.id);

  return jsonb_build_object(
    'ok', true,
    'role', v.role,
    'name', v.name,
    'username', v.username,
    'mustChangePassword', v.must_change_password,
    'serverTime', to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'vnToday', to_char(today, 'YYYY-MM-DD'),
    'sig', v_sig,
    'window', jsonb_build_object('from', d_from, 'to', d_to),
    'employees', v_employees,
    'records', v_records,
    'holidays', v_holidays,
    'lockedDays', v_locked,
    'dayModAlerts', v_alerts,
    'dayStatuses', v_statuses
  );
end $$;

-- Hỏi nhanh "có gì mới không": chỉ trả về vài byte. Máy khách chỉ tải lại dữ liệu khi chữ ký đổi.
create or replace function public.app_pulse(p_token text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v ot.employees;
begin
  v := ot.require_session(p_token);
  return jsonb_build_object(
    'ok', true,
    'sig', case when v.role = 'admin' then (select m.version from ot.meta m where m.id = 1)::text else v.rev::text end
  );
end $$;

-- Ghi dữ liệu: chỉ nhận các thay đổi (thêm/sửa/xóa theo từng dòng), tất cả trong 1 giao dịch.
create or replace function public.app_push(p_token text, p_ops jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v ot.employees;
  is_admin boolean;
  today date := ot.vn_today();
  item jsonb;
  k text;
  emp ot.employees;
  rec_emp ot.employees;
  v_id text;
  v_job text;
  v_start timestamp;
  v_end timestamp;
  v_date date;
  v_override numeric;
  v_type text;
  v_mode text;
  v_note text;
  v_receipt text;
  touched text[] := '{}';
  receipts jsonb := '{}'::jsonb;
  v_name text;
  v_user text;
  v_pwd text;
  v_sd date;
  v_ed date;
  v_key text;
  v_wd date;
  v_data jsonb;
  v_limit int;
  v_bump bigint[] := '{}';
  v_bump_all boolean := false;
  v_eid bigint;
  v_leave text;
  v_early numeric;
begin
  v := ot.require_session(p_token);
  is_admin := (v.role = 'admin');

  if p_ops is null or jsonb_typeof(p_ops) <> 'object' then
    perform ot.fail('bad_request', 'Dữ liệu gửi lên không hợp lệ.');
  end if;

  if not is_admin then
    for k in select jsonb_object_keys(p_ops) loop
      if k not in ('recordsUpsert', 'recordsDelete', 'alertsUpsert', 'statusUpsert', 'statusDelete') then
        perform ot.fail('forbidden', 'Bạn không có quyền thực hiện thao tác này.');
      end if;
    end loop;
  end if;

  v_limit := case when is_admin then 1000 else 40 end;
  if jsonb_array_length(ot.arr(p_ops, 'recordsUpsert')) > v_limit
     or jsonb_array_length(ot.arr(p_ops, 'recordsDelete')) > v_limit
     or jsonb_array_length(ot.arr(p_ops, 'statusUpsert')) > v_limit
     or jsonb_array_length(ot.arr(p_ops, 'statusDelete')) > v_limit then
    perform ot.fail('too_many', 'Gửi quá nhiều dòng cùng lúc.');
  end if;

  -- Xếp hàng các lần ghi để kiểm tra trùng giờ luôn chính xác khi nhiều người bấm cùng lúc
  perform pg_advisory_xact_lock(727001);

  -- ===== Thêm / sửa nhân viên (chỉ quản trị viên) - làm trước để ca của nhân viên mới nhập cùng lúc vẫn hợp lệ =====
  for item in select jsonb_array_elements(ot.arr(p_ops, 'employeesUpsert')) loop
    v_name := btrim(coalesce(item ->> 'name', ''));
    if v_name = '' or length(v_name) > 80 then
      perform ot.fail('bad_employee', 'Tên nhân viên không hợp lệ.');
    end if;
    v_user := lower(btrim(coalesce(item ->> 'username', '')));
    if v_user !~ '^[a-z0-9._-]{2,32}$' then
      perform ot.fail('bad_employee', 'Tên đăng nhập chỉ gồm chữ không dấu, số, dấu chấm, gạch (2-32 ký tự).');
    end if;
    if v_user in ('admin', 'quantri') then
      perform ot.fail('bad_employee', 'Tên đăng nhập "' || v_user || '" dành riêng cho quản trị viên.');
    end if;
    v_type := coalesce(nullif(item ->> 'defaultOvertimeType', ''), 'Ngoài khoán');
    if v_type not in ('Ngoài khoán', 'Trong khoán') then
      perform ot.fail('bad_employee', 'Loại tăng ca mặc định không hợp lệ.');
    end if;
    v_mode := coalesce(nullif(item ->> 'defaultWorkMode', ''), 'Tăng ca tại công ty');
    if v_mode not in ('Tăng ca tại công ty', 'Tăng ca trưa', 'Tăng ca ngoài công ty') then
      perform ot.fail('bad_employee', 'Hình thức tăng ca mặc định không hợp lệ.');
    end if;
    v_sd := ot.parse_iso_date(item ->> 'startDate');
    v_ed := ot.parse_iso_date(item ->> 'endDate');
    if v_sd is not null and v_ed is not null and v_ed < v_sd then
      perform ot.fail('bad_employee', 'Ngày nghỉ việc không được trước ngày vào làm.');
    end if;
    v_pwd := nullif(item ->> 'password', '');
    if v_pwd is not null and length(v_pwd) < 4 then
      perform ot.fail('bad_employee', 'Mật khẩu phải có ít nhất 4 ký tự.');
    end if;

    select * into emp from ot.employees where name = v_name;
    begin
      if found then
        if emp.role = 'admin' then
          perform ot.fail('forbidden', 'Không thể sửa tài khoản quản trị viên ở đây.');
        end if;
        update ot.employees
           set username = v_user, default_overtime_type = v_type, default_work_mode = v_mode,
               start_date = v_sd, end_date = v_ed, updated_at = now(), rev = rev + 1
         where id = emp.id;
        if v_pwd is not null then
          update ot.employees
             set password_hash = extensions.crypt(v_pwd, extensions.gen_salt('bf', 10)),
                 must_change_password = true, failed_attempts = 0, locked_until = null
           where id = emp.id;
          delete from ot.sessions where employee_id = emp.id;
        end if;
      else
        if v_pwd is null then
          perform ot.fail('bad_employee', 'Cần đặt mật khẩu cho nhân viên mới.');
        end if;
        insert into ot.employees (name, username, password_hash, default_overtime_type, default_work_mode,
                                  start_date, end_date, must_change_password)
        values (v_name, v_user, extensions.crypt(v_pwd, extensions.gen_salt('bf', 10)), v_type, v_mode,
                v_sd, v_ed, true);
      end if;
    exception when unique_violation then
      perform ot.fail('duplicate', 'Tên đăng nhập "' || v_user || '" hoặc tên nhân viên đã có người dùng. Vui lòng chọn tên khác.');
    end;
  end loop;

  -- ===== Xóa ca =====
  for v_id in select jsonb_array_elements_text(ot.arr(p_ops, 'recordsDelete')) loop
    if not is_admin and exists (select 1 from ot.records where id = v_id and employee_id <> v.id) then
      perform ot.fail('forbidden', 'Bạn chỉ được xóa ca của chính mình.');
    end if;
    select employee_id into v_eid from ot.records where id = v_id;
    if found then
      v_bump := v_bump || v_eid;
    end if;
    delete from ot.records where id = v_id and (is_admin or employee_id = v.id);
  end loop;

  -- ===== Thêm / sửa ca =====
  for item in select jsonb_array_elements(ot.arr(p_ops, 'recordsUpsert')) loop
    if is_admin then
      select * into rec_emp from ot.employees
       where name = btrim(coalesce(item ->> 'employeeName', '')) and role = 'worker';
      if not found then
        perform ot.fail('bad_employee', 'Không tìm thấy nhân viên: ' || coalesce(item ->> 'employeeName', ''));
      end if;
    else
      if btrim(coalesce(item ->> 'employeeName', '')) is distinct from v.name then
        perform ot.fail('forbidden', 'Bạn chỉ được báo tăng ca cho chính mình.');
      end if;
      rec_emp := v;
    end if;

    v_id := btrim(coalesce(item ->> 'id', ''));
    if v_id !~ '^[A-Za-z0-9_-]{4,64}$' then
      perform ot.fail('bad_record', 'Mã ca không hợp lệ.');
    end if;
    v_job := btrim(coalesce(item ->> 'jobContent', ''));
    if v_job = '' then
      perform ot.fail('bad_record', 'Thiếu nội dung công việc.');
    end if;
    if length(v_job) > 300 then
      perform ot.fail('bad_record', 'Nội dung công việc quá dài (tối đa 300 ký tự).');
    end if;
    v_note := btrim(coalesce(item ->> 'note', ''));
    if length(v_note) > 300 then
      perform ot.fail('bad_record', 'Ghi chú quá dài (tối đa 300 ký tự).');
    end if;

    v_start := ot.parse_vn_ts(item ->> 'startTime');
    v_end := ot.parse_vn_ts(item ->> 'endTime');
    if v_end <= v_start then
      perform ot.fail('bad_record', 'Giờ kết thúc phải sau giờ bắt đầu.');
    end if;
    if v_end - v_start > interval '24 hours' then
      perform ot.fail('bad_record', 'Một ca không được dài quá 24 giờ.');
    end if;
    v_date := ot.parse_vn_date(coalesce(nullif(btrim(item ->> 'workDate'), ''), split_part(item ->> 'startTime', ' ', 1)));
    if abs(v_date - v_start::date) > 1 then
      perform ot.fail('bad_record', 'Ngày tính công lệch quá xa so với giờ bắt đầu.');
    end if;
    if (rec_emp.start_date is not null and v_date < rec_emp.start_date)
       or (rec_emp.end_date is not null and v_date > rec_emp.end_date) then
      perform ot.fail('not_employed', 'Nhân viên chưa vào làm hoặc đã nghỉ việc vào ngày ' || to_char(v_date, 'DD/MM/YYYY') || '.');
    end if;
    if not is_admin and v_date > today then
      perform ot.fail('future_date', 'Chưa tới ngày ' || to_char(v_date, 'DD/MM/YYYY') || ' nên chưa báo được.');
    end if;

    v_override := null;
    if nullif(btrim(coalesce(item ->> 'overrideHours', '')), '') is not null then
      begin
        v_override := (item ->> 'overrideHours')::numeric;
      exception when invalid_text_representation then
        perform ot.fail('bad_record', 'Số giờ ghi đè không hợp lệ.');
      end;
      if v_override < 0 or v_override > 24 then
        perform ot.fail('bad_record', 'Số giờ ghi đè phải từ 0 đến 24.');
      end if;
    end if;

    v_type := coalesce(nullif(item ->> 'overtimeType', ''), 'Ngoài khoán');
    if v_type not in ('Ngoài khoán', 'Trong khoán') then
      perform ot.fail('bad_record', 'Loại tăng ca không hợp lệ.');
    end if;
    v_mode := coalesce(nullif(item ->> 'workMode', ''), 'Tăng ca tại công ty');
    if v_mode not in ('Tăng ca tại công ty', 'Tăng ca trưa', 'Tăng ca ngoài công ty') then
      perform ot.fail('bad_record', 'Hình thức tăng ca không hợp lệ.');
    end if;

    select employee_id into v_eid from ot.records where id = v_id;
    if found then
      v_bump := v_bump || v_eid;
    end if;
    v_bump := v_bump || rec_emp.id;

    update ot.records
       set employee_id = rec_emp.id,
           job_content = v_job,
           start_time = btrim(item ->> 'startTime'),
           end_time = btrim(item ->> 'endTime'),
           start_ts = v_start,
           end_ts = v_end,
           work_date = v_date,
           override_hours = case when is_admin then v_override else override_hours end,
           overtime_type = v_type,
           work_mode = v_mode,
           note = v_note,
           modified_after_lock = (item -> 'modifiedAfterLock') = 'true'::jsonb,
           modified_at = left(coalesce(item ->> 'modifiedAt', ''), 40),
           updated_at = now()
     where id = v_id and (is_admin or employee_id = v.id)
    returning receipt_id into v_receipt;

    if not found then
      if exists (select 1 from ot.records where id = v_id) then
        perform ot.fail('forbidden', 'Mã ca đã được dùng bởi dữ liệu khác.');
      end if;
      v_receipt := 'ACK_' || upper(substr(md5(random()::text || clock_timestamp()::text || v_id), 1, 6));
      insert into ot.records (id, employee_id, job_content, start_time, end_time, start_ts, end_ts, work_date,
                              override_hours, overtime_type, work_mode, note, modified_after_lock, modified_at, receipt_id)
      values (v_id, rec_emp.id, v_job, btrim(item ->> 'startTime'), btrim(item ->> 'endTime'), v_start, v_end, v_date,
              case when is_admin then v_override else null end, v_type, v_mode, v_note,
              (item -> 'modifiedAfterLock') = 'true'::jsonb, left(coalesce(item ->> 'modifiedAt', ''), 40), v_receipt);
    end if;

    receipts := receipts || jsonb_build_object(v_id, v_receipt);
    touched := touched || v_id;
  end loop;

  if array_length(touched, 1) is not null then
    if exists (
      select 1
        from ot.records t
        join ot.records o on o.employee_id = t.employee_id and o.id <> t.id
                         and o.start_ts < t.end_ts and t.start_ts < o.end_ts
       where t.id = any (touched)
    ) then
      perform ot.fail('overlap', 'Giờ tăng ca bị trùng hoặc chồng lấn với ca đã báo trước đó.');
    end if;
    if exists (
      select 1
        from ot.records r
       where (r.employee_id, r.work_date) in (select t.employee_id, t.work_date from ot.records t where t.id = any (touched))
       group by r.employee_id, r.work_date
      having count(*) > 12
    ) then
      perform ot.fail('too_many', 'Một ngày không được có quá 12 ca.');
    end if;
  end if;

  -- ===== Nghỉ (P) / về sớm theo ngày (khóa 'dd/mm/yyyy::Tên') =====
  for item in select jsonb_array_elements(ot.arr(p_ops, 'statusUpsert')) loop
    v_key := btrim(coalesce(item ->> 'key', ''));
    if position('::' in v_key) = 0 then
      perform ot.fail('bad_request', 'Mã ngày nghỉ / về sớm không hợp lệ.');
    end if;
    v_wd := ot.parse_vn_date(split_part(v_key, '::', 1));
    v_name := substr(v_key, position('::' in v_key) + 2);
    select * into emp from ot.employees where name = v_name and role = 'worker';
    if not found then
      perform ot.fail('bad_employee', 'Không tìm thấy nhân viên: ' || v_name);
    end if;
    if not is_admin and emp.id <> v.id then
      perform ot.fail('forbidden', 'Bạn chỉ được báo nghỉ / về sớm cho chính mình.');
    end if;
    if (emp.start_date is not null and v_wd < emp.start_date) or (emp.end_date is not null and v_wd > emp.end_date) then
      perform ot.fail('not_employed', 'Nhân viên chưa vào làm hoặc đã nghỉ việc vào ngày ' || to_char(v_wd, 'DD/MM/YYYY') || '.');
    end if;
    if not is_admin and v_wd > today then
      perform ot.fail('future_date', 'Chưa tới ngày ' || to_char(v_wd, 'DD/MM/YYYY') || ' nên chưa báo được.');
    end if;
    v_leave := coalesce(item ->> 'leave', '');
    if v_leave not in ('', 'MORNING', 'AFTERNOON', 'FULL') then
      perform ot.fail('bad_request', 'Loại nghỉ không hợp lệ.');
    end if;
    begin
      v_early := round(coalesce(nullif(btrim(coalesce(item ->> 'earlyHours', '')), ''), '0')::numeric, 2);
    exception when invalid_text_representation then
      perform ot.fail('bad_request', 'Số giờ về sớm không hợp lệ.');
    end;
    if v_early < 0 or v_early > 8 then
      perform ot.fail('bad_request', 'Số giờ về sớm phải từ 0 đến 8.');
    end if;
    if v_leave = 'FULL' then
      v_early := 0;
    end if;
    if v_leave = '' and v_early = 0 then
      delete from ot.day_status where employee_id = emp.id and work_date = v_wd;
    else
      insert into ot.day_status (employee_id, work_date, leave, early_hours) values (emp.id, v_wd, v_leave, v_early)
      on conflict (employee_id, work_date) do update
        set leave = excluded.leave, early_hours = excluded.early_hours, updated_at = now();
    end if;
    v_bump := v_bump || emp.id;
  end loop;
  for v_key in select jsonb_array_elements_text(ot.arr(p_ops, 'statusDelete')) loop
    if position('::' in v_key) = 0 then
      perform ot.fail('bad_request', 'Mã ngày nghỉ / về sớm không hợp lệ.');
    end if;
    v_wd := ot.parse_vn_date(split_part(v_key, '::', 1));
    v_name := substr(v_key, position('::' in v_key) + 2);
    select * into emp from ot.employees where name = v_name and role = 'worker';
    if found then
      if not is_admin and emp.id <> v.id then
        perform ot.fail('forbidden', 'Bạn chỉ được sửa nghỉ / về sớm của chính mình.');
      end if;
      delete from ot.day_status where employee_id = emp.id and work_date = v_wd;
      v_bump := v_bump || emp.id;
    end if;
  end loop;

  -- ===== Xóa nhân viên (chỉ khi chưa có dữ liệu tăng ca / nghỉ) =====
  for v_name in select jsonb_array_elements_text(ot.arr(p_ops, 'employeesDelete')) loop
    select * into emp from ot.employees where name = v_name and role = 'worker';
    if found then
      if exists (select 1 from ot.records where employee_id = emp.id)
         or exists (select 1 from ot.day_status where employee_id = emp.id) then
        perform ot.fail('has_records', 'Nhân viên "' || v_name || '" đã có dữ liệu tăng ca nên không xóa được. Hãy dùng "Cho nghỉ việc".');
      end if;
      delete from ot.employees where id = emp.id;
    end if;
  end loop;

  -- ===== Ngày nghỉ lễ =====
  for item in select jsonb_array_elements(ot.arr(p_ops, 'holidaysUpsert')) loop
    v_wd := ot.parse_vn_date(item ->> 'date');
    v_name := btrim(coalesce(item ->> 'name', ''));
    if v_name = '' or length(v_name) > 100 then
      perform ot.fail('bad_holiday', 'Tên ngày nghỉ không hợp lệ.');
    end if;
    insert into ot.holidays (work_date, name) values (v_wd, v_name)
    on conflict (work_date) do update set name = excluded.name;
    v_bump_all := true;
  end loop;
  for v_key in select jsonb_array_elements_text(ot.arr(p_ops, 'holidaysDelete')) loop
    delete from ot.holidays where work_date = ot.parse_vn_date(v_key);
    v_bump_all := true;
  end loop;

  -- ===== Chốt công =====
  for item in select jsonb_array_elements(ot.arr(p_ops, 'lockedUpsert')) loop
    v_wd := ot.parse_vn_date(item ->> 'date');
    v_data := coalesce(item -> 'data', '{}'::jsonb);
    if jsonb_typeof(v_data) <> 'object' or length(v_data::text) > 200000 then
      perform ot.fail('bad_request', 'Dữ liệu chốt công không hợp lệ.');
    end if;
    insert into ot.locked_days (work_date, data) values (v_wd, v_data)
    on conflict (work_date) do update set data = excluded.data, updated_at = now();
    v_bump_all := true;
  end loop;
  for v_key in select jsonb_array_elements_text(ot.arr(p_ops, 'lockedDelete')) loop
    delete from ot.locked_days where work_date = ot.parse_vn_date(v_key);
    v_bump_all := true;
  end loop;

  -- ===== Cảnh báo sửa sau chốt =====
  for item in select jsonb_array_elements(ot.arr(p_ops, 'alertsUpsert')) loop
    v_key := btrim(coalesce(item ->> 'key', ''));
    if position('::' in v_key) = 0 then
      perform ot.fail('bad_request', 'Mã cảnh báo không hợp lệ.');
    end if;
    v_wd := ot.parse_vn_date(split_part(v_key, '::', 1));
    v_name := substr(v_key, position('::' in v_key) + 2);
    select * into emp from ot.employees where name = v_name and role = 'worker';
    if not found then
      perform ot.fail('bad_employee', 'Không tìm thấy nhân viên: ' || v_name);
    end if;
    if not is_admin and emp.id <> v.id then
      perform ot.fail('forbidden', 'Bạn chỉ được gửi cảnh báo của chính mình.');
    end if;
    v_data := coalesce(item -> 'data', '{}'::jsonb);
    if jsonb_typeof(v_data) <> 'object' or length(v_data::text) > 20000 then
      perform ot.fail('bad_request', 'Dữ liệu cảnh báo không hợp lệ.');
    end if;
    insert into ot.mod_alerts (alert_key, work_date, employee_id, data) values (v_key, v_wd, emp.id, v_data)
    on conflict (alert_key) do update set data = excluded.data, updated_at = now();
    v_bump := v_bump || emp.id;
  end loop;
  if is_admin then
    for v_key in select jsonb_array_elements_text(ot.arr(p_ops, 'alertsDelete')) loop
      select employee_id into v_eid from ot.mod_alerts where alert_key = v_key;
      if found then
        v_bump := v_bump || v_eid;
      end if;
      delete from ot.mod_alerts where alert_key = v_key;
    end loop;
  end if;

  -- Báo cho máy khách biết có thay đổi (admin: mọi thay đổi; công nhân: chỉ phần liên quan tới họ)
  if v_bump_all then
    update ot.employees set rev = rev + 1 where role = 'worker';
  elsif array_length(v_bump, 1) is not null then
    update ot.employees set rev = rev + 1 where id = any (v_bump);
  end if;
  update ot.meta set version = version + 1 where id = 1;

  return jsonb_build_object(
    'ok', true,
    'receipts', receipts,
    'serverTime', to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  );
end $$;

-- ---------------------------------------------------------------------
-- 4. CÔNG CỤ CHO CHỦ DỰ ÁN (chỉ chạy được trong SQL Editor, không gọi được từ web)
-- ---------------------------------------------------------------------

-- Tạo tài khoản quản trị lần đầu:   select ot.bootstrap_admin('mật-khẩu-của-bạn');
create or replace function ot.bootstrap_admin(p_password text) returns text
language plpgsql set search_path = '' as $$
begin
  if exists (select 1 from ot.employees where role = 'admin') then
    raise exception 'Đã có tài khoản admin rồi. Nếu quên mật khẩu hãy dùng: select ot.reset_admin_password(''mật-khẩu-mới'');';
  end if;
  if length(coalesce(p_password, '')) < 6 then
    raise exception 'Mật khẩu admin phải có ít nhất 6 ký tự.';
  end if;
  insert into ot.employees (name, username, password_hash, role)
  values ('Quản trị viên', 'admin', extensions.crypt(p_password, extensions.gen_salt('bf', 10)), 'admin');
  return 'Đã tạo tài khoản admin. Đăng nhập trong ứng dụng bằng tên đăng nhập: admin';
end $$;

-- Quên mật khẩu admin:   select ot.reset_admin_password('mật-khẩu-mới');
create or replace function ot.reset_admin_password(p_password text) returns text
language plpgsql set search_path = '' as $$
begin
  if length(coalesce(p_password, '')) < 6 then
    raise exception 'Mật khẩu admin phải có ít nhất 6 ký tự.';
  end if;
  update ot.employees
     set password_hash = extensions.crypt(p_password, extensions.gen_salt('bf', 10)),
         failed_attempts = 0, locked_until = null, must_change_password = false
   where role = 'admin';
  if not found then
    raise exception 'Chưa có tài khoản admin. Hãy dùng: select ot.bootstrap_admin(''mật-khẩu'');';
  end if;
  delete from ot.sessions where employee_id in (select id from ot.employees where role = 'admin');
  return 'Đã đổi mật khẩu admin.';
end $$;

-- ---------------------------------------------------------------------
-- 5. PHÂN QUYỀN: web chỉ gọi được 5 hàm app_*, không đọc được bảng nào
-- ---------------------------------------------------------------------

revoke all on all functions in schema ot from public, anon, authenticated;

revoke all on function public.app_login(text, text) from public;
revoke all on function public.app_logout(text) from public;
revoke all on function public.app_change_password(text, text, text) from public;
revoke all on function public.app_pull(text, date, date) from public;
revoke all on function public.app_pulse(text) from public;
revoke all on function public.app_push(text, jsonb) from public;

grant execute on function public.app_login(text, text) to anon, authenticated;
grant execute on function public.app_logout(text) to anon, authenticated;
grant execute on function public.app_change_password(text, text, text) to anon, authenticated;
grant execute on function public.app_pull(text, date, date) to anon, authenticated;
grant execute on function public.app_pulse(text) to anon, authenticated;
grant execute on function public.app_push(text, jsonb) to anon, authenticated;

notify pgrst, 'reload schema';
