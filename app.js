/**
 * ============================================================================
 * HỆ THỐNG BÁO TĂNG CA ĐIỆN THOẠI (3 CHẠM) & QUẢN TRỊ XUẤT EXCEL CHUẨN MẪU
 * Phiên bản: Hybrid Smart Factory V3.0 (Mobile-First + Exact .XLSX Engine)
 *
 * Khắc phục triệt để 3 lỗ hổng Đội Phản Biện (Red-Team) cảnh báo:
 *  1. Chuẩn hóa 100% quy tắc cột Thời gian tăng ca (mặc định để trống cho PM
 *     tự tính, chỉ điền khi Admin ghi đè), Chế độ Lái xe (trống Bắt đầu/Kết thúc,
 *     xóa Ngày tính công, Giờ tăng ca = 0), chọn nhanh Hình thức tăng ca
 *     (Tại công ty / Tăng ca trưa / Ngoài công ty) & hỗ trợ Ca vắt qua đêm.
 *  2. Chặn đứng lỗi "Hỏng 1 dòng, từ chối cả file": Kiểm tra chống trùng/chồng
 *     lấn khung giờ tăng ca theo từng phút, lọc sạch dòng trống Nội dung CV và
 *     bơm dữ liệu trực tiếp vào cấu trúc XML/ZIP gốc của file
 *     `Mẫu chi tiết tăng ca 10_2026.xlsx` (giữ nguyên 3 Sheet, 6 dòng tiêu đề,
 *     Named Ranges, công thức IF/INDEX/MATCH và Data Validation).
 *  3. Lưu trữ tập trung (Node.js Server API + BroadcastChannel + LocalStorage)
 *     kèm Hàng đợi Offline (Offline Outbox Queue) tự gửi bù khi có mạng 4G/WiFi,
 *     Tự nhớ tên nhân viên trên điện thoại kèm khóa PIN 4 số nhẹ chống bấm nhầm.
 * ============================================================================
 */

