// Run: node --test tests/accounts-roles.test.cjs
// Quyền theo tài khoản + "Có chấm công cá nhân": danh sách bảng công, computeOps, mapServerEmployee,
// đăng nhập chế độ thử bằng nhân viên Admin, escape tên Telegram.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const R = require('../remote.js');

function fakeElement() {
  const classes = new Set();
  return {
    style: {}, rows: [], value: '', textContent: '', innerHTML: '', checked: false, disabled: false, dataset: {},
    classList: {
      add: (c) => classes.add(c), remove: (c) => classes.delete(c),
      toggle: (c, on) => { if (on === undefined ? !classes.has(c) : on) classes.add(c); else classes.delete(c); },
      contains: (c) => classes.has(c)
    },
    addEventListener() {}, removeEventListener() {}, focus() {}, select() {}, setAttribute() {},
    querySelector: () => null, querySelectorAll: () => [], closest: () => null
  };
}

function fixture({ remoteMode = false, store = {} } = {}) {
  const elements = {};
  const document = {
    readyState: 'loading', addEventListener() {},
    getElementById: (id) => (elements[id] = elements[id] || fakeElement()),
    querySelectorAll: () => [], querySelector: () => null, createElement: fakeElement,
    activeElement: null, visibilityState: 'visible'
  };
  const storage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; }
  };
  const window = { location: { protocol: 'file:' }, addEventListener() {}, history: {}, scrollTo() {} };
  if (remoteMode) {
    window.APP_CONFIG = { supabaseUrl: 'https://test.invalid', supabaseKey: 'test-only' };
    window.OTRemote = R;
  }
  const ctx = { window, document, navigator: {}, localStorage: storage, sessionStorage: storage,
    console, TextEncoder, URL, Blob, setTimeout, clearTimeout, setInterval, clearInterval };
  let src = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');
  const tail = src.lastIndexOf('})();');
  src = src.slice(0, tail) + `
    window.toasts = [];
    showToast = (message) => { window.toasts.push(String(message)); };
    playFeedbackSound = () => {};
    syncWithCentralServer = async () => ({});
    window.pulls = 0;
    remoteSyncPull = async () => { window.pulls += 1; return {}; };
    window.api = { state, getTimesheetEmployees, isTimesheetEmployee, createDaySnapshot, renderAdminDashboard,
      generateExactTemplateXlsxBytes, mapServerEmployee, attemptLoginSubmit, loadLocalState, renderAll,
      switchMainView, canSwitchView, personalName, buildManageEmployeesHtml, saveLocalState,
      syncWorkerDefaultsFromSelectedEmp, openAdminEditOvertimeModal, openTelegramDialog, closeTelegramDialog, remote,
      applyServerMe, updateTelegramButtons, startTelegramLink, personalHasNoTimesheet };
  ` + src.slice(tail);
  vm.runInNewContext(src, ctx);
  return { api: window.api, elements, window, store, el: (id) => document.getElementById(id) };
}

const emp = (name, extra = {}) => ({
  name, username: name.toLowerCase(), defaultOvertimeType: 'Ngoài khoán', defaultWorkMode: 'Tăng ca tại công ty', ...extra
});
const rec = (id, name, day) => ({
  id, employeeName: name, jobContent: 'Làm theo kế hoạch', startTime: `${day} 17:15`, endTime: `${day} 18:15`,
  workDate: day, overrideHours: null, overtimeType: 'Ngoài khoán', workMode: 'Tăng ca tại công ty', note: ''
});

function seed(api) {
  Object.assign(api.state, {
    employees: [
      emp('An'),
      emp('Bình', { hasTimesheet: false }),
      emp('Quản đốc', { role: 'admin', hasTimesheet: false }),
      emp('Cường', { role: 'admin', hasTimesheet: true })
    ],
    records: [], offlineQueue: [], holidays: {}, dayStatuses: {}, lockedDays: {}, dayModAlerts: {},
    matrixMonth: '2026-10', adminFilterEmp: 'ALL', adminFilterDay: '', adminFilterMode: 'ALL', adminSearchQuery: '',
    activeExcelSheet: 'SHEET_MATRIX', adminUnlocked: true
  });
}
const names = (list) => list.map((e) => e.name).join(',');

