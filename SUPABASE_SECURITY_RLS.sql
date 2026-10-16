-- ============================================================================
-- KỊCH BẢN BẢO MẬT SUPABASE (POSTGRESQL + ROW LEVEL SECURITY + SERVER TIMESTAMP)
-- Dành cho Hệ Thống Báo Tăng Ca Điện Thoại (GitHub Pages 24/7)
-- Khắc phục triệt để 3 tử huyệt Đội Phản Biện (Red-Team) cảnh báo:
--   1. Chống F12 lộ mã PIN nhân sự & khóa Admin bằng Row Level Security (RLS)
--   2. Chống Race Condition khi 50 công nhân gửi đơn cùng lúc (ACID Transaction)
--   3. Chống gian lận chỉnh lùi đồng hồ điện thoại bằng Server Timestamp (now())
-- ============================================================================

-- 1. Bảng Danh mục Nhân viên (Khớp Sheet 2: Danh sách nhân viên)
CREATE TABLE IF NOT EXISTS public.employees (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  default_overtime_type TEXT NOT NULL DEFAULT 'Ngoài khoán',
  default_work_mode TEXT NOT NULL DEFAULT 'Tăng ca tại công ty',
  pin_hash TEXT NOT NULL, -- Lưu mã băm SHA-256 của PIN 4 số, tuyệt đối không lộ qua API public
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 2. Bảng Chi tiết Tăng ca (Khớp Sheet 1: Chi tiết tăng ca)
CREATE TABLE IF NOT EXISTS public.overtime_records (
  id TEXT PRIMARY KEY,
  employee_name TEXT NOT NULL REFERENCES public.employees(name) ON UPDATE CASCADE,
  job_content TEXT NOT NULL CHECK (char_length(trim(job_content)) > 0),
  start_time TEXT NOT NULL DEFAULT '',
  end_time TEXT NOT NULL DEFAULT '',
  work_date TEXT NOT NULL DEFAULT '',
  override_hours NUMERIC(5,2) NULL CHECK (override_hours IS NULL OR override_hours >= 0),
  overtime_type TEXT NOT NULL DEFAULT 'Ngoài khoán',
  work_mode TEXT NOT NULL DEFAULT 'Tăng ca tại công ty',
  note TEXT NOT NULL DEFAULT '',
  is_driver_no_time BOOLEAN NOT NULL DEFAULT FALSE,
  client_reported_at TEXT NULL,
  server_created_at TIMESTAMPTZ NOT NULL DEFAULT now() -- Giờ chuẩn Server chống chỉnh đồng hồ điện thoại
);

-- 3. View công khai cho màn hình Điện thoại Công nhân (Ẩn hoàn toàn cột pin_hash chống F12)
CREATE OR REPLACE VIEW public.public_workers AS
SELECT
  name,
  default_overtime_type AS "defaultOvertimeType",
  default_work_mode AS "defaultWorkMode"
FROM public.employees
ORDER BY name ASC;

-- 4. Bật Row Level Security (RLS) bảo vệ dữ liệu cấp độ Server
ALTER TABLE public.employees ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.overtime_records ENABLE ROW LEVEL SECURITY;

-- Chỉ Admin đã đăng nhập qua Supabase Auth (role = 'authenticated') mới được toàn quyền đọc/sửa/xóa bảng employees
DROP POLICY IF EXISTS "Admin full access on employees" ON public.employees;
CREATE POLICY "Admin full access on employees"
  ON public.employees
  FOR ALL
  TO authenticated
  USING (true)
  WITH CHECK (true);

-- Công nhân (role = 'anon') chỉ được đọc danh sách ca để đối chiếu chống trùng giờ, và chỉ được INSERT qua hàm RPC kiểm định
DROP POLICY IF EXISTS "Public read overtime records for overlap check" ON public.overtime_records;
CREATE POLICY "Public read overtime records for overlap check"
  ON public.overtime_records
  FOR SELECT
  TO anon, authenticated
  USING (true);

DROP POLICY IF EXISTS "Admin full manage overtime records" ON public.overtime_records;
CREATE POLICY "Admin full manage overtime records"
  ON public.overtime_records
  FOR ALL
  TO authenticated
  USING (true)
  WITH CHECK (true);

-- 5. Hàm RPC Server-Side: Xác thực PIN nhân viên, lấy Giờ Chuẩn Server (now()) và ghi nhận đơn tăng ca an toàn
CREATE OR REPLACE FUNCTION public.submit_overtime_secure(
  p_id TEXT,
  p_employee_name TEXT,
  p_pin_hash TEXT,
  p_job_content TEXT,
  p_start_time TEXT,
  p_end_time TEXT,
  p_work_date TEXT,
  p_overtime_type TEXT,
  p_work_mode TEXT,
  p_note TEXT,
  p_is_driver_no_time BOOLEAN
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_emp RECORD;
  v_server_now TIMESTAMPTZ := now();
BEGIN
  -- Kiểm tra nhân viên & mã băm PIN trên Server (Chống F12 bypass)
  SELECT * INTO v_emp FROM public.employees WHERE name = p_employee_name;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Nhân viên không tồn tại trong danh sách.');
  END IF;

  IF v_emp.pin_hash <> p_pin_hash THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Mã PIN xác thực nhân viên không đúng.');
  END IF;

  -- Chống spam: chặn nếu cùng 1 nhân viên gửi liên tiếp trong vòng 3 giây theo Giờ Server
  IF EXISTS (
    SELECT 1 FROM public.overtime_records
    WHERE employee_name = p_employee_name
      AND server_created_at > (v_server_now - INTERVAL '3 seconds')
  ) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Thao tác quá nhanh (Rate-Limit). Vui lòng đợi 3 giây.');
  END IF;

  INSERT INTO public.overtime_records (
    id, employee_name, job_content, start_time, end_time, work_date,
    override_hours, overtime_type, work_mode, note, is_driver_no_time, server_created_at
  ) VALUES (
    p_id,
    p_employee_name,
    trim(p_job_content),
    CASE WHEN p_is_driver_no_time THEN '' ELSE trim(p_start_time) END,
    CASE WHEN p_is_driver_no_time THEN '' ELSE trim(p_end_time) END,
    CASE WHEN p_is_driver_no_time THEN '' ELSE trim(p_work_date) END,
    CASE WHEN p_is_driver_no_time THEN 0 ELSE NULL END,
    p_overtime_type,
    p_work_mode,
     coalesce(p_note, ''),
    p_is_driver_no_time,
    v_server_now
  );

  RETURN jsonb_build_object(
    'ok', true,
    'receipt_id', p_id,
    'server_timestamp', v_server_now
  );
END;
$$;