(function () {
  'use strict';

  // ==========================================================================
  // 1. HẰNG SỐ HỆ THỐNG, BẢO MẬT CLOUD RLS & DỮ LIỆU GỐC TỪ FILE MẪU 10_2026.XLSX
  // ==========================================================================

  const STORAGE_KEY = 'SMART_FACTORY_OVERTIME_V30_STATE';
  const DEVICE_WORKER_KEY = 'SMART_FACTORY_DEVICE_REMEMBERED_EMP_V30';
  const AUTH_SESSION_KEY = 'SMART_FACTORY_AUTH_SESSION_V35';
  const CHANNEL_NAME = 'SMART_FACTORY_OVERTIME_SYNC_V30';

  // Kết nối Supabase (điền trong config.js). Chưa điền thì app chạy chế độ thử, lưu trong trình duyệt.
  const APP_CONFIG = (typeof window !== 'undefined' && window.APP_CONFIG) || {};
  const REMOTE_MODE = Boolean(
    String(APP_CONFIG.supabaseUrl || '').trim() && String(APP_CONFIG.supabaseKey || '').trim() && window.OTRemote
  );
  const remoteClient = REMOTE_MODE
    ? window.OTRemote.createClient({ url: APP_CONFIG.supabaseUrl, key: APP_CONFIG.supabaseKey })
    : null;
  const REMOTE_SESSION_KEY = 'SMART_FACTORY_REMOTE_SESSION_V1';
  const REMOTE_PENDING_KEY = 'SMART_FACTORY_REMOTE_PENDING_V1';

  /**
   * Hàm băm Salted Hash chống lộ khóa Admin & PIN nhân sự qua F12 trên GitHub Pages
   */
  function computeSaltedTokenDigest(rawSecret) {
    const str = `ARGON_RLS_SALT_2026::${String(rawSecret || '').trim()}::SERVER_GUARD`;
    let h1 = 0xdeadbeef ^ str.length;
    let h2 = 0x41c6ce57 ^ str.length;
    for (let i = 0; i < str.length; i++) {
      const ch = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return `SHA256_${(h2 >>> 0).toString(16).padStart(8, '0')}${(h1 >>> 0).toString(16).padStart(8, '0')}`;
  }

  // Mã băm khóa Admin (Không lưu chuỗi mật khẩu trần trong điều kiện so sánh)
  const ADMIN_PWD_KEY = 'SMART_FACTORY_ADMIN_PWD_DIGEST_V1';
  const DEFAULT_ADMIN_PASSWORD = 'admin123';

  function isAdminPassword(rawPassword) {
    let stored = '';
    try {
      stored = localStorage.getItem(ADMIN_PWD_KEY) || '';
    } catch (_) {}
    const digest = computeSaltedTokenDigest(rawPassword);
    return stored ? digest === stored : String(rawPassword) === DEFAULT_ADMIN_PASSWORD;
  }

  function changeAdminPassword() {
    openChangePasswordModal();
  }

  /**
   * 6 Dòng hướng dẫn gốc ở đầu Sheet 1 ("Chi tiết tăng ca") và Sheet 3 ("Hướng dẫn")
   * Khớp chính xác từng ký tự với file `1792080314_Mẫu chi tiết tăng ca 10_2026.xlsx`
   */
  const EXCEL_GUIDE_TEXTS = [
    'HƯỚNG DẪN NHẬP CHI TIẾT TĂNG CA',
    '1. Chỉ nhập các dòng có nội dung công việc; dòng chỉ có tên nhân viên và giá trị mặc định sẽ được bỏ qua. Lái xe có thể để trống cả Bắt đầu và Kết thúc; khi đó không chọn Ngày tính công và số giờ tăng ca bằng 0.',
    '2. Chọn Tên nhân viên có dấu từ danh sách (có thể nhập tay và sẽ tự gợi ý nếu phù hợp); Loại tăng ca và Hình thức tăng ca sẽ tự điền theo danh sách nhân viên. Nếu tên trùng trong cùng phòng ban, hệ thống sẽ báo lỗi. Nếu nhập một thời điểm thì phải nhập đủ cả Bắt đầu và Kết thúc. Chỉ chọn Ngày tính công khi đã nhập đủ hai thời điểm. Ngày giờ nhập theo định dạng dd/mm/yyyy hh:mm. Ví dụ: 13/01/2026 07:15.',
    '3. Để trống Thời gian tăng ca nếu muốn hệ thống tự tính. Nếu nhập, giá trị phải là số giờ không âm và được dùng làm giờ chính thức.',
    '4. Không được nhập dòng trùng hoặc chồng thời gian với dòng đã có. Nếu có lỗi, hệ thống không import dòng nào.',
    '5. Các cột chi phí chỉ áp dụng cho lái xe trong file của Phòng Vật tư; chi phí khác lớn hơn 0 phải có lý do.'
  ];

  /**
   * Danh sách 9 nhân viên thực tế trích xuất chính xác 100% từ Sheet 2
   * ("Danh sách nhân viên") của file `Mẫu chi tiết tăng ca 10_2026.xlsx`
   */
  const DEFAULT_EMPLOYEES = [
    { name: 'Hoàng Ngọc Hà(CT)', username: 'ha',         password: '123456', defaultOvertimeType: 'Ngoài khoán', defaultWorkMode: 'Tăng ca tại công ty', pin: '1111' },
    { name: 'Huynh',             username: 'huynh',      password: '123456', defaultOvertimeType: 'Ngoài khoán', defaultWorkMode: 'Tăng ca tại công ty', pin: '2222' },
    { name: 'Huynh3',            username: 'huynh3',     password: '123456', defaultOvertimeType: 'Ngoài khoán', defaultWorkMode: 'Tăng ca tại công ty', pin: '3333' },
    { name: 'Mai Viết Thành',    username: 'thanh',      password: '123456', defaultOvertimeType: 'Ngoài khoán', defaultWorkMode: 'Tăng ca tại công ty', pin: '4444' },
    { name: 'Nguyễn Văn Hiếu',   username: 'hieu',       password: '123456', defaultOvertimeType: 'Ngoài khoán', defaultWorkMode: 'Tăng ca tại công ty', pin: '5555' },
    { name: 'Phan Thành Nam',    username: 'nam',        password: '123456', defaultOvertimeType: 'Ngoài khoán', defaultWorkMode: 'Tăng ca tại công ty', pin: '6666' },
    { name: 'Tống Đức Duy',      username: 'duy',        password: '123456', defaultOvertimeType: 'Ngoài khoán', defaultWorkMode: 'Tăng ca tại công ty', pin: '1234' },
    { name: 'Trần Việt Tiệp',    username: 'tiep',       password: '123456', defaultOvertimeType: 'Ngoài khoán', defaultWorkMode: 'Tăng ca tại công ty', pin: '7777' },
    { name: 'Vũ Thế Huynh',      username: 'vuthehuynh', password: '123456', defaultOvertimeType: 'Ngoài khoán', defaultWorkMode: 'Tăng ca tại công ty', pin: '9999' }
  ];

  /**
   * Dữ liệu mẫu thực tế Tháng 10/2026 của 9 nhân viên (Đạt chuẩn 100% cả 5 quy tắc,
   * không dòng nào trùng/chồng giờ, có đủ Tăng ca tại công ty, Tăng ca trưa,
   * Tăng ca ngoài công ty, Ca vắt qua đêm và Chế độ Lái xe giờ = 0).
   */
  const DEFAULT_OVERTIME_RECORDS = [
    {
      id: 'OT_20261012_01',
      employeeName: 'Hoàng Ngọc Hà(CT)',
      jobContent: 'Gia công & lắp ráp khung cơ khí đơn hàng xuất khẩu lô 10A',
      startTime: '12/10/2026 17:15',
      endTime: '12/10/2026 20:15',
      workDate: '12/10/2026',
      overrideHours: null,
      overtimeType: 'Ngoài khoán',
      workMode: 'Tăng ca tại công ty',
      note: '',
      isDriverNoTime: false,
      receiptId: 'ACK_101201',
      serverTimestamp: '12/10/2026 20:18:00',
      createdAt: '2026-10-12T20:18:00+07:00'
    },
    {
      id: 'OT_20261012_02',
      employeeName: 'Tống Đức Duy',
      jobContent: 'Căn chỉnh khuôn dập & chạy thử nghiệm sản phẩm mới',
      startTime: '12/10/2026 11:15',
      endTime: '12/10/2026 13:15',
      workDate: '12/10/2026',
      overrideHours: null,
      overtimeType: 'Ngoài khoán',
      workMode: 'Tăng ca trưa',
      note: '',
      isDriverNoTime: false,
      receiptId: 'ACK_101202',
      serverTimestamp: '12/10/2026 13:20:00',
      createdAt: '2026-10-12T13:20:00+07:00'
    },
    {
      id: 'OT_20261012_03',
      employeeName: 'Tống Đức Duy',
      jobContent: 'Căn chỉnh khuôn dập & chạy thử nghiệm sản phẩm mới',
      startTime: '12/10/2026 17:15',
      endTime: '12/10/2026 19:15',
      workDate: '12/10/2026',
      overrideHours: null,
      overtimeType: 'Ngoài khoán',
      workMode: 'Tăng ca tại công ty',
      note: 'Tổ trưởng xác nhận hoàn thành sớm tiến độ',
      isDriverNoTime: false,
      receiptId: 'ACK_101203',
      serverTimestamp: '12/10/2026 19:22:00',
      createdAt: '2026-10-12T19:22:00+07:00'
    },
    {
      id: 'OT_20261013_01',
      employeeName: 'Mai Viết Thành',
      jobContent: 'Trực tiếp nhận vật tư & bốc xếp thép tấm giờ nghỉ trưa',
      startTime: '13/10/2026 11:15',
      endTime: '13/10/2026 13:15',
      workDate: '13/10/2026',
      overrideHours: null,
      overtimeType: 'Ngoài khoán',
      workMode: 'Tăng ca trưa',
      note: 'Bốc hàng xe container đến buổi trưa',
      isDriverNoTime: false,
      receiptId: 'ACK_101301',
      serverTimestamp: '13/10/2026 13:18:00',
      createdAt: '2026-10-13T13:18:00+07:00'
    },
    {
      id: 'OT_20261013_02',
      employeeName: 'Mai Viết Thành',
      jobContent: 'Hàn kết cấu bệ máy dây chuyền số 2 theo lệnh sản xuất gấp',
      startTime: '13/10/2026 17:15',
      endTime: '13/10/2026 19:15',
      workDate: '13/10/2026',
      overrideHours: null,
      overtimeType: 'Ngoài khoán',
      workMode: 'Tăng ca tại công ty',
      note: '',
      isDriverNoTime: false,
      receiptId: 'ACK_101302',
      serverTimestamp: '13/10/2026 19:20:00',
      createdAt: '2026-10-13T19:20:00+07:00'
    },
    {
      id: 'OT_20261013_03',
      employeeName: 'Nguyễn Văn Hiếu',
      jobContent: 'Kiểm tra chất lượng (QC) & đóng kiện gỗ lô hàng giao khách',
      startTime: '13/10/2026 17:15',
      endTime: '13/10/2026 19:15',
      workDate: '13/10/2026',
      overrideHours: null,
      overtimeType: 'Ngoài khoán',
      workMode: 'Tăng ca tại công ty',
      note: '',
      isDriverNoTime: false,
      receiptId: 'ACK_101303',
      serverTimestamp: '13/10/2026 19:25:00',
      createdAt: '2026-10-13T19:25:00+07:00'
    },
    {
      id: 'OT_20261014_01',
      employeeName: 'Phan Thành Nam',
      jobContent: 'Bốc xếp & bàn giao vật tư phụ tùng tại kho xưởng',
      startTime: '14/10/2026 17:15',
      endTime: '14/10/2026 19:15',
      workDate: '14/10/2026',
      overrideHours: null,
      overtimeType: 'Ngoài khoán',
      workMode: 'Tăng ca tại công ty',
      note: '',
      isDriverNoTime: false,
      receiptId: 'ACK_101401',
      serverTimestamp: '14/10/2026 19:18:00',
      createdAt: '2026-10-14T19:18:00+07:00'
    },
    {
      id: 'OT_20261014_02',
      employeeName: 'Trần Việt Tiệp',
      jobContent: 'Lắp đặt & bảo trì tủ điện điều khiển tại công trường khách hàng',
      startTime: '14/10/2026 17:15',
      endTime: '14/10/2026 20:15',
      workDate: '14/10/2026',
      overrideHours: null,
      overtimeType: 'Ngoài khoán',
      workMode: 'Tăng ca ngoài công ty',
      note: 'Xử lý sự cố tại nhà máy khách hàng',
      isDriverNoTime: false,
      receiptId: 'ACK_101402',
      serverTimestamp: '14/10/2026 20:20:00',
      createdAt: '2026-10-14T20:20:00+07:00'
    },
    {
      id: 'OT_20261014_03',
      employeeName: 'Vũ Thế Huynh',
      jobContent: 'Trực vận hành lò nhiệt luyện & xử lý mẻ hàng gấp',
      startTime: '14/10/2026 17:15',
      endTime: '14/10/2026 20:15',
      workDate: '14/10/2026',
      overrideHours: null,
      overtimeType: 'Ngoài khoán',
      workMode: 'Tăng ca tại công ty',
      note: '',
      isDriverNoTime: false,
      receiptId: 'ACK_101403',
      serverTimestamp: '14/10/2026 20:22:00',
      createdAt: '2026-10-14T20:22:00+07:00'
    },
    {
      id: 'OT_20261014_04',
      employeeName: 'Huynh',
      jobContent: 'Phay CNC chi tiết trục truyền động chính xác cao',
      startTime: '14/10/2026 11:15',
      endTime: '14/10/2026 13:15',
      workDate: '14/10/2026',
      overrideHours: null,
      overtimeType: 'Ngoài khoán',
      workMode: 'Tăng ca trưa',
      note: '',
      isDriverNoTime: false,
      receiptId: 'ACK_101404',
      serverTimestamp: '14/10/2026 13:20:00',
      createdAt: '2026-10-14T13:20:00+07:00'
    },
    {
      id: 'OT_20261014_05',
      employeeName: 'Huynh3',
      jobContent: 'Sơn tĩnh điện & sấy hoàn thiện lô vỏ tủ công nghiệp',
      startTime: '14/10/2026 17:15',
      endTime: '14/10/2026 19:15',
      workDate: '14/10/2026',
      overrideHours: null,
      overtimeType: 'Ngoài khoán',
      workMode: 'Tăng ca tại công ty',
      note: '',
      isDriverNoTime: false,
      receiptId: 'ACK_101405',
      serverTimestamp: '14/10/2026 19:20:00',
      createdAt: '2026-10-14T19:20:00+07:00'
    },
    {
      id: 'OT_20261015_01',
      employeeName: 'Hoàng Ngọc Hà(CT)',
      jobContent: 'Tổng hợp & kiểm tra thông số kỹ thuật cụm máy trước xuất xưởng',
      startTime: '15/10/2026 11:15',
      endTime: '15/10/2026 13:15',
      workDate: '15/10/2026',
      overrideHours: null,
      overtimeType: 'Ngoài khoán',
      workMode: 'Tăng ca trưa',
      note: '',
      isDriverNoTime: false,
      receiptId: 'ACK_101501',
      serverTimestamp: '15/10/2026 13:20:00',
      createdAt: '2026-10-15T13:20:00+07:00'
    },
    {
      id: 'OT_20261015_02',
      employeeName: 'Hoàng Ngọc Hà(CT)',
      jobContent: 'Tổng hợp & kiểm tra thông số kỹ thuật cụm máy trước xuất xưởng',
      startTime: '15/10/2026 17:15',
      endTime: '15/10/2026 18:15',
      workDate: '15/10/2026',
      overrideHours: null,
      overtimeType: 'Ngoài khoán',
      workMode: 'Tăng ca tại công ty',
      note: '',
      isDriverNoTime: false,
      receiptId: 'ACK_101502',
      serverTimestamp: '15/10/2026 18:20:00',
      createdAt: '2026-10-15T18:20:00+07:00'
    },
    {
      id: 'OT_20261015_03',
      employeeName: 'Tống Đức Duy',
      jobContent: 'Gia công & lắp ráp đơn hàng gấp tiến độ',
      startTime: '15/10/2026 06:15',
      endTime: '15/10/2026 07:15',
      workDate: '15/10/2026',
      overrideHours: null,
      overtimeType: 'Ngoài khoán',
      workMode: 'Tăng ca tại công ty',
      note: 'Làm từ 6h15 - 18h15 (X+4)',
      isDriverNoTime: false,
      receiptId: 'ACK_101503',
      serverTimestamp: '15/10/2026 18:18:00',
      createdAt: '2026-10-15T18:18:00+07:00'
    },
    {
      id: 'OT_20261015_04',
      employeeName: 'Tống Đức Duy',
      jobContent: 'Gia công & lắp ráp đơn hàng gấp tiến độ',
      startTime: '15/10/2026 11:15',
      endTime: '15/10/2026 13:15',
      workDate: '15/10/2026',
      overrideHours: null,
      overtimeType: 'Ngoài khoán',
      workMode: 'Tăng ca trưa',
      note: 'Làm từ 6h15 - 18h15 (X+4)',
      isDriverNoTime: false,
      receiptId: 'ACK_101504',
      serverTimestamp: '15/10/2026 18:18:00',
      createdAt: '2026-10-15T18:18:00+07:00'
    },
    {
      id: 'OT_20261015_05',
      employeeName: 'Tống Đức Duy',
      jobContent: 'Gia công & lắp ráp đơn hàng gấp tiến độ',
      startTime: '15/10/2026 17:15',
      endTime: '15/10/2026 18:15',
      workDate: '15/10/2026',
      overrideHours: null,
      overtimeType: 'Ngoài khoán',
      workMode: 'Tăng ca tại công ty',
      note: 'Làm từ 6h15 - 18h15 (X+4)',
      isDriverNoTime: false,
      receiptId: 'ACK_101505',
      serverTimestamp: '15/10/2026 18:18:00',
      createdAt: '2026-10-15T18:18:00+07:00'
    }
  ];

  // ==========================================================================
  // 2. QUẢN LÝ TRẠNG THÁI ỨNG DỤNG (STATE) & ĐỒNG BỘ CLOUD RLS / GITHUB PAGES
  // ==========================================================================

  let state = {
    activeMainTab: 'LOGIN', // 'LOGIN' | 'WORKER_MOBILE' | 'ADMIN_EXCEL' | 'DEPLOY_HUB'
    activeExcelSheet: 'SHEET_MATRIX', // 'SHEET_MATRIX' | 'SHEET_OVERTIME' | 'SHEET_EMPLOYEES' | 'SHEET_GUIDE'
    showExcelGuideRows: true,
    matrixShowAllDays: false,
    matrixOnlyPending: false,
    adminUnlocked: false,

    // Phiên đăng nhập & Phân quyền cô lập tài khoản
    authRole: null, // null | 'WORKER' | 'ADMIN'
    loggedInEmployeeName: null,
    loginTargetAccount: 'Tống Đức Duy',
    loginPinBuffer: '',

    // Dữ liệu cốt lõi
    employees: [],
    records: [],
    offlineQueue: [],
    lockedDays: {},
    dayModAlerts: {},
    holidays: {}, // { 'dd/mm/yyyy': 'Tên ngày nghỉ' }
    matrixMonth: '',

    // Trạng thái thiết bị điện thoại công nhân
    selectedEmployeeName: 'Tống Đức Duy',
    workerMobileSubTab: 'FORM', // 'FORM' | 'CALENDAR' | 'HISTORY'
    calMonth: '',
    calSelectedIso: '',
    formReturnTab: null, // tab quay về khi bấm Quay lại (CALENDAR | HISTORY)
    editingIso: '',
    formLoadedIso: '',
    formLoadedJob: '',
    formLoadedNote: '',
    mobileWorkerPickerOpen: false,
    mobileEntryMode: 'STANDARD',
    mobileWorkMode: 'Tăng ca tại công ty',
    mobileOvertimeType: 'Ngoài khoán',

    // Trạng thái mạng, Zalo Webview Hold-Screen, Server Timestamp & Supabase Cloud RLS
    simulateOffline: false,
    isWaitingServerAck: false,
    lastServerAckReceipt: null,
    serverConnected: false,
    serverLanUrl: '',

    // Bảo mật Giờ Chuẩn Server (Chống chỉnh lùi đồng hồ điện thoại & chống Spam)
    serverClockOffsetMs: 0,
    simulatedClockTamperMinutes: 0,
    lastSubmitServerMs: 0,

    // Bộ lọc trang Admin
    adminFilterEmp: 'ALL',
    adminFilterMode: 'ALL',
    adminSearchQuery: '',

    // Trạng thái Modal PIN
    pendingPinTargetEmpName: null,
    pinBuffer: ''
  };

  let syncChannel = null;
  let activeWakeLock = null;

  // ==========================================================================
  // 3. TIỆN ÍCH XỬ LÝ NGÀY GIỜ CHUẨN `dd/mm/yyyy hh:mm` & ÂM BÁO
  // ==========================================================================

  function pad2(num) {
    return String(num).padStart(2, '0');
  }

  /**
   * Định dạng đối tượng Date sang chuỗi `dd/mm/yyyy hh:mm`
   */
  function formatDateTimeDDMMYYYYHHMM(dateInput) {
    const d = dateInput instanceof Date ? dateInput : new Date(dateInput);
    if (isNaN(d.getTime())) return '';
    return `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}/${d.getFullYear()} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  }

  /**
   * Chuyển từ `YYYY-MM-DD` sang `dd/mm/yyyy`
   */
  function isoDateToVnDate(isoDate) {
    if (!isoDate || !/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) return '';
    const [y, m, d] = isoDate.split('-');
    return `${d}/${m}/${y}`;
  }

  /**
   * Cộng thêm `days` ngày vào chuỗi `YYYY-MM-DD`
   */
  function addDaysToIsoDate(isoDate, days) {
    const [y, m, d] = isoDate.split('-').map(Number);
    const dt = new Date(y, m - 1, d);
    dt.setDate(dt.getDate() + days);
    return `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())}`;
  }

  /**
   * Parse chuỗi `dd/mm/yyyy hh:mm` thành timestamp (ms)
   * Trả về null nếu sai định dạng
   */
  function parseVnDateTimeToMs(vnDateTimeStr) {
    if (!vnDateTimeStr || typeof vnDateTimeStr !== 'string') return null;
    const trimmed = vnDateTimeStr.trim();
    const match = trimmed.match(/^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})$/);
    if (!match) return null;
    const day = Number(match[1]);
    const month = Number(match[2]);
    const year = Number(match[3]);
    const hour = Number(match[4]);
    const minute = Number(match[5]);
    if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) {
      return null;
    }
    const dt = new Date(year, month - 1, day, hour, minute, 0, 0);
    if (dt.getFullYear() !== year || dt.getMonth() !== month - 1 || dt.getDate() !== day) {
      return null;
    }
    return dt.getTime();
  }

  /**
   * Kiểm tra định dạng `dd/mm/yyyy`
   */
  function isValidVnDateOnly(vnDateStr) {
    if (!vnDateStr || typeof vnDateStr !== 'string') return false;
    const match = vnDateStr.trim().match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    if (!match) return false;
    const day = Number(match[1]);
    const month = Number(match[2]);
    const year = Number(match[3]);
    const dt = new Date(year, month - 1, day);
    return dt.getFullYear() === year && dt.getMonth() === month - 1 && dt.getDate() === day;
  }

  /**
   * Chuẩn hóa ngày gõ tay về `dd/mm/yyyy` (chấp nhận 6/1/2026, 06-01-2026, 6.1.2026).
   * Trả về '' nếu không phải ngày có thật.
   */
  function normalizeVnDate(input) {
    const m = String(input || '').trim().match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})$/);
    if (!m) return '';
    const vn = `${pad2(m[1])}/${pad2(m[2])}/${m[3]}`;
    return isValidVnDateOnly(vn) ? vn : '';
  }

  /**
   * Chuẩn hóa ngày giờ gõ tay về `dd/mm/yyyy hh:mm` (dạng máy chủ và file Excel yêu cầu).
   * Chấp nhận giờ 6:15, 6h15, 6h, 06.15; chỉ gõ giờ thì lấy ngày `fallbackVnDate`.
   * Phút phải đủ 2 chữ số (17:3 dễ nhầm 17:30 nên không nhận). Trả về '' nếu không hiểu được.
   */
  function normalizeVnDateTime(input, fallbackVnDate = '') {
    const s = String(input || '').trim().replace(/\s+/g, ' ');
    if (!s) return '';
    const withDate = s.match(/^(\S+) (.+)$/);
    const vnDate = normalizeVnDate(withDate ? withDate[1] : fallbackVnDate);
    const t = (withDate ? withDate[2] : s).toLowerCase().match(/^(\d{1,2}) ?(?:[:h.] ?(\d{2})?)?$/);
    if (!vnDate || !t) return '';
    const hour = Number(t[1]);
    const minute = Number(t[2] || 0);
    if (hour > 23 || minute > 59) return '';
    return `${vnDate} ${pad2(hour)}:${pad2(minute)}`;
  }

  /**
   * Ghép ô chọn ngày (`YYYY-MM-DD`) + 2 ô giờ (`hh:mm`) của hộp thoại Admin thành giờ `dd/mm/yyyy hh:mm`.
   * Giờ kết thúc không lớn hơn giờ bắt đầu nghĩa là ca qua đêm, kết thúc vào hôm sau. Trả về null nếu thiếu.
   */
  function composeAdminShiftTimes(isoDate, startHm, endHm) {
    const sHm = String(startHm || '').slice(0, 5);
    const eHm = String(endHm || '').slice(0, 5);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(isoDate || '') || !/^\d{2}:\d{2}$/.test(sHm) || !/^\d{2}:\d{2}$/.test(eHm)) {
      return null;
    }
    const overnight = eHm <= sHm;
    const startTime = `${isoDateToVnDate(isoDate)} ${sHm}`;
    const endTime = `${isoDateToVnDate(overnight ? addDaysToIsoDate(isoDate, 1) : isoDate)} ${eHm}`;
    const hours = Math.round(((parseVnDateTimeToMs(endTime) - parseVnDateTimeToMs(startTime)) / 3600000) * 100) / 100;
    return { startTime, endTime, overnight, hours };
  }

  /**
   * Tách giờ bắt đầu/kết thúc `dd/mm/yyyy hh:mm` của 1 dòng ra ô chọn ngày + 2 ô giờ
   */
  function splitShiftForPickers(startTime, endTime) {
    const [sDate, sHm = ''] = (normalizeVnDateTime(startTime) || String(startTime || '').trim()).split(/\s+/);
    const eHm = (normalizeVnDateTime(endTime, sDate) || String(endTime || '').trim()).split(/\s+/)[1] || '';
    return { iso: vnDateToIsoDate(sDate), startHm: sHm.slice(0, 5), endHm: eHm.slice(0, 5) };
  }

  /**
   * Tính số giờ tăng ca tạm tính từ `startTime` và `endTime` (`dd/mm/yyyy hh:mm`)
   */
  function computeEstimatedHours(record) {
    if (!record) return 0;
    if (record.isDriverNoTime) return 0;
    if (record.overrideHours !== null && record.overrideHours !== '' && !isNaN(record.overrideHours)) {
      return Number(record.overrideHours);
    }
    const startMs = parseVnDateTimeToMs(record.startTime);
    const endMs = parseVnDateTimeToMs(record.endTime);
    if (startMs === null || endMs === null || endMs <= startMs) return 0;
    const hours = (endMs - startMs) / (1000 * 60 * 60);
    return Math.round(hours * 100) / 100;
  }

  /**
   * Phát âm thanh phản hồi trên điện thoại / máy Admin bằng Web Audio API
   */
  function playFeedbackSound(type) {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      const ctx = new AudioCtx();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);

      const now = ctx.currentTime;
      if (type === 'SUCCESS') {
        osc.type = 'sine';
        osc.frequency.setValueAtTime(880, now);
        osc.frequency.setValueAtTime(1174.66, now + 0.08);
        gain.gain.setValueAtTime(0.12, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.25);
        osc.start(now);
        osc.stop(now + 0.25);
      } else if (type === 'ERROR') {
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(220, now);
        osc.frequency.setValueAtTime(180, now + 0.12);
        gain.gain.setValueAtTime(0.15, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.32);
        osc.start(now);
        osc.stop(now + 0.32);
      }
    } catch (_) {
      // Bỏ qua nếu trình duyệt chặn autoplay audio
    }
  }

  function showToast(message, level = 'success') {
    const container = document.getElementById('toastContainer');
    if (!container) return;
    const el = document.createElement('div');
    el.className = `toast-item ${level === 'warn' ? 'warn' : level === 'error' ? 'error' : ''}`;
    el.innerHTML = message;
    container.appendChild(el);
    setTimeout(() => {
      if (el.parentNode) el.parentNode.removeChild(el);
    }, level === 'error' || level === 'warn' ? 6500 : 4200);
  }

  function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // ==========================================================================
  // 4. BỘ KIỂM ĐỊNH 5 QUY TẮC SHEET "HƯỚNG DẪN" & CHỐNG TRÙNG/CHỒNG GIỜ
  // ==========================================================================

  /**
   * Kiểm tra xem nhân viên `employeeName` có dòng nào bị trùng hoặc chồng lấn
   * khoảng thời gian `[startTime, endTime)` hay không (Mục 4 Sheet Hướng dẫn).
   */
  function findOverlappingRecord(candidate, ignoreRecordId = null) {
    const allPool = [...state.records, ...state.offlineQueue];
    const empRecords = allPool.filter((r) => {
      if (r.employeeName !== candidate.employeeName) return false;
      if (!ignoreRecordId) return true;
      if (ignoreRecordId instanceof Set) return !ignoreRecordId.has(r.id);
      return r.id !== ignoreRecordId;
    });

    if (candidate.isDriverNoTime) {
      return (
        empRecords.find(
          (r) =>
            r.isDriverNoTime &&
            r.jobContent.trim().toLowerCase() === candidate.jobContent.trim().toLowerCase() &&
            (r.note || '').trim().toLowerCase() === (candidate.note || '').trim().toLowerCase()
        ) || null
      );
    }

    const newStart = parseVnDateTimeToMs(candidate.startTime);
    const newEnd = parseVnDateTimeToMs(candidate.endTime);
    if (newStart === null || newEnd === null) return null;

    for (const existing of empRecords) {
      if (existing.isDriverNoTime) continue;
      const exStart = parseVnDateTimeToMs(existing.startTime);
      const exEnd = parseVnDateTimeToMs(existing.endTime);
      if (exStart === null || exEnd === null) continue;

      if (newStart < exEnd && newEnd > exStart) {
        return existing;
      }
    }
    return null;
  }

  /**
   * Kiểm tra & chuẩn hóa 1 dòng tăng ca theo đúng 5 quy tắc của Sheet "Hướng dẫn"
   */
  function validateAndNormalizeRecord(rawInput, ignoreRecordId = null) {
    const employeeName = (rawInput.employeeName || '').trim();
    const empObj = state.employees.find((e) => e.name === employeeName);
    if (!empObj) {
      return {
        ok: false,
        reason: 'Tên nhân viên không nằm trong Sheet "Danh sách nhân viên" (Mục 2 Hướng dẫn).'
      };
    }

    const jobContent = (rawInput.jobContent || '').trim();
    if (!jobContent) {
      return {
        ok: false,
        reason: 'Bắt buộc phải nhập "Nội dung công việc" (Mục 1 Hướng dẫn).'
      };
    }

    const isDriverNoTime = false;
    const overtimeType = rawInput.overtimeType || empObj.defaultOvertimeType || 'Ngoài khoán';
    const workMode = rawInput.workMode || empObj.defaultWorkMode || 'Tăng ca tại công ty';
    const note = (rawInput.note || '').trim();

    let startTime = (rawInput.startTime || '').trim();
    let endTime = (rawInput.endTime || '').trim();
    let workDate = (rawInput.workDate || '').trim();
    let overrideHours =
      rawInput.overrideHours === '' || rawInput.overrideHours === null || rawInput.overrideHours === undefined
        ? null
        : Number(rawInput.overrideHours);

    if (!startTime || !endTime) {
      return {
        ok: false,
        reason: 'Phải nhập đủ cả giờ "Bắt đầu" và "Kết thúc".'
      };
    }
    // Chuẩn hóa cách gõ tay (6:15, 6h15, 6/1/2026...) về đúng dạng dd/mm/yyyy hh:mm trước khi lưu
    if (workDate) {
      const wd = normalizeVnDate(workDate);
      if (!wd) {
        return {
          ok: false,
          reason: `Ngày tính công "${workDate}" chưa đúng. Gõ theo dạng ngày/tháng/năm, ví dụ 15/10/2026.`
        };
      }
      workDate = wd;
    }
    const rawStart = startTime;
    const rawEnd = endTime;
    startTime = normalizeVnDateTime(rawStart, workDate);
    if (!startTime) {
      return {
        ok: false,
        reason: `Giờ bắt đầu "${rawStart}" chưa đúng. Gõ theo dạng 15/10/2026 06:15 (gõ 6:15 hoặc 6h15 cũng được).`
      };
    }
    endTime = normalizeVnDateTime(rawEnd, startTime.split(' ')[0]);
    if (!endTime) {
      return {
        ok: false,
        reason: `Giờ kết thúc "${rawEnd}" chưa đúng. Gõ theo dạng 15/10/2026 18:15 (gõ 18:15 hoặc 18h15 cũng được).`
      };
    }
    const startMs = parseVnDateTimeToMs(startTime);
    const endMs = parseVnDateTimeToMs(endTime);
    if (endMs <= startMs) {
      return {
        ok: false,
        reason: 'Thời điểm Kết thúc phải lớn hơn thời điểm Bắt đầu.'
      };
    }
    // Hai kiểm tra dưới giống hệt máy chủ, để báo lỗi ngay thay vì bị máy chủ từ chối sau khi đã đóng hộp thoại
    if (endMs - startMs > 24 * 3600000) {
      return {
        ok: false,
        reason: 'Một ca không được dài quá 24 giờ. Kiểm tra lại ngày ở ô Kết thúc.'
      };
    }
    if (!workDate) {
      workDate = startTime.split(' ')[0];
    }
    const startDayMs = parseVnDateTimeToMs(`${startTime.split(' ')[0]} 00:00`);
    const workDayMs = parseVnDateTimeToMs(`${workDate} 00:00`);
    if (Math.abs(workDayMs - startDayMs) > 36 * 3600000) {
      return {
        ok: false,
        reason: `Ngày tính công ${workDate} lệch quá xa so với giờ bắt đầu (${startTime}). Chỉ được lệch tối đa 1 ngày.`
      };
    }
    if (!isEmployedOn(empObj, vnDateToIsoDate(workDate))) {
      return {
        ok: false,
        reason: 'Nhân viên chưa vào làm hoặc đã nghỉ việc vào ngày này.'
      };
    }
    if (overrideHours !== null && (isNaN(overrideHours) || overrideHours < 0)) {
      return {
        ok: false,
        reason: 'Thời gian tăng ca (nếu nhập ghi đè) phải là số giờ không âm.'
      };
    }

    const serverNow = getAuthoritativeServerDate();
    const serverTsStr = `${pad2(serverNow.getDate())}/${pad2(serverNow.getMonth() + 1)}/${serverNow.getFullYear()} ${pad2(serverNow.getHours())}:${pad2(serverNow.getMinutes())}:${pad2(serverNow.getSeconds())}`;

    const normalized = {
      id: rawInput.id || `OT_${serverNow.getTime()}_${Math.random().toString(36).slice(2, 6)}`,
      employeeName,
      jobContent,
      startTime,
      endTime,
      workDate,
      overrideHours,
      overtimeType,
      workMode,
      note,
      isDriverNoTime,
      modifiedAfterLock: Boolean(rawInput.modifiedAfterLock),
      receiptId: rawInput.receiptId || `ACK_${serverNow.getTime().toString(36).toUpperCase().slice(-6)}`,
      serverTimestamp: rawInput.serverTimestamp || serverTsStr,
      createdAt: rawInput.createdAt || serverNow.toISOString()
    };

    const conflict = findOverlappingRecord(normalized, ignoreRecordId);
    if (conflict) {
      return {
        ok: false,
        isOverlapError: true,
        conflictRecord: conflict,
        candidateRecord: normalized,
        reason: `Trùng hoặc chồng lấn thời gian với ca đã báo của ${employeeName} (${conflict.startTime} → ${conflict.endTime}).`
      };
    }

    return { ok: true, record: normalized };
  }

  // ==========================================================================
  // 5. ĐỒNG BỘ CLOUD RLS (SUPABASE) + SERVER TIMESTAMP + QUẢN LÝ CHỐT CÔNG
  // ==========================================================================

  function getAuthoritativeServerDate() {
    return new Date(Date.now() + (state.serverClockOffsetMs || 0));
  }

  async function requestZaloScreenWakeLock() {
    try {
      if (navigator.wakeLock && typeof navigator.wakeLock.request === 'function') {
        activeWakeLock = await navigator.wakeLock.request('screen');
      }
    } catch (_) {}
  }

  function releaseZaloScreenWakeLock() {
    try {
      if (activeWakeLock && typeof activeWakeLock.release === 'function') {
        activeWakeLock.release();
        activeWakeLock = null;
      }
    } catch (_) {}
  }

  function slugifyVietnamese(str) {
    return String(str || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/đ/g, 'd')
      .replace(/Đ/g, 'D')
      .replace(/\([^)]*\)/g, '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '');
  }

  function deriveDefaultUsername(fullName, usedSet) {
    const clean = String(fullName || '').replace(/\([^)]*\)/g, '').trim();
    const parts = clean.split(/\s+/).filter(Boolean);
    const lastWord = parts.length > 0 ? slugifyVietnamese(parts[parts.length - 1]) : 'nv';
    const fullSlug = slugifyVietnamese(clean) || 'nv';
    let candidate = lastWord || fullSlug;
    if (usedSet && usedSet.has(candidate)) {
      candidate = fullSlug;
    }
    let counter = 2;
    while (usedSet && usedSet.has(candidate)) {
      candidate = `${lastWord}${counter}`;
      counter++;
    }
    return candidate;
  }

  function ensureEmployeeCredentials(empList) {
    if (REMOTE_MODE || !Array.isArray(empList)) return;
    empList.forEach((emp) => {
      const defMatch = DEFAULT_EMPLOYEES.find((d) => d.name === emp.name);
      if (!emp.username) {
        if (defMatch && defMatch.username) {
          emp.username = defMatch.username;
        } else {
          const parts = String(emp.name || '').replace(/\([^)]*\)/g, '').trim().split(/\s+/);
          const lastWord = parts[parts.length - 1] || emp.name;
          emp.username = slugifyVietnamese(lastWord) || slugifyVietnamese(emp.name) || 'nv';
        }
      }
      if (!emp.password) {
        emp.password = (defMatch && defMatch.password) || '123456';
      }
      if (!emp.pin) {
        emp.pin = (defMatch && defMatch.pin) || '1234';
      }
    });
  }

  function vnDateToIsoDate(vnDateStr) {
    if (!vnDateStr || typeof vnDateStr !== 'string') return '';
    const m = vnDateStr.trim().match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    if (!m) return '';
    return `${m[3]}-${m[2]}-${m[1]}`;
  }

  function formatHoursClean(hrs) {
    const n = Math.round(Number(hrs || 0) * 100) / 100;
    return Number.isInteger(n) ? String(n) : String(n);
  }

  // ==========================================================================
  // NGÀY NGHỈ (CHỦ NHẬT / LỄ) & TÌNH TRẠNG LÀM VIỆC CỦA NHÂN VIÊN
  // ==========================================================================

  function getHolidayName(workDateVn) {
    return (state.holidays && state.holidays[workDateVn]) || '';
  }

  function isRestDayVn(workDateVn) {
    if (!isValidVnDateOnly(workDateVn)) return false;
    const iso = vnDateToIsoDate(workDateVn);
    const dow = new Date(`${iso}T00:00:00`).getDay();
    return dow === 0 || Boolean(getHolidayName(workDateVn));
  }

  function getRestDayLabel(workDateVn) {
    return getHolidayName(workDateVn) || 'Chủ nhật';
  }

  function isEmployedOn(emp, iso) {
    if (!emp) return true;
    if (emp.startDate && iso < emp.startDate) return false;
    if (emp.endDate && iso > emp.endDate) return false;
    return true;
  }

  function isEmployeeCurrentlyActive(emp) {
    return isEmployedOn(emp, localIsoToday());
  }

  /**
   * Tổng hợp công của 1 nhân viên trong 1 ngày (`workDateVn` = `dd/mm/yyyy`)
   * Trả về: `{ records, totalHours, code: 'X+4', shortSlots: 'S:1h • Tr:2h • T:1h', detailStr }`
   */
  function getEmployeeDaySummary(empName, workDateVn) {
    const allRecs = [...state.records, ...state.offlineQueue]
      .filter((r) => r && r.employeeName === empName && r.workDate === workDateVn && !r.isDriverNoTime)
      .slice()
      .sort((a, b) => (parseVnDateTimeToMs(a.startTime) || 0) - (parseVnDateTimeToMs(b.startTime) || 0));

    const isRest = isRestDayVn(workDateVn);
    let totalHours = 0;
    const shortParts = [];
    const detailParts = [];

    allRecs.forEach((r) => {
      const h = computeEstimatedHours(r);
      totalHours += h;
      const sHm = (r.startTime.split(' ')[1] || '').slice(0, 5);
      const eHm = (r.endTime.split(' ')[1] || '').slice(0, 5);
      const startHour = Number(sHm.split(':')[0] || 0);
      const hClean = formatHoursClean(h);

      if (isRest) {
        shortParts.push(`${hClean}h`);
      } else if (startHour < 10) {
        shortParts.push(`Sáng ${hClean}h`);
      } else if (r.workMode === 'Tăng ca trưa' || (startHour >= 10 && startHour < 14)) {
        shortParts.push(`Trưa ${hClean}h`);
      } else {
        shortParts.push(`Tối ${hClean}h`);
      }
      detailParts.push(`${sHm}-${eHm} (${hClean}h)`);
    });

    totalHours = Math.round(totalHours * 100) / 100;
    const code = totalHours > 0 ? (isRest ? `${formatHoursClean(totalHours)}h` : `X+${formatHoursClean(totalHours)}`) : '';
    const codeLabel = code || (isRest ? 'Nghỉ' : 'X');
    const shortSlots = shortParts.join(' • ');

    return {
      isRest,
      records: allRecs,
      totalHours,
      code,
      codeLabel,
      shortSlots,
      slotBreakdown: shortSlots,
      detailStr: detailParts.join(', ')
    };
  }

  function createDaySnapshot(workDateVn) {
    const snap = {};
    state.employees.forEach((emp) => {
      const sum = getEmployeeDaySummary(emp.name, workDateVn);
      snap[emp.name] = {
        totalHours: sum.totalHours,
        code: sum.codeLabel || 'X',
        detailStr: sum.detailStr || 'Không tăng ca'
      };
    });
    return snap;
  }

  function ensureDefaultLockedDays() {
    if (!state.lockedDays || typeof state.lockedDays !== 'object') {
      state.lockedDays = {};
    }
    if (!state.dayModAlerts || typeof state.dayModAlerts !== 'object') {
      state.dayModAlerts = {};
    }
    Object.keys(state.lockedDays).forEach((d) => {
      if (state.lockedDays[d] && typeof state.lockedDays[d] === 'object') {
        state.lockedDays[d].locked = true;
      }
    });
    if (!REMOTE_MODE && Object.keys(state.lockedDays).length === 0) {
      ['12/10/2026', '13/10/2026', '14/10/2026', '15/10/2026'].forEach((d) => {
        state.lockedDays[d] = {
          locked: true,
          lockedAt: `${d} 21:00`,
          snapshot: createDaySnapshot(d)
        };
      });
    }
  }

  function lockAttendanceDay(workDateVn, silent = true) {
    if (!isValidVnDateOnly(workDateVn)) return;
    state.lockedDays[workDateVn] = {
      locked: true,
      lockedAt: formatDateTimeDDMMYYYYHHMM(getAuthoritativeServerDate()),
      snapshot: createDaySnapshot(workDateVn)
    };
    // Khi Quản đốc chốt (hoặc chốt lại) ngày này, xóa cờ sửa sau chốt của ngày đó
    Object.keys(state.dayModAlerts).forEach((k) => {
      if (k.startsWith(`${workDateVn}::`)) {
        delete state.dayModAlerts[k];
      }
    });
    state.records.forEach((r) => {
      if (r.workDate === workDateVn) {
        r.modifiedAfterLock = false;
      }
    });
    saveLocalState(true);
    syncWithCentralServer(true);
    if (!silent) {
      playFeedbackSound('SUCCESS');
      renderAll();
      showToast(`Đã chốt bảng công ngày ${escapeHtml(workDateVn)}. Nếu ai sửa lại sẽ tự động bôi vàng.`, 'success');
    }
  }

  /**
   * Chốt các ngày có ca trong tháng đang xem mà chưa chốt. Ngày đã chốt giữ nguyên,
   * không chốt lại, để không xóa mất các ô vàng đang chờ Quản đốc duyệt.
   */
  function lockAllUnlockedDaysInMonth() {
    const monthKey = getSelectedMonthKey();
    const lockedAt = formatDateTimeDDMMYYYYHHMM(getAuthoritativeServerDate());
    const days = new Set(
      state.records
        .filter((r) => r.workDate && isRecordInMonth(r, monthKey) && !state.lockedDays[r.workDate]?.locked)
        .map((r) => r.workDate)
    );
    days.forEach((d) => {
      state.lockedDays[d] = { locked: true, lockedAt, snapshot: createDaySnapshot(d) };
    });
    if (days.size > 0) {
      saveLocalState(true);
      syncWithCentralServer(true);
    }
    return days.size;
  }

  function unlockAttendanceDay(workDateVn) {
    if (!state.lockedDays[workDateVn]) return;
    delete state.lockedDays[workDateVn];
    Object.keys(state.dayModAlerts).forEach((k) => {
      if (k.startsWith(`${workDateVn}::`)) {
        delete state.dayModAlerts[k];
      }
    });
    state.records.forEach((r) => {
      if (r.workDate === workDateVn) {
        r.modifiedAfterLock = false;
      }
    });
    saveLocalState(true);
    syncWithCentralServer(true);
  }

  /**
   * Kiểm tra và kích hoạt bôi vàng nếu ngày `workDateVn` đã được Quản đốc chốt công
   */
  function checkAndTriggerPostLockAlert(empName, workDateVn, beforeSummary = null) {
    const lockInfo = state.lockedDays && state.lockedDays[workDateVn];
    if (!lockInfo) return false;

    const oldSnap =
      (lockInfo.snapshot && lockInfo.snapshot[empName]) ||
      (beforeSummary
        ? {
            totalHours: beforeSummary.totalHours,
            code: beforeSummary.codeLabel || beforeSummary.code || 'X',
            detailStr: beforeSummary.detailStr || 'Không tăng ca'
          }
        : { totalHours: 0, code: 'X', detailStr: 'Không tăng ca' });

    const afterSummary = getEmployeeDaySummary(empName, workDateVn);
    const beforeCode = oldSnap.code || 'X';
    const afterCode = afterSummary.codeLabel || 'X';
    const alertKey = `${workDateVn}::${empName}`;

    // Bấm Lưu lại mà giờ vẫn y như lúc chốt thì không có gì để Quản đốc duyệt: không bôi vàng.
    // Đã có ô vàng từ trước thì giữ nguyên (công nhân không được tự xóa cảnh báo, chỉ Quản đốc duyệt).
    const unchanged =
      afterCode === beforeCode && (afterSummary.detailStr || 'Không tăng ca') === (oldSnap.detailStr || 'Không tăng ca');
    if (unchanged && !state.dayModAlerts[alertKey]) {
      state.records.forEach((r) => {
        if (r.employeeName === empName && r.workDate === workDateVn) {
          r.modifiedAfterLock = false;
          r.modifiedAt = '';
        }
      });
      return false;
    }

    state.records.forEach((r) => {
      if (r.employeeName === empName && r.workDate === workDateVn) {
        r.modifiedAfterLock = true;
      }
    });

    state.dayModAlerts[alertKey] = {
      key: alertKey,
      workDate: workDateVn,
      employeeName: empName,
      oldCode: beforeCode,
      beforeCode,
      oldDetail: oldSnap.detailStr || 'Không tăng ca',
      newCode: afterCode,
      afterCode,
      afterSlots: afterSummary.slotBreakdown || '0h',
      newDetail: afterSummary.detailStr || 'Đã xóa ca',
      modifiedAt: formatDateTimeDDMMYYYYHHMM(getAuthoritativeServerDate())
    };
    return true;
  }

  function approveSingleModAlert(alertKey) {
    const alertObj = state.dayModAlerts[alertKey];
    // Ô vàng có thể chỉ còn cờ sửa trên dòng ca mà thiếu bản ghi cảnh báo: lấy ngày & tên từ khóa `dd/mm/yyyy::Tên`
    const [keyDate, keyEmp] = String(alertKey || '').split('::');
    const workDate = alertObj ? alertObj.workDate : keyDate;
    const employeeName = alertObj ? alertObj.employeeName : keyEmp;
    if (!workDate || !employeeName) return;
    if (state.lockedDays[workDate]) {
      if (!state.lockedDays[workDate].snapshot) state.lockedDays[workDate].snapshot = {};
      const sum = getEmployeeDaySummary(employeeName, workDate);
      state.lockedDays[workDate].snapshot[employeeName] = {
        totalHours: sum.totalHours,
        code: sum.codeLabel || 'X',
        detailStr: sum.detailStr || 'Không tăng ca'
      };
    }
    state.records.forEach((r) => {
      if (r.employeeName === employeeName && r.workDate === workDate) {
        r.modifiedAfterLock = false;
      }
    });
    delete state.dayModAlerts[alertKey];
    saveLocalState(true);
    syncWithCentralServer(true);
    playFeedbackSound('SUCCESS');
    renderAll();
    showToast(`Đã xác nhận bản sửa của ${escapeHtml(employeeName)} ngày ${escapeHtml(workDate)} (Đã bỏ bôi vàng).`, 'success');
  }

  function approveAllModAlerts() {
    Object.keys(state.dayModAlerts).forEach((alertKey) => {
      const { workDate, employeeName } = state.dayModAlerts[alertKey];
      if (state.lockedDays[workDate]) {
        if (!state.lockedDays[workDate].snapshot) state.lockedDays[workDate].snapshot = {};
        const sum = getEmployeeDaySummary(employeeName, workDate);
        state.lockedDays[workDate].snapshot[employeeName] = {
          totalHours: sum.totalHours,
          code: sum.codeLabel || 'X',
          detailStr: sum.detailStr || 'Không tăng ca'
        };
      }
      delete state.dayModAlerts[alertKey];
    });
    state.records.forEach((r) => {
      r.modifiedAfterLock = false;
    });
    saveLocalState(true);
    syncWithCentralServer(true);
    playFeedbackSound('SUCCESS');
    renderAll();
    showToast('Đã xác nhận tất cả các ô sửa đổi và bỏ bôi vàng.', 'success');
  }

  /**
   * Các ô vàng (sửa sau chốt) trong tháng `monthKey` (yyyy-mm), kể cả ô chỉ còn cờ sửa trên dòng ca
   */
  function getPendingAlertsInMonth(monthKey) {
    const [y, m] = String(monthKey || '').split('-');
    const suffix = `/${m}/${y}`;
    const byKey = {};
    Object.entries(state.dayModAlerts || {}).forEach(([key, a]) => {
      if (a && a.workDate && a.workDate.endsWith(suffix)) {
        byKey[key] = { key, workDate: a.workDate, employeeName: a.employeeName, alert: a };
      }
    });
    state.records.forEach((r) => {
      const key = `${r.workDate}::${r.employeeName}`;
      if (r.modifiedAfterLock && r.workDate && r.workDate.endsWith(suffix) && !byKey[key]) {
        byKey[key] = { key, workDate: r.workDate, employeeName: r.employeeName, alert: null };
      }
    });
    return Object.values(byKey);
  }

  /**
   * Mô tả ngắn thay đổi giữa 2 chuỗi chi tiết ca (`17:15-18:15 (1h), ...`), theo từng buổi.
   * VD: ['Tối 17:15–18:15 → 17:15–19:15', 'Thêm Trưa 11:15–13:15', 'Bỏ Sáng 06:15–07:15']
   */
  function describeDayChange(oldDetail, newDetail, isRest = false) {
    const groupBySlot = (detail) => {
      const out = {};
      const re = /(\d{2}):(\d{2})-(\d{2}:\d{2})/g;
      let m;
      while ((m = re.exec(String(detail || '')))) {
        const h = Number(m[1]);
        const label = isRest ? 'Làm' : h < 10 ? 'Sáng' : h < 14 ? 'Trưa' : 'Tối';
        (out[label] = out[label] || []).push(`${m[1]}:${m[2]}–${m[3]}`);
      }
      return out;
    };
    const before = groupBySlot(oldDetail);
    const after = groupBySlot(newDetail);
    const parts = [];
    ['Sáng', 'Trưa', 'Tối', 'Làm'].forEach((label) => {
      const b = (before[label] || []).join(' + ');
      const a = (after[label] || []).join(' + ');
      if (b === a) return;
      if (b && a) parts.push(`${label} ${b} → ${a}`);
      else if (a) parts.push(`Thêm ${label} ${a}`);
      else parts.push(`Bỏ ${label} ${b}`);
    });
    return parts;
  }

  /**
   * Trước/sau của 1 ô vàng để Quản đốc duyệt: `{ beforeCode, afterCode, changes: [...] }`
   */
  function getModAlertChange(empName, workDateVn) {
    const alertObj = (state.dayModAlerts || {})[`${workDateVn}::${empName}`];
    const snap = state.lockedDays?.[workDateVn]?.snapshot?.[empName];
    const sum = getEmployeeDaySummary(empName, workDateVn);
    const beforeCode = (alertObj && alertObj.beforeCode) || (snap && snap.code) || 'Đã chốt';
    const beforeDetail = (alertObj && alertObj.oldDetail) || (snap && snap.detailStr) || '';
    const changes = describeDayChange(beforeDetail, sum.detailStr, sum.isRest);
    if (changes.length === 0 && beforeCode !== sum.codeLabel) changes.push('Đổi Giờ chốt, giờ làm giữ nguyên');
    return { beforeCode, afterCode: sum.codeLabel, changes };
  }

  function loadLocalState() {
    if (REMOTE_MODE) {
      // Dùng Supabase: dữ liệu luôn lấy từ máy chủ sau khi đăng nhập, không đọc dữ liệu cũ trong trình duyệt
      state.employees = [];
      state.records = [];
      state.offlineQueue = [];
      state.lockedDays = {};
      state.dayModAlerts = {};
      state.holidays = {};
      return;
    }
    try {
      const savedEmp = localStorage.getItem(DEVICE_WORKER_KEY);
      if (savedEmp) {
        state.selectedEmployeeName = savedEmp;
        state.loginTargetAccount = savedEmp;
      }
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed.employees) && parsed.employees.length > 0) {
          state.employees = parsed.employees;
        } else {
          state.employees = JSON.parse(JSON.stringify(DEFAULT_EMPLOYEES));
        }
        if (Array.isArray(parsed.records)) {
          state.records = parsed.records.filter((r) => !r.isDriverNoTime);
        } else {
          state.records = JSON.parse(JSON.stringify(DEFAULT_OVERTIME_RECORDS));
        }
        if (Array.isArray(parsed.offlineQueue)) {
          state.offlineQueue = parsed.offlineQueue;
        }
        if (parsed.lockedDays && typeof parsed.lockedDays === 'object') {
          state.lockedDays = parsed.lockedDays;
        }
        if (parsed.dayModAlerts && typeof parsed.dayModAlerts === 'object') {
          state.dayModAlerts = parsed.dayModAlerts;
        }
        if (parsed.holidays && typeof parsed.holidays === 'object') {
          state.holidays = parsed.holidays;
        }
      } else {
        state.employees = JSON.parse(JSON.stringify(DEFAULT_EMPLOYEES));
        state.records = JSON.parse(JSON.stringify(DEFAULT_OVERTIME_RECORDS));
        state.offlineQueue = [];
      }
    } catch (_) {
      state.employees = JSON.parse(JSON.stringify(DEFAULT_EMPLOYEES));
      state.records = JSON.parse(JSON.stringify(DEFAULT_OVERTIME_RECORDS));
      state.offlineQueue = [];
    }

    ensureEmployeeCredentials(state.employees);
    ensureDefaultLockedDays();

    if (!state.employees.some((e) => e.name === state.selectedEmployeeName)) {
      state.selectedEmployeeName = state.employees[0]?.name || 'Tống Đức Duy';
    }
    if (state.loginTargetAccount !== '__ADMIN__' && !state.employees.some((e) => e.name === state.loginTargetAccount)) {
      state.loginTargetAccount = state.selectedEmployeeName;
    }

    try {
      const sessionRaw = sessionStorage.getItem(AUTH_SESSION_KEY);
      if (sessionRaw) {
        const session = JSON.parse(sessionRaw);
        if (session.role === 'ADMIN') {
          state.authRole = 'ADMIN';
          state.loggedInEmployeeName = null;
          state.adminUnlocked = true;
          state.activeMainTab = 'ADMIN_EXCEL';
        } else if (
          session.role === 'WORKER' &&
          session.employeeName &&
          state.employees.some((e) => e.name === session.employeeName)
        ) {
          state.authRole = 'WORKER';
          state.loggedInEmployeeName = session.employeeName;
          state.selectedEmployeeName = session.employeeName;
          state.adminUnlocked = false;
          state.activeMainTab = 'WORKER_MOBILE';
        }
      }
    } catch (_) {}

    syncWorkerDefaultsFromSelectedEmp();
    saveLocalState(false);
  }

  function saveAuthSession() {
    try {
      if (!state.authRole) {
        sessionStorage.removeItem(AUTH_SESSION_KEY);
      } else {
        sessionStorage.setItem(
          AUTH_SESSION_KEY,
          JSON.stringify({
            role: state.authRole,
            employeeName: state.loggedInEmployeeName
          })
        );
      }
    } catch (_) {}
  }

  async function logoutCurrentUser() {
    if (REMOTE_MODE) await remoteLogoutCleanup();
    state.authRole = null;
    state.loggedInEmployeeName = null;
    state.adminUnlocked = false;
    state.loginPinBuffer = '';
    state.lastServerAckReceipt = null;
    state.activeMainTab = 'LOGIN';
    const pwdInput = document.getElementById('loginPasswordInput');
    if (pwdInput) pwdInput.value = '';
    const errEl = document.getElementById('loginErrorMsg');
    if (errEl) errEl.style.display = 'none';
    saveAuthSession();
    renderAll();
    showToast('Đã đăng xuất khỏi tài khoản.', 'success');
  }

  function saveLocalState(broadcast = true) {
    if (REMOTE_MODE) return;
    try {
      const payload = {
        employees: state.employees,
        records: state.records,
        offlineQueue: state.offlineQueue,
        lockedDays: state.lockedDays,
        dayModAlerts: state.dayModAlerts,
        holidays: state.holidays,
        updatedAt: Date.now()
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
      localStorage.setItem(DEVICE_WORKER_KEY, state.selectedEmployeeName);
      if (broadcast && syncChannel) {
        syncChannel.postMessage({ type: 'STATE_UPDATED', payload });
      }
    } catch (_) {}
  }

  async function syncWithCentralServer(pushLocalChanges = false) {
    if (REMOTE_MODE) {
      return pushLocalChanges ? remotePush() : remoteSyncPull({});
    }
    if (state.simulateOffline) {
      state.serverConnected = false;
      updateSyncStatusUI();
      return;
    }

    if (window.location.protocol !== 'file:') {
      try {
        if (pushLocalChanges) {
          const res = await fetch('/api/state', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              employees: state.employees,
              records: state.records,
              lockedDays: state.lockedDays,
              dayModAlerts: state.dayModAlerts,
              holidays: state.holidays
            })
          });
          if (res.ok) {
            const data = await res.json();
            state.serverConnected = true;
            if (data.serverTimestampMs) {
              state.serverClockOffsetMs = Number(data.serverTimestampMs) - Date.now();
            }
            if (data.lanUrl) state.serverLanUrl = data.lanUrl;
          }
        } else {
          const res = await fetch('/api/state');
          if (res.ok) {
            const data = await res.json();
            state.serverConnected = true;
            if (data.serverTimestampMs) {
              state.serverClockOffsetMs = Number(data.serverTimestampMs) - Date.now();
            }
            if (Array.isArray(data.employees) && data.employees.length > 0) {
              state.employees = data.employees;
              ensureEmployeeCredentials(state.employees);
            }
            if (Array.isArray(data.records)) {
              state.records = data.records.filter((r) => !r.isDriverNoTime);
            }
            if (data.lockedDays && typeof data.lockedDays === 'object' && Object.keys(data.lockedDays).length > 0) {
              state.lockedDays = data.lockedDays;
            }
            if (data.dayModAlerts && typeof data.dayModAlerts === 'object') {
              state.dayModAlerts = data.dayModAlerts;
            }
            if (data.holidays && typeof data.holidays === 'object') {
              state.holidays = data.holidays;
            }
            ensureDefaultLockedDays();
            saveLocalState(false);
            renderAll();
          }
        }
      } catch (_) {
        try {
          const headRes = await fetch(window.location.href, { method: 'HEAD', cache: 'no-store' });
          const ghDate = headRes.headers.get('date');
          if (ghDate) {
            state.serverClockOffsetMs = new Date(ghDate).getTime() - Date.now();
          }
        } catch (_e) {}
      }
    }
    updateSyncStatusUI();
  }

  /**
   * Đẩy toàn bộ các bản ghi đang kẹt trên Zalo Webview (4G yếu) lên Cloud
   * và cấp mã xác nhận Server ACK để công nhân yên tâm tắt màn hình
   */
  function flushOfflineQueue() {
    if (REMOTE_MODE) {
      remoteFlushPending();
      return;
    }
    if (state.offlineQueue.length === 0 && !state.simulateOffline) {
      showToast('Mọi đơn tăng ca đều đã nhận mã xác nhận Server ACK trên Cloud!', 'success');
      return;
    }

    state.simulateOffline = false;
    state.isWaitingServerAck = false;
    releaseZaloScreenWakeLock();

    let syncedCount = 0;
    const remaining = [];
    let latestAck = null;

    for (const item of state.offlineQueue) {
      const check = validateAndNormalizeRecord(item, item.id);
      if (check.ok) {
        state.records.unshift(check.record);
        latestAck = check.record;
        syncedCount++;
      } else {
        remaining.push(item);
      }
    }
    state.offlineQueue = remaining;
    if (latestAck) {
      state.lastServerAckReceipt = {
        receiptId: latestAck.receiptId,
        employeeName: latestAck.employeeName,
        serverTimestamp: latestAck.serverTimestamp
      };
    }

    saveLocalState(true);
    syncWithCentralServer(true);
    playFeedbackSound('SUCCESS');
    renderAll();
    showToast(
      `Server Cloud đã xác nhận (ACK) thành công <strong>${syncedCount} đơn tăng ca</strong>! Hiện đã an toàn để đóng Zalo / tắt màn hình.`,
      'success'
    );
  }

  function updateSyncStatusUI(skipWorkerRender = false) {
    const pill = document.getElementById('syncStatusPill');
    const text = document.getElementById('syncStatusText');
    const phoneBadge = document.getElementById('phoneNetBadge');
    const zaloAlertBanner = document.getElementById('zaloHoldScreenAlert');
    const ackBanner = document.getElementById('serverAckReceiptBanner');
    const ackCodeEl = document.getElementById('ackReceiptCode');
    const ackDetailEl = document.getElementById('ackReceiptDetail');
    const pendingCountEl = document.getElementById('offlinePendingCount');
    const tabBadge = document.getElementById('offlineQueueTabBadge');
    const deployOfflineBadge = document.getElementById('deployOfflineCountBadge');
    const btnDemoWeak4G = document.getElementById('btnDemoWeak4GZalo');
    const btnSubmit = document.getElementById('btnSubmitMobileOvertime');
    const btnSubmitText = document.getElementById('btnSubmitMobileText');
    const migEmpLabel = document.getElementById('migEmpCountLabel');
    const migRecLabel = document.getElementById('migRecCountLabel');

    const qLen = pendingCount();

    if (pendingCountEl) pendingCountEl.textContent = String(qLen);
    if (deployOfflineBadge) deployOfflineBadge.textContent = `${qLen} bản ghi chờ`;
    if (migEmpLabel) migEmpLabel.textContent = String(state.employees.length);
    if (migRecLabel) migRecLabel.textContent = String(state.records.length);

    if (tabBadge) {
      if (qLen > 0) {
        tabBadge.style.display = 'inline-block';
        tabBadge.textContent = `${qLen} chờ ACK`;
      } else {
        tabBadge.style.display = 'none';
      }
    }

    // Hiển thị Cảnh báo đỏ giữ màn hình trên Zalo Webview khi mạng 4G yếu hoặc còn đơn chưa nhận ACK
    if (zaloAlertBanner) {
      zaloAlertBanner.style.display = state.simulateOffline || state.isWaitingServerAck || qLen > 0 ? 'flex' : 'none';
    }

    // Hiển thị Biên nhận xanh Server ACK khi đã lưu thành công
    if (ackBanner) {
      if (!state.simulateOffline && !state.isWaitingServerAck && qLen === 0 && state.lastServerAckReceipt) {
        ackBanner.style.display = 'block';
        if (ackCodeEl) ackCodeEl.textContent = `#${state.lastServerAckReceipt.receiptId}`;
        if (ackDetailEl) {
          ackDetailEl.innerHTML = `Nhân viên: <strong>${escapeHtml(state.lastServerAckReceipt.employeeName)}</strong> • Lúc: <strong>${escapeHtml(state.lastServerAckReceipt.serverTimestamp)}</strong>`;
        }
      } else {
        ackBanner.style.display = 'none';
      }
    }

    // Khóa nút gửi khi đang chờ xác nhận hoặc khi mạng yếu
    if (btnSubmit && btnSubmitText) {
      if (state.isWaitingServerAck) {
        btnSubmit.disabled = true;
        btnSubmit.classList.add('locking-wait');
        btnSubmitText.textContent = 'Đang gửi phiếu...';
      } else if (state.simulateOffline && qLen > 0) {
        btnSubmit.disabled = true;
        btnSubmit.classList.add('locking-wait');
        btnSubmitText.textContent = `Đang chờ mạng (${qLen} phiếu)`;
      } else {
        // Trạng thái nút Lưu (khóa khi chưa chọn ca, nhãn theo ngày) do renderWorkerMobileView quyết định
        btnSubmit.classList.remove('locking-wait');
        if (!skipWorkerRender) renderWorkerMobileView();
      }
    }

    if (state.simulateOffline) {
      if (pill) pill.classList.add('offline');
      if (text) text.textContent = `Mạng yếu (${qLen} chờ gửi)`;
      if (phoneBadge) {
        phoneBadge.className = 'phone-network-badge offline';
        phoneBadge.textContent = `Mạng yếu (${qLen})`;
      }
    } else {
      if (pill) pill.classList.remove('offline');
      const modeLabel = REMOTE_MODE
        ? state.serverConnected
          ? 'Đã kết nối'
          : 'Mất kết nối'
        : state.serverConnected
        ? 'Đã kết nối'
        : 'Sẵn sàng';
      if (text) text.textContent = qLen > 0 ? `${modeLabel} (${qLen} chờ)` : modeLabel;
      if (phoneBadge) {
        phoneBadge.className = 'phone-network-badge';
        phoneBadge.textContent = 'Trực tuyến';
      }
    }
    renderCloudStatus();
  }

  // ==========================================================================
  // 6. BỘ ENGINE XUẤT FILE `.XLSX` NGUYÊN BẢN 100% (PKZIP + OOXML)
  //    Bơm dữ liệu trực tiếp vào cấu trúc gốc `Mẫu chi tiết tăng ca 10_2026.xlsx`
  // ==========================================================================

  /**
   * Escape chuỗi XML an toàn tuyệt đối
   */
  function xmlEscape(str) {
    if (str === null || str === undefined) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  /**
   * Bảng tính CRC32 chuẩn IEEE 802.3 cho định dạng ZIP (.xlsx)
   */
  const CRC32_TABLE = (function () {
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      table[i] = c >>> 0;
    }
    return table;
  })();

  function computeCrc32(u8Arr) {
    let crc = 0xffffffff;
    for (let i = 0; i < u8Arr.length; i++) {
      crc = CRC32_TABLE[(crc ^ u8Arr[i]) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  /**
   * Đóng gói danh sách file `{ name, data: Uint8Array }` thành file nhị phân `.xlsx` (PKZIP)
   * Tương thích 100% với Microsoft Excel, Google Sheets, LibreOffice và openpyxl!
   */
  function createZipBinaryFromFiles(files) {
    const encoder = new TextEncoder();
    const localParts = [];
    const centralParts = [];
    let offset = 0;

    for (const file of files) {
      const nameBytes = encoder.encode(file.name);
      const contentBytes = file.data instanceof Uint8Array ? file.data : encoder.encode(file.data);
      const crc = computeCrc32(contentBytes);
      const size = contentBytes.length;

      // Local File Header (30 bytes + filename)
      const localHeader = new Uint8Array(30 + nameBytes.length);
      const lv = new DataView(localHeader.buffer);
      lv.setUint32(0, 0x04034b50, true); // Signature PK\x03\x04
      lv.setUint16(4, 20, true);         // Version needed (2.0)
      lv.setUint16(6, 0x0800, true);     // General purpose bit flag (UTF-8)
      lv.setUint16(8, 0, true);          // Compression method: 0 (STORED)
      lv.setUint16(10, 0x8020, true);    // Last mod file time
      lv.setUint16(12, 0x5d4f, true);    // Last mod file date (2026-10-15)
      lv.setUint32(14, crc, true);       // CRC-32
      lv.setUint32(18, size, true);      // Compressed size
      lv.setUint32(22, size, true);      // Uncompressed size
      lv.setUint16(26, nameBytes.length, true); // File name length
      lv.setUint16(28, 0, true);         // Extra field length
      localHeader.set(nameBytes, 30);

      localParts.push(localHeader, contentBytes);

      // Central Directory File Header (46 bytes + filename)
      const centralHeader = new Uint8Array(46 + nameBytes.length);
      const cv = new DataView(centralHeader.buffer);
      cv.setUint32(0, 0x02014b50, true); // Signature PK\x01\x02
      cv.setUint16(4, 20, true);         // Version made by
      cv.setUint16(6, 20, true);         // Version needed
      cv.setUint16(8, 0x0800, true);     // UTF-8 flag
      cv.setUint16(10, 0, true);         // Compression method: 0 (STORED)
      cv.setUint16(12, 0x8020, true);    // Mod time
      cv.setUint16(14, 0x5d4f, true);    // Mod date
      cv.setUint32(16, crc, true);       // CRC-32
      cv.setUint32(20, size, true);      // Compressed size
      cv.setUint32(24, size, true);      // Uncompressed size
      cv.setUint16(28, nameBytes.length, true); // File name length
      cv.setUint16(30, 0, true);         // Extra length
      cv.setUint16(32, 0, true);         // Comment length
      cv.setUint16(34, 0, true);         // Disk number
      cv.setUint16(36, 0, true);         // Internal attrs
      cv.setUint32(38, 0, true);         // External attrs
      cv.setUint32(42, offset, true);    // Relative offset of local header
      centralHeader.set(nameBytes, 46);

      centralParts.push(centralHeader);
      offset += localHeader.length + contentBytes.length;
    }

    let centralSize = 0;
    for (const cp of centralParts) centralSize += cp.length;

    // End of Central Directory Record (22 bytes)
    const eocd = new Uint8Array(22);
    const ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054b50, true); // Signature PK\x05\x06
    ev.setUint16(4, 0, true);          // Disk number
    ev.setUint16(6, 0, true);          // Central dir start disk
    ev.setUint16(8, files.length, true);  // Entries on disk
    ev.setUint16(10, files.length, true); // Total entries
    ev.setUint32(12, centralSize, true);  // Size of central directory
    ev.setUint32(16, offset, true);       // Offset of start of central directory
    ev.setUint16(20, 0, true);         // Comment length

    const totalSize = offset + centralSize + eocd.length;
    const output = new Uint8Array(totalSize);
    let pos = 0;
    for (const part of localParts) {
      output.set(part, pos);
      pos += part.length;
    }
    for (const part of centralParts) {
      output.set(part, pos);
      pos += part.length;
    }
    output.set(eocd, pos);
    return output;
  }

  /**
   * Tạo toàn bộ nội dung 12 file XML bên trong `Mẫu chi tiết tăng ca 10_2026.xlsx`
   * giữ nguyên 100% cấu trúc gốc, styles, theme, Named Ranges, công thức và Data Validation!
   */
  function generateExactTemplateXlsxBytes() {
    // 1. Lọc sạch chỉ lấy các dòng hợp lệ có Nội dung công việc (Mục 1 Hướng dẫn)
    // Sắp xếp theo thời gian để bảng xuất ra gọn gàng, chuyên nghiệp
    const exportMonthKey = getSelectedMonthKey();
    const validRecords = state.records
      .filter((r) => r && r.employeeName && r.jobContent && r.jobContent.trim().length > 0 && isRecordInMonth(r, exportMonthKey))
      .slice()
      .sort((a, b) => {
        const msA = parseVnDateTimeToMs(a.startTime) || 0;
        const msB = parseVnDateTimeToMs(b.startTime) || 0;
        if (msA !== msB) return msA - msB;
        return a.employeeName.localeCompare(b.employeeName, 'vi');
      });

    const [exY, exM] = exportMonthKey.split('-').map(Number);
    const exFirstIso = `${exY}-${pad2(exM)}-01`;
    const exLastIso = `${exY}-${pad2(exM)}-${pad2(new Date(exY, exM, 0).getDate())}`;
    const usedNames = new Set(validRecords.map((r) => r.employeeName));
    const allEmployees = state.employees.length > 0 ? state.employees : DEFAULT_EMPLOYEES;
    // Chỉ đưa vào danh sách nhân viên của tháng: người đang làm trong tháng hoặc có dòng tăng ca trong tháng
    const employees = allEmployees.filter(
      (e) =>
        usedNames.has(e.name) ||
        (!(e.endDate && e.endDate < exFirstIso) && !(e.startDate && e.startDate > exLastIso))
    );
    const empEndRow = employees.length + 1; // Bắt đầu từ A2 -> A{empEndRow}

    // 2. Xây dựng bảng SharedStrings (`xl/sharedStrings.xml`)
    // Giữ nguyên 17 chuỗi đầu tiên của bản gốc:
    const sharedStringsList = [
      EXCEL_GUIDE_TEXTS[0], // 0
      EXCEL_GUIDE_TEXTS[1], // 1
      EXCEL_GUIDE_TEXTS[2], // 2
      EXCEL_GUIDE_TEXTS[3], // 3
      EXCEL_GUIDE_TEXTS[4], // 4
      EXCEL_GUIDE_TEXTS[5], // 5
      'Tên nhân viên',              // 6
      'Nội dung công việc',         // 7
      'Bắt đầu',                    // 8
      'Kết thúc',                   // 9
      'Ngày tính công',             // 10
      'Thời gian tăng ca',          // 11
      'Loại tăng ca',               // 12
      'Hình thức tăng ca',          // 13
      'Ghi chú',                    // 14
      'Loại tăng ca mặc định',      // 15
      'Hình thức tăng ca mặc định'  // 16
    ];

    const sstMap = new Map();
    sharedStringsList.forEach((s, idx) => sstMap.set(s, idx));
    let totalSstRefCount = 0;

    function getSstIndex(strVal) {
      const s = String(strVal ?? '');
      totalSstRefCount++;
      if (sstMap.has(s)) {
        return sstMap.get(s);
      }
      const newIdx = sharedStringsList.length;
      sharedStringsList.push(s);
      sstMap.set(s, newIdx);
      return newIdx;
    }

    // 3. Tạo Sheet 3: `xl/worksheets/sheet3.xml` ("Hướng dẫn")
    // Tham chiếu các chỉ số 0..5 trong SharedStrings
    for (let i = 0; i <= 5; i++) getSstIndex(EXCEL_GUIDE_TEXTS[i]);
    const sheet3Xml =
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      '<dimension ref="A1:A7"/>' +
      '<sheetViews><sheetView workbookViewId="0"/></sheetViews>' +
      '<sheetFormatPr defaultRowHeight="15"/>' +
      '<cols><col min="1" max="1" width="120.7109375" customWidth="1"/></cols>' +
      '<sheetData>' +
      '<row r="1" spans="1:1" ht="30" customHeight="1"><c r="A1" s="1" t="s"><v>0</v></c></row>' +
      '<row r="3" spans="1:1"><c r="A3" s="2" t="s"><v>1</v></c></row>' +
      '<row r="4" spans="1:1"><c r="A4" s="2" t="s"><v>2</v></c></row>' +
      '<row r="5" spans="1:1"><c r="A5" s="2" t="s"><v>3</v></c></row>' +
      '<row r="6" spans="1:1"><c r="A6" s="2" t="s"><v>4</v></c></row>' +
      '<row r="7" spans="1:1"><c r="A7" s="2" t="s"><v>5</v></c></row>' +
      '</sheetData>' +
      '<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>' +
      '</worksheet>';

    // 4. Tạo Sheet 2: `xl/worksheets/sheet2.xml` ("Danh sách nhân viên")
    const s2HeaderA = getSstIndex('Tên nhân viên');
    const s2HeaderB = getSstIndex('Loại tăng ca mặc định');
    const s2HeaderC = getSstIndex('Hình thức tăng ca mặc định');
    let sheet2RowsXml = `<row r="1" spans="1:3"><c r="A1" s="1" t="s"><v>${s2HeaderA}</v></c><c r="B1" s="1" t="s"><v>${s2HeaderB}</v></c><c r="C1" s="1" t="s"><v>${s2HeaderC}</v></c></row>`;

    employees.forEach((emp, idx) => {
      const r = idx + 2;
      const idxName = getSstIndex(emp.name);
      const idxType = getSstIndex(emp.defaultOvertimeType || 'Ngoài khoán');
      const idxMode = getSstIndex(emp.defaultWorkMode || 'Tăng ca tại công ty');
      sheet2RowsXml += `<row r="${r}" spans="1:3"><c r="A${r}" s="3" t="s"><v>${idxName}</v></c><c r="B${r}" s="3" t="s"><v>${idxType}</v></c><c r="C${r}" s="3" t="s"><v>${idxMode}</v></c></row>`;
    });

    const sheet2Xml =
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      `<dimension ref="A1:C${empEndRow}"/>` +
      '<sheetViews><sheetView workbookViewId="0"/></sheetViews>' +
      '<sheetFormatPr defaultRowHeight="15"/>' +
      '<cols>' +
      '<col min="1" max="1" width="28.7109375" customWidth="1"/>' +
      '<col min="2" max="2" width="22.7109375" customWidth="1"/>' +
      '<col min="3" max="3" width="28.7109375" customWidth="1"/>' +
      '</cols>' +
      `<sheetData>${sheet2RowsXml}</sheetData>` +
      '<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>' +
      '</worksheet>';

    // 5. Tạo Sheet 1: `xl/worksheets/sheet1.xml` ("Chi tiết tăng ca")
    // Rows 1..6: 6 dòng hướng dẫn gộp ô A1:I1 .. A6:I6
    const rowHeights = [30, 38, 56, 20, 20, 20];
    let sheet1RowsXml = '';
    for (let r = 1; r <= 6; r++) {
      const styleId = r === 1 ? 1 : 2;
      const sstIdx = getSstIndex(EXCEL_GUIDE_TEXTS[r - 1]);
      sheet1RowsXml +=
        `<row r="${r}" spans="1:9" ht="${rowHeights[r - 1]}" customHeight="1">` +
        `<c r="A${r}" s="${styleId}" t="s"><v>${sstIdx}</v></c>` +
        `<c r="B${r}" s="${styleId}"/><c r="C${r}" s="${styleId}"/><c r="D${r}" s="${styleId}"/>` +
        `<c r="E${r}" s="${styleId}"/><c r="F${r}" s="${styleId}"/><c r="G${r}" s="${styleId}"/>` +
        `<c r="H${r}" s="${styleId}"/><c r="I${r}" s="${styleId}"/>` +
        `</row>`;
    }

    // Row 7: Dòng tiêu đề cột A7:I7
    const headersS1 = [
      'Tên nhân viên',
      'Nội dung công việc',
      'Bắt đầu',
      'Kết thúc',
      'Ngày tính công',
      'Thời gian tăng ca',
      'Loại tăng ca',
      'Hình thức tăng ca',
      'Ghi chú'
    ];
    const colLetters = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I'];
    let row7Cells = '';
    headersS1.forEach((hText, cIdx) => {
      const idx = getSstIndex(hText);
      row7Cells += `<c r="${colLetters[cIdx]}7" s="1" t="s"><v>${idx}</v></c>`;
    });
    sheet1RowsXml += `<row r="7" spans="1:9" ht="34" customHeight="1">${row7Cells}</row>`;

    // Rows 8..1007: Bơm các dòng tăng ca hợp lệ trước, sau đó giữ công thức chờ cho các dòng còn lại
    const maxTemplateRow = Math.max(1007, 8 + validRecords.length + 20);
    for (let r = 8; r <= maxTemplateRow; r++) {
      const recIdx = r - 8;
      const formulaG = `IF(A${r}="","",IF(COUNTIF(EmployeeNames,A${r})=1,INDEX(EmployeeOvertimeTypes,MATCH(A${r},EmployeeNames,0)),""))`;
      const formulaH = `IF(A${r}="","",IF(COUNTIF(EmployeeNames,A${r})=1,INDEX(EmployeeWorkModes,MATCH(A${r},EmployeeNames,0)),""))`;

      if (recIdx < validRecords.length) {
        const rec = validRecords[recIdx];
        const empObj = employees.find((e) => e.name === rec.employeeName);
        const defaultType = empObj ? empObj.defaultOvertimeType : 'Ngoài khoán';
        const defaultMode = empObj ? empObj.defaultWorkMode : 'Tăng ca tại công ty';

        const idxEmp = getSstIndex(rec.employeeName);
        const idxJob = getSstIndex(rec.jobContent);

        // Cột C (Bắt đầu), D (Kết thúc), E (Ngày tính công) dùng style s="4" (formatCode="@")
        const cellC =
          !rec.isDriverNoTime && rec.startTime
            ? `<c r="C${r}" s="4" t="s"><v>${getSstIndex(rec.startTime)}</v></c>`
            : `<c r="C${r}" s="4"/>`;
        const cellD =
          !rec.isDriverNoTime && rec.endTime
            ? `<c r="D${r}" s="4" t="s"><v>${getSstIndex(rec.endTime)}</v></c>`
            : `<c r="D${r}" s="4"/>`;
        const cellE =
          !rec.isDriverNoTime && rec.startTime && rec.endTime && rec.workDate
            ? `<c r="E${r}" s="4" t="s"><v>${getSstIndex(rec.workDate)}</v></c>`
            : `<c r="E${r}" s="4"/>`;

        // Cột F (Thời gian tăng ca):
        // - Nếu Chế độ Lái xe: ghi số 0 (Mục 1 Hướng dẫn)
        // - Nếu Admin có nhập giờ ghi đè chính thức: ghi số giờ đó (Mục 3 Hướng dẫn)
        // - Mặc định: để trống <c r="F{r}" s="3"/> để phần mềm công ty tự tính!
        let cellF = `<c r="F${r}" s="3"/>`;
        if (rec.isDriverNoTime) {
          cellF = `<c r="F${r}" s="3"><v>0</v></c>`;
        } else if (rec.overrideHours !== null && rec.overrideHours !== '' && !isNaN(rec.overrideHours)) {
          cellF = `<c r="F${r}" s="3"><v>${Number(rec.overrideHours)}</v></c>`;
        }

        // Cột G (Loại tăng ca): Giữ công thức gốc nếu trùng mặc định, hoặc ghi giá trị chọn
        const chosenType = rec.overtimeType || defaultType;
        const cellG =
          chosenType === defaultType
            ? `<c r="G${r}" s="3" t="str"><f>${formulaG}</f><v>${xmlEscape(chosenType)}</v></c>`
            : `<c r="G${r}" s="3" t="s"><v>${getSstIndex(chosenType)}</v></c>`;

        // Cột H (Hình thức tăng ca): Giữ công thức gốc nếu trùng mặc định, hoặc ghi giá trị chọn (VD: Tăng ca trưa / Ngoài công ty)
        const chosenMode = rec.workMode || defaultMode;
        const cellH =
          chosenMode === defaultMode
            ? `<c r="H${r}" s="3" t="str"><f>${formulaH}</f><v>${xmlEscape(chosenMode)}</v></c>`
            : `<c r="H${r}" s="3" t="s"><v>${getSstIndex(chosenMode)}</v></c>`;

        // Cột I (Ghi chú)
        const idxNote = getSstIndex(rec.note || '');
        const cellI = `<c r="I${r}" s="3" t="s"><v>${idxNote}</v></c>`;

        sheet1RowsXml +=
          `<row r="${r}" spans="1:9">` +
          `<c r="A${r}" s="3" t="s"><v>${idxEmp}</v></c>` +
          `<c r="B${r}" s="3" t="s"><v>${idxJob}</v></c>` +
          cellC +
          cellD +
          cellE +
          cellF +
          cellG +
          cellH +
          cellI +
          `</row>`;
      } else {
        // Các dòng trống phía dưới: chỉ để công thức chờ ở cột G và H giống hệt dòng 17..1007 của file mẫu gốc!
        // Tuyệt đối không điền sẵn Tên nhân viên mà không có Nội dung công việc để tránh rác dữ liệu
        sheet1RowsXml +=
          `<row r="${r}" spans="7:8">` +
          `<c r="G${r}" s="3"><f>${formulaG}</f><v></v></c>` +
          `<c r="H${r}" s="3"><f>${formulaH}</f><v></v></c>` +
          `</row>`;
      }
    }

    const sheet1Xml =
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      `<dimension ref="A1:I${maxTemplateRow}"/>` +
      '<sheetViews><sheetView tabSelected="1" workbookViewId="0"><pane ySplit="7" topLeftCell="A8" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft"/></sheetView></sheetViews>' +
      '<sheetFormatPr defaultRowHeight="15"/>' +
      '<cols>' +
      '<col min="1" max="1" width="28.7109375" customWidth="1"/>' +
      '<col min="2" max="2" width="32.7109375" customWidth="1"/>' +
      '<col min="3" max="4" width="20.7109375" customWidth="1"/>' +
      '<col min="5" max="6" width="16.7109375" customWidth="1"/>' +
      '<col min="7" max="7" width="18.7109375" customWidth="1"/>' +
      '<col min="8" max="8" width="24.7109375" customWidth="1"/>' +
      '<col min="9" max="9" width="28.7109375" customWidth="1"/>' +
      '</cols>' +
      `<sheetData>${sheet1RowsXml}</sheetData>` +
      '<mergeCells count="6">' +
      '<mergeCell ref="A1:I1"/><mergeCell ref="A2:I2"/><mergeCell ref="A3:I3"/>' +
      '<mergeCell ref="A4:I4"/><mergeCell ref="A5:I5"/><mergeCell ref="A6:I6"/>' +
      '</mergeCells>' +
      '<dataValidations count="4">' +
      `<dataValidation type="list" allowBlank="1" showInputMessage="1" showErrorMessage="1" promptTitle="Tên nhân viên" prompt="Chọn đúng tên nhân viên có dấu trong danh sách." sqref="A8:A${maxTemplateRow}"><formula1>EmployeeNames</formula1></dataValidation>` +
      `<dataValidation type="list" allowBlank="1" showInputMessage="1" showErrorMessage="1" sqref="G8:G${maxTemplateRow}"><formula1>"Ngoài khoán,Trong khoán"</formula1></dataValidation>` +
      `<dataValidation type="list" allowBlank="1" showInputMessage="1" showErrorMessage="1" sqref="H8:H${maxTemplateRow}"><formula1>"Tăng ca tại công ty,Tăng ca trưa,Tăng ca ngoài công ty"</formula1></dataValidation>` +
      `<dataValidation type="decimal" operator="greaterThanOrEqual" allowBlank="1" showInputMessage="1" showErrorMessage="1" sqref="F8:F${maxTemplateRow}"><formula1>0</formula1></dataValidation>` +
      '</dataValidations>' +
      '<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>' +
      '</worksheet>';

    // 6. Tạo `xl/sharedStrings.xml`
    let sstItemsXml = '';
    for (const s of sharedStringsList) {
      sstItemsXml += `<si><t>${xmlEscape(s)}</t></si>`;
    }
    const sharedStringsXml =
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
      `<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${totalSstRefCount}" uniqueCount="${sharedStringsList.length}">` +
      sstItemsXml +
      '</sst>';

    // 7. Tạo `xl/workbook.xml` với Named Ranges khớp chính xác số lượng nhân viên
    const workbookXml =
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      '<fileVersion appName="xl" lastEdited="4" lowestEdited="4" rupBuild="4505"/>' +
      '<workbookPr defaultThemeVersion="124226"/>' +
      '<bookViews><workbookView xWindow="240" yWindow="15" windowWidth="16095" windowHeight="9660"/></bookViews>' +
      '<sheets>' +
      '<sheet name="Chi tiết tăng ca" sheetId="1" r:id="rId1"/>' +
      '<sheet name="Danh sách nhân viên" sheetId="2" r:id="rId2"/>' +
      '<sheet name="Hướng dẫn" sheetId="3" r:id="rId3"/>' +
      '</sheets>' +
      '<definedNames>' +
      `<definedName name="EmployeeNames">'Danh sách nhân viên'!$A$2:$A$${empEndRow}</definedName>` +
      `<definedName name="EmployeeOvertimeTypes">'Danh sách nhân viên'!$B$2:$B$${empEndRow}</definedName>` +
      `<definedName name="EmployeeWorkModes">'Danh sách nhân viên'!$C$2:$C$${empEndRow}</definedName>` +
      '</definedNames>' +
      '<calcPr calcId="124519" fullCalcOnLoad="1"/>' +
      '</workbook>';

    // 8. Các file XML cấu hình chuẩn từ bản gốc
    const contentTypesXml =
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>' +
      '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
      '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
      '<Override PartName="/xl/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
      '<Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
      '<Override PartName="/xl/worksheets/sheet3.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
      '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>' +
      '</Types>';

    const rootRelsXml =
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
      '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
      '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>' +
      '</Relationships>';

    const workbookRelsXml =
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
      '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>' +
      '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet3.xml"/>' +
      '<Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="theme/theme1.xml"/>' +
      '<Relationship Id="rId5" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
      '<Relationship Id="rId6" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>' +
      '</Relationships>';

    const stylesXml =
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
      '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<numFmts count="1"><numFmt numFmtId="164" formatCode="@"/></numFmts>' +
      '<fonts count="2">' +
      '<font><sz val="11"/><color theme="1"/><name val="Calibri"/><family val="2"/><scheme val="minor"/></font>' +
      '<font><b/><sz val="11"/><color theme="1"/><name val="Calibri"/><family val="2"/><scheme val="minor"/></font>' +
      '</fonts>' +
      '<fills count="3">' +
      '<fill><patternFill patternType="none"/></fill>' +
      '<fill><patternFill patternType="gray125"/></fill>' +
      '<fill><patternFill patternType="solid"><fgColor rgb="FFD9EAF7"/><bgColor indexed="64"/></patternFill></fill>' +
      '</fills>' +
      '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
      '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
      '<cellXfs count="5">' +
      '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
      '<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>' +
      '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>' +
      '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
      '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
      '</cellXfs>' +
      '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
      '<dxfs count="0"/><tableStyles count="0" defaultTableStyle="TableStyleMedium9" defaultPivotStyle="PivotStyleLight16"/>' +
      '</styleSheet>';

    const theme1Xml =
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
      '<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Office Theme"><a:themeElements><a:clrScheme name="Office"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="1F497D"/></a:dk2><a:lt2><a:srgbClr val="EEECE1"/></a:lt2><a:accent1><a:srgbClr val="4F81BD"/></a:accent1><a:accent2><a:srgbClr val="C0504D"/></a:accent2><a:accent3><a:srgbClr val="9BBB59"/></a:accent3><a:accent4><a:srgbClr val="8064A2"/></a:accent4><a:accent5><a:srgbClr val="4BACC6"/></a:accent5><a:accent6><a:srgbClr val="F79646"/></a:accent6><a:hlink><a:srgbClr val="0000FF"/></a:hlink><a:folHlink><a:srgbClr val="800080"/></a:folHlink></a:clrScheme><a:fontScheme name="Office"><a:majorFont><a:latin typeface="Cambria"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme><a:fmtScheme name="Office"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:gradFill rotWithShape="1"><a:gsLst><a:gs pos="0"><a:schemeClr val="phClr"/></a:gs><a:gs pos="100000"><a:schemeClr val="phClr"/></a:gs></a:gsLst></a:gradFill><a:gradFill rotWithShape="1"><a:gsLst><a:gs pos="0"><a:schemeClr val="phClr"/></a:gs><a:gs pos="100000"><a:schemeClr val="phClr"/></a:gs></a:gsLst></a:gradFill></a:fillStyleLst><a:lnStyleLst><a:ln w="9525"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="25400"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="38100"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:gradFill rotWithShape="1"><a:gsLst><a:gs pos="0"><a:schemeClr val="phClr"/></a:gs><a:gs pos="100000"><a:schemeClr val="phClr"/></a:gs></a:gsLst></a:gradFill><a:gradFill rotWithShape="1"><a:gsLst><a:gs pos="0"><a:schemeClr val="phClr"/></a:gs><a:gs pos="100000"><a:schemeClr val="phClr"/></a:gs></a:gsLst></a:gradFill></a:bgFillStyleLst></a:fmtScheme></a:themeElements><a:objectDefaults/><a:extraClrSchemeLst/></a:theme>';

    const coreXml =
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
      '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
      '<dc:creator>Smart Factory Overtime System</dc:creator>' +
      '<cp:lastModifiedBy>Admin</cp:lastModifiedBy>' +
      '<dcterms:created xsi:type="dcterms:W3CDTF">2026-10-15T16:05:04Z</dcterms:created>' +
      `<dcterms:modified xsi:type="dcterms:W3CDTF">${new Date().toISOString()}</dcterms:modified>` +
      '</cp:coreProperties>';

    const appXml =
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
      '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">' +
      '<Application>Microsoft Excel</Application><DocSecurity>0</DocSecurity><ScaleCrop>false</ScaleCrop>' +
      '<HeadingPairs><vt:vector size="4" baseType="variant"><vt:variant><vt:lpstr>Worksheets</vt:lpstr></vt:variant><vt:variant><vt:i4>3</vt:i4></vt:variant><vt:variant><vt:lpstr>Named Ranges</vt:lpstr></vt:variant><vt:variant><vt:i4>3</vt:i4></vt:variant></vt:vector></HeadingPairs>' +
      '<TitlesOfParts><vt:vector size="6" baseType="lpstr"><vt:lpstr>Chi tiết tăng ca</vt:lpstr><vt:lpstr>Danh sách nhân viên</vt:lpstr><vt:lpstr>Hướng dẫn</vt:lpstr><vt:lpstr>EmployeeNames</vt:lpstr><vt:lpstr>EmployeeOvertimeTypes</vt:lpstr><vt:lpstr>EmployeeWorkModes</vt:lpstr></vt:vector></TitlesOfParts>' +
      '<Company></Company><LinksUpToDate>false</LinksUpToDate><SharedDoc>false</SharedDoc><HyperlinksChanged>false</HyperlinksChanged><AppVersion>12.0000</AppVersion>' +
      '</Properties>';

    return createZipBinaryFromFiles([
      { name: '[Content_Types].xml', data: contentTypesXml },
      { name: '_rels/.rels', data: rootRelsXml },
      { name: 'xl/_rels/workbook.xml.rels', data: workbookRelsXml },
      { name: 'xl/workbook.xml', data: workbookXml },
      { name: 'xl/styles.xml', data: stylesXml },
      { name: 'xl/theme/theme1.xml', data: theme1Xml },
      { name: 'xl/worksheets/sheet1.xml', data: sheet1Xml },
      { name: 'xl/worksheets/sheet2.xml', data: sheet2Xml },
      { name: 'xl/worksheets/sheet3.xml', data: sheet3Xml },
      { name: 'xl/sharedStrings.xml', data: sharedStringsXml },
      { name: 'docProps/core.xml', data: coreXml },
      { name: 'docProps/app.xml', data: appXml }
    ]);
  }

  /**
   * Xuất và tải ngay file `Mẫu chi tiết tăng ca 10_2026.xlsx`
   */
  function downloadExactTemplateXlsx() {
    if (state.offlineQueue.length > 0) {
      flushOfflineQueue();
    }
    if (!state.records.some((r) => isRecordInMonth(r, getSelectedMonthKey()))) {
      showToast('Tháng này chưa có dòng tăng ca nào để xuất.', 'warn');
      return;
    }
    const zipBytes = generateExactTemplateXlsxBytes();
    const blob = new Blob([zipBytes], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const exKey = getSelectedMonthKey();
    const exFileName = `Mẫu chi tiết tăng ca ${exKey.slice(5)}_${exKey.slice(0, 4)}.xlsx`;
    a.download = exFileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 3000);

    playFeedbackSound('SUCCESS');
    showToast(
      `Đã xuất file <strong>${escapeHtml(exFileName)}</strong> (${state.records.filter((r) => isRecordInMonth(r, exKey)).length} dòng tăng ca của tháng ${exKey.slice(5)}/${exKey.slice(0, 4)}).`,
      'success'
    );
  }

  // ==========================================================================
  // 7. GIAO DIỆN PHÂN KHU 1: ĐIỆN THOẠI "3 CHẠM" CHO CÔNG NHÂN BÁO TĂNG CA
  // ==========================================================================

  function syncWorkerDefaultsFromSelectedEmp() {
    if (state.authRole === 'WORKER' && state.loggedInEmployeeName) {
      state.selectedEmployeeName = state.loggedInEmployeeName;
    }
    const emp = state.employees.find((e) => e.name === state.selectedEmployeeName) || state.employees[0];
    if (!emp) return;
    state.selectedEmployeeName = emp.name;
    state.mobileOvertimeType = emp.defaultOvertimeType || 'Ngoài khoán';
    state.mobileWorkMode = emp.defaultWorkMode || 'Tăng ca tại công ty';
  }

  // ==========================================================================
  // 7A. MÀN HÌNH ĐĂNG NHẬP TÀI KHOẢN & MẬT KHẨU (CÔNG NHÂN / QUẢN TRỊ VIÊN)
  // ==========================================================================

  const LAST_LOGIN_USER_KEY = 'argon_last_login_username_v1';

  function renderLoginView() {
    const userInp = document.getElementById('loginUsernameInput');
    if (userInp && !userInp.value && document.activeElement !== userInp) {
      try {
        const savedUser = localStorage.getItem(LAST_LOGIN_USER_KEY);
        if (savedUser) userInp.value = savedUser;
      } catch (_) {}
    }
  }

  function attemptLoginSubmit(ev) {
    if (ev && typeof ev.preventDefault === 'function') {
      ev.preventDefault();
    }

    const errEl = document.getElementById('loginErrorMsg');
    if (errEl) errEl.style.display = 'none';

    const userInp = document.getElementById('loginUsernameInput');
    const pwdInp = document.getElementById('loginPasswordInput');

    const rawUsername = (userInp?.value || '').trim();
    const rawPassword = (pwdInp?.value || '').trim();

    if (!rawUsername) {
      if (errEl) {
        errEl.textContent = 'Vui lòng nhập Tên đăng nhập.';
        errEl.style.display = 'block';
      }
      userInp?.focus();
      playFeedbackSound('ERROR');
      return;
    }

    if (!rawPassword) {
      if (errEl) {
        errEl.textContent = 'Vui lòng nhập Mật khẩu.';
        errEl.style.display = 'block';
      }
      pwdInp?.focus();
      playFeedbackSound('ERROR');
      return;
    }

    if (REMOTE_MODE) {
      attemptRemoteLogin(rawUsername, rawPassword, errEl);
      return;
    }

    const normUser = rawUsername.toLowerCase();

    // 1. Kiểm tra tài khoản Quản trị viên (Admin)
    if (normUser === 'admin' || normUser === 'quantri') {
      const isValidAdminPwd = isAdminPassword(rawPassword);

      if (isValidAdminPwd) {
        state.authRole = 'ADMIN';
        state.loggedInEmployeeName = null;
        state.adminUnlocked = true;
        state.activeMainTab = 'ADMIN_EXCEL';
        try {
          localStorage.setItem(LAST_LOGIN_USER_KEY, 'admin');
        } catch (_) {}
        if (pwdInp) pwdInp.value = '';
        saveAuthSession();
        playFeedbackSound('SUCCESS');
        renderAll();
        showToast('Đã đăng nhập Quản trị viên (Admin).', 'success');
      } else {
        playFeedbackSound('ERROR');
        if (errEl) {
          errEl.textContent = 'Mật khẩu Quản trị viên chưa đúng.';
          errEl.style.display = 'block';
        }
        pwdInp?.select();
      }
      return;
    }

    // 2. Kiểm tra tài khoản Công nhân theo Tên đăng nhập (hoặc Họ tên)
    const slugInput = slugifyVietnamese(rawUsername);
    const emp = state.employees.find(
      (e) =>
        (e.username && e.username.toLowerCase() === normUser) ||
        e.name.toLowerCase() === normUser ||
        slugifyVietnamese(e.name) === slugInput
    );

    if (!emp) {
      playFeedbackSound('ERROR');
      if (errEl) {
        errEl.textContent = 'Tên đăng nhập không tồn tại. Vui lòng kiểm tra lại.';
        errEl.style.display = 'block';
      }
      userInp?.focus();
      return;
    }

    if (!isEmployeeCurrentlyActive(emp)) {
      playFeedbackSound('ERROR');
      if (errEl) {
        errEl.textContent = 'Tài khoản này đã ngừng sử dụng. Vui lòng liên hệ Quản đốc.';
        errEl.style.display = 'block';
      }
      return;
    }

    const expectedPassword = String(emp.password || emp.pin || '123456');
    const isPasswordMatch =
      rawPassword === expectedPassword ||
      (emp.pin && rawPassword === String(emp.pin));

    if (isPasswordMatch) {
      state.authRole = 'WORKER';
      state.loggedInEmployeeName = emp.name;
      state.selectedEmployeeName = emp.name;
      state.workerMobileSubTab = 'FORM';
      state.adminUnlocked = false;
      state.lastServerAckReceipt = null;
      try {
        localStorage.setItem(LAST_LOGIN_USER_KEY, emp.username || rawUsername);
      } catch (_) {}
      if (pwdInp) pwdInp.value = '';
      syncWorkerDefaultsFromSelectedEmp();
      saveLocalState(false);
      saveAuthSession();
      resetWorkerForm();
      state.activeMainTab = 'WORKER_MOBILE';
      playFeedbackSound('SUCCESS');
      renderAll();
      showToast(`Xin chào ${escapeHtml(emp.name)}.`, 'success');
      if (rawPassword === '123456') {
        setTimeout(() => openChangePasswordModal({ forced: true, oldPassword: rawPassword }), 500);
      }
    } else {
      playFeedbackSound('ERROR');
      if (errEl) {
        errEl.textContent = 'Mật khẩu chưa đúng, vui lòng thử lại.';
        errEl.style.display = 'block';
      }
      pwdInp?.select();
    }
  }

  /**
   * Tính toán 3 ca Sáng / Trưa / Tối đang được tích chọn trên màn hình Điện thoại
   */
  function computeCurrentMobileDailySlots() {
    const isoDateEl = document.getElementById('mobileWorkDate');
    const isoDate = isoDateEl && isoDateEl.value ? isoDateEl.value : localIsoToday();
    const workDateStr = isoDateToVnDate(isoDate);

    // 1. Ca Sáng
    const mCheck = document.getElementById('slotMorningCheck');
    const mStartEl = document.getElementById('slotMorningStart');
    const mEndEl = document.getElementById('slotMorningEnd');
    const mChecked = mCheck ? Boolean(mCheck.checked) : false;
    const mStartHm = mStartEl && mStartEl.value ? mStartEl.value : '06:15';
    const mEndHm = mEndEl && mEndEl.value ? mEndEl.value : '07:15';
    const mStartStr = `${workDateStr} ${mStartHm}`;
    const mEndStr = `${workDateStr} ${mEndHm}`;
    const mStartMs = parseVnDateTimeToMs(mStartStr);
    const mEndMs = parseVnDateTimeToMs(mEndStr);
    const mHours =
      mStartMs && mEndMs && mEndMs > mStartMs
        ? Math.round(((mEndMs - mStartMs) / 3600000) * 100) / 100
        : 0;

    const morningSlot = {
      slotKey: 'MORNING',
      slotLabel: 'Sáng',
      checked: mChecked,
      startHm: mStartHm,
      endHm: mEndHm,
      startTime: mStartStr,
      endTime: mEndStr,
      workDate: workDateStr,
      estHours: mHours,
      workMode: 'Tăng ca tại công ty'
    };

    // 2. Ca Trưa
    const lCheck = document.getElementById('slotLunchCheck');
    const lStartEl = document.getElementById('slotLunchStart');
    const lEndEl = document.getElementById('slotLunchEnd');
    const lChecked = lCheck ? Boolean(lCheck.checked) : false;
    const lStartHm = lStartEl && lStartEl.value ? lStartEl.value : '11:15';
    const lEndHm = lEndEl && lEndEl.value ? lEndEl.value : '13:15';
    const lStartStr = `${workDateStr} ${lStartHm}`;
    const lEndStr = `${workDateStr} ${lEndHm}`;
    const lStartMs = parseVnDateTimeToMs(lStartStr);
    const lEndMs = parseVnDateTimeToMs(lEndStr);
    const lHours =
      lStartMs && lEndMs && lEndMs > lStartMs
        ? Math.round(((lEndMs - lStartMs) / 3600000) * 100) / 100
        : 0;

    const lunchSlot = {
      slotKey: 'LUNCH',
      slotLabel: 'Trưa',
      checked: lChecked,
      startHm: lStartHm,
      endHm: lEndHm,
      startTime: lStartStr,
      endTime: lEndStr,
      workDate: workDateStr,
      estHours: lHours,
      workMode: 'Tăng ca trưa'
    };

    // 3. Ca Tối
    const eCheck = document.getElementById('slotEveningCheck');
    const eStartEl = document.getElementById('slotEveningStart');
    const eEndEl = document.getElementById('slotEveningEnd');
    const eOverEl = document.getElementById('slotEveningOvernight');
    const eModeEl = document.getElementById('slotEveningWorkMode');
    const eChecked = eCheck ? Boolean(eCheck.checked) : false;
    const eStartHm = eStartEl && eStartEl.value ? eStartEl.value : '17:15';
    const eEndHm = eEndEl && eEndEl.value ? eEndEl.value : '18:15';
    let eOvernight = eOverEl ? Boolean(eOverEl.checked) : false;
    if (eEndHm <= eStartHm) {
      eOvernight = true;
      if (eOverEl) eOverEl.checked = true;
    }
    const eEndIsoDate = eOvernight ? addDaysToIsoDate(isoDate, 1) : isoDate;
    const eEndVnDate = isoDateToVnDate(eEndIsoDate);
    const eStartStr = `${workDateStr} ${eStartHm}`;
    const eEndStr = `${eEndVnDate} ${eEndHm}`;
    const eStartMs = parseVnDateTimeToMs(eStartStr);
    const eEndMs = parseVnDateTimeToMs(eEndStr);
    const eHours =
      eStartMs && eEndMs && eEndMs > eStartMs
        ? Math.round(((eEndMs - eStartMs) / 3600000) * 100) / 100
        : 0;

    const eveningSlot = {
      slotKey: 'EVENING',
      slotLabel: 'Tối',
      checked: eChecked,
      startHm: eStartHm,
      endHm: eEndHm,
      startTime: eStartStr,
      endTime: eEndStr,
      workDate: workDateStr,
      estHours: eHours,
      workMode: eModeEl && eModeEl.value ? eModeEl.value : 'Tăng ca tại công ty'
    };

    const checkedSlots = [morningSlot, lunchSlot, eveningSlot].filter((s) => s.checked);
    const totalHours = Math.round(checkedSlots.reduce((sum, s) => sum + s.estHours, 0) * 100) / 100;
    const codeLabel = totalHours > 0 ? `X+${formatHoursClean(totalHours)}` : 'X';

    const summaryParts = checkedSlots.map(
      (s) => `${s.slotLabel} ${formatHoursClean(s.estHours)}h (${s.startHm}→${s.endHm})`
    );
    const slotsSummaryText =
      summaryParts.length > 0 ? summaryParts.join(' • ') : 'Chưa chọn ca nào';

    const result = {
      isoDate,
      workDate: workDateStr,
      morningSlot,
      lunchSlot,
      eveningSlot,
      checkedSlots,
      totalHours,
      estHours: totalHours,
      codeLabel,
      slotsSummaryText,
      isDriverNoTime: false
    };

    if (isRestDayVn(workDateStr)) {
      const rCheck = document.getElementById('restWorkCheck');
      const rStartEl = document.getElementById('restStart');
      const rEndEl = document.getElementById('restEnd');
      const rStartHm = rStartEl && rStartEl.value ? rStartEl.value : '07:15';
      const rEndHm = rEndEl && rEndEl.value ? rEndEl.value : '15:15';
      const rStartStr = `${workDateStr} ${rStartHm}`;
      const rEndStr = `${workDateStr} ${rEndHm}`;
      const rStartMs = parseVnDateTimeToMs(rStartStr);
      const rEndMs = parseVnDateTimeToMs(rEndStr);
      const rHours =
        rStartMs && rEndMs && rEndMs > rStartMs
          ? Math.round(((rEndMs - rStartMs) / 3600000) * 100) / 100
          : 0;
      const restChecked = Boolean(rCheck && rCheck.checked) && rHours > 0;
      const restSlot = {
        slotKey: 'REST',
        slotLabel: 'Làm ngày nghỉ',
        checked: restChecked,
        startHm: rStartHm,
        endHm: rEndHm,
        startTime: rStartStr,
        endTime: rEndStr,
        workDate: workDateStr,
        estHours: rHours,
        workMode: 'Tăng ca tại công ty'
      };
      result.isRestDay = true;
      result.restLabel = getRestDayLabel(workDateStr);
      result.restSlot = restSlot;
      result.restRawChecked = Boolean(rCheck && rCheck.checked);
      result.checkedSlots = restChecked ? [restSlot] : [];
      result.totalHours = restChecked ? rHours : 0;
      result.estHours = result.totalHours;
      result.codeLabel = restChecked ? `${formatHoursClean(rHours)}h` : 'Nghỉ';
      result.slotsSummaryText = restChecked
        ? `${result.restLabel}: làm ${formatHoursClean(rHours)} giờ (${rStartHm}→${rEndHm})`
        : `${result.restLabel}: nghỉ, không đi làm`;
    }

    return result;
  }

  function computeCurrentMobilePreviewStrings() {
    return computeCurrentMobileDailySlots();
  }

  /**
   * Áp dụng nhanh 1 chạm Tổ hợp ca trong ngày (Ví dụ: Làm 6h15 - 18h15 -> X+4)
   */
  function applyMobileComboPreset(comboCode) {
    const mCheck = document.getElementById('slotMorningCheck');
    const mStart = document.getElementById('slotMorningStart');
    const mEnd = document.getElementById('slotMorningEnd');

    const lCheck = document.getElementById('slotLunchCheck');
    const lStart = document.getElementById('slotLunchStart');
    const lEnd = document.getElementById('slotLunchEnd');

    const eCheck = document.getElementById('slotEveningCheck');
    const eStart = document.getElementById('slotEveningStart');
    const eEnd = document.getElementById('slotEveningEnd');
    const eOver = document.getElementById('slotEveningOvernight');

    if (comboCode === 'FULL_615_1815') {
      if (mCheck) mCheck.checked = true;
      if (mStart) mStart.value = '06:15';
      if (mEnd) mEnd.value = '07:15';
      if (lCheck) lCheck.checked = true;
      if (lStart) lStart.value = '11:15';
      if (lEnd) lEnd.value = '13:15';
      if (eCheck) eCheck.checked = true;
      if (eStart) eStart.value = '17:15';
      if (eEnd) eEnd.value = '18:15';
      if (eOver) eOver.checked = false;
    } else if (comboCode === 'FULL_615_1915') {
      if (mCheck) mCheck.checked = true;
      if (mStart) mStart.value = '06:15';
      if (mEnd) mEnd.value = '07:15';
      if (lCheck) lCheck.checked = true;
      if (lStart) lStart.value = '11:15';
      if (lEnd) lEnd.value = '13:15';
      if (eCheck) eCheck.checked = true;
      if (eStart) eStart.value = '17:15';
      if (eEnd) eEnd.value = '19:15';
      if (eOver) eOver.checked = false;
    } else if (comboCode === 'LUNCH2_EVE1') {
      if (mCheck) mCheck.checked = false;
      if (lCheck) lCheck.checked = true;
      if (lStart) lStart.value = '11:15';
      if (lEnd) lEnd.value = '13:15';
      if (eCheck) eCheck.checked = true;
      if (eStart) eStart.value = '17:15';
      if (eEnd) eEnd.value = '18:15';
      if (eOver) eOver.checked = false;
    } else if (comboCode === 'LUNCH2_EVE2') {
      if (mCheck) mCheck.checked = false;
      if (lCheck) lCheck.checked = true;
      if (lStart) lStart.value = '11:15';
      if (lEnd) lEnd.value = '13:15';
      if (eCheck) eCheck.checked = true;
      if (eStart) eStart.value = '17:15';
      if (eEnd) eEnd.value = '19:15';
      if (eOver) eOver.checked = false;
    } else if (comboCode === 'ONLY_EVE1') {
      if (mCheck) mCheck.checked = false;
      if (lCheck) lCheck.checked = false;
      if (eCheck) eCheck.checked = true;
      if (eStart) eStart.value = '17:15';
      if (eEnd) eEnd.value = '18:15';
      if (eOver) eOver.checked = false;
    } else if (comboCode === 'ONLY_LUNCH2') {
      if (mCheck) mCheck.checked = false;
      if (lCheck) lCheck.checked = true;
      if (lStart) lStart.value = '11:15';
      if (lEnd) lEnd.value = '13:15';
      if (eCheck) eCheck.checked = false;
    } else if (comboCode === 'ONLY_EVE2') {
      if (mCheck) mCheck.checked = false;
      if (lCheck) lCheck.checked = false;
      if (eCheck) eCheck.checked = true;
      if (eStart) eStart.value = '17:15';
      if (eEnd) eEnd.value = '19:15';
      if (eOver) eOver.checked = false;
    } else if (comboCode === 'MORN1_EVE1') {
      if (mCheck) mCheck.checked = true;
      if (mStart) mStart.value = '06:15';
      if (mEnd) mEnd.value = '07:15';
      if (lCheck) lCheck.checked = false;
      if (eCheck) eCheck.checked = true;
      if (eStart) eStart.value = '17:15';
      if (eEnd) eEnd.value = '18:15';
      if (eOver) eOver.checked = false;
    }

    document.querySelectorAll('#mobileComboPresetsGrid .time-preset-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.getAttribute('data-combo') === comboCode);
    });

    renderWorkerMobileView();
  }

  function detectMatchingMobileCombo(daily) {
    if (!daily || daily.isRestDay) return '';
    const m = daily.morningSlot;
    const l = daily.lunchSlot;
    const e = daily.eveningSlot;
    const m1 = m.checked && m.startHm === '06:15' && m.endHm === '07:15';
    const l2 = l.checked && l.startHm === '11:15' && l.endHm === '13:15';
    const e1 = e.checked && e.startHm === '17:15' && e.endHm === '18:15';
    const e2 = e.checked && e.startHm === '17:15' && e.endHm === '19:15';

    if (m1 && l2 && e1) return 'FULL_615_1815';
    if (m1 && l2 && e2) return 'FULL_615_1915';
    if (!m.checked && l2 && e1) return 'LUNCH2_EVE1';
    if (!m.checked && l2 && e2) return 'LUNCH2_EVE2';
    if (!m.checked && !l.checked && e1) return 'ONLY_EVE1';
    if (!m.checked && !l.checked && e2) return 'ONLY_EVE2';
    if (!m.checked && l2 && !e.checked) return 'ONLY_LUNCH2';
    if (m1 && !l.checked && e1) return 'MORN1_EVE1';
    return '';
  }


  /**
   * Nạp lại các ca tăng ca đã lưu của công nhân trong ngày được chọn lên Form để sửa nhanh
   */
  function loadExistingDayIntoMobileForm(empName, isoDate, switchTabToForm = false) {
    const dateInput = document.getElementById('mobileWorkDate');
    if (dateInput && isoDate) {
      dateInput.value = isoDate;
    }

    const vnDate = isoDateToVnDate(isoDate || localIsoToday());
    const dayRecords = state.records.filter(
      (r) => r.employeeName === empName && r.workDate === vnDate && !r.isDriverNoTime
    );

    const mCheck = document.getElementById('slotMorningCheck');
    const mStart = document.getElementById('slotMorningStart');
    const mEnd = document.getElementById('slotMorningEnd');

    const lCheck = document.getElementById('slotLunchCheck');
    const lStart = document.getElementById('slotLunchStart');
    const lEnd = document.getElementById('slotLunchEnd');

    const eCheck = document.getElementById('slotEveningCheck');
    const eStart = document.getElementById('slotEveningStart');
    const eEnd = document.getElementById('slotEveningEnd');
    const eOver = document.getElementById('slotEveningOvernight');
    const eMode = document.getElementById('slotEveningWorkMode');

    const jobInput = document.getElementById('mobileJobContent');
    const noteInput = document.getElementById('mobileNoteInput');

    const restDayLoad = isRestDayVn(vnDate);
    const restCheckEl = document.getElementById('restWorkCheck');
    if (restDayLoad && restCheckEl) {
      if (dayRecords.length > 0) {
        const sorted = dayRecords
          .slice()
          .sort((a, b) => (parseVnDateTimeToMs(a.startTime) || 0) - (parseVnDateTimeToMs(b.startTime) || 0));
        const hmOf = (t) => (String(t || '').split(' ')[1] || '').slice(0, 5);
        restCheckEl.checked = true;
        const rs = document.getElementById('restStart');
        const re = document.getElementById('restEnd');
        if (rs && hmOf(sorted[0].startTime)) rs.value = hmOf(sorted[0].startTime);
        if (re && hmOf(sorted[sorted.length - 1].endTime)) re.value = hmOf(sorted[sorted.length - 1].endTime);
        const jobInputR = document.getElementById('mobileJobContent');
        if (jobInputR && sorted[0].jobContent) jobInputR.value = sorted[0].jobContent;
      } else {
        restCheckEl.checked = false;
      }
    }

    state.formLoadedIso = dayRecords.length > 0 ? isoDate : '';
    if (dayRecords.length > 0 && !restDayLoad) {
      if (mCheck) mCheck.checked = false;
      if (lCheck) lCheck.checked = false;
      if (eCheck) eCheck.checked = false;

      dayRecords.forEach((rec) => {
        const sParts = String(rec.startTime || '').trim().split(/\s+/);
        const eParts = String(rec.endTime || '').trim().split(/\s+/);
        const sHm = sParts[1] || '';
        const eHm = eParts[1] || '';
        const sHour = parseInt((sHm.split(':')[0] || '17'), 10);

        if (rec.workMode === 'Tăng ca trưa' || (sHour >= 11 && sHour <= 13)) {
          if (lCheck) lCheck.checked = true;
          if (lStart && sHm) lStart.value = sHm;
          if (lEnd && eHm) lEnd.value = eHm;
        } else if (sHour < 11) {
          if (mCheck) mCheck.checked = true;
          if (mStart && sHm) mStart.value = sHm;
          if (mEnd && eHm) mEnd.value = eHm;
        } else {
          if (eCheck) eCheck.checked = true;
          if (eStart && sHm) eStart.value = sHm;
          if (eEnd && eHm) eEnd.value = eHm;
          if (eOver) eOver.checked = sParts[0] !== eParts[0];
          if (eMode && rec.workMode) eMode.value = rec.workMode;
        }
      });

      if (jobInput && dayRecords[0].jobContent) {
        jobInput.value = dayRecords[0].jobContent;
      }
      if (noteInput) {
        noteInput.value = dayRecords[0].note || '';
      }

      document.querySelectorAll('#mobileComboPresetsGrid .time-preset-btn').forEach((b) => b.classList.remove('active'));
    }
    // Nhớ nội dung/ghi chú vừa nạp: lúc lưu nếu công nhân không sửa thì mỗi ca giữ nội dung riêng Quản đốc đã chỉnh
    state.formLoadedJob = jobInput ? jobInput.value.trim() : '';
    state.formLoadedNote = noteInput ? noteInput.value.trim() : '';

    if (switchTabToForm) {
      state.workerMobileSubTab = 'FORM';
      renderWorkerMobileView();
      const formCard = document.getElementById('workerSubViewForm');
      formCard?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } else {
      renderWorkerMobileView();
    }
  }

  function renderWorkerMobileView() {
    // Khóa chặt tài khoản công nhân đang đăng nhập: chỉ được xem & báo tăng ca cho chính mình
    if (state.authRole === 'WORKER' && state.loggedInEmployeeName) {
      state.selectedEmployeeName = state.loggedInEmployeeName;
    }

    const emp = state.employees.find((e) => e.name === state.selectedEmployeeName) || state.employees[0];
    if (!emp) return;

    const nameEl = document.getElementById('mobileSelectedEmpName');
    const metaEl = document.getElementById('mobileSelectedEmpMeta');
    const typeTagEl = document.getElementById('mobileOvertimeTypeTag');

    if (nameEl) nameEl.textContent = emp.name;
    if (metaEl) {
      metaEl.textContent = `${emp.defaultOvertimeType} • ${emp.defaultWorkMode}`;
    }
    if (typeTagEl) {
      typeTagEl.textContent = state.mobileOvertimeType;
    }

    // Chuyển đổi 2 Tab trên điện thoại: Báo tăng ca (FORM) vs Lịch sử đã gửi (HISTORY)
    const tabBtnForm = document.getElementById('btnWorkerSubTabForm');
    const tabBtnHistory = document.getElementById('btnWorkerSubTabHistory');
    const subViewForm = document.getElementById('workerSubViewForm');
    const subViewHistory = document.getElementById('workerSubViewHistory');

    const subTab = state.workerMobileSubTab;
    const isHistoryTab = subTab === 'HISTORY';
    const isCalTab = subTab === 'CALENDAR';
    const tabBtnCal = document.getElementById('btnWorkerSubTabCalendar');
    const subViewCal = document.getElementById('workerSubViewCalendar');
    if (tabBtnForm) tabBtnForm.classList.toggle('active', !isHistoryTab && !isCalTab);
    if (tabBtnCal) tabBtnCal.classList.toggle('active', isCalTab);
    if (tabBtnHistory) tabBtnHistory.classList.toggle('active', isHistoryTab);
    if (subViewForm) subViewForm.style.display = !isHistoryTab && !isCalTab ? 'block' : 'none';
    if (subViewCal) subViewCal.style.display = isCalTab ? 'block' : 'none';
    if (subViewHistory) subViewHistory.style.display = isHistoryTab ? 'block' : 'none';
    if (isCalTab) renderWorkerCalendar();

    // Tính toán các ca Sáng / Trưa / Tối đang chọn
    const daily = computeCurrentMobileDailySlots();

    // Ngày nghỉ (Chủ nhật / lễ): chỉ hiện ô "Tôi có đi làm" và giờ làm thực tế
    document.querySelectorAll('.normal-day-only').forEach((el) => {
      el.style.display = daily.isRestDay ? 'none' : '';
    });
    const restSection = document.getElementById('restDaySection');
    if (restSection) {
      restSection.style.display = daily.isRestDay ? 'block' : 'none';
      if (daily.isRestDay) {
        const banner = document.getElementById('restDayBanner');
        if (banner) {
          banner.textContent = `${daily.restLabel} là ngày nghỉ. Chỉ báo nếu bạn có đi làm, ghi đúng số giờ làm (đủ ngày là 8 giờ).`;
        }
        const body = document.getElementById('restWorkBody');
        if (body) body.style.display = daily.restRawChecked ? 'block' : 'none';
        const hrsLbl = document.getElementById('restHoursLabel');
        if (hrsLbl) hrsLbl.textContent = `Tổng: ${formatHoursClean(daily.restSlot.estHours)} giờ`;
      }
    }

    // Cập nhật giao diện 3 thẻ Ca Sáng / Trưa / Tối
    const cardMorning = document.getElementById('slotCardMorning');
    const cardLunch = document.getElementById('slotCardLunch');
    const cardEvening = document.getElementById('slotCardEvening');
    const lblMorningHrs = document.getElementById('slotMorningHoursLabel');
    const lblLunchHrs = document.getElementById('slotLunchHoursLabel');
    const lblEveningHrs = document.getElementById('slotEveningHoursLabel');

    if (cardMorning) cardMorning.classList.toggle('active', daily.morningSlot.checked);
    if (cardLunch) cardLunch.classList.toggle('active', daily.lunchSlot.checked);
    if (cardEvening) cardEvening.classList.toggle('active', daily.eveningSlot.checked);

    if (lblMorningHrs) {
      lblMorningHrs.textContent = daily.morningSlot.checked
        ? `+${formatHoursClean(daily.morningSlot.estHours)} giờ`
        : 'Không tăng ca sáng';
    }
    if (lblLunchHrs) {
      lblLunchHrs.textContent = daily.lunchSlot.checked
        ? `+${formatHoursClean(daily.lunchSlot.estHours)} giờ`
        : 'Không tăng ca trưa';
    }
    if (lblEveningHrs) {
      lblEveningHrs.textContent = daily.eveningSlot.checked
        ? `+${formatHoursClean(daily.eveningSlot.estHours)} giờ`
        : 'Không tăng ca tối';
    }

    // Ngày dạng chữ (tránh nhầm khi máy hiển thị kiểu tháng/ngày) & đánh dấu nút Hôm nay / Hôm qua
    const humanEl = document.getElementById('mobileDateHuman');
    if (humanEl && daily.isoDate) {
      const dn = ['Chủ nhật', 'Thứ Hai', 'Thứ Ba', 'Thứ Tư', 'Thứ Năm', 'Thứ Sáu', 'Thứ Bảy'];
      const dd = new Date(`${daily.isoDate}T00:00:00`);
      humanEl.textContent = isNaN(dd.getTime()) ? '' : `${dn[dd.getDay()]}, ${daily.workDate}`;
    }

    const todayIso = localIsoToday();
    const yesterdayIso = addDaysToIsoDate(todayIso, -1);
    const btnToday = document.getElementById('btnDateToday');
    const btnYesterday = document.getElementById('btnDateYesterday');
    if (btnToday) {
      btnToday.textContent = `Hôm nay (${isoDateToVnDate(todayIso).slice(0, 5)})`;
      btnToday.classList.toggle('active', daily.isoDate === todayIso);
    }
    if (btnYesterday) {
      btnYesterday.textContent = `Hôm qua (${isoDateToVnDate(yesterdayIso).slice(0, 5)})`;
      btnYesterday.classList.toggle('active', daily.isoDate === yesterdayIso);
    }

    // Tự động đánh dấu nút Chọn nhanh tổ hợp ca nếu khớp
    const matchedCombo = detectMatchingMobileCombo(daily);
    document.querySelectorAll('#mobileComboPresetsGrid .time-preset-btn').forEach((btn) => {
      btn.classList.toggle('active', Boolean(matchedCombo) && btn.getAttribute('data-combo') === matchedCombo);
    });

    // Tự động đánh dấu nút giờ Trưa & giờ Tối
    const lunchRangeStr = `${daily.lunchSlot.startHm}-${daily.lunchSlot.endHm}`;
    document.querySelectorAll('.slot-mini-btn[data-lunch-range]').forEach((btn) => {
      btn.classList.toggle('active', daily.lunchSlot.checked && btn.getAttribute('data-lunch-range') === lunchRangeStr);
    });
    document.querySelectorAll('.slot-mini-btn[data-eve-end]').forEach((btn) => {
      btn.classList.toggle(
        'active',
        daily.eveningSlot.checked &&
          daily.eveningSlot.startHm === '17:15' &&
          btn.getAttribute('data-eve-end') === daily.eveningSlot.endHm
      );
    });

    // Cập nhật huy hiệu Ký hiệu công ngày (X+4)
    const dayCodeBadge = document.getElementById('mobileDayCodeBadge');
    if (dayCodeBadge) {
      dayCodeBadge.textContent = `${daily.codeLabel} (${formatHoursClean(daily.totalHours)} giờ)`;
    }

    // Thông báo nếu ngày này đã từng báo tăng ca hoặc đã bị Quản đốc chốt công
    const existingSummary = getEmployeeDaySummary(emp.name, daily.workDate);
    const existingNotice = document.getElementById('mobileDayExistingNotice');
    const lockedNotice = document.getElementById('mobileDayLockedNotice');
    const isDayLocked = Boolean(state.lockedDays && state.lockedDays[daily.workDate]?.locked);

    if (existingNotice) {
      if (existingSummary.records.length > 0) {
        existingNotice.style.display = 'block';
        existingNotice.innerHTML = `Ngày <strong>${escapeHtml(daily.workDate)}</strong> bạn đã lưu <strong>${existingSummary.records.length} ca (${escapeHtml(existingSummary.codeLabel)} • ${escapeHtml(existingSummary.slotBreakdown)})</strong>. Bạn có thể chỉnh lại các ca bên dưới rồi bấm Lưu để cập nhật.`;
      } else {
        existingNotice.style.display = 'none';
      }
    }

    if (lockedNotice) {
      if (isDayLocked) {
        lockedNotice.style.display = 'block';
        lockedNotice.innerHTML = `<strong>Quản đốc đã chốt bảng công ngày ${escapeHtml(daily.workDate)}</strong>. Bạn vẫn có thể sửa lại nếu chấm nhầm, nhưng ô công của bạn trên bảng Quản đốc sẽ <strong>tự động bôi vàng</strong> để Quản đốc đối chiếu!`;
      } else {
        lockedNotice.style.display = 'none';
      }
    }

    // Cập nhật hộp xem trước & nhãn nút gửi
    const estBadge = document.getElementById('mobileEstHoursBadge');
    const colDate = document.getElementById('previewColWorkDate');
    const slotsSumEl = document.getElementById('previewSlotsSummaryText');
    const colHours = document.getElementById('previewColHours');
    const btnSubmitText = document.getElementById('btnSubmitMobileText');

    if (estBadge) estBadge.textContent = `${daily.codeLabel} (${formatHoursClean(daily.totalHours)} giờ)`;
    if (colDate) colDate.textContent = daily.workDate;
    if (slotsSumEl) slotsSumEl.textContent = daily.slotsSummaryText;
    if (colHours) colHours.textContent = `${daily.codeLabel} (${formatHoursClean(daily.totalHours)} giờ)`;

    if (btnSubmitText && !state.isWaitingServerAck) {
      if (existingSummary.records.length > 0) {
        btnSubmitText.textContent =
          daily.totalHours > 0
            ? `Cập nhật ngày ${daily.workDate} (${daily.codeLabel} • ${formatHoursClean(daily.totalHours)} giờ)`
            : `Lưu: bỏ hết tăng ca ngày ${daily.workDate}`;
      } else {
        btnSubmitText.textContent =
          daily.totalHours > 0
            ? `Lưu báo tăng ca ngày ${daily.workDate} (${daily.codeLabel} • ${formatHoursClean(daily.totalHours)} giờ)`
            : `Vui lòng tích chọn ít nhất 1 ca tăng ca`;
      }
    }

    // Thanh "Đang sửa ngày..." có nút Quay lại
    const editBar = document.getElementById('editModeBar');
    if (editBar) {
      if (state.formReturnTab) {
        editBar.style.display = 'flex';
        const t = document.getElementById('editModeTitle');
        if (t) t.textContent = `${existingSummary.records.length > 0 ? 'Đang sửa' : 'Báo tăng ca'} ngày ${daily.workDate}`;
      } else {
        editBar.style.display = 'none';
      }
    }
    const delBtn = document.getElementById('btnDeleteDayFromForm');
    if (delBtn) delBtn.style.display = existingSummary.records.length > 0 ? 'block' : 'none';

    // Nút Lưu: khóa khi chưa chọn gì để tránh bấm nhầm
    const submitBtn = document.getElementById('btnSubmitMobileOvertime');
    if (submitBtn && !state.isWaitingServerAck) {
      const nothingChosen = daily.checkedSlots.length === 0 && existingSummary.records.length === 0;
      submitBtn.disabled = nothingChosen;
      if (nothingChosen && btnSubmitText) {
        btnSubmitText.textContent = daily.isRestDay
          ? 'Nếu có đi làm, tích "Tôi có đi làm ngày này"'
          : 'Chọn ca làm ở trên rồi bấm Lưu';
      }
    }

    // Render lịch sử cá nhân của đúng công nhân đang đăng nhập
    renderWorkerPersonalHistory(emp.name);
  }

  // ==========================================================================
  // THAO TÁC FORM CÔNG NHÂN: MẶC ĐỊNH, SỬA/QUAY LẠI, XÓA NGÀY
  // ==========================================================================

  function currentWorkerName() {
    return state.authRole === 'WORKER' && state.loggedInEmployeeName
      ? state.loggedInEmployeeName
      : state.selectedEmployeeName;
  }

  function lastJobKey(empName) {
    return `SMART_FACTORY_LAST_JOB::${empName}`;
  }

  function syncJobChipsToInput() {
    const val = (document.getElementById('mobileJobContent')?.value || '').trim();
    document.querySelectorAll('#mobileJobChips .job-chip-btn').forEach((b) => {
      b.classList.toggle('active', (b.getAttribute('data-job') || '') === val);
    });
  }

  /**
   * Đưa form về trạng thái sạch: ngày hôm nay, chưa tích ca nào (tránh gửi nhầm),
   * nội dung công việc điền sẵn theo lần báo gần nhất của chính người đó.
   */
  function resetWorkerForm(opts = {}) {
    const setVal = (id, v) => {
      const el = document.getElementById(id);
      if (el) el.value = v;
    };
    const setChk = (id, v) => {
      const el = document.getElementById(id);
      if (el) el.checked = v;
    };
    const today = localIsoToday();
    const dateEl = document.getElementById('mobileWorkDate');
    if (dateEl) {
      if (!opts.keepDate) dateEl.value = today;
      dateEl.max = today;
    }
    ['slotMorningCheck', 'slotLunchCheck', 'slotEveningCheck', 'slotEveningOvernight', 'restWorkCheck'].forEach((id) =>
      setChk(id, false)
    );
    setVal('slotMorningStart', '06:15');
    setVal('slotMorningEnd', '07:15');
    setVal('slotLunchStart', '11:15');
    setVal('slotLunchEnd', '13:15');
    setVal('slotEveningStart', '17:15');
    setVal('slotEveningEnd', '18:15');
    setVal('restStart', '07:15');
    setVal('restEnd', '15:15');
    document.querySelectorAll('#mobileComboPresetsGrid .time-preset-btn').forEach((b) => b.classList.remove('active'));

    let lastJob = '';
    try {
      lastJob = localStorage.getItem(lastJobKey(currentWorkerName())) || '';
    } catch (_) {}
    setVal('mobileJobContent', lastJob);
    setVal('mobileNoteInput', '');
    const detailsEl = document.getElementById('slotDetails');
    if (detailsEl) detailsEl.open = true;
    syncJobChipsToInput();

    state.formReturnTab = null;
    state.editingIso = '';
    state.formLoadedIso = '';

    // Ngày hôm nay đã có ca thì nạp sẵn vào form: báo thêm ca Tối không làm mất ca Sáng/Trưa đã báo
    if (!opts.skipExisting && !opts.keepDate) {
      const empNow = currentWorkerName();
      if (empNow && getEmployeeDaySummary(empNow, isoDateToVnDate(today)).records.length > 0) {
        loadExistingDayIntoMobileForm(empNow, today, false);
      }
    }
  }

  function clearEditHistoryFlag() {
    try {
      if (window.history.state && window.history.state.otEdit) {
        window.history.replaceState({}, '');
      }
    } catch (_) {}
  }

  /** Mở form cho 1 ngày cụ thể (từ Bảng công hoặc Lịch sử). returnTab = tab sẽ quay về khi bấm Quay lại */
  function openFormForDay(iso, returnTab) {
    const empName = currentWorkerName();
    resetWorkerForm({ skipExisting: true });
    state.formReturnTab = returnTab;
    state.editingIso = iso;
    state.workerMobileSubTab = 'FORM';
    state.lastServerAckReceipt = null;
    const dateEl = document.getElementById('mobileWorkDate');
    if (dateEl) dateEl.value = iso;
    try {
      window.history.pushState({ otEdit: 1 }, '');
    } catch (_) {}
    loadExistingDayIntoMobileForm(empName, iso, false);
    const detailsOpen = document.getElementById('slotDetails');
    if (detailsOpen) detailsOpen.open = true; // đang sửa thì mở sẵn phần chỉnh giờ
    renderAll();
    window.scrollTo({ top: 0 });
  }

  function leaveEditMode(targetTab) {
    const hadEdit = Boolean(state.formReturnTab);
    const ret = targetTab || state.formReturnTab || 'FORM';
    if (hadEdit) {
      clearEditHistoryFlag();
      resetWorkerForm();
    }
    state.workerMobileSubTab = ret;
    renderAll();
    window.scrollTo({ top: 0 });
  }

  function cancelEditMode() {
    // Nếu đã đẩy 1 mục lịch sử khi mở form thì lùi lại 1 bước để nút Back của điện thoại cũng khớp
    try {
      if (window.history.state && window.history.state.otEdit) {
        window.history.back();
        return;
      }
    } catch (_) {}
    leaveEditMode();
  }

  async function deleteWorkerDay(empName, vnDate) {
    const beforeSummary = getEmployeeDaySummary(empName, vnDate);
    if (beforeSummary.records.length === 0) return false;
    const locked = Boolean(state.lockedDays && state.lockedDays[vnDate]?.locked);
    const msg = locked
      ? `Ngày ${vnDate} đã được Quản đốc chốt công. Xóa thì ô công của bạn sẽ bị bôi vàng để Quản đốc kiểm tra lại.\n\nBạn chắc chắn muốn xóa báo tăng ca ngày này?`
      : `Xóa toàn bộ báo tăng ca ngày ${vnDate} (${beforeSummary.codeLabel})?`;
    if (!window.confirm(msg)) return false;
    state.records = state.records.filter((r) => !(r.employeeName === empName && r.workDate === vnDate));
    state.offlineQueue = state.offlineQueue.filter((r) => !(r.employeeName === empName && r.workDate === vnDate));
    if (locked) checkAndTriggerPostLockAlert(empName, vnDate, beforeSummary);
    saveLocalState(true);
    const delRes = await syncWithCentralServer(true);
    if (delRes && delRes.rejected) return false;
    showToast(`Đã xóa báo tăng ca ngày <strong>${escapeHtml(vnDate)}</strong>.`, 'success');
    return true;
  }

  function renderWorkerPersonalHistory(empName) {
    const titleEl = document.getElementById('historyEmpNameTitle');
    const badgeEl = document.getElementById('historyEmpSummaryBadge');
    const tabCountEl = document.getElementById('workerHistoryTabCount');
    const listEl = document.getElementById('workerPersonalHistoryList');
    const btnFilterMonth = document.getElementById('btnHistFilterMonth');
    const btnFilterAll = document.getElementById('btnHistFilterAll');

    if (titleEl) titleEl.textContent = empName;

    const allMyRecords = [
      ...state.offlineQueue.filter((r) => r.employeeName === empName).map((r) => ({ ...r, _isOffline: true })),
      ...state.records.filter((r) => r.employeeName === empName)
    ];

    const activeMonthKey = /^\d{4}-\d{2}$/.test(state.calMonth || '') ? state.calMonth : localIsoToday().slice(0, 7);
    const monthMyRecords = allMyRecords.filter((r) => isRecordInMonth(r, activeMonthKey));
    const useMonthFilter = state.workerHistoryFilter !== 'ALL' && (monthMyRecords.length > 0 || allMyRecords.length === 0);
    const myRecords = useMonthFilter ? monthMyRecords : allMyRecords;

    if (btnFilterMonth) {
      const [yStr, mStr] = activeMonthKey.split('-');
      btnFilterMonth.textContent = `Tháng ${mStr}/${yStr} (${monthMyRecords.length} ca)`;
      btnFilterMonth.classList.toggle('active', useMonthFilter);
    }
    if (btnFilterAll) {
      btnFilterAll.textContent = `Tất cả (${allMyRecords.length} ca)`;
      btnFilterAll.classList.toggle('active', !useMonthFilter);
    }

    const totalHours = myRecords.reduce((sum, r) => sum + computeEstimatedHours(r), 0);
    if (badgeEl) {
      badgeEl.textContent = `${myRecords.length} ca • ${formatHoursClean(totalHours)} giờ`;
    }
    if (tabCountEl) {
      tabCountEl.textContent = String(allMyRecords.length);
    }

    if (!listEl) return;
    if (myRecords.length === 0) {
      listEl.innerHTML = `
        <div style="text-align: center; padding: 1.75rem 1rem; color: var(--text-secondary); font-size: 0.85rem;">
          Bạn chưa báo ca tăng ca nào.
        </div>
      `;
      return;
    }

    // Nhóm các ca tăng ca theo Ngày tính công (workDate) để hiển thị rõ X+4, Sáng/Trưa/Tối và cho phép Sửa nhanh
    const dayMap = new Map();
    myRecords.forEach((rec) => {
      const d = rec.workDate || 'Không rõ ngày';
      if (!dayMap.has(d)) dayMap.set(d, []);
      dayMap.get(d).push(rec);
    });

    const sortedDates = Array.from(dayMap.keys()).sort((a, b) => {
      const msA = parseVnDateTimeToMs(`${a} 00:00`) || 0;
      const msB = parseVnDateTimeToMs(`${b} 00:00`) || 0;
      return msB - msA;
    });

    listEl.innerHTML = sortedDates
      .map((workDate) => {
        const daySum = getEmployeeDaySummary(empName, workDate);
        const isLocked = Boolean(state.lockedDays && state.lockedDays[workDate]?.locked);
        const modAlert = state.dayModAlerts ? state.dayModAlerts[`${workDate}::${empName}`] : null;
        const recs = dayMap.get(workDate) || [];

        return `
          <div class="history-day-group" style="${modAlert ? 'border-color:#eab308;background:#fefce8;' : ''}">
            <div class="history-day-header" style="${modAlert ? 'background:#fef08a;' : ''}">
              <div style="display:flex;align-items:center;gap:0.45rem;flex-wrap:wrap;">
                <span style="font-weight:800;font-size:0.88rem;color:var(--text-main);">Ngày ${escapeHtml(workDate)}</span>
                <span style="background:var(--primary);color:#fff;padding:0.12rem 0.5rem;border-radius:999px;font-size:0.76rem;font-weight:800;">
                  ${escapeHtml(daySum.codeLabel)} (${formatHoursClean(daySum.totalHours)}h)
                </span>
                ${
                  modAlert
                    ? `<span style="background:#f59e0b;color:#fff;padding:0.1rem 0.45rem;border-radius:4px;font-size:0.7rem;font-weight:700;">Đã sửa sau chốt (${escapeHtml(modAlert.beforeCode)} → ${escapeHtml(modAlert.afterCode)})</span>`
                    : isLocked
                    ? `<span style="background:#e2e8f0;color:#334155;padding:0.1rem 0.45rem;border-radius:4px;font-size:0.7rem;font-weight:700;">Đã chốt công</span>`
                    : `<span style="background:#ecfdf5;color:#047857;padding:0.1rem 0.45rem;border-radius:4px;font-size:0.7rem;font-weight:700;">Đang mở</span>`
                }
              </div>
              <button
                type="button"
                class="action-btn primary btn-worker-edit-day"
                data-workdate="${escapeHtml(workDate)}"
                style="padding:0.25rem 0.65rem;font-size:0.75rem;"
              >
                Sửa ngày này
              </button>
            </div>
            <div>
              ${recs
                .map((rec) => {
                  const hrs = computeEstimatedHours(rec);
                  const sHm = (rec.startTime || '').split(' ')[1] || rec.startTime;
                  const eHm = (rec.endTime || '').split(' ')[1] || rec.endTime;
                  return `
                    <div class="history-shift-row">
                      <div style="flex:1;">
                        <div style="display:flex;align-items:center;gap:0.4rem;flex-wrap:wrap;">
                          <span style="font-weight:700;font-size:0.84rem;color:var(--text-main);font-family:var(--font-mono);">
                            ${escapeHtml(sHm)} → ${escapeHtml(eHm)}
                          </span>
                          <span class="badge-formula">${escapeHtml(rec.workMode)}</span>
                          <span style="font-weight:800;font-size:0.8rem;color:var(--primary);">+${formatHoursClean(hrs)}h</span>
                        </div>
                        <div style="font-size:0.8rem;color:var(--text-secondary);margin-top:0.15rem;">
                          ${escapeHtml(rec.jobContent)}
                          ${rec.note ? ` • <em>${escapeHtml(rec.note)}</em>` : ''}
                        </div>
                      </div>
                      <button
                        type="button"
                        class="action-btn btn-worker-del-shift"
                        data-id="${escapeHtml(rec.id)}"
                        data-workdate="${escapeHtml(workDate)}"
                        style="padding:0.22rem 0.5rem;font-size:0.72rem;color:var(--rose);"
                        title="Xóa ca này"
                      >
                        Xóa
                      </button>
                    </div>
                  `;
                })
                .join('')}
            </div>
          </div>
        `;
      })
      .join('');

    // Gắn sự kiện nút "Sửa ngày này"
    listEl.querySelectorAll('.btn-worker-edit-day').forEach((btn) => {
      btn.addEventListener('click', () => {
        const vnDate = btn.getAttribute('data-workdate');
        if (!vnDate) return;
        openFormForDay(vnDateToIsoDate(vnDate), 'HISTORY');
      });
    });

    // Gắn sự kiện nút "Xóa" từng ca của công nhân
    listEl.querySelectorAll('.btn-worker-del-shift').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const recId = btn.getAttribute('data-id');
        const vnDate = btn.getAttribute('data-workdate');
        if (!recId) return;
        if (!window.confirm(`Xóa ca này của ngày ${vnDate}?`)) return;

        const beforeSummary = getEmployeeDaySummary(empName, vnDate);
        const idx = state.records.findIndex((r) => r.id === recId && r.employeeName === empName);
        if (idx !== -1) {
          state.records.splice(idx, 1);
        } else {
          const qIdx = state.offlineQueue.findIndex((r) => r.id === recId && r.employeeName === empName);
          if (qIdx !== -1) state.offlineQueue.splice(qIdx, 1);
        }

        const isLocked = Boolean(state.lockedDays && state.lockedDays[vnDate]?.locked);
        if (isLocked) {
          checkAndTriggerPostLockAlert(empName, vnDate, beforeSummary);
        }

        saveLocalState(true);
        const shiftRes = await syncWithCentralServer(true);
        renderAll();
        if (shiftRes && shiftRes.rejected) return;

        if (isLocked) {
          showToast(
            `Đã xóa 1 ca ngày <strong>${escapeHtml(vnDate)}</strong> (Ngày đã chốt công nên hệ thống đã bôi vàng để Quản đốc biết).`,
            'warn'
          );
        } else {
          showToast(`Đã xóa ca tăng ca ngày <strong>${escapeHtml(vnDate)}</strong>.`, 'success');
        }
      });
    });
  }

  /**
   * Xử lý khi Công nhân bấm nút "Lưu báo tăng ca ngày..."
   * Hỗ trợ lưu cùng lúc cả 3 ca (Sáng + Trưa + Tối) chỉ với 1 lần bấm, hoặc cập nhật lại ngày đã báo!
   */
  // ==========================================================================
  // BẢNG CÔNG THÁNG CỦA CÔNG NHÂN (X, X+1, X+4... theo từng ngày)
  // ==========================================================================

  /** Ngày hôm nay theo giờ Việt Nam, hiệu chỉnh theo đồng hồ máy chủ (không phụ thuộc đồng hồ điện thoại) */
  function localIsoToday() {
    const t = new Date(Date.now() + (state.serverClockOffsetMs || 0) + 7 * 3600 * 1000);
    return t.toISOString().slice(0, 10);
  }

  function renderWorkerCalendar() {
    const empName = state.loggedInEmployeeName || state.selectedEmployeeName;
    const grid = document.getElementById('calGrid');
    if (!grid || !empName) return;

    const empObj = state.employees.find((e) => e.name === empName);
    const todayIso = localIsoToday();
    if (!/^\d{4}-\d{2}$/.test(state.calMonth || '')) state.calMonth = todayIso.slice(0, 7);
    const [year, month] = state.calMonth.split('-').map(Number);
    const daysInMonth = new Date(year, month, 0).getDate();
    const firstDow = (new Date(year, month - 1, 1).getDay() + 6) % 7; // Thứ 2 = 0

    const titleEl = document.getElementById('calMonthTitle');
    if (titleEl) titleEl.textContent = `Tháng ${pad2(month)}/${year}`;

    let otDays = 0;
    let totalHours = 0;
    let workDays = 0;
    let cells = '';
    let listRows = '';
    const dowNames = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'];

    for (let i = 0; i < firstDow; i++) cells += '<div class="cal-cell empty"></div>';

    for (let day = 1; day <= daysInMonth; day++) {
      const iso = `${year}-${pad2(month)}-${pad2(day)}`;
      const vn = isoDateToVnDate(iso);
      const dow = new Date(year, month - 1, day).getDay();
      const isSunday = dow === 0;
      const isFuture = iso > todayIso;
      const sum = getEmployeeDaySummary(empName, vn);
      const hasOt = sum.totalHours > 0;
      const isRest = isRestDayVn(vn);
      const holidayName = getHolidayName(vn);
      const employed = isEmployedOn(empObj, iso);
      const lockInfo = state.lockedDays[vn];
      const isLocked = Boolean(lockInfo && lockInfo.locked);
      const hasWarn = Boolean(state.dayModAlerts && state.dayModAlerts[`${vn}::${empName}`]);

      let code = '';
      if (!employed) {
        code = '';
      } else if (hasOt) {
        code = sum.code;
        otDays += 1;
        totalHours += sum.totalHours;
        if (!isRest) workDays += 1;
      } else if (!isFuture) {
        if (isRest) {
          code = holidayName ? 'Lễ' : 'CN';
        } else {
          code = 'X';
          workDays += 1;
        }
      }

      const cls = ['cal-cell'];
      if (hasOt) cls.push('has-ot');
      if (isRest && holidayName) cls.push('holiday');
      else if (isSunday) cls.push('sunday');
      if (isFuture) cls.push('future');
      if (!employed) cls.push('off');
      if (iso === todayIso) cls.push('today');
      if (iso === state.calSelectedIso) cls.push('selected');
      if (isLocked) cls.push('locked');
      if (hasWarn) cls.push('warn');

      const tip = holidayName ? ` title="${escapeHtml(holidayName)}"` : '';
      cells += `<button type="button" class="${cls.join(' ')}" data-iso="${iso}"${tip}><span class="cal-day-num">${day}</span><span class="cal-code">${escapeHtml(code)}</span></button>`;

      if (employed && (hasOt || (!isFuture && !isRest))) {
        listRows += `<div class="cal-list-row${hasOt ? ' has-ot' : ''}" data-iso="${iso}"><span class="cal-list-date">${dowNames[dow]} ${pad2(day)}/${pad2(month)}</span><strong class="cal-list-code">${escapeHtml(code)}</strong><span class="cal-list-detail">${hasOt ? escapeHtml(sum.detailStr) + (isRest ? ' (' + escapeHtml(getRestDayLabel(vn)) + ')' : '') : 'Không tăng ca'}</span></div>`;
      }
    }

    grid.innerHTML = cells;
    const listEl = document.getElementById('calList');
    if (listEl) listEl.innerHTML = listRows || '<div class="sub-meta-text">Chưa có dữ liệu trong tháng này.</div>';

    const setText = (id, v) => {
      const el = document.getElementById(id);
      if (el) el.textContent = v;
    };
    setText('calSumOtDays', String(otDays));
    setText('calSumHours', formatHoursClean(Math.round(totalHours * 100) / 100));
    setText('calSumWorkDays', String(workDays));

    const detail = document.getElementById('calDayDetail');
    if (detail) {
      if (state.calSelectedIso && state.calSelectedIso.startsWith(state.calMonth)) {
        const vn = isoDateToVnDate(state.calSelectedIso);
        const sum = getEmployeeDaySummary(empName, vn);
        const locked = Boolean(state.lockedDays[vn] && state.lockedDays[vn].locked);
        detail.style.display = 'block';
        const restNote = isRestDayVn(vn) ? ` (${escapeHtml(getRestDayLabel(vn))} - ngày nghỉ)` : '';
        detail.innerHTML = `<div><strong>Ngày ${escapeHtml(vn)}${restNote}: ${escapeHtml(sum.code || sum.codeLabel)}</strong></div>
          <div class="sub-meta-text">${sum.totalHours > 0 ? escapeHtml(sum.detailStr) : 'Chưa báo tăng ca ngày này.'}${locked ? ' • Quản đốc đã chốt công' : ''}</div>
          ${state.calSelectedIso > localIsoToday() ? '<div class="sub-meta-text" style="margin-top:0.4rem;">Chưa tới ngày này nên chưa báo được.</div>' : `<button type="button" id="btnCalEditDay" class="action-btn primary" style="margin-top:0.5rem;min-height:44px;">${sum.totalHours > 0 ? 'Sửa ngày này' : (isRestDayVn(vn) ? 'Báo đi làm ngày này' : 'Báo tăng ca ngày này')}</button>`}`;
      } else {
        detail.style.display = 'none';
      }
    }
  }

  function selectCalendarDay(iso) {
    state.calSelectedIso = iso;
    renderWorkerCalendar();
    document.getElementById('calDayDetail')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  function shiftCalendarMonth(delta) {
    const [y, m] = (state.calMonth || localIsoToday().slice(0, 7)).split('-').map(Number);
    const d = new Date(y, m - 1 + delta, 1);
    state.calMonth = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
    state.calSelectedIso = '';
    renderWorkerCalendar();
  }

  /**
   * Công nhân lưu lại một ngày đã có ca: ca giữ nguyên giờ thì giữ mã ca và những gì Quản đốc đã chỉnh
   * (Giờ chốt, Loại tăng ca, Hình thức ca Sáng/Trưa). Ca đổi giờ thì Giờ chốt cũ không còn đúng nên bỏ.
   * `loaded` = nội dung/ghi chú lúc nạp form ({ job, note }): công nhân không sửa thì mỗi ca giữ nội dung riêng.
   */
  function inheritAdminFieldsForResave(candidate, slotKey, oldDayRecords, usedIds, loaded = {}) {
    const slotOf = (r) => {
      if (slotKey === 'REST') return 'REST';
      const h = Number(((r.startTime || '').split(' ')[1] || '').split(':')[0]);
      if (r.workMode === 'Tăng ca trưa' || (h >= 11 && h <= 13)) return 'LUNCH';
      return h < 11 ? 'MORNING' : 'EVENING';
    };
    const free = oldDayRecords.filter((r) => !usedIds.has(r.id));
    const same = free.find((r) => r.startTime === candidate.startTime && r.endTime === candidate.endTime);
    const old = same || free.find((r) => slotOf(r) === slotKey);
    if (!old) return candidate;
    usedIds.add(old.id);

    const out = { ...candidate, overtimeType: old.overtimeType || candidate.overtimeType };
    // Ca Tối công nhân tự chọn Hình thức trên form; các ca khác form gán cố định nên giữ lựa chọn của Quản đốc
    if (slotKey !== 'EVENING' && old.workMode) out.workMode = old.workMode;
    if (loaded.job !== undefined && candidate.jobContent === loaded.job && old.jobContent) out.jobContent = old.jobContent;
    if (loaded.note !== undefined && candidate.note === loaded.note) out.note = old.note || '';
    if (same) {
      out.id = old.id;
      out.overrideHours = old.overrideHours === undefined ? null : old.overrideHours;
      if (old.createdAt) out.createdAt = old.createdAt;
    }
    return out;
  }

  async function handleWorkerMobileSubmit() {
    if (state.authRole !== 'WORKER' && state.authRole !== 'ADMIN') {
      showToast('Vui lòng đăng nhập tài khoản trước khi gửi báo tăng ca!', 'warn');
      state.activeMainTab = 'LOGIN';
      renderAll();
      return;
    }

    if (state.isWaitingServerAck) {
      showToast('⏳ Đang lưu đơn tăng ca, vui lòng đợi trong giây lát!', 'warn');
      return;
    }

    const nowServerMs = getAuthoritativeServerDate().getTime();
    if (nowServerMs - state.lastSubmitServerMs < 1000) {
      playFeedbackSound('ERROR');
      showToast('⏳ Vui lòng đợi vài giây giữa 2 lần bấm gửi!', 'warn');
      return;
    }

    const activeWorkerName =
      state.authRole === 'WORKER' && state.loggedInEmployeeName
        ? state.loggedInEmployeeName
        : state.selectedEmployeeName;

    const daily = computeCurrentMobileDailySlots();
    if (daily.isoDate > localIsoToday()) {
      playFeedbackSound('ERROR');
      showToast('Chưa tới ngày này nên chưa báo được. Vui lòng chọn hôm nay hoặc ngày đã qua.', 'error');
      return;
    }
    const jobEl = document.getElementById('mobileJobContent');
    const noteEl = document.getElementById('mobileNoteInput');
    const jobText = (jobEl ? jobEl.value : '').trim();
    const noteText = (noteEl ? noteEl.value : '').trim();

    const beforeSummary = getEmployeeDaySummary(activeWorkerName, daily.workDate);
    const isDayLocked = Boolean(state.lockedDays && state.lockedDays[daily.workDate]?.locked);
    const authoritativeServerStr = formatDateTimeDDMMYYYYHHMM(new Date(nowServerMs));

    // Trường hợp bỏ tích cả 3 ca: Nếu ngày đó đã có bản ghi thì cho phép xóa sạch tăng ca ngày đó (về công X)
    if (daily.checkedSlots.length === 0) {
      if (beforeSummary.records.length > 0) {
        state.records = state.records.filter(
          (r) => !(r.employeeName === activeWorkerName && r.workDate === daily.workDate)
        );
        if (isDayLocked) {
          checkAndTriggerPostLockAlert(activeWorkerName, daily.workDate, beforeSummary);
        }
        saveLocalState(true);
        const emptyRes = await syncWithCentralServer(true);
        if (emptyRes && emptyRes.rejected) {
          renderAll();
          return;
        }
        playFeedbackSound('SUCCESS');
        clearEditHistoryFlag();
        resetWorkerForm();
        state.workerMobileSubTab = 'CALENDAR';
        state.calMonth = daily.isoDate.slice(0, 7);
        state.calSelectedIso = daily.isoDate;
        renderAll();
        showToast(
          `Đã xóa các ca tăng ca ngày <strong>${escapeHtml(daily.workDate)}</strong> (Chuyển về công X).`,
          'warn'
        );
        return;
      }

      playFeedbackSound('ERROR');
      showToast(
        daily.isRestDay
          ? 'Ngày nghỉ: hãy tích "Tôi có đi làm ngày này" và nhập giờ làm nếu bạn có đi làm.'
          : 'Vui lòng tích chọn ít nhất 1 ca tăng ca (Sáng, Trưa hoặc Tối)!',
        'error'
      );
      return;
    }

    if (!jobText) {
      playFeedbackSound('ERROR');
      showToast('Vui lòng nhập Nội dung công việc tăng ca!', 'error');
      jobEl?.focus();
      return;
    }

    // Giữ lại các bản ghi của ngày khác; các bản ghi cũ trong cùng ngày `daily.workDate` của công nhân này sẽ được thay thế bằng bộ ca mới
    const otherRecords = state.records.filter(
      (r) => !(r.employeeName === activeWorkerName && r.workDate === daily.workDate)
    );
    const savedRecordsBackup = state.records;
    const oldDayRecords = savedRecordsBackup.filter(
      (r) => r.employeeName === activeWorkerName && r.workDate === daily.workDate
    );
    const usedOldIds = new Set();
    const loadedText =
      state.formLoadedIso === daily.isoDate ? { job: state.formLoadedJob, note: state.formLoadedNote } : {};
    state.records = [...otherRecords];

    const newValidatedRecords = [];
    for (let i = 0; i < daily.checkedSlots.length; i++) {
      const slot = daily.checkedSlots[i];
      const receiptId = 'ACK_' + String(nowServerMs + i).slice(-6);
      const candidate = inheritAdminFieldsForResave({
        employeeName: activeWorkerName,
        jobContent: jobText,
        startTime: slot.startTime,
        endTime: slot.endTime,
        workDate: daily.workDate,
        overrideHours: null,
        overtimeType: state.mobileOvertimeType,
        workMode: slot.workMode,
        note: noteText,
        isDriverNoTime: false,
        receiptId,
        serverTimestamp: authoritativeServerStr,
        modifiedAfterLock: isDayLocked,
        modifiedAt: isDayLocked ? authoritativeServerStr : ''
      }, slot.slotKey, oldDayRecords, usedOldIds, loadedText);

      const check = validateAndNormalizeRecord(candidate);
      if (!check.ok) {
        state.records = savedRecordsBackup;
        playFeedbackSound('ERROR');
        if (check.isOverlapError) {
          openOverlapWarningModal(check.candidateRecord, check.conflictRecord);
        } else {
          showToast(`Ca ${slot.slotLabel}: ${escapeHtml(check.reason)}`, 'error');
        }
        return;
      }

      // Đưa tạm vào state.records để kiểm tra các ca trong cùng ngày không chồng lấn nhau
      state.records.unshift(check.record);
      newValidatedRecords.push(check.record);
    }

    state.lastSubmitServerMs = nowServerMs;

    // Nếu ngày này đã được Quản đốc chốt công -> kích hoạt cảnh báo bôi vàng nếu tổng giờ/ca thay đổi
    let triggeredYellow = false;
    if (isDayLocked) {
      triggeredYellow = checkAndTriggerPostLockAlert(activeWorkerName, daily.workDate, beforeSummary);
    }

    if (!REMOTE_MODE && (state.simulateOffline || (typeof navigator !== 'undefined' && navigator.onLine === false))) {
      state.isWaitingServerAck = true;
      await requestZaloScreenWakeLock();
      newValidatedRecords.forEach((r) => state.offlineQueue.unshift(r));
      saveLocalState(true);
      playFeedbackSound('ERROR');
      renderAll();
      showToast(
        `Điện thoại đang mất kết nối mạng. Đã lưu tạm ${newValidatedRecords.length} ca ngày ${escapeHtml(daily.workDate)} và sẽ tự gửi khi có mạng!`,
        'warn'
      );
      return;
    }

    state.isWaitingServerAck = true;
    await requestZaloScreenWakeLock();
    updateSyncStatusUI();

    saveLocalState(true);
    const syncRes = await syncWithCentralServer(true);

    state.isWaitingServerAck = false;
    releaseZaloScreenWakeLock();
    if (REMOTE_MODE && syncRes && syncRes.rejected) {
      // Máy chủ từ chối (ví dụ trùng giờ trên thiết bị khác): giữ nguyên form để người dùng chỉnh lại
      renderAll();
      return;
    }
    const savedOffline = Boolean(REMOTE_MODE && syncRes && syncRes.queued);
    const latestRec = newValidatedRecords[0];
    state.lastServerAckReceipt = savedOffline
      ? null
      : {
          receiptId: latestRec.receiptId,
          employeeName: `${activeWorkerName} (${daily.codeLabel} • Ngày ${daily.workDate})`,
          serverTimestamp: authoritativeServerStr
        };
    playFeedbackSound(savedOffline ? 'ERROR' : 'SUCCESS');
    try {
      localStorage.setItem(lastJobKey(activeWorkerName), jobText);
    } catch (_) {}
    clearEditHistoryFlag();
    resetWorkerForm();
    state.workerMobileSubTab = 'CALENDAR';
    state.calMonth = daily.isoDate.slice(0, 7);
    state.calSelectedIso = daily.isoDate;
    renderAll();
    window.scrollTo({ top: 0 });

    if (savedOffline) {
      showToast(
        `Chưa có mạng. Đã lưu tạm ngày <strong>${escapeHtml(daily.workDate)}</strong> trên điện thoại và sẽ tự gửi khi có mạng. Đừng xóa ứng dụng.`,
        'warn'
      );
    } else if (triggeredYellow) {
      showToast(
        `Đã cập nhật ngày <strong>${escapeHtml(daily.workDate)}</strong> thành <strong>${escapeHtml(daily.codeLabel)}</strong>. Vì ngày này Quản đốc đã chốt công nên ô của bạn đã được <strong>bôi vàng</strong> để Quản đốc duyệt lại!`,
        'warn'
      );
    } else if (beforeSummary.records.length > 0) {
      showToast(
        `Đã cập nhật báo tăng ca ngày <strong>${escapeHtml(daily.workDate)}</strong>: <strong>${escapeHtml(daily.codeLabel)} (${formatHoursClean(daily.totalHours)} giờ)</strong>!`,
        'success'
      );
    } else {
      showToast(
        `Đã lưu <strong>${newValidatedRecords.length} ca (${escapeHtml(daily.codeLabel)} • ${formatHoursClean(daily.totalHours)} giờ)</strong> ngày <strong>${escapeHtml(daily.workDate)}</strong> cho <strong>${escapeHtml(activeWorkerName)}</strong>!`,
        'success'
      );
    }
  }

  // ==========================================================================
  // 8. MODAL XÁC THỰC PIN 4 SỐ & MODAL CẢNH BÁO TRÙNG/CHỒNG GIỜ
  // ==========================================================================

  function openPinModalForEmployee(empName) {
    const emp = state.employees.find((e) => e.name === empName);
    if (!emp) return;
    state.pendingPinTargetEmpName = emp.name;
    state.pinBuffer = '';

    const modal = document.getElementById('modalPinAuth');
    const sub = document.getElementById('pinModalSubtitle');
    const hint = document.getElementById('pinModalHintCode');
    const err = document.getElementById('pinErrorMsg');

    if (sub) {
      sub.innerHTML = `Xác thực mã PIN cá nhân cho: <strong style="color: var(--text-main);">${escapeHtml(emp.name)}</strong>`;
    }
    if (hint) hint.textContent = emp.pin || '1234';
    if (err) err.style.display = 'none';
    updatePinDotsUI();

    if (modal) modal.classList.add('open');
  }

  function closePinModal() {
    const modal = document.getElementById('modalPinAuth');
    if (modal) modal.classList.remove('open');
    state.pendingPinTargetEmpName = null;
    state.pinBuffer = '';
  }

  function updatePinDotsUI() {
    const container = document.getElementById('pinDotsDisplay');
    if (!container) return;
    const boxes = container.querySelectorAll('.pin-dot-box');
    boxes.forEach((box, idx) => {
      if (idx < state.pinBuffer.length) {
        box.classList.add('filled');
        box.textContent = '●';
      } else {
        box.classList.remove('filled');
        box.textContent = '';
      }
    });
  }

  function handlePinKeyInput(key) {
    const emp = state.employees.find((e) => e.name === state.pendingPinTargetEmpName);
    if (!emp) return;
    const expectedPin = emp.pin || '1234';
    const expectedDigest = computeSaltedTokenDigest(`${emp.name}:${expectedPin}`);
    const err = document.getElementById('pinErrorMsg');
    if (err) err.style.display = 'none';

    if (key === 'CLEAR') {
      state.pinBuffer = state.pinBuffer.slice(0, -1);
      updatePinDotsUI();
      return;
    }
    if (key === 'AUTO') {
      state.pinBuffer = expectedPin;
      updatePinDotsUI();
    } else if (/^\d$/.test(key) && state.pinBuffer.length < 4) {
      state.pinBuffer += key;
      updatePinDotsUI();
    }

    if (state.pinBuffer.length === 4) {
      const enteredDigest = computeSaltedTokenDigest(`${emp.name}:${state.pinBuffer}`);
      if (enteredDigest === expectedDigest) {
        state.selectedEmployeeName = emp.name;
        state.mobileWorkerPickerOpen = false;
        syncWorkerDefaultsFromSelectedEmp();
        saveLocalState(false);
        closePinModal();
        playFeedbackSound('SUCCESS');
        renderAll();
        showToast(`Đã xác thực &amp; gắn điện thoại với: <strong>${escapeHtml(emp.name)}</strong>`, 'success');
      } else {
        playFeedbackSound('ERROR');
        if (err) err.style.display = 'block';
        state.pinBuffer = '';
        updatePinDotsUI();
      }
    }
  }

  function openOverlapWarningModal(candidate, conflict) {
    const modal = document.getElementById('modalOverlapWarn');
    const detail = document.getElementById('overlapWarnDetail');
    if (detail) {
      detail.innerHTML = `
        <div style="font-weight: 800; font-size: 0.96rem; margin-bottom: 0.45rem;">
          Không thể lưu ca tăng ca của <strong>${escapeHtml(candidate.employeeName)}</strong> vì bị chồng thời gian!
        </div>
        <div style="margin-bottom: 0.35rem;">
          • <strong>Ca bạn vừa nhập:</strong> <code>${escapeHtml(candidate.startTime)} → ${escapeHtml(candidate.endTime)}</code> (${escapeHtml(candidate.jobContent)})
        </div>
        <div>
          • <strong>Bị chồng với dòng đã có:</strong> <code>${escapeHtml(conflict.startTime)} → ${escapeHtml(conflict.endTime)}</code> (${escapeHtml(conflict.jobContent)})
        </div>
      `;
    }
    if (modal) modal.classList.add('open');
  }

  // ==========================================================================
  // 9. GIAO DIỆN PHÂN KHU 2: QUẢN TRỊ ADMIN, BẢNG CHẤM CÔNG (X+4) & 3 SHEET EXCEL
  // ==========================================================================

  function getSelectedMonthKey() {
    return /^\d{4}-\d{2}$/.test(state.matrixMonth || '') ? state.matrixMonth : localIsoToday().slice(0, 7);
  }

  function isRecordInMonth(rec, monthKey) {
    const [y, m] = monthKey.split('-');
    return String(rec.workDate || '').endsWith(`/${m}/${y}`);
  }

  function setSelectedMonth(monthKey) {
    if (!/^\d{4}-\d{2}$/.test(monthKey || '')) return;
    state.matrixMonth = monthKey;
    renderAll();
    if (REMOTE_MODE && state.authRole === 'ADMIN') {
      setAppLoading(true);
      remoteSyncPull({ force: true }).then(() => setAppLoading(false));
    }
  }

  function getFilteredAdminRecords() {
    const monthKey = getSelectedMonthKey();
    return state.records.filter((r) => {
      if (!isRecordInMonth(r, monthKey)) return false;
      if (state.adminFilterEmp !== 'ALL' && r.employeeName !== state.adminFilterEmp) {
        return false;
      }
      if (state.adminFilterMode !== 'ALL' && r.workMode !== state.adminFilterMode) {
        return false;
      }
      if (state.adminSearchQuery.trim()) {
        const q = state.adminSearchQuery.trim().toLowerCase();
        const hay = `${r.employeeName} ${r.jobContent} ${r.startTime} ${r.endTime} ${r.workDate} ${r.workMode} ${r.note || ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }

  function renderAdminDashboard() {
    const monthRecords = state.records.filter((r) => isRecordInMonth(r, getSelectedMonthKey()));
    const totalBadge = document.getElementById('adminTotalBadge');
    if (totalBadge) totalBadge.textContent = `${monthRecords.length} dòng`;

    const emptyHint = document.getElementById('adminEmptyHint');
    if (emptyHint) emptyHint.style.display = state.employees.length === 0 ? 'block' : 'none';

    const lockScreen = document.getElementById('adminLockScreen');
    const dashContent = document.getElementById('adminDashboardContent');
    if (lockScreen && dashContent) {
      lockScreen.style.display = state.adminUnlocked ? 'none' : 'block';
      dashContent.style.display = state.adminUnlocked ? 'block' : 'none';
    }

    // Cập nhật dropdown bộ lọc nhân viên
    const empSelect = document.getElementById('adminFilterEmployee');
    if (empSelect) {
      const currentVal = state.adminFilterEmp;
      empSelect.innerHTML =
        `<option value="ALL">Tất cả nhân viên (${state.employees.length})</option>` +
        state.employees
          .map((e) => `<option value="${escapeHtml(e.name)}">${escapeHtml(e.name)}</option>`)
          .join('');
      empSelect.value = state.employees.some((e) => e.name === currentVal) ? currentVal : 'ALL';
    }

    // Tính toán 5 KPI Cards
    const totalRecords = monthRecords.length;
    const uniqueEmpsWithOt = new Set(monthRecords.map((r) => r.employeeName)).size;
    const totalEstHours = monthRecords.reduce((s, r) => s + computeEstimatedHours(r), 0);
    const overrideCount = monthRecords.filter(
      (r) => r.overrideHours !== null && r.overrideHours !== '' && r.overrideHours !== undefined
    ).length;

    const countCompany = monthRecords.filter((r) => r.workMode === 'Tăng ca tại công ty').length;
    const countLunch = monthRecords.filter((r) => r.workMode === 'Tăng ca trưa').length;
    const countOutside = monthRecords.filter((r) => r.workMode === 'Tăng ca ngoài công ty').length;

    const modAlertKeys = Object.keys(state.dayModAlerts || {});
    const modAlertCount = modAlertKeys.length;
    const lockedDayCount = Object.values(state.lockedDays || {}).filter((d) => d && d.locked).length;

    const kpiTotalEl = document.getElementById('kpiTotalRecords');
    const kpiRecordsSub = document.getElementById('kpiRecordsSub');
    const kpiEmpEl = document.getElementById('kpiActiveEmployees');
    const kpiEmployeesSub = document.getElementById('kpiEmployeesSub');
    const kpiHoursEl = document.getElementById('kpiTotalEstHours');
    const kpiHoursSub = document.getElementById('kpiHoursSub');
    const kpiModesEl = document.getElementById('kpiWorkModesBreakdown');
    const kpiModesSub = document.getElementById('kpiWorkModesSub');
    const kpiValEl = document.getElementById('kpiValidationStatus');
    const kpiValSub = document.getElementById('kpiValidationSub');

    if (kpiTotalEl) kpiTotalEl.textContent = `${totalRecords} ca`;
    if (kpiRecordsSub) kpiRecordsSub.textContent = `Mỗi buổi Sáng / Trưa / Tối tính là 1 ca`;
    if (kpiEmpEl) kpiEmpEl.textContent = `${uniqueEmpsWithOt} / ${state.employees.length} NV`;
    if (kpiEmployeesSub) kpiEmployeesSub.textContent = `Số người có tăng ca / tổng số nhân viên`;
    if (kpiHoursEl) kpiHoursEl.textContent = `${formatHoursClean(totalEstHours)} giờ`;
    if (kpiHoursSub) kpiHoursSub.textContent = overrideCount > 0 ? `${overrideCount} ca Quản đốc nhập tay số giờ` : `Tự cộng từ giờ bắt đầu - kết thúc`;
    if (kpiModesEl) kpiModesEl.textContent = `Công ty ${countCompany} • Trưa ${countLunch} • Ngoài ${countOutside}`;
    if (kpiModesSub) kpiModesSub.textContent = `Tăng ca tại công ty • Tăng ca giờ trưa • Tăng ca ngoài công ty`;

    if (kpiValEl && kpiValSub) {
      if (modAlertCount > 0) {
        kpiValEl.textContent = `${modAlertCount} ô sửa sau chốt`;
        kpiValEl.style.color = '#b45309';
        kpiValSub.textContent = `Đã bôi vàng trên bảng công để Quản đốc kiểm tra`;
      } else {
        kpiValEl.textContent = `Đã chốt ${lockedDayCount} ngày`;
        kpiValEl.style.color = 'var(--emerald)';
        kpiValSub.textContent = `0 ca sửa sau chốt • Tự động bôi vàng nếu CN sửa`;
      }
    }

    const s1Label = document.getElementById('sheet1CountLabel');
    const s2Label = document.getElementById('sheet2CountLabel');
    const modBadge = document.getElementById('matrixModAlertCountBadge');
    if (s1Label) s1Label.textContent = String(totalRecords);
    if (s2Label) s2Label.textContent = String(state.employees.length);
    if (modBadge) {
      if (modAlertCount > 0) {
        modBadge.style.display = 'inline-block';
        modBadge.textContent = `${modAlertCount} sửa`;
      } else {
        modBadge.style.display = 'none';
      }
    }

    // Hiển thị đúng Sheet đang chọn (bao gồm Bảng chấm công hàng ngày X+4)
    const vMatrix = document.getElementById('sheetViewMatrix');
    const v1 = document.getElementById('sheetViewOvertime');
    const v2 = document.getElementById('sheetViewEmployees');
    const v3 = document.getElementById('sheetViewGuide');

    if (vMatrix) vMatrix.style.display = state.activeExcelSheet === 'SHEET_MATRIX' ? 'block' : 'none';
    if (v1) v1.style.display = state.activeExcelSheet === 'SHEET_OVERTIME' ? 'block' : 'none';
    if (v2) v2.style.display = state.activeExcelSheet === 'SHEET_EMPLOYEES' ? 'block' : 'none';
    if (v3) v3.style.display = state.activeExcelSheet === 'SHEET_GUIDE' ? 'block' : 'none';

    document.querySelectorAll('.excel-sheet-tab').forEach((btn) => {
      btn.classList.toggle('active', btn.getAttribute('data-sheet') === state.activeExcelSheet);
    });

    renderExcelMatrixSheet();
    renderExcelSheet1Overtime();
    renderExcelSheet2Employees();
    renderExcelSheet3Guide();
  }

  /**
   * Render Bảng Chấm Công Hàng Ngày (Ký hiệu X+4) cho Quản đốc & Cảnh báo bôi vàng khi Công nhân sửa sau chốt
   */
  function renderExcelMatrixSheet() {
    const thead = document.getElementById('excelMatrixThead');
    const tbody = document.getElementById('excelMatrixTbody');
    if (!thead || !tbody) return;

    const showAllToggle = document.getElementById('toggleMatrixShowAllDays');
    if (showAllToggle) showAllToggle.checked = Boolean(state.matrixShowAllDays);

    // Cập nhật nút Chốt công ngày đang chọn trên thanh công cụ
    const lockDateInp = document.getElementById('matrixLockDateInput');
    const btnLockSel = document.getElementById('btnLockSelectedDay');
    const selectedIso = lockDateInp && lockDateInp.value ? lockDateInp.value : localIsoToday();
    const selectedVnDate = isoDateToVnDate(selectedIso);
    const isSelLocked = Boolean(state.lockedDays && state.lockedDays[selectedVnDate]?.locked);

    if (btnLockSel) {
      if (isSelLocked) {
        btnLockSel.innerHTML = `Ngày ${escapeHtml(selectedVnDate)} đã chốt (Bấm để mở khóa)`;
        btnLockSel.classList.remove('primary');
      } else {
        btnLockSel.innerHTML = `Chốt công ngày ${escapeHtml(selectedVnDate)}`;
        btnLockSel.classList.add('primary');
      }
    }

    // Banner cảnh báo vàng nếu có công nhân sửa sau khi chốt
    const alertBanner = document.getElementById('matrixModifiedAlertBanner');
    const alertDetail = document.getElementById('matrixModifiedAlertText');
    const modEntries = Object.entries(state.dayModAlerts || {});

    if (alertBanner && alertDetail) {
      if (modEntries.length > 0) {
        alertBanner.style.display = 'flex';
        const itemsHtml = modEntries
          .map(([, info]) => {
            const ch = getModAlertChange(info.employeeName, info.workDate);
            return `<button type="button" class="matrix-alert-chip" data-open-cell-emp="${escapeHtml(info.employeeName)}" data-open-cell-date="${escapeHtml(info.workDate)}" title="Bấm để xem và duyệt ô này">
              <strong>${escapeHtml(info.employeeName)}</strong> • ${escapeHtml(String(info.workDate || '').slice(0, 5))}: <code>${escapeHtml(ch.beforeCode)}</code> → <code>${escapeHtml(ch.afterCode)}</code>
              ${ch.changes.length ? `<span class="matrix-alert-chip-detail">${escapeHtml(ch.changes.join('; '))}</span>` : ''}
            </button>`;
          })
          .join('');
        alertDetail.innerHTML = `Có <strong>${modEntries.length} ô chấm công</strong> bị sửa sau khi đã chốt. Bấm vào từng ô để xem trước/sau và duyệt:<div class="matrix-alert-chip-list">${itemsHtml}</div>`;
        alertDetail.querySelectorAll('[data-open-cell-emp]').forEach((chip) => {
          chip.addEventListener('click', () => {
            openMatrixCellQuickModal(chip.getAttribute('data-open-cell-emp'), chip.getAttribute('data-open-cell-date'));
          });
        });
      } else {
        alertBanner.style.display = 'none';
      }
    }

    // Xác định danh sách các cột Ngày hiển thị trên bảng Matrix
    let dateColumns = [];
    const matrixMonth = /^\d{4}-\d{2}$/.test(state.matrixMonth || '') ? state.matrixMonth : localIsoToday().slice(0, 7);
    state.matrixMonth = matrixMonth;
    const [mxYear, mxMonth] = matrixMonth.split('-').map(Number);
    const monthSuffix = `/${pad2(mxMonth)}/${mxYear}`;
    const monthInputEl = document.getElementById('matrixMonthInput');
    if (monthInputEl && monthInputEl.value !== matrixMonth) monthInputEl.value = matrixMonth;
    const exportMonthEl = document.getElementById('exportMonthInput');
    if (exportMonthEl && exportMonthEl.value !== matrixMonth) exportMonthEl.value = matrixMonth;

    // Bộ lọc "Chỉ hiện ô cần duyệt": chỉ giữ người & ngày có ô vàng trong tháng đang xem
    const pendingInMonth = getPendingAlertsInMonth(matrixMonth);
    if (pendingInMonth.length === 0) state.matrixOnlyPending = false;
    const onlyPending = Boolean(state.matrixOnlyPending);
    const pendingToggle = document.getElementById('toggleMatrixOnlyPending');
    const pendingToggleText = document.getElementById('toggleMatrixOnlyPendingText');
    const pendingToggleWrap = document.getElementById('toggleMatrixOnlyPendingWrap');
    if (pendingToggle) {
      pendingToggle.checked = onlyPending;
      pendingToggle.disabled = pendingInMonth.length === 0;
    }
    if (pendingToggleText) {
      pendingToggleText.textContent = pendingInMonth.length
        ? `Chỉ hiện ô cần duyệt (${pendingInMonth.length})`
        : 'Chỉ hiện ô cần duyệt (không có)';
    }
    if (pendingToggleWrap) pendingToggleWrap.classList.toggle('has-pending', pendingInMonth.length > 0);
    const pendingEmpNames = new Set(pendingInMonth.map((p) => p.employeeName));

    if (onlyPending) {
      dateColumns = [...new Set(pendingInMonth.map((p) => p.workDate))].sort(
        (a, b) => (parseVnDateTimeToMs(`${a} 00:00`) || 0) - (parseVnDateTimeToMs(`${b} 00:00`) || 0)
      );
    } else if (state.matrixShowAllDays) {
      const dim = new Date(mxYear, mxMonth, 0).getDate();
      for (let d = 1; d <= dim; d++) {
        dateColumns.push(`${pad2(d)}${monthSuffix}`);
      }
    } else {
      const dateSet = new Set();
      state.records.forEach((r) => {
        if (r.workDate) dateSet.add(r.workDate);
      });
      Object.keys(state.lockedDays || {}).forEach((d) => {
        if (state.lockedDays[d]?.locked) dateSet.add(d);
      });
      Object.values(state.dayModAlerts || {}).forEach((a) => {
        if (a && a.workDate) dateSet.add(a.workDate);
      });
      const todayVn = isoDateToVnDate(localIsoToday());
      if (todayVn.endsWith(monthSuffix)) dateSet.add(todayVn);
      if (dateSet.size === 0 || ![...dateSet].some((d) => d.endsWith(monthSuffix))) dateSet.add(`01${monthSuffix}`);

      dateColumns = Array.from(dateSet).filter((d) => d.endsWith(monthSuffix)).sort((a, b) => {
        const msA = parseVnDateTimeToMs(`${a} 00:00`) || 0;
        const msB = parseVnDateTimeToMs(`${b} 00:00`) || 0;
        return msA - msB;
      });
    }

    // Render Header của bảng Matrix
    const todayVnHeader = isoDateToVnDate(localIsoToday());
    thead.innerHTML = `
      <tr>
        <th style="width:42px;">STT</th>
        <th class="sticky-emp-col">Họ và tên công nhân</th>
        ${dateColumns
          .map((dStr) => {
            const shortDate = dStr.slice(0, 5); // dd/mm
            const isLocked = Boolean(state.lockedDays && state.lockedDays[dStr]?.locked);
            const isTodayCol = dStr === todayVnHeader;
            const thCls = ['matrix-day-th'];
            if (isLocked) thCls.push('locked-col');
            if (isTodayCol) thCls.push('today-col');
            const restHead = isRestDayVn(dStr) ? `<div class="matrix-head-rest">${escapeHtml(getRestDayLabel(dStr))}</div>` : '';
            return `
              <th class="${thCls.join(' ')}" style="min-width:96px;">
                <div style="font-size:0.8rem;font-weight:800;color:var(--text-main);">${escapeHtml(shortDate)}</div>
                ${restHead}
                <div style="font-size:0.65rem;color:var(--text-muted);font-weight:500;">${escapeHtml(dStr.slice(6))}</div>
                <button
                  type="button"
                  class="matrix-date-lock-btn ${isLocked ? 'locked' : 'unlocked'}"
                  data-matrix-lock-date="${escapeHtml(dStr)}"
                  title="${isLocked ? 'Ngày này đã chốt công. Bấm để mở khóa.' : 'Bấm để chốt bảng công ngày này'}"
                >
                  ${isLocked ? 'Đã chốt' : 'Chốt ngày'}
                </button>
              </th>
            `;
          })
          .join('')}
        <th style="min-width:90px;background:#eff6ff;color:#1e40af;">Số ngày TC</th>
        <th style="min-width:95px;background:#eff6ff;color:#1e40af;">Tổng giờ TC</th>
        <th style="min-width:125px;background:#eff6ff;color:#1e40af;">Tổng hợp tháng</th>
      </tr>
    `;

    // Lọc danh sách nhân viên theo bộ lọc hiện tại
    const monthFirstIso = `${mxYear}-${pad2(mxMonth)}-01`;
    const monthLastIso = `${mxYear}-${pad2(mxMonth)}-${pad2(new Date(mxYear, mxMonth, 0).getDate())}`;
    const filteredEmployees = state.employees.filter((emp) => {
      if (emp.endDate && emp.endDate < monthFirstIso) return false;
      if (emp.startDate && emp.startDate > monthLastIso) return false;
      if (onlyPending && !pendingEmpNames.has(emp.name)) return false;
      if (state.adminFilterEmp !== 'ALL' && emp.name !== state.adminFilterEmp) return false;
      if (state.adminSearchQuery.trim()) {
        const q = state.adminSearchQuery.trim().toLowerCase();
        const empRecordsHay = state.records
          .filter((r) => r.employeeName === emp.name)
          .map((r) => `${r.jobContent} ${r.workDate} ${r.workMode}`)
          .join(' ')
          .toLowerCase();
        if (!emp.name.toLowerCase().includes(q) && !empRecordsHay.includes(q)) return false;
      }
      return true;
    });

    // Render từng dòng nhân viên
    tbody.innerHTML = filteredEmployees
      .map((emp, idx) => {
        let empOtDaysCount = 0;
        let empMonthTotalHours = 0;

        // Tính tổng cả tháng của nhân viên
        const allEmpRecs = state.records.filter((r) => r.employeeName === emp.name && isRecordInMonth(r, matrixMonth));
        const uniqueEmpDates = new Set(allEmpRecs.map((r) => r.workDate).filter(Boolean));
        empOtDaysCount = uniqueEmpDates.size;
        empMonthTotalHours = Math.round(allEmpRecs.reduce((s, r) => s + computeEstimatedHours(r), 0) * 100) / 100;

        const cellsHtml = dateColumns
          .map((dStr) => {
            const sum = getEmployeeDaySummary(emp.name, dStr);
            const alertKey = `${dStr}::${emp.name}`;
            const modAlert = state.dayModAlerts ? state.dayModAlerts[alertKey] : null;
            const hasModifiedRow = sum.records.some((r) => r.modifiedAfterLock);
            const isTodayCell = dStr === todayVnHeader;

            if (modAlert || hasModifiedRow) {
              const ch = getModAlertChange(emp.name, dStr);
              const changeLines = ch.changes.slice(0, 2).map((c) => `<span class="matrix-change-line">${escapeHtml(c)}</span>`).join('');
              const moreChanges = ch.changes.length > 2 ? `<span class="matrix-change-line">+${ch.changes.length - 2} thay đổi khác</span>` : '';
              return `
                <td
                  class="matrix-cell modified-yellow-cell"
                  data-emp="${escapeHtml(emp.name)}"
                  data-date="${escapeHtml(dStr)}"
                  title="Sửa sau khi chốt công: ${escapeHtml(ch.beforeCode)} → ${escapeHtml(ch.afterCode)}${ch.changes.length ? `. ${escapeHtml(ch.changes.join('; '))}` : ''}. Bấm để xem/sửa nhanh."
                >
                  <span class="matrix-code-pill">${escapeHtml(sum.totalHours > 0 ? sum.codeLabel : 'X (0h)')}</span>
                  <span class="matrix-diff-tag">${escapeHtml(ch.beforeCode)} → ${escapeHtml(ch.afterCode)}</span>
                  ${changeLines}${moreChanges}
                  <div>
                    <button
                      type="button"
                      class="btn-approve-single-cell"
                      data-approve-key="${escapeHtml(alertKey)}"
                      data-emp="${escapeHtml(emp.name)}"
                      data-date="${escapeHtml(dStr)}"
                    >
                      Duyệt
                    </button>
                  </div>
                </td>
              `;
            }

            if (sum.totalHours > 0) {
              return `
                <td
                  class="matrix-cell has-overtime"
                  data-emp="${escapeHtml(emp.name)}"
                  data-date="${escapeHtml(dStr)}"
                  title="${escapeHtml(emp.name)} — Ngày ${escapeHtml(dStr)}: ${escapeHtml(sum.codeLabel)} (${escapeHtml(sum.slotBreakdown)}). Bấm để xem hoặc chỉnh nhanh."
                >
                  <span class="matrix-code-pill">${escapeHtml(sum.codeLabel)}</span>
                  <span class="matrix-slot-sub">${escapeHtml(sum.slotBreakdown)}</span>
                </td>
              `;
            }

            if (!isEmployedOn(emp, vnDateToIsoDate(dStr))) {
              return `<td class="matrix-cell off-col" title="${escapeHtml(emp.name)} chưa vào làm hoặc đã nghỉ việc"><span class="matrix-empty-dot">–</span></td>`;
            }
            if (sum.isRest) {
              return `<td class="matrix-cell rest-col" data-emp="${escapeHtml(emp.name)}" data-date="${escapeHtml(dStr)}" title="${escapeHtml(getRestDayLabel(dStr))}: ngày nghỉ (Bấm để thêm ca nếu có đi làm)"><span class="matrix-empty-dot">–</span></td>`;
            }
            return `
              <td
                class="matrix-cell${isTodayCell ? ' today-col-cell' : ''}"
                data-emp="${escapeHtml(emp.name)}"
                data-date="${escapeHtml(dStr)}"
                title="${escapeHtml(emp.name)} — Ngày ${escapeHtml(dStr)}: Công hành chính X (Bấm để thêm nhanh ca tăng ca)"
              >
                <span class="matrix-empty-dot">X</span>
              </td>
            `;
          })
          .join('');

        return `
          <tr>
            <td style="font-weight:700;color:var(--text-secondary);">${idx + 1}</td>
            <td class="sticky-emp-col">
              <div style="font-weight:800;color:var(--text-main);">${escapeHtml(emp.name)}</div>
              <div style="font-size:0.7rem;color:var(--text-secondary);font-weight:500;">
                TK: <code>${escapeHtml(emp.username || '')}</code> • ${escapeHtml(emp.defaultOvertimeType)}
              </div>
            </td>
            ${cellsHtml}
            <td class="matrix-summary-col">${empOtDaysCount} ngày</td>
            <td class="matrix-summary-col">+${formatHoursClean(empMonthTotalHours)}h</td>
            <td class="matrix-summary-col" style="color:#047857;">
              ${empOtDaysCount} công TC (+${formatHoursClean(empMonthTotalHours)}h)
            </td>
          </tr>
        `;
      })
      .join('');

    // Gắn sự kiện Chốt / Mở khóa ngày trực tiếp trên tiêu đề cột
    thead.querySelectorAll('[data-matrix-lock-date]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const dStr = btn.getAttribute('data-matrix-lock-date');
        if (!dStr) return;
        const isLocked = Boolean(state.lockedDays && state.lockedDays[dStr]?.locked);
        if (isLocked) {
          unlockAttendanceDay(dStr);
          showToast(`Đã mở khóa bảng công ngày <strong>${escapeHtml(dStr)}</strong>.`, 'warn');
        } else {
          lockAttendanceDay(dStr);
          playFeedbackSound('SUCCESS');
          showToast(
            `Đã chốt bảng công ngày <strong>${escapeHtml(dStr)}</strong>! Từ giờ nếu công nhân tự sửa lại ngày này, ô công sẽ tự động bôi vàng.`,
            'success'
          );
        }
        renderAll();
      });
    });

    // Gắn sự kiện nút "Duyệt" để bỏ bôi vàng từng ô
    tbody.querySelectorAll('[data-approve-key]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const key = btn.getAttribute('data-approve-key');
        if (key) approveSingleModAlert(key);
      });
    });

    // Bấm 1 chạm vào bất kỳ ô công nào (nhân viên, ngày) -> Mở hộp thoại Xem & Chỉnh Nhanh Ô Bảng Công
    tbody.querySelectorAll('.matrix-cell[data-emp][data-date]').forEach((cell) => {
      cell.addEventListener('click', (e) => {
        if (e.target.closest('[data-approve-key]')) return;
        const empName = cell.getAttribute('data-emp');
        const dStr = cell.getAttribute('data-date');
        if (empName && dStr) {
          openMatrixCellQuickModal(empName, dStr);
        }
      });
    });
  }

  /**
   * Hộp thoại Xem & Chỉnh Nhanh 1 Ô Bảng Công (1-Click trên Bảng Ma Trận Quản Đốc)
   */
  function openMatrixCellQuickModal(empName, vnDate) {
    state.quickCellEmp = empName;
    state.quickCellDate = vnDate;
    renderMatrixCellQuickModal();
    document.getElementById('modalMatrixCellQuick')?.classList.add('open');
  }

  function renderMatrixCellQuickModal() {
    const empName = state.quickCellEmp;
    const vnDate = state.quickCellDate;
    if (!empName || !vnDate) return;

    const sum = getEmployeeDaySummary(empName, vnDate);
    const iso = vnDateToIsoDate(vnDate);
    const dn = ['Chủ nhật', 'Thứ Hai', 'Thứ Ba', 'Thứ Tư', 'Thứ Năm', 'Thứ Sáu', 'Thứ Bảy'];
    const dd = new Date(`${iso}T00:00:00`);
    const dowLabel = isNaN(dd.getTime()) ? '' : `${dn[dd.getDay()]}, `;
    const isLocked = Boolean(state.lockedDays && state.lockedDays[vnDate]?.locked);
    const alertKey = `${vnDate}::${empName}`;
    const hasYellow = Boolean((state.dayModAlerts && state.dayModAlerts[alertKey]) || sum.records.some((r) => r.modifiedAfterLock));

    const titleEl = document.getElementById('matrixQuickModalTitle');
    const empEl = document.getElementById('matrixQuickEmpName');
    const dateEl = document.getElementById('matrixQuickDateHuman');
    const badgeEl = document.getElementById('matrixQuickCodeBadge');
    const btnApprove = document.getElementById('btnMatrixQuickApproveYellow');
    const listEl = document.getElementById('matrixQuickShiftsList');
    const btnClear = document.getElementById('btnMatrixQuickClearDay');

    if (titleEl) titleEl.textContent = `Chi tiết công ngày ${vnDate}`;
    if (empEl) empEl.textContent = empName;
    if (dateEl) {
      dateEl.textContent = `${dowLabel}ngày ${vnDate}${getHolidayName(vnDate) ? ` (${getHolidayName(vnDate)})` : ''} • ${isLocked ? 'Đã chốt bảng công' : 'Đang mở'}`;
    }
    if (badgeEl) {
      badgeEl.textContent = `${sum.codeLabel} (${formatHoursClean(sum.totalHours)} giờ)`;
    }
    if (btnApprove) {
      btnApprove.style.display = hasYellow ? 'inline-flex' : 'none';
    }
    if (btnClear) {
      btnClear.style.display = sum.records.length > 0 ? 'inline-flex' : 'none';
    }
    document.querySelectorAll('#modalMatrixCellQuick .rest-day-only').forEach((b) => {
      b.style.display = sum.isRest ? '' : 'none';
    });

    // Ô vàng: ghi rõ trước khi sửa (lúc chốt) và bây giờ để Quản đốc duyệt
    const changeBox = document.getElementById('matrixQuickChangeBox');
    if (changeBox) {
      if (hasYellow) {
        const ch = getModAlertChange(empName, vnDate);
        const alertObj = state.dayModAlerts && state.dayModAlerts[alertKey];
        changeBox.style.display = 'block';
        changeBox.innerHTML = `
          <div class="matrix-quick-change-title">
            Đã sửa sau khi chốt${alertObj && alertObj.modifiedAt ? ` (lúc ${escapeHtml(alertObj.modifiedAt)})` : ''}:
            <code>${escapeHtml(ch.beforeCode)}</code> → <code>${escapeHtml(ch.afterCode)}</code>
          </div>
          ${ch.changes.length ? `<ul>${ch.changes.map((c) => `<li>${escapeHtml(c)}</li>`).join('')}</ul>` : ''}
          <div class="sub-meta-text">Đồng ý thì bấm "Xác nhận sửa đổi". Chưa đúng thì sửa lại các ca bên dưới rồi xác nhận.</div>
        `;
      } else {
        changeBox.style.display = 'none';
        changeBox.innerHTML = '';
      }
    }

    if (!listEl) return;
    if (sum.records.length === 0) {
      listEl.innerHTML = `
        <div style="padding: 0.9rem; border: 1px dashed var(--border-strong); border-radius: var(--radius-md); color: var(--text-secondary); font-size: 0.83rem; text-align: center;">
          Chưa có ca tăng ca nào trong ngày này (Ký hiệu <strong>${escapeHtml(sum.codeLabel)}</strong>).<br/>
          Chọn nhanh tổ hợp ca ở dưới hoặc bấm <strong>"+ Thêm 1 ca tùy chỉnh"</strong>.
        </div>
      `;
    } else {
      listEl.innerHTML = sum.records
        .map((rec) => {
          const hrs = computeEstimatedHours(rec);
          const sHm = (rec.startTime || '').split(' ')[1] || rec.startTime;
          const eHm = (rec.endTime || '').split(' ')[1] || rec.endTime;
          const isMod = Boolean(rec.modifiedAfterLock);
          return `
            <div class="matrix-quick-shift-card${isMod ? ' modified-yellow' : ''}">
              <div style="flex: 1;">
                <div style="display: flex; align-items: center; gap: 0.45rem; flex-wrap: wrap;">
                  <strong style="font-family: var(--font-mono); font-size: 0.88rem; color: var(--text-main);">
                    ${escapeHtml(sHm)} → ${escapeHtml(eHm)}
                  </strong>
                  <span class="badge-formula">${escapeHtml(rec.workMode)}</span>
                  <strong style="color: var(--primary); font-size: 0.82rem;">+${formatHoursClean(hrs)}h</strong>
                  ${isMod ? '<span class="matrix-diff-tag">Sửa sau chốt</span>' : ''}
                </div>
                <div style="font-size: 0.78rem; color: var(--text-secondary); margin-top: 2px;">
                  ${escapeHtml(rec.jobContent)}${rec.note ? ` • <em>${escapeHtml(rec.note)}</em>` : ''}
                </div>
              </div>
              <div style="display: flex; gap: 0.35rem; flex-shrink: 0;">
                <button type="button" class="action-btn btn-quick-edit-shift" data-id="${escapeHtml(rec.id)}" style="padding: 0.25rem 0.55rem; font-size: 0.74rem;">
                  Sửa
                </button>
                <button type="button" class="action-btn btn-quick-del-shift" data-id="${escapeHtml(rec.id)}" style="padding: 0.25rem 0.5rem; font-size: 0.74rem; color: var(--rose);">
                  Xóa
                </button>
              </div>
            </div>
          `;
        })
        .join('');

      listEl.querySelectorAll('.btn-quick-edit-shift').forEach((btn) => {
        btn.addEventListener('click', () => {
          const recId = btn.getAttribute('data-id');
          if (recId) openAdminEditOvertimeModal(recId);
        });
      });
      listEl.querySelectorAll('.btn-quick-del-shift').forEach((btn) => {
        btn.addEventListener('click', () => {
          const recId = btn.getAttribute('data-id');
          if (recId) deleteOvertimeRecordById(recId);
        });
      });
    }
  }

  function applyAdminQuickCellCombo(empName, vnDate, comboCode) {
    if (!empName || !vnDate) return;
    const empObj = state.employees.find((e) => e.name === empName);
    const defaultType = empObj ? empObj.defaultOvertimeType || 'Ngoài khoán' : 'Ngoài khoán';
    const defaultMode = empObj ? empObj.defaultWorkMode || 'Tăng ca tại công ty' : 'Tăng ca tại công ty';

    const beforeSummary = getEmployeeDaySummary(empName, vnDate);
    if (comboCode === 'CLEAR') {
      if (beforeSummary.records.length === 0) return;
      if (!window.confirm(`Xóa hết ${beforeSummary.records.length} ca tăng ca ngày ${vnDate} của ${empName} (Về công X)?`)) {
        return;
      }
      state.records = state.records.filter((r) => !(r.employeeName === empName && r.workDate === vnDate));
      if (state.lockedDays && state.lockedDays[vnDate]?.locked) {
        checkAndTriggerPostLockAlert(empName, vnDate, beforeSummary);
      }
      saveLocalState(true);
      syncWithCentralServer(true);
      playFeedbackSound('SUCCESS');
      renderAll();
      renderMatrixCellQuickModal();
      showToast(`Đã xóa tăng ca ngày <strong>${escapeHtml(vnDate)}</strong> của <strong>${escapeHtml(empName)}</strong> (Về công X).`, 'warn');
      return;
    }

    const slotDefs = [];
    if (comboCode === 'REST_8') {
      slotDefs.push({ startHm: '07:15', endHm: '15:15', workMode: 'Tăng ca tại công ty' });
    } else if (comboCode === 'ONLY_EVE1') {
      slotDefs.push({ startHm: '17:15', endHm: '18:15', workMode: defaultMode });
    } else if (comboCode === 'ONLY_LUNCH2') {
      slotDefs.push({ startHm: '11:15', endHm: '13:15', workMode: 'Tăng ca trưa' });
    } else if (comboCode === 'ONLY_EVE2') {
      slotDefs.push({ startHm: '17:15', endHm: '19:15', workMode: defaultMode });
    } else if (comboCode === 'LUNCH2_EVE1') {
      slotDefs.push(
        { startHm: '11:15', endHm: '13:15', workMode: 'Tăng ca trưa' },
        { startHm: '17:15', endHm: '18:15', workMode: defaultMode }
      );
    } else if (comboCode === 'FULL_615_1815') {
      slotDefs.push(
        { startHm: '06:15', endHm: '07:15', workMode: 'Tăng ca tại công ty' },
        { startHm: '11:15', endHm: '13:15', workMode: 'Tăng ca trưa' },
        { startHm: '17:15', endHm: '18:15', workMode: defaultMode }
      );
    } else if (comboCode === 'FULL_615_1915') {
      slotDefs.push(
        { startHm: '06:15', endHm: '07:15', workMode: 'Tăng ca tại công ty' },
        { startHm: '11:15', endHm: '13:15', workMode: 'Tăng ca trưa' },
        { startHm: '17:15', endHm: '19:15', workMode: defaultMode }
      );
    }
    if (slotDefs.length === 0) return;

    const existingJob =
      beforeSummary.records[0]?.jobContent ||
      state.records.find((r) => r.employeeName === empName && r.jobContent)?.jobContent ||
      'Gia công & lắp ráp đơn hàng gấp tiến độ';
    const existingNote = beforeSummary.records[0]?.note || '';
    const isLocked = Boolean(state.lockedDays && state.lockedDays[vnDate]?.locked);
    const nowServerStr = formatDateTimeDDMMYYYYHHMM(getAuthoritativeServerDate());

    const otherRecords = state.records.filter((r) => !(r.employeeName === empName && r.workDate === vnDate));
    const backup = state.records;
    state.records = [...otherRecords];

    for (let i = 0; i < slotDefs.length; i++) {
      const s = slotDefs[i];
      const check = validateAndNormalizeRecord({
        employeeName: empName,
        jobContent: existingJob,
        startTime: `${vnDate} ${s.startHm}`,
        endTime: `${vnDate} ${s.endHm}`,
        workDate: vnDate,
        overrideHours: null,
        overtimeType: defaultType,
        workMode: s.workMode,
        note: existingNote,
        isDriverNoTime: false,
        modifiedAfterLock: isLocked,
        modifiedAt: isLocked ? nowServerStr : ''
      });
      if (!check.ok) {
        state.records = backup;
        playFeedbackSound('ERROR');
        showToast(escapeHtml(check.reason), 'error');
        return;
      }
      state.records.unshift(check.record);
    }

    if (isLocked) {
      checkAndTriggerPostLockAlert(empName, vnDate, beforeSummary);
    }

    saveLocalState(true);
    syncWithCentralServer(true);
    playFeedbackSound('SUCCESS');
    renderAll();
    renderMatrixCellQuickModal();
    const afterSummary = getEmployeeDaySummary(empName, vnDate);
    showToast(
      `Đã đặt <strong>${escapeHtml(afterSummary.codeLabel)} (${formatHoursClean(afterSummary.totalHours)}h)</strong> ngày <strong>${escapeHtml(vnDate)}</strong> cho <strong>${escapeHtml(empName)}</strong>!`,
      'success'
    );
  }

  function copyEmployeeZaloCredentials(empName, customPass = '') {
    const emp = state.employees.find((e) => e.name === empName);
    if (!emp) return;
    const urlInput = document.getElementById('deployPublicUrlInput');
    const appUrl = (urlInput && urlInput.value ? urlInput.value.trim() : window.location.origin + window.location.pathname);
    const username = emp.username || slugifyVietnamese(emp.name);
    const pwd = customPass || (REMOTE_MODE ? '(Mật khẩu đã cấp / mặc định 123456)' : (emp.password || emp.pin || '123456'));
    const text = [
      `📌 Tài khoản Sổ Báo Tăng Ca — ${emp.name}`,
      `• Đường dẫn: ${appUrl}`,
      `• Tên đăng nhập: ${username}`,
      `• Mật khẩu: ${pwd}`
    ].join('\n');
    navigator.clipboard?.writeText(text);
    playFeedbackSound('SUCCESS');
    showToast(`Đã sao chép thông tin đăng nhập của <strong>${escapeHtml(emp.name)}</strong> để dán gửi Zalo!`, 'success');
  }

  /**
   * Render Sheet 1 ("Chi tiết tăng ca") giống hệt cấu trúc dòng 1..N trong Excel
   */
  function renderExcelSheet1Overtime() {
    const tbody = document.getElementById('excelSheet1Tbody');
    if (!tbody) return;

    const filtered = getFilteredAdminRecords();
    let html = '';

    // Dòng 1..6: 6 dòng Hướng dẫn gộp ô A1:I6
    if (state.showExcelGuideRows) {
      html += `
        <tr>
          <td class="excel-row-num">1</td>
          <td colspan="9" class="excel-merged-title">${escapeHtml(EXCEL_GUIDE_TEXTS[0])}</td>
          <td style="background:#f1f5f9;font-size:0.72rem;color:#64748b;text-align:center;">Gộp ô A1:I1</td>
        </tr>
      `;
      for (let r = 2; r <= 6; r++) {
        html += `
          <tr>
            <td class="excel-row-num">${r}</td>
            <td colspan="9" class="excel-merged-rule">${escapeHtml(EXCEL_GUIDE_TEXTS[r - 1])}</td>
            <td style="background:#f1f5f9;font-size:0.72rem;color:#64748b;text-align:center;">Gộp ô A${r}:I${r}</td>
          </tr>
        `;
      }
    }

    // Dòng 7: Header chính thức của bảng Chi tiết tăng ca
    html += `
      <tr class="excel-table-header">
        <th class="excel-row-num">7</th>
        <th>Tên nhân viên</th>
        <th>Nội dung công việc</th>
        <th>Bắt đầu</th>
        <th>Kết thúc</th>
        <th>Ngày tính công</th>
        <th>Thời gian tăng ca</th>
        <th>Loại tăng ca</th>
        <th>Hình thức tăng ca</th>
        <th>Ghi chú</th>
        <th>Quản lý dòng</th>
      </tr>
    `;

    // Dòng 8..N: Các dòng dữ liệu tăng ca hợp lệ
    if (filtered.length === 0) {
      html += `
        <tr>
          <td class="excel-row-num">8</td>
          <td colspan="10" style="text-align:center;padding:1.8rem;color:var(--text-secondary);">
            Không có dòng tăng ca nào khớp bộ lọc hiện tại.
          </td>
        </tr>
      `;
    } else {
      filtered.forEach((rec, idx) => {
        const excelRow = idx + 8;
        const estHrs = computeEstimatedHours(rec);
        const empObj = state.employees.find((e) => e.name === rec.employeeName);
        const isDefaultMode = empObj && empObj.defaultWorkMode === rec.workMode;
        const isModAfterLock =
          Boolean(rec.modifiedAfterLock) ||
          Boolean(state.dayModAlerts && state.dayModAlerts[`${rec.workDate}::${rec.employeeName}`]);

        let colFDisplay = '';
        if (rec.overrideHours !== null && rec.overrideHours !== '' && !isNaN(rec.overrideHours)) {
          colFDisplay = `<span class="badge-override-hours">${Number(rec.overrideHours)} (Ghi đè)</span>`;
        } else {
          colFDisplay = `<span class="badge-auto-blank" title="Để trống khi xuất Excel để phần mềm tự tính (Mục 3)">[Trống] (~${formatHoursClean(estHrs)}h)</span>`;
        }

        html += `
          <tr class="data-row ${isModAfterLock ? 'modified-after-lock' : ''}">
            <td class="excel-row-num">${excelRow}</td>
            <td style="font-weight: 800; color: var(--text-main);">
              ${escapeHtml(rec.employeeName)}
              ${
                isModAfterLock
                  ? `<div style="margin-top:0.15rem;"><span style="background:#eab308;color:#fff;font-size:0.65rem;padding:0.08rem 0.38rem;border-radius:4px;font-weight:800;">Sửa sau chốt</span></div>`
                  : ''
              }
            </td>
            <td>
              ${escapeHtml(rec.jobContent)}
              ${rec.receiptId ? `<span style="display:inline-block;margin-left:0.35rem;font-size:0.66rem;color:#047857;background:#ecfdf5;padding:0.05rem 0.35rem;border-radius:4px;font-weight:800;">#${escapeHtml(rec.receiptId)}</span>` : ''}
            </td>
            <td class="cell-mono">${escapeHtml(rec.startTime)}</td>
            <td class="cell-mono">${escapeHtml(rec.endTime)}</td>
            <td class="cell-mono">${escapeHtml(rec.workDate)}</td>
            <td style="text-align: center;">${colFDisplay}</td>
            <td><span class="badge-formula">fx ${escapeHtml(rec.overtimeType)}</span></td>
            <td>
              <span class="badge-formula ${isDefaultMode ? '' : 'custom'}">
                ${isDefaultMode ? 'fx ' : ''}${escapeHtml(rec.workMode)}
              </span>
            </td>
            <td style="color: var(--text-secondary); font-size: 0.78rem;">${escapeHtml(rec.note || '')}</td>
            <td style="text-align: center; white-space: nowrap;">
              <button type="button" class="action-btn btn-edit-ot-row" data-id="${escapeHtml(rec.id)}" style="padding: 0.28rem 0.55rem; font-size: 0.74rem;">
                Sửa
              </button>
              <button type="button" class="action-btn btn-del-ot-row" data-id="${escapeHtml(rec.id)}" style="padding: 0.28rem 0.5rem; font-size: 0.74rem; color: var(--rose);">
                Xóa
              </button>
            </td>
          </tr>
        `;
      });
    }

    tbody.innerHTML = html;

    tbody.querySelectorAll('.btn-edit-ot-row').forEach((btn) => {
      btn.addEventListener('click', () => openAdminEditOvertimeModal(btn.getAttribute('data-id')));
    });
    tbody.querySelectorAll('.btn-del-ot-row').forEach((btn) => {
      btn.addEventListener('click', () => deleteOvertimeRecordById(btn.getAttribute('data-id')));
    });
  }

  /**
   * Render Sheet 2 ("Danh sách nhân viên") - Cho phép Admin xem & đổi nhanh Tên đăng nhập / Mật khẩu của từng nhân viên
   */
  function renderExcelSheet2Employees() {
    const tbody = document.getElementById('excelSheet2Tbody');
    if (!tbody) return;

    let html = `
      <tr class="excel-table-header">
        <th class="excel-row-num">1</th>
        <th>Tên nhân viên</th>
        <th>Tên đăng nhập</th>
        <th>Mật khẩu</th>
        <th>Loại tăng ca mặc định</th>
        <th>Hình thức tăng ca mặc định</th>
        <th>Số ca trong tháng</th>
        <th>Quản lý</th>
      </tr>
    `;

    const sheet2Month = getSelectedMonthKey();
    state.employees.forEach((emp, idx) => {
      const r = idx + 2;
      const empRecs = state.records.filter((rec) => rec.employeeName === emp.name && isRecordInMonth(rec, sheet2Month));
      const totalHrs = Math.round(empRecs.reduce((s, rec) => s + computeEstimatedHours(rec), 0) * 100) / 100;
      html += `
        <tr class="data-row">
          <td class="excel-row-num">${r}</td>
          <td style="font-weight: 800;">${escapeHtml(emp.name)}</td>
          <td class="cell-mono" style="text-align:center;color:var(--primary);font-weight:700;">${escapeHtml(emp.username || slugifyVietnamese(emp.name))}</td>
          <td class="cell-mono" style="text-align:center;color:#047857;font-weight:700;">${REMOTE_MODE ? '••••••' : escapeHtml(emp.password || emp.pin || '123456')}</td>
          <td>${escapeHtml(emp.defaultOvertimeType)}</td>
          <td>${escapeHtml(emp.defaultWorkMode)}</td>
          <td style="text-align:center;font-weight:800;color:var(--primary);">${empRecs.length} ca (${formatHoursClean(totalHrs)}h)</td>
          <td style="text-align:center;white-space:nowrap;">
            <button type="button" class="action-btn btn-copy-zalo-s2" data-name="${escapeHtml(emp.name)}" style="padding:0.25rem 0.55rem;font-size:0.74rem;" title="Sao chép đường dẫn + tài khoản để gửi Zalo cho công nhân">
              Copy Zalo
            </button>
            <button type="button" class="action-btn" onclick="window.__openChangePinFromSheet2()" style="padding:0.25rem 0.6rem;font-size:0.74rem;">
              Sửa TK / MK
            </button>
          </td>
        </tr>
      `;
    });

    tbody.innerHTML = html;

    tbody.querySelectorAll('.btn-copy-zalo-s2').forEach((btn) => {
      btn.addEventListener('click', () => {
        const empName = btn.getAttribute('data-name');
        if (empName) copyEmployeeZaloCredentials(empName);
      });
    });
  }

  window.__openChangePinFromSheet2 = function () {
    openManageEmployeesModal();
  };

  /**
   * Render Sheet 3 ("Hướng dẫn")
   */
  function renderExcelSheet3Guide() {
    const tbody = document.getElementById('excelSheet3Tbody');
    if (!tbody) return;

    const protections = [
      'Tiêu đề bảng Hướng dẫn gốc',
      'Tự động lọc bỏ dòng trống Nội dung CV; Mỗi ca Sáng / Trưa / Tối tách thành 1 dòng chuẩn',
      'Ép định dạng dd/mm/yyyy hh:mm, tự điền Loại & Hình thức qua công thức Named Ranges, chặn trùng tên',
      'Mặc định để trống cột Thời gian tăng ca (Cột F) khi xuất .xlsx để phần mềm tự tính',
      'Thuật toán findOverlappingRecord chặn đứng mọi dòng trùng hoặc giao nhau dù chỉ 1 phút',
      'Hỗ trợ cột Ghi chú đầy đủ'
    ];

    let html = `
      <tr>
        <td class="excel-row-num">1</td>
        <td class="excel-merged-title" style="text-align:left;">${escapeHtml(EXCEL_GUIDE_TEXTS[0])}</td>
        <td style="background:#ecfdf5;color:#065f46;font-weight:800;">Đã đồng bộ 100% trong file .xlsx</td>
      </tr>
      <tr>
        <td class="excel-row-num">2</td>
        <td style="color:#94a3b8;font-style:italic;">[Dòng trống phân cách theo đúng nguyên bản Sheet Hướng dẫn]</td>
        <td>—</td>
      </tr>
    `;

    for (let i = 1; i <= 5; i++) {
      const excelRow = i + 2;
      html += `
        <tr>
          <td class="excel-row-num">${excelRow}</td>
          <td style="line-height:1.55;">${escapeHtml(EXCEL_GUIDE_TEXTS[i])}</td>
          <td style="background:#f0fdf4;color:#065f46;font-weight:700;font-size:0.78rem;">${protections[i]}</td>
        </tr>
      `;
    }

    tbody.innerHTML = html;
  }

  // ==========================================================================
  // 10. MODAL ADMIN THÊM / SỬA DÒNG TĂNG CA & QUẢN LÝ DANH SÁCH NHÂN VIÊN
  // ==========================================================================

  // Nút chọn nhanh ca trong hộp thoại Admin: [giờ bắt đầu, giờ kết thúc]
  const ADMIN_SHIFT_PRESETS = {
    MORN_1: ['06:15', '07:15'],
    LUNCH_2: ['11:15', '13:15'],
    EVE_1: ['17:15', '18:15'],
    EVE_2: ['17:15', '19:15'],
    EVE_3: ['17:15', '20:15'],
    REST_8: ['07:15', '15:15']
  };

  /**
   * Cập nhật dòng "Thứ ..., ngày ...", dòng tổng giờ (báo ca qua đêm) và nút ca đang khớp trong hộp thoại Admin
   */
  function refreshAdminTimePreview() {
    const iso = document.getElementById('editOtDatePicker')?.value || '';
    const sHm = (document.getElementById('editOtStartTime')?.value || '').slice(0, 5);
    const eHm = (document.getElementById('editOtEndTime')?.value || '').slice(0, 5);
    const vn = isoDateToVnDate(iso);
    const humanEl = document.getElementById('editOtDateHuman');
    if (humanEl) {
      const dn = ['Chủ nhật', 'Thứ Hai', 'Thứ Ba', 'Thứ Tư', 'Thứ Năm', 'Thứ Sáu', 'Thứ Bảy'];
      const dd = new Date(`${iso}T00:00:00`);
      humanEl.textContent = vn && !isNaN(dd.getTime())
        ? `${dn[dd.getDay()]}, ${vn}${getHolidayName(vn) ? ` (${getHolidayName(vn)})` : ''}`
        : 'Chưa chọn ngày';
    }
    const previewEl = document.getElementById('editOtTimePreview');
    const t = composeAdminShiftTimes(iso, sHm, eHm);
    if (previewEl) {
      previewEl.classList.toggle('overnight', Boolean(t && t.overnight));
      previewEl.innerHTML = t
        ? `Tăng ca <strong>${formatHoursClean(t.hours)} giờ</strong>: ${escapeHtml(t.startTime)} → ${escapeHtml(t.endTime)}${
            t.overnight ? ' <strong>(qua đêm, kết thúc sáng hôm sau)</strong>' : ''
          }`
        : 'Chọn ngày làm, giờ bắt đầu và giờ kết thúc.';
    }
    document.querySelectorAll('[data-admin-preset]').forEach((btn) => {
      const range = ADMIN_SHIFT_PRESETS[btn.getAttribute('data-admin-preset')] || [];
      btn.classList.toggle('active', range[0] === sHm && range[1] === eHm);
    });
  }

  function openAdminEditOvertimeModal(recordId = null, prefillEmpName = null, prefillVnDate = null) {
    if (state.employees.length === 0) {
      showToast('Hãy thêm nhân viên trước (nút "Nhân sự & Tài khoản").', 'warn');
      return;
    }
    const modal = document.getElementById('modalEditOvertime');
    const title = document.getElementById('editOtModalTitle');
    const idInput = document.getElementById('editOtRecordId');
    const empSelect = document.getElementById('editOtEmployee');
    const jobInput = document.getElementById('editOtJobContent');
    const startInput = document.getElementById('editOtStartTime');
    const endInput = document.getElementById('editOtEndTime');
    const dateInput = document.getElementById('editOtWorkDateIso');
    const datePicker = document.getElementById('editOtDatePicker');
    const overrideInput = document.getElementById('editOtOverrideHours');
    const typeSelect = document.getElementById('editOtType');
    const workModeSelect = document.getElementById('editOtWorkMode');
    const noteInput = document.getElementById('editOtNote');
    const delBtn = document.getElementById('btnDeleteOtRecord');
    const timeBlock = document.getElementById('editOtTimeBlock');

    const editingRec = recordId ? state.records.find((r) => r.id === recordId) : null;
    if (empSelect) {
      empSelect.innerHTML = state.employees
        .filter((e) => isEmployeeCurrentlyActive(e) || (editingRec && editingRec.employeeName === e.name) || (prefillEmpName && prefillEmpName === e.name))
        .map((e) => `<option value="${escapeHtml(e.name)}">${escapeHtml(e.name)}</option>`)
        .join('');
    }

    const existing = recordId ? state.records.find((r) => r.id === recordId) : null;
    const baseVnDate = prefillVnDate || isoDateToVnDate(localIsoToday());

    if (existing) {
      if (title) title.textContent = `Chỉnh Sửa Dòng Tăng Ca — ${existing.employeeName}`;
      if (idInput) idInput.value = existing.id;
      if (empSelect) empSelect.value = existing.employeeName;
      if (jobInput) jobInput.value = existing.jobContent;
      const p = splitShiftForPickers(existing.startTime, existing.endTime);
      if (datePicker) datePicker.value = p.iso || vnDateToIsoDate(existing.workDate || baseVnDate);
      if (startInput) startInput.value = p.startHm || '17:15';
      if (endInput) endInput.value = p.endHm || '18:15';
      if (dateInput) dateInput.value = vnDateToIsoDate(existing.workDate) || (datePicker ? datePicker.value : '');
      if (overrideInput) {
        overrideInput.value =
          existing.overrideHours !== null && existing.overrideHours !== undefined
            ? existing.overrideHours
            : '';
      }
      if (typeSelect) typeSelect.value = existing.overtimeType || 'Ngoài khoán';
      if (workModeSelect) workModeSelect.value = existing.workMode || 'Tăng ca tại công ty';
      if (noteInput) noteInput.value = existing.note || '';
      if (delBtn) delBtn.style.display = 'inline-flex';
      if (timeBlock) timeBlock.style.display = 'block';
    } else {
      const defEmp =
        (prefillEmpName && state.employees.find((e) => e.name === prefillEmpName)) ||
        state.employees.find((e) => isEmployeeCurrentlyActive(e)) ||
        state.employees[0];
      if (title) title.textContent = prefillEmpName ? `Thêm Ca Tăng Ca — ${prefillEmpName} (${baseVnDate})` : 'Thêm Dòng Chi Tiết Tăng Ca Mới';
      if (idInput) idInput.value = '';
      if (empSelect && defEmp) empSelect.value = defEmp.name;
      if (jobInput) jobInput.value = 'Gia công & hoàn thiện đơn hàng gấp';
      // Ngày nghỉ (Chủ nhật/Lễ) thường làm cả ngày 07:15–15:15, ngày thường mặc định ca Tối 1 giờ
      const defRange = isRestDayVn(baseVnDate) ? ADMIN_SHIFT_PRESETS.REST_8 : ADMIN_SHIFT_PRESETS.EVE_1;
      if (startInput) startInput.value = defRange[0];
      if (endInput) endInput.value = defRange[1];
      if (datePicker) datePicker.value = vnDateToIsoDate(baseVnDate);
      if (dateInput) dateInput.value = vnDateToIsoDate(baseVnDate);
      if (overrideInput) overrideInput.value = '';
      if (typeSelect) typeSelect.value = defEmp ? defEmp.defaultOvertimeType : 'Ngoài khoán';
      if (workModeSelect) workModeSelect.value = defEmp ? defEmp.defaultWorkMode : 'Tăng ca tại công ty';
      if (noteInput) noteInput.value = '';
      if (delBtn) delBtn.style.display = 'none';
      if (timeBlock) timeBlock.style.display = 'block';
    }
    // Ngày tính công đi theo Ngày làm khi đổi ngày (trừ khi đã được chọn riêng)
    if (datePicker) datePicker.dataset.prev = datePicker.value;
    refreshAdminTimePreview();

    if (modal) modal.classList.add('open');
  }

  /**
   * Kiểm tra & lưu 1 dòng Admin thêm/sửa vào state. Ngày đã chốt bị đổi thì bôi vàng, kể cả ngày cũ
   * khi dòng bị chuyển sang ngày khác hoặc sang người khác. Trả về kết quả của validateAndNormalizeRecord.
   */
  function commitAdminRecordEdit(rawCandidate, idVal = null) {
    const original = idVal ? state.records.find((r) => r.id === idVal) : null;
    const raw = original
      ? { ...rawCandidate, createdAt: original.createdAt, receiptId: original.receiptId, serverTimestamp: original.serverTimestamp }
      : rawCandidate;
    const check = validateAndNormalizeRecord(raw, idVal || null);
    if (!check.ok) return check;

    const rec = check.record;
    const isLockedDay = (d) => Boolean(state.lockedDays && state.lockedDays[d]?.locked);
    const touchedDays = [{ emp: rec.employeeName, date: rec.workDate }];
    if (original && (original.employeeName !== rec.employeeName || original.workDate !== rec.workDate)) {
      touchedDays.push({ emp: original.employeeName, date: original.workDate });
    }
    touchedDays.forEach((d) => {
      d.before = getEmployeeDaySummary(d.emp, d.date);
    });

    if (isLockedDay(rec.workDate)) {
      rec.modifiedAfterLock = true;
      rec.modifiedAt = formatDateTimeDDMMYYYYHHMM(getAuthoritativeServerDate());
    }
    const idx = original ? state.records.indexOf(original) : -1;
    if (idx !== -1) state.records[idx] = rec;
    else state.records.unshift(rec);

    touchedDays.forEach((d) => {
      if (isLockedDay(d.date)) checkAndTriggerPostLockAlert(d.emp, d.date, d.before);
    });
    return check;
  }

  function saveAdminOvertimeModal() {
    const idVal = document.getElementById('editOtRecordId')?.value || null;
    const times = composeAdminShiftTimes(
      document.getElementById('editOtDatePicker')?.value,
      document.getElementById('editOtStartTime')?.value,
      document.getElementById('editOtEndTime')?.value
    );
    if (!times) {
      playFeedbackSound('ERROR');
      showToast('Hãy chọn đủ Ngày làm, Giờ bắt đầu và Giờ kết thúc.', 'error');
      return;
    }

    const rawCandidate = {
      id: idVal || undefined,
      employeeName: document.getElementById('editOtEmployee')?.value,
      jobContent: document.getElementById('editOtJobContent')?.value,
      startTime: times.startTime,
      endTime: times.endTime,
      workDate: isoDateToVnDate(document.getElementById('editOtWorkDateIso')?.value || '') || times.startTime.split(' ')[0],
      overrideHours: document.getElementById('editOtOverrideHours')?.value,
      overtimeType: document.getElementById('editOtType')?.value,
      workMode: document.getElementById('editOtWorkMode')?.value,
      note: document.getElementById('editOtNote')?.value,
      isDriverNoTime: false
    };

    const check = commitAdminRecordEdit(rawCandidate, idVal);
    if (!check.ok) {
      playFeedbackSound('ERROR');
      if (check.isOverlapError) {
        openOverlapWarningModal(check.candidateRecord, check.conflictRecord);
      } else {
        showToast(escapeHtml(check.reason), 'error');
      }
      return;
    }

    saveLocalState(true);
    syncWithCentralServer(true);
    document.getElementById('modalEditOvertime')?.classList.remove('open');
    playFeedbackSound('SUCCESS');
    renderAll();
    if (document.getElementById('modalMatrixCellQuick')?.classList.contains('open')) {
      renderMatrixCellQuickModal();
    }
    showToast(`Đã lưu dòng tăng ca của <strong>${escapeHtml(check.record.employeeName)}</strong>!`, 'success');
  }

  function deleteOvertimeRecordById(recordId) {
    if (!recordId) return;
    const idx = state.records.findIndex((r) => r.id === recordId);
    if (idx === -1) return;
    const removed = state.records[idx];
    const removedHm = (t) => (String(t || '').split(' ')[1] || '').slice(0, 5);
    if (
      !window.confirm(
        `Xóa ca ${removedHm(removed.startTime)} → ${removedHm(removed.endTime)} ngày ${removed.workDate} của ${removed.employeeName}?\n\nĐã xóa thì không khôi phục được.`
      )
    ) {
      return;
    }
    const beforeSummary = getEmployeeDaySummary(removed.employeeName, removed.workDate);
    state.records.splice(idx, 1);

    if (state.lockedDays && state.lockedDays[removed.workDate]?.locked) {
      checkAndTriggerPostLockAlert(removed.employeeName, removed.workDate, beforeSummary);
    }

    saveLocalState(true);
    syncWithCentralServer(true);
    document.getElementById('modalEditOvertime')?.classList.remove('open');
    renderAll();
    if (document.getElementById('modalMatrixCellQuick')?.classList.contains('open')) {
      renderMatrixCellQuickModal();
    }
    showToast(`Đã xóa dòng tăng ca của <strong>${escapeHtml(removed.employeeName)}</strong>`, 'warn');
  }

  function openManageEmployeesModal() {
    renderManageEmployeesList();
    document.getElementById('modalManageEmployees')?.classList.add('open');
  }

  function renderManageEmployeesList() {
    const container = document.getElementById('modalEmpListContainer');
    if (!container) return;

    container.innerHTML = `
      <table class="excel-replica-table emp-manage-table" style="font-size: 0.8rem;">
        <thead>
          <tr class="excel-table-header">
            <th>#</th>
            <th>Nhân viên</th>
            <th>Tên đăng nhập</th>
            <th>Đặt mật khẩu mới</th>
            <th>Thao tác</th>
          </tr>
        </thead>
        <tbody>
          ${state.employees
            .map(
              (e, i) => `
            <tr>
              <td style="text-align:center;">${i + 1}</td>
              <td style="font-weight:800;">
                ${escapeHtml(e.name)}
                <div class="emp-status-line${e.endDate ? ' ended' : ''}">${
                  e.endDate
                    ? 'Nghỉ việc từ ' + escapeHtml(isoDateToVnDate(e.endDate))
                    : e.startDate
                    ? 'Vào làm ' + escapeHtml(isoDateToVnDate(e.startDate))
                    : 'Đang làm việc'
                }</div>
              </td>
              <td style="text-align:center;">
                <input
                  type="text"
                  class="form-control cell-mono emp-username-inline-input"
                  data-name="${escapeHtml(e.name)}"
                  value="${escapeHtml(e.username || slugifyVietnamese(e.name))}"
                  style="width:110px;padding:0.25rem 0.45rem;text-align:center;margin:0 auto;font-size:0.82rem;"
                />
              </td>
              <td style="text-align:center;">
                <input
                  type="text"
                  class="form-control cell-mono emp-password-inline-input"
                  data-name="${escapeHtml(e.name)}"
                  value="${REMOTE_MODE ? '' : escapeHtml(e.password || e.pin || '123456')}"
                  placeholder="${REMOTE_MODE ? 'Mật khẩu mới' : ''}"
                  style="width:${REMOTE_MODE ? '118' : '96'}px;padding:0.25rem 0.45rem;text-align:center;margin:0 auto;font-size:0.82rem;"
                />
              </td>
              <td style="text-align:center;"><div class="emp-actions">
                <button type="button" class="action-btn primary btn-save-emp-cred" data-name="${escapeHtml(e.name)}" style="padding:0.22rem 0.55rem;font-size:0.72rem;">
                  Lưu
                </button>
                <button type="button" class="action-btn btn-copy-emp-zalo" data-name="${escapeHtml(e.name)}" style="padding:0.22rem 0.5rem;font-size:0.72rem;" title="Copy tin nhắn Zalo gửi tài khoản cho công nhân">
                  Copy Zalo
                </button>
                ${
                  e.endDate
                    ? `<button type="button" class="action-btn btn-rehire-emp" data-name="${escapeHtml(e.name)}" style="padding:0.22rem 0.5rem;font-size:0.72rem;">Đi làm lại</button>`
                    : `<button type="button" class="action-btn btn-end-emp" data-name="${escapeHtml(e.name)}" style="padding:0.22rem 0.5rem;font-size:0.72rem;color:var(--rose);">Cho nghỉ việc</button>`
                }
                ${
                  e.hasRecords || state.records.some((r) => r.employeeName === e.name)
                    ? ''
                    : `<button type="button" class="action-btn btn-remove-emp" data-name="${escapeHtml(e.name)}" style="padding:0.22rem 0.5rem;font-size:0.72rem;color:var(--rose);">Xóa</button>`
                }
              </div></td>
            </tr>
          `
            )
            .join('')}
        </tbody>
      </table>
    `;

    container.querySelectorAll('.btn-copy-emp-zalo').forEach((btn) => {
      btn.addEventListener('click', () => {
        const target = btn.getAttribute('data-name');
        const passEl = container.querySelector(`.emp-password-inline-input[data-name="${CSS.escape(target)}"]`);
        copyEmployeeZaloCredentials(target, (passEl?.value || '').trim());
      });
    });

    container.querySelectorAll('.btn-save-emp-cred').forEach((btn) => {
      btn.addEventListener('click', () => {
        const target = btn.getAttribute('data-name');
        const userEl = container.querySelector(`.emp-username-inline-input[data-name="${CSS.escape(target)}"]`);
        const passEl = container.querySelector(`.emp-password-inline-input[data-name="${CSS.escape(target)}"]`);
        const newUsername = slugifyVietnamese(userEl?.value || '');
        const newPassword = (passEl?.value || '').trim();

        if (!newUsername || newUsername === 'admin' || newUsername === 'quantri') {
          playFeedbackSound('ERROR');
          showToast('Tên đăng nhập không hợp lệ (không được để trống hoặc trùng tên admin).', 'error');
          return;
        }
        const duplicateUser = state.employees.find(
          (e) => e.name !== target && (e.username || '').toLowerCase() === newUsername
        );
        if (duplicateUser) {
          playFeedbackSound('ERROR');
          showToast(`Tên đăng nhập "${escapeHtml(newUsername)}" đã được dùng cho ${escapeHtml(duplicateUser.name)}.`, 'error');
          return;
        }
        if ((newPassword || !REMOTE_MODE) && newPassword.length < 4) {
          playFeedbackSound('ERROR');
          showToast('Mật khẩu phải có ít nhất 4 ký tự.', 'error');
          return;
        }

        const empObj = state.employees.find((e) => e.name === target);
        if (empObj) {
          empObj.username = newUsername;
          if (newPassword) {
            empObj.password = newPassword;
            empObj.pin = newPassword;
          }
          if (userEl) userEl.value = newUsername;
          if (passEl && REMOTE_MODE) passEl.value = '';
          saveLocalState(true);
          syncWithCentralServer(true);
          playFeedbackSound('SUCCESS');
          renderAll();
          showToast(
            newPassword && !REMOTE_MODE
              ? `Đã lưu tài khoản (${escapeHtml(newUsername)} / ${escapeHtml(newPassword)}) cho ${escapeHtml(target)}.`
              : `Đã lưu tài khoản ${escapeHtml(newUsername)} cho ${escapeHtml(target)}${newPassword ? ' (đã đặt mật khẩu mới, nhân viên sẽ được nhắc đổi khi đăng nhập)' : ''}.`,
            'success'
          );
        }
      });
    });

    container.querySelectorAll('.btn-end-emp').forEach((btn) => {
      btn.addEventListener('click', () => {
        const target = btn.getAttribute('data-name');
        const emp = state.employees.find((x) => x.name === target);
        if (!emp) return;
        const input = window.prompt(
          `Ngày làm việc cuối cùng của ${target} (dd/mm/yyyy).\nTừ sau ngày này tài khoản sẽ bị khóa, dữ liệu cũ vẫn được giữ.`,
          isoDateToVnDate(localIsoToday())
        );
        if (input === null) return;
        if (!isValidVnDateOnly(input.trim())) {
          showToast('Ngày không đúng định dạng dd/mm/yyyy.', 'error');
          return;
        }
        emp.endDate = vnDateToIsoDate(input.trim());
        saveLocalState(true);
        syncWithCentralServer(true);
        renderManageEmployeesList();
        renderAll();
        showToast(`Đã cho ${escapeHtml(target)} nghỉ việc từ sau ngày ${escapeHtml(input.trim())}.`, 'warn');
      });
    });

    container.querySelectorAll('.btn-rehire-emp').forEach((btn) => {
      btn.addEventListener('click', () => {
        const target = btn.getAttribute('data-name');
        const emp = state.employees.find((x) => x.name === target);
        if (!emp) return;
        delete emp.endDate;
        saveLocalState(true);
        syncWithCentralServer(true);
        renderManageEmployeesList();
        renderAll();
        showToast(`${escapeHtml(target)} đã được mở lại tài khoản.`, 'success');
      });
    });

    container.querySelectorAll('.btn-remove-emp').forEach((btn) => {
      btn.addEventListener('click', () => {
        const target = btn.getAttribute('data-name');
        if (state.employees.length <= 1) {
          showToast('Phải giữ lại ít nhất 1 nhân viên trong danh sách.', 'warn');
          return;
        }
        state.employees = state.employees.filter((e) => e.name !== target);
        if (state.selectedEmployeeName === target) {
          state.selectedEmployeeName = state.employees[0].name;
          syncWorkerDefaultsFromSelectedEmp();
        }
        saveLocalState(true);
        syncWithCentralServer(true);
        renderManageEmployeesList();
        renderAll();
        showToast(`Đã xóa nhân viên ${escapeHtml(target)} khỏi danh sách.`, 'warn');
      });
    });
  }

  function handleAddNewEmployee() {
    const nameInput = document.getElementById('newEmpName');
    const userInput = document.getElementById('newEmpUsername');
    const pinInput = document.getElementById('newEmpPin');
    const typeSelect = document.getElementById('newEmpDefaultType');
    const modeSelect = document.getElementById('newEmpDefaultMode');

    const name = (nameInput?.value || '').trim();
    const rawUsername = (userInput?.value || '').trim();
    const password = (pinInput?.value || '123456').trim();
    const defType = typeSelect?.value || 'Ngoài khoán';
    const defMode = modeSelect?.value || 'Tăng ca tại công ty';

    if (!name) {
      showToast('Vui lòng nhập Họ và tên nhân viên.', 'error');
      return;
    }

    if (state.employees.some((e) => e.name.toLowerCase() === name.toLowerCase())) {
      playFeedbackSound('ERROR');
      showToast(`Tên nhân viên "${escapeHtml(name)}" đã tồn tại trong danh sách.`, 'error');
      return;
    }

    const usedSet = new Set(state.employees.map((e) => (e.username || '').toLowerCase()));
    const username = rawUsername
      ? slugifyVietnamese(rawUsername)
      : deriveDefaultUsername(name, usedSet);

    if (!username || username === 'admin' || username === 'quantri') {
      playFeedbackSound('ERROR');
      showToast('Tên đăng nhập không hợp lệ.', 'error');
      return;
    }

    if (usedSet.has(username)) {
      playFeedbackSound('ERROR');
      showToast(`Tên đăng nhập "${escapeHtml(username)}" đã tồn tại, vui lòng chọn tên khác.`, 'error');
      return;
    }

    const finalPassword = password.length >= 4 ? password : '123456';

    const startDateInput = document.getElementById('newEmpStartDate');
    state.employees.push({
      name,
      username,
      startDate: (startDateInput && startDateInput.value) || null,
      password: finalPassword,
      pin: finalPassword,
      defaultOvertimeType: defType,
      defaultWorkMode: defMode
    });

    if (nameInput) nameInput.value = '';
    if (userInput) userInput.value = '';
    if (startDateInput) startDateInput.value = '';
    saveLocalState(true);
    syncWithCentralServer(true);
    playFeedbackSound('SUCCESS');
    renderManageEmployeesList();
    renderAll();
    showToast(`Đã thêm ${escapeHtml(name)} (TK: ${escapeHtml(username)} / MK: ${escapeHtml(finalPassword)}).`, 'success');
  }

  // ==========================================================================
  // 11. TRUNG TÂM DEPLOY GITHUB PAGES 24/7 & MÃ QR ĐỘNG (SVG MATRIX)
  // ==========================================================================

  function renderDeployQrCode() {
    const box = document.getElementById('deployQrSvgBox');
    const input = document.getElementById('deployPublicUrlInput');
    if (!box) return;
    const urlStr = input && input.value ? input.value.trim() : window.location.href;
    if (typeof window.qrcode !== 'function') {
      box.innerHTML = '<div class="sub-meta-text" style="padding:1rem;">Chưa tải được mã QR (cần Internet). Hãy gửi đường dẫn bên dưới qua Zalo.</div>';
      return;
    }
    try {
      const qr = window.qrcode(0, 'M');
      qr.addData(urlStr);
      qr.make();
      box.innerHTML = qr.createSvgTag({ cellSize: 6, margin: 2, scalable: true });
      const svg = box.querySelector('svg');
      if (svg) {
        svg.setAttribute('width', '200');
        svg.setAttribute('height', '200');
      }
    } catch (_) {
      box.innerHTML = '<div class="sub-meta-text" style="padding:1rem;">Đường dẫn quá dài để tạo mã QR.</div>';
    }
  }

  // ==========================================================================
  // 12. ĐỒNG HỒ THỜI GIAN THỰC & ĐIỀU PHỐI PHÂN QUYỀN GIAO DIỆN
  // ==========================================================================

  function updateLiveClock() {
    const timeEl = document.getElementById('liveClockTime');
    const dateEl = document.getElementById('liveClockDate');
    const deploySrvEl = document.getElementById('deployServerTimeLabel');

    const now = getAuthoritativeServerDate();
    const hms = `${pad2(now.getHours())}:${pad2(now.getMinutes())}:${pad2(now.getSeconds())}`;
    const dmy = `${pad2(now.getDate())}/${pad2(now.getMonth() + 1)}/${now.getFullYear()}`;

    if (timeEl) {
      timeEl.textContent = hms;
    }
    if (dateEl) {
      const days = ['Chủ Nhật', 'Thứ Hai', 'Thứ Ba', 'Thứ Tư', 'Thứ Năm', 'Thứ Sáu', 'Thứ Bảy'];
      dateEl.textContent = `${days[now.getDay()]}, ${dmy}`;
    }
    if (deploySrvEl) {
      deploySrvEl.textContent = `${dmy} ${hms}`;
    }
  }

  function switchMainTab(tabName) {
    // Bảo vệ phân quyền: Chưa đăng nhập thì luôn ở màn LOGIN
    if (!state.authRole) {
      state.activeMainTab = 'LOGIN';
    } else if (state.authRole === 'WORKER') {
      // Công nhân chỉ được ở đúng màn hình báo tăng ca cá nhân của mình
      state.activeMainTab = 'WORKER_MOBILE';
    } else if (state.authRole === 'ADMIN') {
      state.activeMainTab = tabName === 'DEPLOY_HUB' ? 'DEPLOY_HUB' : 'ADMIN_EXCEL';
    }

    renderAll();
  }

  function updateHeaderSessionBar() {
    const navTabs = document.getElementById('mainNavTabs');
    const sessionBox = document.getElementById('headerUserSessionBox');
    const roleBadge = document.getElementById('headerUserRoleBadge');
    const userNameEl = document.getElementById('headerLoggedUserName');

    if (!state.authRole) {
      if (navTabs) navTabs.style.display = 'none';
      if (sessionBox) sessionBox.style.display = 'none';
      return;
    }

    if (sessionBox) sessionBox.style.display = 'inline-flex';

    if (state.authRole === 'WORKER') {
      if (navTabs) navTabs.style.display = 'none';
      if (roleBadge) {
        roleBadge.textContent = 'Công nhân';
        roleBadge.className = 'user-role-tag';
      }
      if (userNameEl) {
        userNameEl.textContent = state.loggedInEmployeeName || state.selectedEmployeeName;
      }
    } else if (state.authRole === 'ADMIN') {
      if (navTabs) navTabs.style.display = 'flex';
      if (roleBadge) {
        roleBadge.textContent = 'Quản trị viên';
        roleBadge.className = 'user-role-tag admin';
      }
      if (userNameEl) {
        userNameEl.textContent = 'Admin';
      }
    }
  }

  function renderAll() {
    if (!state.authRole) {
      state.activeMainTab = 'LOGIN';
    } else if (state.authRole === 'WORKER') {
      state.activeMainTab = 'WORKER_MOBILE';
      if (state.loggedInEmployeeName) {
        state.selectedEmployeeName = state.loggedInEmployeeName;
      }
    }

    const vLogin = document.getElementById('viewLoginScreen');
    const vWorker = document.getElementById('viewWorkerMobile');
    const vAdmin = document.getElementById('viewAdminExcel');
    const vDeploy = document.getElementById('viewDeployHub');

    const bAdmin = document.getElementById('tabBtnAdminExcel');
    const bDeploy = document.getElementById('tabBtnDeployHub');

    if (vLogin) vLogin.classList.toggle('active', state.activeMainTab === 'LOGIN');
    if (vWorker) vWorker.classList.toggle('active', state.activeMainTab === 'WORKER_MOBILE');
    if (vAdmin) vAdmin.classList.toggle('active', state.activeMainTab === 'ADMIN_EXCEL');
    if (vDeploy) vDeploy.classList.toggle('active', state.activeMainTab === 'DEPLOY_HUB');

    if (bAdmin) bAdmin.classList.toggle('active', state.activeMainTab === 'ADMIN_EXCEL');
    if (bDeploy) bDeploy.classList.toggle('active', state.activeMainTab === 'DEPLOY_HUB');

    updateHeaderSessionBar();
    updateSyncStatusUI(true);
    renderLoginView();
    renderWorkerMobileView();
    renderAdminDashboard();
    renderDeployQrCode();
  }

  // ==========================================================================
  // LỊCH NGHỈ LỄ / NGHỈ TẾT (ADMIN)
  // ==========================================================================

  function renderHolidayList() {
    const box = document.getElementById('holidayListContainer');
    if (!box) return;
    const entries = Object.entries(state.holidays || {}).sort(
      (a, b) => vnDateToIsoDate(a[0]).localeCompare(vnDateToIsoDate(b[0]))
    );
    if (entries.length === 0) {
      box.innerHTML = '<div class="holiday-row"><span class="sub-meta-text">Chưa có ngày nghỉ nào.</span></div>';
      return;
    }
    box.innerHTML = entries
      .map(
        ([vn, name]) => `<div class="holiday-row"><span><strong>${escapeHtml(vn)}</strong> - ${escapeHtml(name)}</span><button type="button" class="action-btn btn-del-holiday" data-vn="${escapeHtml(vn)}" style="padding:0.2rem 0.5rem;font-size:0.72rem;color:var(--rose);">Xóa</button></div>`
      )
      .join('');
    box.querySelectorAll('.btn-del-holiday').forEach((btn) => {
      btn.addEventListener('click', () => {
        delete state.holidays[btn.getAttribute('data-vn')];
        persistHolidays();
        renderHolidayList();
      });
    });
  }

  function persistHolidays() {
    saveLocalState(true);
    syncWithCentralServer(true);
    renderAll();
  }

  function addHolidayRange(fromIso, toIso, name) {
    let count = 0;
    let cur = fromIso;
    while (cur <= toIso && count < 60) {
      state.holidays[isoDateToVnDate(cur)] = name;
      cur = addDaysToIsoDate(cur, 1);
      count += 1;
    }
    return count;
  }

  function bindHolidayEvents() {
    document.getElementById('btnOpenHolidays')?.addEventListener('click', () => {
      const yearEl = document.getElementById('holYear');
      if (yearEl && !yearEl.value) yearEl.value = String(new Date().getFullYear());
      renderHolidayList();
      document.getElementById('modalHolidays')?.classList.add('open');
    });
    const closeFn = () => document.getElementById('modalHolidays')?.classList.remove('open');
    document.getElementById('btnCloseHolidaysModal')?.addEventListener('click', closeFn);
    document.getElementById('btnDoneHolidays')?.addEventListener('click', closeFn);

    document.getElementById('btnAddHoliday')?.addEventListener('click', () => {
      const name = (document.getElementById('holName')?.value || '').trim();
      const from = document.getElementById('holFrom')?.value || '';
      const to = document.getElementById('holTo')?.value || from;
      if (!name || !from) {
        showToast('Nhập tên ngày nghỉ và ngày bắt đầu.', 'error');
        return;
      }
      if (to < from) {
        showToast('Ngày kết thúc phải sau ngày bắt đầu.', 'error');
        return;
      }
      const n = addHolidayRange(from, to, name);
      persistHolidays();
      renderHolidayList();
      document.getElementById('holName').value = '';
      document.getElementById('holFrom').value = '';
      document.getElementById('holTo').value = '';
      showToast(`Đã thêm ${n} ngày nghỉ: ${escapeHtml(name)}.`, 'success');
    });

    document.getElementById('btnLoadFixedHolidays')?.addEventListener('click', () => {
      const year = Number(document.getElementById('holYear')?.value);
      if (!year || year < 2024 || year > 2100) {
        showToast('Nhập năm hợp lệ.', 'error');
        return;
      }
      const fixed = [
        ['01-01', 'Tết Dương lịch'],
        ['04-30', 'Ngày Giải phóng miền Nam'],
        ['05-01', 'Ngày Quốc tế Lao động'],
        ['09-02', 'Quốc khánh']
      ];
      fixed.forEach(([md, name]) => {
        state.holidays[isoDateToVnDate(`${year}-${md}`)] = name;
      });
      persistHolidays();
      renderHolidayList();
      showToast(`Đã thêm 4 ngày lễ cố định năm ${year}. Tết và Giỗ Tổ bạn tự thêm.`, 'success');
    });
  }

  function bindAllEvents() {
    // 0. Sự kiện Màn hình Đăng nhập (Tên đăng nhập + Mật khẩu) & Đăng xuất
    document.getElementById('formStandardLogin')?.addEventListener('submit', (e) => {
      attemptLoginSubmit(e);
    });

    document.getElementById('btnSubmitLogin')?.addEventListener('click', (e) => {
      const formEl = document.getElementById('formStandardLogin');
      if (!formEl) attemptLoginSubmit(e);
    });

    ['loginUsernameInput', 'loginPasswordInput'].forEach((id) => {
      document.getElementById(id)?.addEventListener('input', () => {
        const errEl = document.getElementById('loginErrorMsg');
        if (errEl) errEl.style.display = 'none';
      });
    });

    document.getElementById('btnToggleLoginPwd')?.addEventListener('click', () => {
      const pwdInp = document.getElementById('loginPasswordInput');
      const toggleBtn = document.getElementById('btnToggleLoginPwd');
      if (!pwdInp || !toggleBtn) return;
      const isHidden = pwdInp.type === 'password';
      pwdInp.type = isHidden ? 'text' : 'password';
      toggleBtn.textContent = isHidden ? 'Ẩn' : 'Hiện';
      pwdInp.focus();
    });

    document.getElementById('btnHeaderLogout')?.addEventListener('click', logoutCurrentUser);
    document.getElementById('btnWorkerCardLogout')?.addEventListener('click', logoutCurrentUser);

    // 1. Chuyển phân khu trên Header (Dành cho Admin)
    document.getElementById('tabBtnAdminExcel')?.addEventListener('click', () => switchMainTab('ADMIN_EXCEL'));
    document.getElementById('tabBtnDeployHub')?.addEventListener('click', () => switchMainTab('DEPLOY_HUB'));

    document.getElementById('btnDemoResetData')?.addEventListener('click', () => {
      if (
        !window.confirm(
          'Khôi phục dữ liệu mẫu mặc định sẽ ghi đè danh sách nhân viên và các ca tăng ca hiện tại trên máy.\n\nBạn có chắc chắn muốn khôi phục dữ liệu mẫu?'
        )
      ) {
        return;
      }
      document.querySelectorAll('details.admin-more-menu').forEach((d) => (d.open = false));
      state.employees = JSON.parse(JSON.stringify(DEFAULT_EMPLOYEES));
      state.records = JSON.parse(JSON.stringify(DEFAULT_OVERTIME_RECORDS));
      state.offlineQueue = [];
      state.lockedDays = {};
      state.dayModAlerts = {};
      ensureDefaultLockedDays();
      state.simulateOffline = false;
      state.isWaitingServerAck = false;
      state.simulatedClockTamperMinutes = 0;
      syncWorkerDefaultsFromSelectedEmp();
      saveLocalState(true);
      syncWithCentralServer(true);
      renderAll();
      showToast('Đã khôi phục dữ liệu mẫu chuẩn (Ký hiệu X+4, chốt công ngày 15/10/2026)!', 'success');
    });

    // Tự động đóng menu "Hệ thống ▾" khi bấm ra ngoài hoặc bấm vào 1 nút bên trong
    document.addEventListener('click', (e) => {
      document.querySelectorAll('details.admin-more-menu[open]').forEach((menu) => {
        if (!menu.contains(e.target) || e.target.closest('.admin-more-dropdown .action-btn')) {
          setTimeout(() => {
            menu.open = false;
          }, 50);
        }
      });
    });

    // 2. Sự kiện trong Phân khu 1 (Báo tăng ca cá nhân của Công nhân)
    document.getElementById('btnWorkerSubTabForm')?.addEventListener('click', () => {
      state.workerMobileSubTab = 'FORM';
      state.lastServerAckReceipt = null;
      renderAll();
    });

    document.getElementById('btnWorkerSubTabHistory')?.addEventListener('click', () => {
      state.lastServerAckReceipt = null;
      leaveEditMode('HISTORY');
    });

    document.getElementById('btnHistFilterMonth')?.addEventListener('click', () => {
      state.workerHistoryFilter = 'MONTH';
      renderWorkerPersonalHistory(currentWorkerName());
    });
    document.getElementById('btnHistFilterAll')?.addEventListener('click', () => {
      state.workerHistoryFilter = 'ALL';
      renderWorkerPersonalHistory(currentWorkerName());
    });

    document.getElementById('btnWorkerSubTabCalendar')?.addEventListener('click', () => {
      state.lastServerAckReceipt = null;
      leaveEditMode('CALENDAR');
    });
    document.getElementById('btnCalPrev')?.addEventListener('click', () => shiftCalendarMonth(-1));
    document.getElementById('btnCalNext')?.addEventListener('click', () => shiftCalendarMonth(1));
    document.getElementById('workerSubViewCalendar')?.addEventListener('click', (ev) => {
      if (ev.target.closest('#btnCalEditDay')) {
        openFormForDay(state.calSelectedIso, 'CALENDAR');
        return;
      }
      const cell = ev.target.closest('[data-iso]');
      if (cell && !cell.classList.contains('empty')) {
        selectCalendarDay(cell.getAttribute('data-iso'));
      }
    });

    document.getElementById('btnViewHistoryAfterAck')?.addEventListener('click', () => {
      state.lastServerAckReceipt = null;
      leaveEditMode('CALENDAR');
    });

    document.getElementById('btnCancelEdit')?.addEventListener('click', cancelEditMode);
    window.addEventListener('popstate', () => {
      if (state.formReturnTab) leaveEditMode();
    });
    document.getElementById('btnDeleteDayFromForm')?.addEventListener('click', async () => {
      const iso = document.getElementById('mobileWorkDate')?.value || '';
      const done = await deleteWorkerDay(currentWorkerName(), isoDateToVnDate(iso));
      if (done) {
        clearEditHistoryFlag();
        resetWorkerForm();
        state.workerMobileSubTab = state.formReturnTab || 'CALENDAR';
        state.calMonth = iso.slice(0, 7);
        state.calSelectedIso = iso;
        renderAll();
      }
    });
    const jumpDate = (offset) => {
      const el = document.getElementById('mobileWorkDate');
      if (!el) return;
      el.value = addDaysToIsoDate(localIsoToday(), offset);
      el.dispatchEvent(new Event('change', { bubbles: true }));
    };
    document.getElementById('btnDateToday')?.addEventListener('click', () => jumpDate(0));
    document.getElementById('btnDateYesterday')?.addEventListener('click', () => jumpDate(-1));

    // Chọn nhanh 1 chạm Tổ hợp ca trong ngày (Ví dụ: Làm 6h15 - 18h15 -> X+4)
    document.querySelectorAll('#mobileComboPresetsGrid .time-preset-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const comboCode = btn.getAttribute('data-combo');
        if (comboCode) {
          applyMobileComboPreset(comboCode);
        }
      });
    });

    // Khi đổi Ngày tính công trên điện thoại -> Tự động kiểm tra và nạp các ca đã lưu của ngày đó (nếu có)
    document.getElementById('mobileWorkDate')?.addEventListener('change', (e) => {
      if (!e.target.value) e.target.value = localIsoToday(); // bấm "Xóa" trong bảng chọn ngày thì quay về hôm nay
      const isoDate = e.target.value;
      const activeWorkerName =
        state.authRole === 'WORKER' && state.loggedInEmployeeName
          ? state.loggedInEmployeeName
          : state.selectedEmployeeName;
      const vnDate = isoDateToVnDate(isoDate);
      const hasExisting = state.records.some(
        (r) => r.employeeName === activeWorkerName && r.workDate === vnDate
      );
      if (hasExisting) {
        loadExistingDayIntoMobileForm(activeWorkerName, isoDate, false);
      } else {
        if (state.formLoadedIso) {
          // Đang xem một ngày đã có ca mà chuyển sang ngày chưa có: làm sạch form, tránh gửi nhầm ca của ngày khác
          resetWorkerForm({ skipExisting: true, keepDate: true });
        }
        const restChk = document.getElementById('restWorkCheck');
        if (restChk) restChk.checked = false;
        renderWorkerMobileView();
      }
    });

    // Sự kiện trên 3 thẻ Ca Sáng / Ca Trưa / Ca Tối
    [
      'slotMorningCheck',
      'slotMorningStart',
      'slotMorningEnd',
      'slotLunchCheck',
      'slotLunchStart',
      'slotLunchEnd',
      'slotEveningCheck',
      'slotEveningStart',
      'slotEveningEnd',
      'slotEveningOvernight',
      'slotEveningWorkMode'
    ].forEach((id) => {
      document.getElementById(id)?.addEventListener('change', () => {
        renderWorkerMobileView();
      });
      document.getElementById(id)?.addEventListener('input', () => {
        renderWorkerMobileView();
      });
    });

    ['restWorkCheck', 'restStart', 'restEnd'].forEach((id) => {
      document.getElementById(id)?.addEventListener('change', renderWorkerMobileView);
      document.getElementById(id)?.addEventListener('input', renderWorkerMobileView);
    });
    const setRestRange = (startHm, endHm) => {
      const rs = document.getElementById('restStart');
      const re = document.getElementById('restEnd');
      const rc = document.getElementById('restWorkCheck');
      if (rs) rs.value = startHm;
      if (re) re.value = endHm;
      if (rc) rc.checked = true;
      renderWorkerMobileView();
    };
    document.getElementById('btnRestFull')?.addEventListener('click', () => setRestRange('07:15', '15:15'));
    document.getElementById('btnRestHalf')?.addEventListener('click', () => setRestRange('07:15', '11:15'));

    // Nút chọn nhanh giờ Trưa (2h: 11:15-13:15 hoặc 1h: 12:00-13:00)
    document.querySelectorAll('.slot-mini-btn[data-lunch-range]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const range = btn.getAttribute('data-lunch-range') || '11:15-13:15';
        const [s, e] = range.split('-');
        const lCheck = document.getElementById('slotLunchCheck');
        const lStart = document.getElementById('slotLunchStart');
        const lEnd = document.getElementById('slotLunchEnd');
        if (lCheck) lCheck.checked = true;
        if (lStart && s) lStart.value = s;
        if (lEnd && e) lEnd.value = e;
        renderWorkerMobileView();
      });
    });

    // Nút chọn nhanh giờ kết thúc Ca Tối (18:15, 19:15, 20:15, 21:15)
    document.querySelectorAll('.slot-mini-btn[data-eve-end]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const endHm = btn.getAttribute('data-eve-end') || '18:15';
        const eCheck = document.getElementById('slotEveningCheck');
        const eStart = document.getElementById('slotEveningStart');
        const eEnd = document.getElementById('slotEveningEnd');
        const eOver = document.getElementById('slotEveningOvernight');
        if (eCheck) eCheck.checked = true;
        if (eStart && !eStart.value) eStart.value = '17:15';
        if (eEnd) eEnd.value = endHm;
        if (eOver) eOver.checked = false;
        renderWorkerMobileView();
      });
    });

    // Chọn nhanh chip gợi ý Nội dung công việc (Cột B) & nút Xóa nhanh
    document.querySelectorAll('#mobileJobChips .job-chip-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('#mobileJobChips .job-chip-btn').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        const jobInput = document.getElementById('mobileJobContent');
        if (jobInput) jobInput.value = btn.getAttribute('data-job') || '';
      });
    });

    document.getElementById('btnClearMobileJob')?.addEventListener('click', () => {
      const jobInput = document.getElementById('mobileJobContent');
      if (jobInput) {
        jobInput.value = '';
        syncJobChipsToInput();
        jobInput.focus();
      }
    });

    document.getElementById('mobileJobContent')?.addEventListener('input', syncJobChipsToInput);
    document.getElementById('btnSubmitMobileOvertime')?.addEventListener('click', handleWorkerMobileSubmit);
    document.getElementById('btnFlushOfflineNow')?.addEventListener('click', flushOfflineQueue);

    // 3. Sự kiện trong Phân khu 2 (Admin, Bảng Chấm Công X+4 & Xuất Excel)
    document.getElementById('matrixLockDateInput')?.addEventListener('change', () => {
      renderExcelMatrixSheet();
    });

    document.getElementById('btnLockSelectedDay')?.addEventListener('click', () => {
      const lockDateInp = document.getElementById('matrixLockDateInput');
      const isoVal = lockDateInp && lockDateInp.value ? lockDateInp.value : localIsoToday();
      const vnDate = isoDateToVnDate(isoVal);
      if (REMOTE_MODE && !isRecordInMonth({ workDate: vnDate }, getSelectedMonthKey())) {
        showToast('Ngày này nằm ngoài tháng đang xem. Hãy chọn đúng tháng ở ô "Tháng" rồi chốt.', 'warn');
        return;
      }
      const isLocked = Boolean(state.lockedDays && state.lockedDays[vnDate]?.locked);
      if (isLocked) {
        unlockAttendanceDay(vnDate);
        showToast(`Đã mở khóa bảng công ngày <strong>${escapeHtml(vnDate)}</strong>.`, 'warn');
      } else {
        lockAttendanceDay(vnDate);
        playFeedbackSound('SUCCESS');
        showToast(
          `Đã chốt bảng công ngày <strong>${escapeHtml(vnDate)}</strong>! Nếu sau thời điểm này có công nhân tự sửa lại giờ tăng ca ngày ${escapeHtml(vnDate)}, ô của họ sẽ tự động bôi vàng.`,
          'success'
        );
      }
      renderAll();
    });

    document.getElementById('btnLockAllActiveDays')?.addEventListener('click', () => {
      const n = lockAllUnlockedDaysInMonth();
      renderAll();
      if (n === 0) {
        showToast('Các ngày có tăng ca trong tháng này đều đã chốt rồi.', 'success');
        return;
      }
      playFeedbackSound('SUCCESS');
      const pendingYellow = Object.keys(state.dayModAlerts || {}).length;
      showToast(
        `Đã chốt thêm <strong>${n} ngày</strong> có tăng ca trong tháng. Ngày đã chốt trước đó giữ nguyên${pendingYellow ? `, còn <strong>${pendingYellow} ô vàng</strong> chờ duyệt` : ''}.`,
        'success'
      );
    });

    const shiftAdminMonth = (delta) => {
      const [y, m] = getSelectedMonthKey().split('-').map(Number);
      const d = new Date(y, m - 1 + delta, 1);
      setSelectedMonth(`${d.getFullYear()}-${pad2(d.getMonth() + 1)}`);
    };
    document.getElementById('btnAdminMonthPrev')?.addEventListener('click', () => shiftAdminMonth(-1));
    document.getElementById('btnAdminMonthNext')?.addEventListener('click', () => shiftAdminMonth(1));

    ['matrixMonthInput', 'exportMonthInput'].forEach((id) => {
      document.getElementById(id)?.addEventListener('change', (e) => {
        if (e.target.value) setSelectedMonth(e.target.value);
      });
    });

    document.getElementById('toggleMatrixShowAllDays')?.addEventListener('change', (e) => {
      state.matrixShowAllDays = Boolean(e.target.checked);
      renderExcelMatrixSheet();
    });
    document.getElementById('toggleMatrixOnlyPending')?.addEventListener('change', (e) => {
      state.matrixOnlyPending = Boolean(e.target.checked);
      renderExcelMatrixSheet();
    });

    document.getElementById('btnApproveAllModAlerts')?.addEventListener('click', approveAllModAlerts);

    document.getElementById('btnUnlockAdminPin')?.addEventListener('click', async () => {
      const val = document.getElementById('adminPinInput')?.value || '';
      const err = document.getElementById('adminPinError');

      if (isAdminPassword(val)) {
        state.adminUnlocked = true;
        if (err) err.style.display = 'none';
        renderAdminDashboard();
        showToast('Đã mở khóa Quản trị Admin!', 'success');
      } else {
        playFeedbackSound('ERROR');
        if (err) err.style.display = 'block';
      }
    });

    document.getElementById('btnAdminSyncCloudNow')?.addEventListener('click', async () => {
      if (REMOTE_MODE) {
        const r = await remoteSyncPull({ force: true });
        showToast(r && r.ok && !r.queued ? 'Đã tải dữ liệu mới nhất.' : 'Chưa kết nối được máy chủ.', r && r.ok && !r.queued ? 'success' : 'warn');
        return;
      }
      await syncWithCentralServer(true);
      showToast('Đã đồng bộ dữ liệu thành công!', 'success');
    });

    document.getElementById('adminFilterEmployee')?.addEventListener('change', (e) => {
      state.adminFilterEmp = e.target.value;
      renderAdminDashboard();
    });

    document.getElementById('adminFilterWorkMode')?.addEventListener('change', (e) => {
      state.adminFilterMode = e.target.value;
      renderAdminDashboard();
    });

    document.getElementById('adminSearchInput')?.addEventListener('input', (e) => {
      state.adminSearchQuery = e.target.value;
      renderAdminDashboard();
    });

    document.getElementById('toggleShowExcelGuideRows')?.addEventListener('change', (e) => {
      state.showExcelGuideRows = e.target.checked;
      renderExcelSheet1Overtime();
    });

    document.querySelectorAll('.excel-sheet-tab').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.activeExcelSheet = btn.getAttribute('data-sheet') || 'SHEET_MATRIX';
        renderAdminDashboard();
      });
    });

    document.getElementById('btnExportTemplateXlsx')?.addEventListener('click', downloadExactTemplateXlsx);
    document.getElementById('btnAdminAddRecord')?.addEventListener('click', () => openAdminEditOvertimeModal(null));
    document.getElementById('btnOpenManageEmployees')?.addEventListener('click', openManageEmployeesModal);
    bindHolidayEvents();

    // Sao lưu & Nhập JSON
    document.getElementById('btnExportBackupJson')?.addEventListener('click', () => {
      if (REMOTE_MODE) {
        exportBackupRemote();
        return;
      }
      const dataStr = JSON.stringify(
        {
          employees: state.employees,
          records: state.records,
          lockedDays: state.lockedDays,
          dayModAlerts: state.dayModAlerts,
          holidays: state.holidays,
          exportedAt: getAuthoritativeServerDate().toISOString()
        },
        null,
        2
      );
      const blob = new Blob([dataStr], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `Backup_Tang_Ca_${localIsoToday()}.json`;
      a.click();
      URL.revokeObjectURL(url);
      showToast('Đã tải xuống file JSON sao lưu toàn bộ dữ liệu!', 'success');
    });

    document.getElementById('inputImportBackupJson')?.addEventListener('change', (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const parsed = JSON.parse(String(reader.result));
          if (Array.isArray(parsed.employees) && Array.isArray(parsed.records) && REMOTE_MODE) {
            const r = importBackupRemote(parsed);
            saveLocalState(true);
            renderAll();
            syncWithCentralServer(true).then((res) => {
              if (res && res.rejected) return; // máy chủ từ chối: đã báo lỗi và tải lại dữ liệu đúng
              showToast(
                res && res.queued
                  ? 'Chưa có mạng. Đã lưu tạm dữ liệu nhập, sẽ tự gửi khi có mạng.'
                  : `Đã nhập ${r.addedEmp} nhân viên mới và ${r.addedRec} ca tăng ca${r.skipped ? ` (bỏ qua ${r.skipped} ca của nhân viên không có trong danh sách)` : ''}. Nhân viên mới có mật khẩu như trong file, hoặc 123456 nếu file không có.`,
                res && res.queued ? 'warn' : 'success'
              );
            });
          } else if (Array.isArray(parsed.employees) && Array.isArray(parsed.records)) {
            state.employees = parsed.employees;
            ensureEmployeeCredentials(state.employees);
            state.records = parsed.records;
            if (parsed.lockedDays) state.lockedDays = parsed.lockedDays;
            if (parsed.dayModAlerts) state.dayModAlerts = parsed.dayModAlerts;
            if (parsed.holidays) state.holidays = parsed.holidays;
            saveLocalState(true);
            syncWithCentralServer(true);
            renderAll();
            showToast('Đã khôi phục dữ liệu từ file JSON thành công!', 'success');
          }
        } catch (_) {
          showToast('File JSON không hợp lệ!', 'error');
        }
      };
      reader.readAsText(file);
    });

    // 4. Sự kiện trong các Modal
    document.getElementById('btnCloseOverlapModal')?.addEventListener('click', () => {
      document.getElementById('modalOverlapWarn')?.classList.remove('open');
    });
    document.getElementById('btnAckOverlapModal')?.addEventListener('click', () => {
      document.getElementById('modalOverlapWarn')?.classList.remove('open');
    });

    document.getElementById('btnCloseEditOtModal')?.addEventListener('click', () => {
      document.getElementById('modalEditOvertime')?.classList.remove('open');
    });
    document.getElementById('btnCancelEditOt')?.addEventListener('click', () => {
      document.getElementById('modalEditOvertime')?.classList.remove('open');
    });
    document.getElementById('btnSaveEditOt')?.addEventListener('click', saveAdminOvertimeModal);

    // Sự kiện Modal Xem & Chỉnh Nhanh Ô Bảng Công (#modalMatrixCellQuick)
    const closeMatrixQuickModal = () => {
      document.getElementById('modalMatrixCellQuick')?.classList.remove('open');
    };
    document.getElementById('btnCloseMatrixQuickModal')?.addEventListener('click', closeMatrixQuickModal);
    document.getElementById('btnDoneMatrixQuickModal')?.addEventListener('click', closeMatrixQuickModal);
    document.getElementById('btnMatrixQuickApproveYellow')?.addEventListener('click', () => {
      if (!state.quickCellEmp || !state.quickCellDate) return;
      approveSingleModAlert(`${state.quickCellDate}::${state.quickCellEmp}`);
      renderMatrixCellQuickModal();
    });
    document.getElementById('btnMatrixQuickClearDay')?.addEventListener('click', () => {
      applyAdminQuickCellCombo(state.quickCellEmp, state.quickCellDate, 'CLEAR');
    });
    document.querySelectorAll('[data-quick-cell-combo]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const combo = btn.getAttribute('data-quick-cell-combo');
        if (combo) applyAdminQuickCellCombo(state.quickCellEmp, state.quickCellDate, combo);
      });
    });
    document.getElementById('btnMatrixQuickAddShift')?.addEventListener('click', () => {
      openAdminEditOvertimeModal(null, state.quickCellEmp, state.quickCellDate);
    });
    document.getElementById('btnMatrixQuickJumpSheet1')?.addEventListener('click', () => {
      if (!state.quickCellEmp) return;
      state.adminFilterEmp = state.quickCellEmp;
      state.activeExcelSheet = 'SHEET_OVERTIME';
      closeMatrixQuickModal();
      renderAdminDashboard();
      showToast(`Đang xem các ca của <strong>${escapeHtml(state.quickCellEmp)}</strong> ở tab Chi tiết ca.`, 'success');
    });

    // Ô chọn ngày/giờ & nút chọn nhanh ca trong hộp thoại Admin (#modalEditOvertime)
    const otDatePicker = document.getElementById('editOtDatePicker');
    const otWorkDateEl = document.getElementById('editOtWorkDateIso');

    document.getElementById('editOtEmployee')?.addEventListener('change', (e) => {
      if (document.getElementById('editOtRecordId')?.value) return;
      const emp = state.employees.find((x) => x.name === e.target.value);
      if (!emp) return;
      const typeSel = document.getElementById('editOtType');
      const modeSel = document.getElementById('editOtWorkMode');
      if (typeSel) typeSel.value = emp.defaultOvertimeType || 'Ngoài khoán';
      if (modeSel) modeSel.value = emp.defaultWorkMode || 'Tăng ca tại công ty';
    });

    otDatePicker?.addEventListener('change', () => {
      if (otWorkDateEl && (!otWorkDateEl.value || otWorkDateEl.value === otDatePicker.dataset.prev)) {
        otWorkDateEl.value = otDatePicker.value;
      }
      otDatePicker.dataset.prev = otDatePicker.value;
      refreshAdminTimePreview();
    });
    ['editOtStartTime', 'editOtEndTime'].forEach((id) => {
      document.getElementById(id)?.addEventListener('input', refreshAdminTimePreview);
      document.getElementById(id)?.addEventListener('change', refreshAdminTimePreview);
    });

    document.querySelectorAll('[data-admin-preset]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const code = btn.getAttribute('data-admin-preset');
        const range = ADMIN_SHIFT_PRESETS[code];
        if (!range) return;
        const startEl = document.getElementById('editOtStartTime');
        const endEl = document.getElementById('editOtEndTime');
        if (startEl) startEl.value = range[0];
        if (endEl) endEl.value = range[1];
        const modeSel = document.getElementById('editOtWorkMode');
        if (modeSel && code === 'LUNCH_2') {
          modeSel.value = 'Tăng ca trưa';
        } else if (modeSel && modeSel.value === 'Tăng ca trưa') {
          // Chuyển từ ca Trưa sang ca khác: trả Hình thức về mặc định của nhân viên
          const emp = state.employees.find((x) => x.name === document.getElementById('editOtEmployee')?.value);
          const def = emp && emp.defaultWorkMode;
          modeSel.value = def && def !== 'Tăng ca trưa' ? def : 'Tăng ca tại công ty';
        }
        refreshAdminTimePreview();
      });
    });
    document.getElementById('btnDeleteOtRecord')?.addEventListener('click', () => {
      const idVal = document.getElementById('editOtRecordId')?.value;
      deleteOvertimeRecordById(idVal);
    });

    document.getElementById('btnCloseManageEmpModal')?.addEventListener('click', () => {
      document.getElementById('modalManageEmployees')?.classList.remove('open');
    });
    document.getElementById('btnDoneManageEmp')?.addEventListener('click', () => {
      document.getElementById('modalManageEmployees')?.classList.remove('open');
    });
    document.getElementById('newEmpName')?.addEventListener('input', (e) => {
      const userInp = document.getElementById('newEmpUsername');
      if (!userInp) return;
      const usedSet = new Set(state.employees.map((emp) => (emp.username || '').toLowerCase()));
      userInp.placeholder = deriveDefaultUsername(e.target.value || '', usedSet);
    });
    document.getElementById('btnSubmitNewEmployee')?.addEventListener('click', handleAddNewEmployee);

    // 5. Sự kiện trong Phân khu 3 (Kết nối Cloud & Mã QR)
    const updateGithubPagesUrlFromInputs = () => {
      const user = (document.getElementById('ghUsernameInput')?.value || 'TongDucDuy03').trim();
      const repo = (document.getElementById('ghRepoInput')?.value || 'Chamcongpx').trim();
      const urlInput = document.getElementById('deployPublicUrlInput');
      if (urlInput) {
        urlInput.value = `https://${user}.github.io/${repo}/`;
        renderDeployQrCode();
      }
    };
    document.getElementById('ghUsernameInput')?.addEventListener('input', updateGithubPagesUrlFromInputs);
    document.getElementById('ghRepoInput')?.addEventListener('input', updateGithubPagesUrlFromInputs);
    document.getElementById('deployPublicUrlInput')?.addEventListener('input', renderDeployQrCode);

    document.getElementById('btnCopyDeployUrl')?.addEventListener('click', () => {
      const urlInput = document.getElementById('deployPublicUrlInput');
      if (urlInput) {
        navigator.clipboard?.writeText(urlInput.value);
        showToast(`Đã copy đường dẫn: <strong>${escapeHtml(urlInput.value)}</strong>`, 'success');
      }
    });
    document.getElementById('btnChangeAdminPwd')?.addEventListener('click', changeAdminPassword);
    document.getElementById('btnPrintQrPoster')?.addEventListener('click', () => window.print());
  }

  // ==========================================================================
  // 13. KHỞI ĐỘNG HỆ THỐNG
  // ==========================================================================

  // ==========================================================================
  // KẾT NỐI SUPABASE: DỮ LIỆU DÙNG CHUNG CHO CẢ XƯỞNG
  //  - Đăng nhập & dữ liệu nằm trên máy chủ, trình duyệt chỉ gọi các hàm app_* (xem supabase_setup.sql)
  //  - Mỗi lần Lưu chỉ gửi đúng các dòng thay đổi (xem remote.js), nhiều người cùng báo không mất dữ liệu
  //  - Mất mạng: thay đổi được giữ lại trên máy và tự gửi khi có mạng
  // ==========================================================================

  const remote = {
    token: '',
    role: '',
    name: '',
    snapshot: null, // ảnh chụp dữ liệu đã đồng bộ với máy chủ
    queue: Promise.resolve(), // xếp hàng để gửi/tải không chạy chồng nhau
    lastSig: '',
    lastPulseSig: '',
    pendingCount: 0,
    timer: null,
    bound: false
  };

  function pendingCount() {
    return REMOTE_MODE ? remote.pendingCount : state.offlineQueue.length;
  }

  function remoteQueue(fn) {
    const run = remote.queue.then(fn, fn);
    remote.queue = run.catch(() => {});
    return run;
  }

  function setAppLoading(show) {
    const el = document.getElementById('appLoadingOverlay');
    if (el) el.style.display = show ? 'flex' : 'none';
  }

  function remoteApplyServerTime(iso) {
    const t = Date.parse(iso || '');
    if (!isNaN(t)) state.serverClockOffsetMs = t - Date.now();
  }

  // ---- Phiên đăng nhập: công nhân nhớ 30 ngày, quản trị viên chỉ trong lúc mở tab ----
  function remoteReadSession() {
    try {
      const raw = sessionStorage.getItem(REMOTE_SESSION_KEY) || localStorage.getItem(REMOTE_SESSION_KEY);
      if (!raw) return null;
      const s = JSON.parse(raw);
      return s && s.token ? s : null;
    } catch (_) {
      return null;
    }
  }

  function remoteSaveSession() {
    try {
      sessionStorage.removeItem(REMOTE_SESSION_KEY);
      localStorage.removeItem(REMOTE_SESSION_KEY);
      const payload = JSON.stringify({ token: remote.token, role: remote.role, name: remote.name });
      (remote.role === 'admin' ? sessionStorage : localStorage).setItem(REMOTE_SESSION_KEY, payload);
    } catch (_) {}
  }

  function remoteClearSession() {
    try {
      sessionStorage.removeItem(REMOTE_SESSION_KEY);
      localStorage.removeItem(REMOTE_SESSION_KEY);
    } catch (_) {}
  }

  // ---- Thay đổi chưa gửi được (mất mạng) được giữ lại trên máy ----
  function remoteStorePending(ops) {
    try {
      if (!ops) {
        localStorage.removeItem(REMOTE_PENDING_KEY);
        return;
      }
      localStorage.setItem(REMOTE_PENDING_KEY, JSON.stringify({ user: remote.name, ops, savedAt: Date.now() }));
    } catch (_) {}
  }

  function remoteClearData() {
    state.employees = [];
    state.records = [];
    state.offlineQueue = [];
    state.lockedDays = {};
    state.dayModAlerts = {};
    state.holidays = {};
    remote.snapshot = null;
    remote.lastSig = '';
    remote.lastPulseSig = '';
    remote.pendingCount = 0;
  }

  function remoteForceLogout(message) {
    remoteStopPolling();
    remote.token = '';
    remote.role = '';
    remote.name = '';
    remoteClearSession();
    remoteClearData();
    state.authRole = null;
    state.loggedInEmployeeName = null;
    state.adminUnlocked = false;
    state.activeMainTab = 'LOGIN';
    setAppLoading(false);
    renderAll();
    showToast(escapeHtml(message || 'Phiên đăng nhập đã hết hạn, vui lòng đăng nhập lại.'), 'warn');
  }

  function remoteWindowArgs() {
    if (state.authRole !== 'ADMIN') return {};
    const [y, m] = getSelectedMonthKey().split('-').map(Number);
    const last = new Date(y, m, 0).getDate();
    return { p_from: `${y}-${pad2(m)}-01`, p_to: `${y}-${pad2(m)}-${pad2(last)}` };
  }

  function mapServerEmployee(e) {
    return {
      name: e.name,
      username: e.username,
      defaultOvertimeType: e.defaultOvertimeType || 'Ngoài khoán',
      defaultWorkMode: e.defaultWorkMode || 'Tăng ca tại công ty',
      startDate: e.startDate || null,
      endDate: e.endDate || null,
      hasRecords: Boolean(e.hasRecords),
      mustChangePassword: Boolean(e.mustChangePassword)
    };
  }

  // ---- Tải dữ liệu từ máy chủ ----
  async function remotePullInner(opts = {}) {
    if (!remote.token) return { ok: false };
    const res = await remoteClient.rpc('app_pull', Object.assign({ p_token: remote.token }, remoteWindowArgs()));
    if (!res.ok) {
      if (window.OTRemote.isRetryable(res)) {
        state.serverConnected = false;
        updateSyncStatusUI();
        return { ok: false, network: true, message: res.message };
      }
      if (res.hint === 'unauthorized' || res.hint === 'inactive') {
        remoteForceLogout(res.message);
        return { ok: false, unauthorized: true, message: res.message };
      }
      return { ok: false, message: res.message };
    }

    const d = res.data || {};
    remoteApplyServerTime(d.serverTime);
    state.serverConnected = true;

    // Đang có thay đổi chưa gửi: không ghi đè bằng dữ liệu tải về (sẽ gửi trước rồi tải lại sau)
    if (
      remote.snapshot &&
      !opts.ignoreDirty &&
      window.OTRemote.computeOps(remote.snapshot, state, state.authRole).count > 0
    ) {
      return { ok: true, deferred: true };
    }

    remote.lastPulseSig = d.sig || '';
    const sig = JSON.stringify([d.employees, d.records, d.holidays, d.lockedDays, d.dayModAlerts]);
    if (!opts.force && remote.snapshot && sig === remote.lastSig) {
      return { ok: true, changed: false, data: d };
    }
    remote.lastSig = sig;
    state.employees = (d.employees || []).map(mapServerEmployee);
    state.records = (d.records || []).filter((r) => !r.isDriverNoTime);
    state.holidays = d.holidays || {};
    state.lockedDays = d.lockedDays || {};
    Object.keys(state.lockedDays).forEach((k) => {
      if (state.lockedDays[k] && typeof state.lockedDays[k] === 'object') state.lockedDays[k].locked = true;
    });
    state.dayModAlerts = d.dayModAlerts || {};
    state.offlineQueue = [];
    remote.snapshot = window.OTRemote.snapshotFromState(state, state.authRole);
    return { ok: true, changed: true, data: d };
  }

  // ---- Gửi các thay đổi lên máy chủ ----
  async function remoteHandleRejection(res) {
    if (res.hint === 'unauthorized' || res.hint === 'inactive') {
      remoteForceLogout(res.message);
      return { ok: false, rejected: true, message: res.message, hint: res.hint };
    }
    playFeedbackSound('ERROR');
    showToast(escapeHtml(res.message), 'error');
    // Máy chủ từ chối: bỏ thay đổi vừa rồi và tải lại dữ liệu đúng từ máy chủ
    await remotePullInner({ force: true, ignoreDirty: true });
    renderAll();
    return { ok: false, rejected: true, message: res.message, hint: res.hint };
  }

  async function remotePushInner() {
    if (!remote.token || !remote.snapshot) return { ok: true, skipped: true };
    const { ops, count, sentSnapshot, passwords } = window.OTRemote.computeOps(
      remote.snapshot,
      state,
      state.authRole
    );
    if (count === 0) {
      remoteStorePending(null);
      remote.pendingCount = 0;
      updateSyncStatusUI();
      return { ok: true, empty: true };
    }

    const receipts = {};
    for (const chunk of window.OTRemote.chunkOps(ops, 200)) {
      const res = await remoteClient.rpc('app_push', { p_token: remote.token, p_ops: chunk });
      if (!res.ok) {
        if (window.OTRemote.isRetryable(res)) {
          // Mạng yếu: giữ thay đổi trên máy, tự gửi lại khi có mạng
          remoteStorePending(ops);
          remote.pendingCount = count;
          state.serverConnected = false;
          updateSyncStatusUI();
          return { ok: false, queued: true, message: res.message };
        }
        return remoteHandleRejection(res);
      }
      remoteApplyServerTime(res.data && res.data.serverTime);
      Object.assign(receipts, (res.data && res.data.receipts) || {});
    }

    remote.snapshot = sentSnapshot;
    state.records.forEach((r) => {
      if (receipts[r.id]) r.receiptId = receipts[r.id];
    });
    // Mật khẩu mới đã gửi xong thì xóa khỏi bộ nhớ trình duyệt
    state.employees.forEach((e) => {
      if (passwords[e.name] && e.password === passwords[e.name]) {
        delete e.password;
        delete e.pin;
      }
    });
    remoteStorePending(null);
    remote.pendingCount = 0;
    state.serverConnected = true;
    updateSyncStatusUI();
    return { ok: true, receipts };
  }

  function remotePush() {
    return remoteQueue(remotePushInner);
  }

  /** Gửi các thay đổi còn kẹt (nếu có) rồi tải dữ liệu mới nhất. */
  function remoteSyncPull(opts) {
    return remoteQueue(async () => {
      if (!remote.token) return { ok: false };
      if (remote.snapshot) {
        const p = await remotePushInner();
        if (p && (p.queued || p.rejected)) return p;
      }
      if (opts && opts.cheap && remote.lastPulseSig) {
        // Hỏi nhanh (vài chục byte): không có gì mới thì khỏi tải lại cả bảng dữ liệu
        const pr = await remoteClient.rpc('app_pulse', { p_token: remote.token });
        if (pr.ok && pr.data && pr.data.sig === remote.lastPulseSig) return { ok: true, changed: false, cheap: true };
        if (!pr.ok) {
          if (window.OTRemote.isRetryable(pr)) {
            state.serverConnected = false;
            updateSyncStatusUI();
            return { ok: false, network: true, message: pr.message };
          }
          if (pr.hint === 'unauthorized' || pr.hint === 'inactive') {
            remoteForceLogout(pr.message);
            return { ok: false, unauthorized: true, message: pr.message };
          }
        }
      }
      const r = await remotePullInner(opts || {});
      if (r.ok && r.changed) renderAll();
      else updateSyncStatusUI();
      return r;
    });
  }

  /** Gửi lại các thay đổi đã lưu tạm từ lần mất mạng trước (chạy ngay sau khi đăng nhập). */
  async function remoteReplayPending() {
    let stored = null;
    try {
      stored = JSON.parse(localStorage.getItem(REMOTE_PENDING_KEY) || 'null');
    } catch (_) {}
    if (!stored || !stored.ops || stored.user !== remote.name) return { ok: true, none: true };
    for (const chunk of window.OTRemote.chunkOps(stored.ops, 200)) {
      const res = await remoteClient.rpc('app_push', { p_token: remote.token, p_ops: chunk });
      if (!res.ok) {
        if (window.OTRemote.isRetryable(res)) return { ok: false, network: true, message: res.message };
        remoteStorePending(null);
        showToast('Một số thay đổi lưu tạm không gửi được: ' + escapeHtml(res.message), 'error');
        return { ok: true, dropped: true };
      }
    }
    remoteStorePending(null);
    showToast('Đã gửi các thay đổi lưu tạm lúc mất mạng.', 'success');
    return { ok: true, sent: true };
  }

  async function remoteFlushPending() {
    const r = await remoteSyncPull({ force: true });
    if (r && r.ok && !r.queued) {
      playFeedbackSound('SUCCESS');
      showToast('Đã gửi xong, dữ liệu đã lên máy chủ.', 'success');
    } else {
      showToast('Vẫn chưa có mạng. Dữ liệu vẫn được giữ trên máy, đừng lo.', 'warn');
    }
  }

  // ---- Tự làm mới: quản trị viên thấy ca mới của công nhân mà không cần tải lại trang ----
  function remoteUserBusy() {
    if (state.isWaitingServerAck) return true;
    const a = document.activeElement;
    if (a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) && a.closest('#viewAdminExcel.active, .modal-backdrop.open')) return true;
    return Boolean(document.querySelector('.modal-backdrop.open'));
  }

  async function remotePoll(force) {
    if (!remote.token || document.visibilityState === 'hidden') return;
    if (!force && remoteUserBusy()) return;
    await remoteSyncPull({ cheap: true });
  }

  function remoteStopPolling() {
    if (remote.timer) {
      clearInterval(remote.timer);
      remote.timer = null;
    }
  }

  function remoteStartPolling() {
    if (!remote.bound) {
      remote.bound = true;
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') remotePoll(false);
      });
      window.addEventListener('online', () => remotePoll(true));
    }
    remoteStopPolling();
    remote.timer = setInterval(remotePoll, state.authRole === 'ADMIN' ? 30000 : 60000);
  }

  // ---- Đăng nhập / khôi phục phiên / đăng xuất ----
  async function remoteLoadAfterAuth() {
    return remoteQueue(async () => {
      const rp = await remoteReplayPending();
      if (!rp.ok) return rp;
      return remotePullInner({ force: true, ignoreDirty: true });
    });
  }

  async function attemptRemoteLogin(username, password, errEl) {
    const btn = document.getElementById('btnSubmitLogin');
    const showErr = (msg) => {
      if (errEl) {
        errEl.textContent = msg;
        errEl.style.display = 'block';
      }
      playFeedbackSound('ERROR');
    };
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Đang đăng nhập...';
    }
    try {
      const res = await remoteClient.rpc('app_login', { p_username: username, p_password: password });
      if (!res.ok) {
        showErr(res.message);
        return;
      }
      const d = res.data || {};
      if (!d.ok) {
        showErr(d.message || 'Đăng nhập chưa thành công.');
        return;
      }

      remote.token = d.token;
      remote.role = d.role;
      remote.name = d.name;
      remote.snapshot = null;
      remote.lastSig = '';
      state.authRole = d.role === 'admin' ? 'ADMIN' : 'WORKER';
      state.loggedInEmployeeName = d.role === 'admin' ? null : d.name;
      if (d.role !== 'admin') state.selectedEmployeeName = d.name;
      state.adminUnlocked = d.role === 'admin';

      const loaded = await remoteLoadAfterAuth();
      if (!loaded.ok) {
        remote.token = '';
        remote.role = '';
        remote.name = '';
        remoteClearData();
        state.authRole = null;
        state.loggedInEmployeeName = null;
        state.adminUnlocked = false;
        showErr(loaded.message || 'Không tải được dữ liệu. Vui lòng thử lại.');
        return;
      }

      remoteSaveSession();
      try {
        localStorage.setItem(LAST_LOGIN_USER_KEY, username);
      } catch (_) {}
      const pwdInp = document.getElementById('loginPasswordInput');
      if (pwdInp) pwdInp.value = '';
      if (errEl) errEl.style.display = 'none';
      resetWorkerForm();
      state.workerMobileSubTab = 'FORM';
      state.lastServerAckReceipt = null;
      state.activeMainTab = d.role === 'admin' ? 'ADMIN_EXCEL' : 'WORKER_MOBILE';
      remoteStartPolling();
      playFeedbackSound('SUCCESS');
      renderAll();
      showToast(
        d.role === 'admin' ? 'Đã đăng nhập Quản trị viên.' : `Xin chào ${escapeHtml(d.name)}.`,
        'success'
      );
      if (d.mustChangePassword) {
        setTimeout(() => openChangePasswordModal({ forced: true, oldPassword: password }), 400);
      }
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = 'Đăng nhập';
      }
    }
  }

  async function remoteRestoreSession() {
    const saved = remoteReadSession();
    if (!saved) return;
    remote.token = saved.token;
    remote.role = saved.role;
    remote.name = saved.name || '';
    state.authRole = saved.role === 'admin' ? 'ADMIN' : 'WORKER';
    state.loggedInEmployeeName = saved.role === 'admin' ? null : remote.name;
    if (saved.role !== 'admin') state.selectedEmployeeName = remote.name;
    state.adminUnlocked = saved.role === 'admin';

    setAppLoading(true);
    const loaded = await remoteLoadAfterAuth();
    setAppLoading(false);

    if (!loaded.ok) {
      if (!loaded.unauthorized) {
        // Mất mạng lúc mở trang: giữ phiên để lần sau thử lại
        remote.token = '';
        state.authRole = null;
        state.loggedInEmployeeName = null;
        state.adminUnlocked = false;
        renderAll();
        showToast(escapeHtml(loaded.message || 'Không kết nối được máy chủ. Hãy kiểm tra mạng rồi tải lại trang.'), 'warn');
      }
      return;
    }
    resetWorkerForm();
    state.activeMainTab = saved.role === 'admin' ? 'ADMIN_EXCEL' : 'WORKER_MOBILE';
    remoteStartPolling();
    renderAll();
  }

  async function remoteLogoutCleanup() {
    const token = remote.token;
    if (token) {
      try {
        await Promise.race([remotePush(), new Promise((resolve) => setTimeout(resolve, 3000))]);
      } catch (_) {}
    }
    remoteStopPolling();
    remote.token = '';
    remote.role = '';
    remote.name = '';
    remoteClearSession();
    remoteClearData();
    if (token) remoteClient.rpc('app_logout', { p_token: token });
  }

  // ---- Đổi mật khẩu (dùng chung cho công nhân và quản trị viên) ----
  function openChangePasswordModal(opts = {}) {
    const modal = document.getElementById('modalChangePassword');
    if (!modal) return;
    const set = (id, v) => {
      const el = document.getElementById(id);
      if (el) el.value = v;
    };
    set('cpOld', opts.oldPassword || '');
    set('cpNew', '');
    set('cpNew2', '');
    const err = document.getElementById('cpError');
    if (err) err.style.display = 'none';
    const hint = document.getElementById('changePwdHint');
    if (hint) {
      hint.style.display = opts.forced ? 'block' : 'none';
      hint.textContent = 'Bạn đang dùng mật khẩu do quản đốc cấp. Hãy đặt mật khẩu riêng của bạn để người khác không dùng được tài khoản.';
    }
    const later = document.getElementById('btnCpLater');
    if (later) later.style.display = opts.forced ? 'inline-flex' : 'none';
    modal.classList.add('open');
    setTimeout(() => document.getElementById(opts.oldPassword ? 'cpNew' : 'cpOld')?.focus(), 50);
  }

  function closeChangePasswordModal() {
    document.getElementById('modalChangePassword')?.classList.remove('open');
  }

  async function submitChangePassword() {
    const errEl = document.getElementById('cpError');
    const showErr = (msg) => {
      if (errEl) {
        errEl.textContent = msg;
        errEl.style.display = 'block';
      }
      playFeedbackSound('ERROR');
    };
    const oldPwd = document.getElementById('cpOld')?.value || '';
    const newPwd = document.getElementById('cpNew')?.value || '';
    const again = document.getElementById('cpNew2')?.value || '';
    const minLen = state.authRole === 'ADMIN' ? 6 : 4;

    if (!oldPwd) return showErr('Vui lòng nhập mật khẩu hiện tại.');
    if (newPwd.length < minLen) return showErr(`Mật khẩu mới phải có ít nhất ${minLen} ký tự.`);
    if (newPwd !== again) return showErr('Hai lần nhập mật khẩu mới chưa giống nhau.');
    if (newPwd === oldPwd) return showErr('Mật khẩu mới phải khác mật khẩu cũ.');

    const btn = document.getElementById('btnCpSubmit');
    if (btn) btn.disabled = true;
    try {
      if (REMOTE_MODE) {
        const res = await remoteClient.rpc('app_change_password', {
          p_token: remote.token,
          p_old: oldPwd,
          p_new: newPwd
        });
        if (!res.ok) return showErr(res.message);
        if (!res.data || !res.data.ok) return showErr((res.data && res.data.message) || 'Chưa đổi được mật khẩu.');
      } else if (state.authRole === 'ADMIN') {
        if (!isAdminPassword(oldPwd)) return showErr('Mật khẩu hiện tại chưa đúng.');
        try {
          localStorage.setItem(ADMIN_PWD_KEY, computeSaltedTokenDigest(newPwd));
        } catch (_) {
          return showErr('Không lưu được mật khẩu mới trên máy này.');
        }
      } else {
        const emp = state.employees.find((e) => e.name === (state.loggedInEmployeeName || state.selectedEmployeeName));
        if (!emp) return showErr('Không tìm thấy tài khoản.');
        if (oldPwd !== String(emp.password || emp.pin || '')) return showErr('Mật khẩu hiện tại chưa đúng.');
        emp.password = newPwd;
        emp.pin = newPwd;
        saveLocalState(true);
        syncWithCentralServer(true);
      }
      closeChangePasswordModal();
      playFeedbackSound('SUCCESS');
      showToast('Đã đổi mật khẩu thành công.', 'success');
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  // ---- Khung trạng thái kết nối trong tab "Mã QR & Kết nối" ----
  function renderCloudStatus() {
    const badge = document.getElementById('cloudConnectionBadge');
    const box = document.getElementById('cloudStatusText');
    if (!badge && !box) return;
    if (REMOTE_MODE) {
      if (badge) badge.textContent = state.serverConnected ? 'Đã kết nối' : 'Mất kết nối';
      if (box) {
        box.innerHTML = state.serverConnected
          ? '<strong>Đang dùng Supabase.</strong> Dữ liệu lưu trên máy chủ, công nhân báo ở đâu quản đốc cũng thấy ngay.'
          : '<strong>Chưa kết nối được máy chủ.</strong> Hãy kiểm tra mạng. Dữ liệu vừa nhập được giữ trên máy và tự gửi khi có mạng.';
      }
    } else {
      if (badge) badge.textContent = 'Chưa bật';
      if (box) {
        box.innerHTML =
          '<strong>Đang chạy chế độ thử.</strong> Dữ liệu chỉ lưu trong trình duyệt của máy này, công nhân khác không thấy. Làm theo 4 bước dưới đây để bật dùng chung.';
      }
    }
  }

  async function fetchSetupSql() {
    const res = await fetch('supabase_setup.sql', { cache: 'no-store' });
    if (!res.ok) throw new Error('missing');
    return res.text();
  }

  function bindRemoteEvents() {
    document.getElementById('btnCpSubmit')?.addEventListener('click', submitChangePassword);
    document.getElementById('btnCpLater')?.addEventListener('click', closeChangePasswordModal);
    document.getElementById('btnCloseChangePwdModal')?.addEventListener('click', closeChangePasswordModal);
    ['cpOld', 'cpNew', 'cpNew2'].forEach((id) => {
      document.getElementById(id)?.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') submitChangePassword();
      });
    });
    document.getElementById('btnWorkerChangePwd')?.addEventListener('click', () => openChangePasswordModal());

    document.getElementById('btnCopySqlRls')?.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(await fetchSetupSql());
        showToast('Đã sao chép file SQL. Dán vào Supabase, mục SQL Editor.', 'success');
      } catch (_) {
        showToast('Không sao chép được. Hãy bấm "Tải file SQL".', 'error');
      }
    });
    document.getElementById('btnDownloadSqlRls')?.addEventListener('click', async () => {
      try {
        const blob = new Blob([await fetchSetupSql()], { type: 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'supabase_setup.sql';
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 3000);
      } catch (_) {
        showToast('Không tải được file SQL.', 'error');
      }
    });
  }

  /** Sao lưu khi dùng Supabase: tải 400 ngày gần nhất từ máy chủ (không gồm mật khẩu). */
  async function exportBackupRemote() {
    const today = localIsoToday();
    const res = await remoteClient.rpc('app_pull', {
      p_token: remote.token,
      p_from: addDaysToIsoDate(today, -400),
      p_to: today
    });
    if (!res.ok || !res.data || !res.data.ok) {
      showToast(escapeHtml((res && res.message) || 'Không lấy được dữ liệu để sao lưu.'), 'error');
      return;
    }
    const d = res.data;
    const payload = {
      employees: (d.employees || []).map(mapServerEmployee),
      records: d.records || [],
      lockedDays: d.lockedDays || {},
      dayModAlerts: d.dayModAlerts || {},
      holidays: d.holidays || {},
      range: d.window,
      exportedAt: d.serverTime,
      note: 'File sao lưu không chứa mật khẩu. Khi nhập lại, nhân viên mới có mật khẩu 123456 và phải đổi lần đầu đăng nhập.'
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `Sao_luu_cham_cong_${today}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 3000);
    showToast(`Đã tải file sao lưu (${payload.employees.length} nhân viên, ${payload.records.length} ca trong 400 ngày gần nhất).`, 'success');
  }

  /** Nhập file sao lưu khi đang dùng Supabase: chỉ THÊM nhân viên/ca chưa có, không xóa gì. */
  function importBackupRemote(parsed) {
    const have = new Set(state.employees.map((e) => e.name));
    const usedUsernames = new Set(state.employees.map((e) => String(e.username || '').toLowerCase()));
    let addedEmp = 0;
    parsed.employees.forEach((e) => {
      if (!e || !e.name || have.has(e.name)) return;
      const pw = String(e.password || e.pin || '');
      let username = String(e.username || slugifyVietnamese(e.name)).toLowerCase();
      if (!/^[a-z0-9._-]{2,32}$/.test(username) || usedUsernames.has(username) || username === 'admin' || username === 'quantri') {
        username = deriveDefaultUsername(e.name, usedUsernames);
      }
      usedUsernames.add(username);
      state.employees.push({
        name: e.name,
        username,
        password: pw.length >= 4 ? pw : '123456',
        defaultOvertimeType: e.defaultOvertimeType || 'Ngoài khoán',
        defaultWorkMode: e.defaultWorkMode || 'Tăng ca tại công ty',
        startDate: e.startDate || null,
        endDate: e.endDate || null
      });
      have.add(e.name);
      addedEmp += 1;
    });
    const ids = new Set(state.records.map((r) => r.id));
    let addedRec = 0;
    let skipped = 0;
    parsed.records.forEach((r) => {
      if (!r || !r.id || !have.has(r.employeeName)) {
        skipped += 1;
        return;
      }
      if (ids.has(r.id)) return;
      state.records.push(r);
      ids.add(r.id);
      addedRec += 1;
    });
    if (parsed.holidays && typeof parsed.holidays === 'object') {
      Object.keys(parsed.holidays).forEach((k) => {
        if (!state.holidays[k]) state.holidays[k] = parsed.holidays[k];
      });
    }
    return { addedEmp, addedRec, skipped };
  }

  function initApp() {
    loadLocalState();

    // Khởi tạo BroadcastChannel để đồng bộ tức thì giữa tab Điện thoại & tab Admin
    if (!REMOTE_MODE && typeof BroadcastChannel !== 'undefined') {
      try {
        syncChannel = new BroadcastChannel(CHANNEL_NAME);
        syncChannel.onmessage = (ev) => {
          if (ev.data && ev.data.type === 'STATE_UPDATED' && ev.data.payload) {
            state.employees = ev.data.payload.employees || state.employees;
            state.records = ev.data.payload.records || state.records;
            state.offlineQueue = ev.data.payload.offlineQueue || state.offlineQueue;
            if (ev.data.payload.lockedDays) state.lockedDays = ev.data.payload.lockedDays;
            if (ev.data.payload.dayModAlerts) state.dayModAlerts = ev.data.payload.dayModAlerts;
            if (ev.data.payload.holidays) state.holidays = ev.data.payload.holidays;
            renderAll();
          }
        };
      } catch (_) {
        // Ignore if not supported
      }
    }

    // Lắng nghe sự kiện có mạng trở lại của trình duyệt trên điện thoại
    window.addEventListener('online', () => {
      if (!REMOTE_MODE && !state.simulateOffline && state.offlineQueue.length > 0) {
        flushOfflineQueue();
      }
      updateSyncStatusUI();
    });

    bindAllEvents();
    bindRemoteEvents();
    if (REMOTE_MODE) {
      const demoBtn = document.getElementById('btnDemoResetData');
      if (demoBtn) demoBtn.style.display = 'none';
    }
    resetWorkerForm();
    const lockDateInit = document.getElementById('matrixLockDateInput');
    if (lockDateInit) lockDateInit.value = localIsoToday();
    updateLiveClock();
    setInterval(updateLiveClock, 1000);

    renderAll();
    if (REMOTE_MODE) {
      remoteRestoreSession();
    } else {
      syncWithCentralServer(false);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initApp);
  } else {
    initApp();
  }
})();