test('roster: hasTimesheet decides, role does not', () => {
  const { api } = fixture();
  seed(api);
  assert.equal(names(api.getTimesheetEmployees()), 'An,Cường');
  assert.equal(names(api.getTimesheetEmployees('2026-10')), 'An,Cường');
});

test('roster: person without timesheet but with records or status in the month stays visible', () => {
  const { api } = fixture();
  seed(api);
  api.state.records.push(rec('r1', 'Bình', '12/10/2026'));
  assert.equal(names(api.getTimesheetEmployees('2026-10')), 'An,Bình,Cường');
  assert.equal(names(api.getTimesheetEmployees('2026-11')), 'An,Cường', 'other months unaffected');
  api.state.dayStatuses['13/10/2026::Quản đốc'] = { leave: 'FULL', earlyHours: 0 };
  assert.equal(names(api.getTimesheetEmployees('2026-10')), 'An,Bình,Quản đốc,Cường');
});

test('KPI denominator and filter dropdown use the roster', () => {
  const { api, elements } = fixture();
  seed(api);
  api.state.records.push(rec('r1', 'An', '12/10/2026'));
  api.renderAdminDashboard();
  assert.equal(elements.kpiActiveEmployees.textContent, '1 / 2 NV');
  assert.match(elements.adminFilterEmployee.innerHTML, /Tất cả nhân viên \(2\)/);
  assert.doesNotMatch(elements.adminFilterEmployee.innerHTML, /Bình|Quản đốc/);
  assert.equal(elements.sheet2CountLabel.textContent, '2');
});

test('matrix rows only for roster people (plus those with records in month)', () => {
  const { api, elements } = fixture();
  seed(api);
  api.state.records.push(rec('r1', 'An', '12/10/2026'));
  api.renderAdminDashboard();
  let html = elements.excelMatrixTbody.innerHTML;
  assert.match(html, /An/);
  assert.match(html, /Cường/);
  assert.doesNotMatch(html, /Bình/);
  assert.doesNotMatch(html, /Quản đốc/);
  api.state.records.push(rec('r2', 'Bình', '12/10/2026'));
  api.renderAdminDashboard();
  html = elements.excelMatrixTbody.innerHTML;
  assert.match(html, /Bình/, 'records keep the person visible');
  assert.equal(elements.kpiActiveEmployees.textContent, '2 / 3 NV');
});

test('day snapshot skips people without timesheet unless they have data that day', () => {
  const { api } = fixture();
  seed(api);
  assert.deepEqual(Object.keys(api.createDaySnapshot('12/10/2026')).sort(), ['An', 'Cường']);
  api.state.records.push(rec('r1', 'Bình', '12/10/2026'));
  assert.deepEqual(Object.keys(api.createDaySnapshot('12/10/2026')).sort(), ['An', 'Bình', 'Cường']);
  assert.deepEqual(Object.keys(api.createDaySnapshot('13/10/2026')).sort(), ['An', 'Cường']);
});

test('Excel export roster: no timesheet -> not listed, unless they have records in the month', () => {
  const { api } = fixture();
  seed(api);
  const xml = () => Buffer.from(api.generateExactTemplateXlsxBytes()).toString('utf8');
  let text = xml();
  assert.ok(text.includes('An') && text.includes('Cường'));
  assert.ok(!text.includes('Bình') && !text.includes('Quản đốc'));
  api.state.records.push(rec('r1', 'Bình', '12/10/2026'));
  text = xml();
  assert.ok(text.includes('Bình'));
  assert.ok(!text.includes('Quản đốc'));
});

test('edit-shift dropdown lists only timesheet people (and the one being edited)', () => {
  const { api, elements } = fixture();
  seed(api);
  api.state.records.push(rec('r1', 'Bình', '12/10/2026'));
  api.openAdminEditOvertimeModal(null);
  assert.ok(!/Bình|Quản đốc/.test(elements.editOtEmployee.innerHTML));
  assert.ok(/An/.test(elements.editOtEmployee.innerHTML));
  api.openAdminEditOvertimeModal('r1');
  assert.ok(/Bình/.test(elements.editOtEmployee.innerHTML), 'editing keeps the record owner');
});

test('computeOps sends role/flags only when they changed (R18)', () => {
  const base = [emp('An', { role: 'worker', hasTimesheet: true, notifyManager: false, notifyPersonal: true })];
  const st = { employees: base, records: [], dayStatuses: {}, holidays: {}, lockedDays: {}, dayModAlerts: {} };
  const prev = R.snapshotFromState(st, 'ADMIN');
  assert.equal(R.computeOps(prev, st, 'ADMIN').count, 0);

  // đổi tên đăng nhập: không kèm role / cờ
  const st2 = { ...st, employees: [{ ...base[0], username: 'an2' }] };
  const op2 = R.computeOps(prev, st2, 'ADMIN').ops.employeesUpsert[0];
  assert.equal(op2.username, 'an2');
  for (const k of ['role', 'hasTimesheet', 'notifyManager', 'notifyPersonal']) assert.ok(!(k in op2), `${k} must be absent`);

  // đổi 2 cờ: chỉ 2 cờ đó được gửi
  const st3 = { ...st, employees: [{ ...base[0], role: 'admin', hasTimesheet: false }] };
  const op3 = R.computeOps(prev, st3, 'ADMIN').ops.employeesUpsert[0];
  assert.equal(op3.role, 'admin');
  assert.equal(op3.hasTimesheet, false);
  assert.ok(!('notifyPersonal' in op3) && !('notifyManager' in op3));

  // công nhân không bao giờ gửi notifyManager = true
  const st4 = { ...st, employees: [{ ...base[0], notifyManager: true }] };
  assert.equal(R.computeOps(prev, st4, 'ADMIN').count, 0);

  // dòng mới: chỉ gửi trường khác mặc định
  const st5 = { ...st, employees: [...base, emp('Dũng', { role: 'admin', notifyManager: true })] };
  const add = R.computeOps(prev, st5, 'ADMIN').ops.employeesUpsert[0];
  assert.equal(add.name, 'Dũng');
  assert.equal(add.role, 'admin');
  assert.equal(add.notifyManager, true);
  assert.ok(!('hasTimesheet' in add) && !('notifyPersonal' in add));
});

test('computeOps against an old server snapshot (no new fields) never sends flags', () => {
  const { api } = fixture({ remoteMode: true });
  const mapped = api.mapServerEmployee({ name: 'An', username: 'an' }); // máy chủ cũ
  const st = { employees: [mapped], records: [], dayStatuses: {}, holidays: {}, lockedDays: {}, dayModAlerts: {} };
  const prev = R.snapshotFromState(st, 'ADMIN');
  const st2 = { ...st, employees: [{ ...mapped, defaultWorkMode: 'Tăng ca trưa' }] };
  const op = R.computeOps(prev, st2, 'ADMIN').ops.employeesUpsert[0];
  assert.ok(!('role' in op) && !('hasTimesheet' in op) && !('notifyManager' in op) && !('notifyPersonal' in op));
});

test('mapServerEmployee defaults (R16) and Telegram fields', () => {
  const { api } = fixture({ remoteMode: true });
  const old = api.mapServerEmployee({ name: 'An', username: 'an' });
  assert.equal(old.role, 'worker');
  assert.equal(old.hasTimesheet, true);
  assert.equal(old.notifyPersonal, true);
  assert.equal(old.notifyManager, false);
  assert.equal(old.telegramLinked, false);
  assert.equal(old.telegramName, null);
  const next = api.mapServerEmployee({
    name: 'Q', username: 'q', role: 'admin', hasTimesheet: false, notifyManager: true, notifyPersonal: false,
    telegramLinked: true, telegramName: '@q', telegramLinkedAt: '2026-10-01T00:00:00Z'
  });
  assert.equal(next.role, 'admin');
  assert.equal(next.hasTimesheet, false);
  assert.equal(next.notifyManager, true);
  assert.equal(next.notifyPersonal, false);
  assert.equal(next.telegramName, '@q');
});

test('local login as a role-admin employee -> ADMIN, can switch to personal view bound to own name', () => {
  const { api, el } = fixture();
  seed(api);
  api.state.employees.find((e) => e.name === 'Cường').password = 'matkhau1';
  el('loginUsernameInput').value = 'cường';
  el('loginPasswordInput').value = 'matkhau1';
  api.attemptLoginSubmit();
  assert.equal(api.state.authRole, 'ADMIN');
  assert.equal(api.state.authEmployeeName, 'Cường');
  assert.equal(api.state.authHasTimesheet, true);
  assert.equal(api.state.loggedInEmployeeName, null);
  assert.equal(api.state.activeMainTab, 'ADMIN_EXCEL');
  assert.equal(api.canSwitchView(), true);

  api.state.selectedEmployeeName = 'An'; // không được ảnh hưởng báo công cá nhân
  api.switchMainView('PERSONAL');
  assert.equal(api.state.activeMainTab, 'WORKER_MOBILE');
  assert.equal(api.personalName(), 'Cường');
  assert.equal(api.state.selectedEmployeeName, 'Cường');
  api.switchMainView('MANAGE');
  assert.equal(api.state.activeMainTab, 'ADMIN_EXCEL');

  // tắt chấm công cá nhân -> không còn chuyển được, luôn ở trang quản lý
  api.state.employees.find((e) => e.name === 'Cường').hasTimesheet = false;
  api.renderAll();
  assert.equal(api.canSwitchView(), false);
  api.state.activeMainTab = 'WORKER_MOBILE';
  api.renderAll();
  assert.equal(api.state.activeMainTab, 'ADMIN_EXCEL');
});

test('local login: role-admin employee without timesheet -> ADMIN, no switch; session is restored', () => {
  const store = {};
  const first = fixture({ store });
  seed(first.api);
  first.api.state.employees.find((e) => e.name === 'Quản đốc').password = 'matkhau2';
  first.api.saveLocalState(false);
  first.el('loginUsernameInput').value = 'quản đốc';
  first.el('loginPasswordInput').value = 'matkhau2';
  first.api.attemptLoginSubmit();
  assert.equal(first.api.state.authRole, 'ADMIN');
  assert.equal(first.api.state.authEmployeeName, 'Quản đốc');
  assert.equal(first.api.canSwitchView(), false);

  const second = fixture({ store }); // tải lại trang: phiên khôi phục từ sessionStorage
  second.api.loadLocalState();
  assert.equal(second.api.state.authRole, 'ADMIN');
  assert.equal(second.api.state.authEmployeeName, 'Quản đốc');
});

test('local login: built-in admin/admin123 unchanged (no employee name, no timesheet)', () => {
  const { api, el } = fixture();
  seed(api);
  el('loginUsernameInput').value = 'admin';
  el('loginPasswordInput').value = 'admin123';
  api.attemptLoginSubmit();
  assert.equal(api.state.authRole, 'ADMIN');
  assert.equal(api.state.authEmployeeName, null);
  assert.equal(api.state.authHasTimesheet, false);
  assert.equal(api.canSwitchView(), false);
});

test('local login: normal worker still goes to the worker page', () => {
  const { api, el } = fixture();
  seed(api);
  api.state.employees[0].password = 'matkhau3';
  el('loginUsernameInput').value = 'an';
  el('loginPasswordInput').value = 'matkhau3';
  api.attemptLoginSubmit();
  assert.equal(api.state.authRole, 'WORKER');
  assert.equal(api.state.loggedInEmployeeName, 'An');
  assert.equal(api.state.activeMainTab, 'WORKER_MOBILE');
  assert.equal(api.personalName(), 'An');
});

test('manage list: malicious telegramName is escaped everywhere (R4)', () => {
  const { api } = fixture({ remoteMode: true });
  const evil = '<img src=x onerror=alert(1)>"\'&';
  Object.assign(api.state, {
    employees: [
      api.mapServerEmployee({ name: 'An', username: 'an', telegramLinked: true, telegramName: evil }),
      api.mapServerEmployee({ name: 'Q', username: 'admin', role: 'admin', hasTimesheet: false, notifyManager: true })
    ],
    records: [], authEmployeeName: 'Q', authRole: 'ADMIN'
  });
  const html = api.buildManageEmployeesHtml();
  assert.ok(!html.includes('<img'), 'no raw tag from telegramName');
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;&quot;&#39;&amp;'));
  assert.ok(html.includes('Đã kết nối: '));
  assert.ok(html.includes('btn-tg-test') && html.includes('btn-tg-unlink'), 'actions only for linked account');
  assert.equal((html.match(/btn-tg-test/g) || []).length, 1);
  // dòng của chính mình: không đổi quyền, không cho nghỉ / xóa
  const selfCard = html.slice(html.indexOf('data-name="Q"'));
  assert.match(selfCard, /emp-role-select[^>]*disabled/);
  assert.ok(!/btn-end-emp" data-name="Q"/.test(html));
  assert.ok(!/btn-remove-emp" data-name="Q"/.test(html));
});

test('manage list in local mode: Telegram cell explains it needs the server, no Telegram actions', () => {
  const { api } = fixture();
  seed(api);
  const html = api.buildManageEmployeesHtml();
  assert.ok(html.includes('Chỉ dùng khi kết nối máy chủ'));
  assert.ok(!html.includes('btn-tg-test') && !html.includes('btn-tg-unlink'));
  assert.ok(html.includes('Công nhân') && html.includes('Admin – Quản đốc'));
  assert.ok(html.includes('Có chấm công cá nhân') && html.includes('Nhận báo cáo quản lý') && html.includes('Nhận thông báo cá nhân'));
  // "Nhận báo cáo quản lý" bị khóa với công nhân
  const anCard = html.slice(html.indexOf('data-name="An"'), html.indexOf('data-name="Bình"'));
  assert.match(anCard, /emp-notify-mgr[^>]*disabled/);
});

test('Telegram missing-function message (PGRST202 / 404) is specific', async () => {
  const realFetch = global.fetch;
  global.fetch = async () => ({ ok: false, status: 404, json: async () => ({ code: 'PGRST202', message: 'x' }) });
  try {
    const client = R.createClient({ url: 'https://x.invalid', key: 'k' });
    const res = await client.telegramLinkStart('tok');
    assert.equal(res.ok, false);
    assert.equal(res.message, 'Máy chủ chưa cài bot Telegram (Quản trị viên cần chạy telegram_nhac_cham_cong.sql)');
  } finally {
    global.fetch = realFetch;
  }
});

test('Telegram dialog: link_start -> <a> with t.me url, polls status, shows escaped name when linked', async () => {
  const realFetch = global.fetch;
  const calls = [];
  let statusCalls = 0;
  const evil = '<b onmouseover=alert(1)>x</b>';
  global.fetch = async (url, opts) => {
    const fn = String(url).split('/rpc/')[1];
    calls.push([fn, JSON.parse(opts.body)]);
    let body;
    if (fn === 'app_telegram_link_start') body = { ok: true, url: 'https://t.me/pxkhuon_bot?start=abc', botUsername: 'pxkhuon_bot', expiresAt: 'x' };
    else if (fn === 'app_telegram_link_status') {
      statusCalls += 1;
      body = statusCalls < 2 ? { ok: true, linked: false, pending: true, pollError: null } : { ok: true, linked: true, telegramName: evil, linkedAt: '2026-10-22T00:00:00Z' };
    } else body = { ok: true };
    return { ok: true, status: 200, json: async () => body };
  };
  try {
    const { api, el, window } = fixture({ remoteMode: true });
    api.remote.token = 'tok';
    Object.assign(api.state, { authRole: 'WORKER', authEmployeeName: 'An', loggedInEmployeeName: 'An', employees: [api.mapServerEmployee({ name: 'An', username: 'an' })] });
    api.openTelegramDialog();
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(calls[0][0], 'app_telegram_link_start');
    assert.deepEqual(calls[0][1], { p_token: 'tok' });
    assert.equal(el('tgLinkOpenBtn').href, 'https://t.me/pxkhuon_bot?start=abc');
    assert.equal(el('tgLinkOpenBtn').textContent, 'Mở Telegram (@pxkhuon_bot)');
    assert.equal(el('tgLinkWaiting').textContent, 'Đang chờ bạn bấm Start…');
    await new Promise((r) => setTimeout(r, 6400)); // 2 lần hỏi, mỗi 3 giây
    assert.equal(statusCalls, 2);
    assert.equal(api.state.authTelegram.linked, true);
    assert.equal(api.state.authTelegram.telegramName, evil);
    assert.ok(el('tgLinkCurrent').innerHTML.includes('&lt;b onmouseover=alert(1)&gt;'));
    assert.ok(!el('tgLinkCurrent').innerHTML.includes('<b '));
    assert.ok(window.toasts.every((t) => !t.includes('<b onmouseover')), 'toast escaped');
    assert.equal(window.pulls, 1, 'pull triggered after linking');
    await new Promise((r) => setTimeout(r, 3300));
    assert.equal(statusCalls, 2, 'polling stopped after linking');
    api.closeTelegramDialog();
  } finally {
    global.fetch = realFetch;
  }
});

test('Telegram dialog: rejects non-Telegram url and stops polling when dialog closed', async () => {
  const realFetch = global.fetch;
  let statusCalls = 0;
  let mode = 'badurl';
  global.fetch = async (url) => {
    const fn = String(url).split('/rpc/')[1];
    if (fn === 'app_telegram_link_status') statusCalls += 1;
    const body = fn === 'app_telegram_link_start'
      ? { ok: true, url: mode === 'badurl' ? 'javascript:alert(1)' : 'https://t.me/b?start=1', botUsername: 'b' }
      : { ok: true, linked: false, pending: true };
    return { ok: true, status: 200, json: async () => body };
  };
  try {
    const { api, el } = fixture({ remoteMode: true });
    api.remote.token = 'tok';
    api.state.authRole = 'WORKER';
    api.openTelegramDialog();
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(el('tgLinkError').textContent, 'Liên kết Telegram không hợp lệ.');
    assert.notEqual(el('tgLinkOpenBtn').href, 'javascript:alert(1)');
    mode = 'ok';
    api.openTelegramDialog();
    await new Promise((r) => setTimeout(r, 50));
    api.closeTelegramDialog();
    await new Promise((r) => setTimeout(r, 3300));
    assert.equal(statusCalls, 0, 'closed dialog -> no status polling');
  } finally {
    global.fetch = realFetch;
  }
});

test('applyServerMe: me from app_pull drives hasTimesheet and Telegram state; old server falls back safely', () => {
  const { api } = fixture({ remoteMode: true });
  Object.assign(api.state, { authRole: 'ADMIN', authEmployeeName: 'Q', employees: [] });
  api.applyServerMe({ me: { name: 'Q', role: 'admin', hasTimesheet: true, telegramLinked: true, telegramName: '@q' } });
  assert.equal(api.state.authHasTimesheet, true);
  assert.deepEqual({ ...api.state.authTelegram }, { linked: true, telegramName: '@q' });
  // máy chủ cũ (không có me, admin không nằm trong danh sách): giữ nguyên, không đoán
  api.state.authHasTimesheet = false;
  api.applyServerMe({});
  assert.equal(api.state.authHasTimesheet, false);
});

test('Telegram reconnect: linked+pending keeps waiting; linked+not pending is success', async () => {
  const realFetch = global.fetch;
  let statusCalls = 0;
  global.fetch = async (url) => {
    const fn = String(url).split('/rpc/')[1];
    let body = { ok: true };
    if (fn === 'app_telegram_link_start') body = { ok: true, url: 'https://t.me/b?start=1', botUsername: 'b' };
    if (fn === 'app_telegram_link_status') {
      statusCalls += 1;
      body = statusCalls < 2
        ? { ok: true, linked: true, pending: true, telegramName: '@cu' }
        : { ok: true, linked: true, pending: false, telegramName: '@moi', linkedAt: 'x' };
    }
    return { ok: true, status: 200, json: async () => body };
  };
  try {
    const { api, el } = fixture({ remoteMode: true });
    api.remote.token = 'tok';
    Object.assign(api.state, { authRole: 'WORKER', authEmployeeName: 'An', loggedInEmployeeName: 'An', employees: [api.mapServerEmployee({ name: 'An', username: 'an', telegramLinked: true, telegramName: '@cu' })] });
    api.state.authTelegram = { linked: true, telegramName: '@cu' };
    api.openTelegramDialog(); // đã kết nối: hiện trạng thái, chưa tạo liên kết
    api.state.authTelegram = { linked: true, telegramName: '@cu' };
    // bấm "Kết nối lại"
    const { startTelegramLink } = api;
    await startTelegramLink();
    await new Promise((r) => setTimeout(r, 3300));
    assert.equal(statusCalls, 1);
    assert.equal(api.state.authTelegram.telegramName, '@cu', 'old link is not reported as success');
    assert.equal(el('tgLinkWaiting').textContent, 'Đang chờ bạn bấm Start…');
    await new Promise((r) => setTimeout(r, 3100));
    assert.equal(api.state.authTelegram.telegramName, '@moi');
    api.closeTelegramDialog();
  } finally {
    global.fetch = realFetch;
  }
});

test('manage list: rescue admin row (username admin) cannot change role, be ended or deleted', () => {
  const { api } = fixture();
  Object.assign(api.state, {
    employees: [
      { name: 'Quản trị viên', username: 'admin', role: 'admin', hasTimesheet: false, defaultOvertimeType: 'Ngoài khoán', defaultWorkMode: 'Tăng ca tại công ty' },
      { name: 'An', username: 'an', defaultOvertimeType: 'Ngoài khoán', defaultWorkMode: 'Tăng ca tại công ty' }
    ],
    records: [], authEmployeeName: 'Zed', authRole: 'ADMIN'
  });
  const html = api.buildManageEmployeesHtml();
  const rescue = html.slice(html.indexOf('data-name="Quản trị viên"'), html.indexOf('data-name="An"'));
  assert.ok(rescue.includes('Tài khoản quản trị gốc'));
  assert.match(rescue, /emp-role-select[^>]*disabled/);
  assert.ok(!rescue.includes('btn-end-emp') && !rescue.includes('btn-remove-emp'));
  assert.ok(html.slice(html.indexOf('data-name="An"')).includes('btn-end-emp'), 'normal rows keep the end button');
});

test('worker with hasTimesheet=false: banner shown and submit disabled', () => {
  const { api, el } = fixture();
  Object.assign(api.state, {
    employees: [{ name: 'An', username: 'an', hasTimesheet: false, defaultOvertimeType: 'Ngoài khoán', defaultWorkMode: 'Tăng ca tại công ty' }],
    authRole: 'WORKER', loggedInEmployeeName: 'An', authEmployeeName: 'An', selectedEmployeeName: 'An',
    records: [], dayStatuses: {}, lockedDays: {}, holidays: {}, dayModAlerts: {}, offlineQueue: []
  });
  assert.equal(api.personalHasNoTimesheet(), true);
  api.renderAll();
  assert.equal(el('noTimesheetBanner').style.display, 'block');
  api.state.employees[0].hasTimesheet = true;
  api.renderAll();
  assert.equal(el('noTimesheetBanner').style.display, 'none');
});
