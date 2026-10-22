// Run: node --test tests/audit-log.test.cjs
// Lịch sử sửa đổi (client): nhãn tiếng Việt + gom nhóm + escape, mục trong hộp "Chi tiết công ngày",
// tab "Lịch sử sửa đổi", chế độ thử, máy chủ cũ, tải lại sau khi đẩy thành công, auditList của remote.js.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const R = require('../remote.js');
const realFetch = global.fetch;

function fakeElement() {
  const classes = new Set();
  return {
    style: {}, rows: [], value: '', textContent: '', innerHTML: '', checked: false, disabled: false, open: false, dataset: {},
    classList: {
      add: (c) => classes.add(c), remove: (c) => classes.delete(c),
      toggle: (c, on) => { if (on === undefined ? !classes.has(c) : on) classes.add(c); else classes.delete(c); },
      contains: (c) => classes.has(c)
    },
    addEventListener() {}, removeEventListener() {}, focus() {}, select() {}, setAttribute() {},
    querySelector: () => null, querySelectorAll: () => [], closest: () => null
  };
}

/** `respond(fn, args)` → { status, body } (hoặc Promise); mọi lần gọi được ghi vào `calls`. */
function fixture({ remoteMode = true, respond = null } = {}) {
  const elements = {};
  const store = {};
  const calls = [];
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
  const fakeFetch = async (url, opts) => {
    const fn = String(url).split('/rpc/')[1];
    const args = JSON.parse(opts.body || '{}');
    calls.push({ fn, args });
    const r = await (respond ? respond(fn, args) : { status: 200, body: { ok: true } });
    return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body };
  };
  const ctx = { window, document, navigator: {}, localStorage: storage, sessionStorage: storage,
    console, TextEncoder, URL, Blob, setTimeout, clearTimeout, setInterval, clearInterval };
  global.fetch = fakeFetch; // remote.js (require) dùng fetch toàn cục của Node
  let src = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');
  const tail = src.lastIndexOf('})();');
  src = src.slice(0, tail) + `
    window.toasts = [];
    showToast = (message) => { window.toasts.push(String(message)); };
    playFeedbackSound = () => {};
    syncWithCentralServer = async () => ({});
    window.api = { state, remote, renderAdminDashboard, auditGroupsHtml, auditEntryLines, auditGroupEntries,
      openMatrixCellQuickModal, renderMatrixCellQuickModal, loadQuickAudit, setupQuickAudit, jumpQuickAuditToHistoryTab,
      renderAuditHistorySheet, auditTabLoadMore, auditAfterPush, remotePushInner, remotePush, setAdminFilterDay, auditTab };
  ` + src.slice(tail);
  vm.runInNewContext(src, ctx);
  return { api: window.api, elements, calls, el: (id) => document.getElementById(id) };
}

const flush = async () => { for (let i = 0; i < 8; i += 1) await new Promise((r) => setImmediate(r)); };
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };

const emp = (name, extra = {}) => ({
  name, username: name.toLowerCase(), defaultOvertimeType: 'Ngoài khoán', defaultWorkMode: 'Tăng ca tại công ty', ...extra
});

function seed(api) {
  Object.assign(api.state, {
    employees: [emp('An'), emp('Bình'), emp('Quản đốc', { role: 'admin' })],
    records: [], offlineQueue: [], holidays: {}, dayStatuses: {}, lockedDays: {}, dayModAlerts: {},
    matrixMonth: '2026-10', adminFilterEmp: 'ALL', adminFilterDay: '', adminFilterMode: 'ALL', adminSearchQuery: '',
    activeExcelSheet: 'SHEET_MATRIX', adminUnlocked: true, authRole: 'ADMIN'
  });
  api.remote.token = 'tok';
}

const sh = (id, s, e, extra = {}) => ({
  id, start: `21/10/2026 ${s}`, end: `21/10/2026 ${e}`, overrideHours: null,
  workMode: 'Tăng ca tại công ty', overtimeType: 'Ngoài khoán', jobContent: 'Làm theo kế hoạch', note: '', ...extra
});
let nextId = 100;
const DAY_LEVEL = ['day_lock', 'day_unlock', 'holiday_set', 'holiday_delete'];
const ACCOUNT_LEVEL = ['account_create', 'account_update', 'account_delete', 'password_reset', 'password_change'];
const ent = (action, o = {}) => ({
  id: nextId--, txid: 1, at: '2026-10-21T09:05:00Z', atVn: '21/10/2026 16:05', actorName: 'Quản đốc', actorRole: 'admin',
  source: 'web', action,
  targetName: DAY_LEVEL.includes(action) ? null : 'An',
  workDate: ACCOUNT_LEVEL.includes(action) ? null : '21/10/2026',
  before: null, after: null, ...o
});
const plain = (v) => JSON.parse(JSON.stringify(v)); // mảng từ vm khác realm
const lines = (api, e, moves) => plain(api.auditEntryLines(e, moves));

test('labels: shifts', () => {
  const { api } = fixture();
  assert.deepEqual(lines(api, ent('record_add', { after: sh('a', '17:15', '18:15') })),
    ['Thêm ca 17:15–18:15 (Tăng ca tại công ty)']);
  assert.deepEqual(lines(api, ent('record_edit', { before: sh('a', '17:15', '18:15'), after: sh('a', '17:15', '19:15') })),
    ['Đổi ca 17:15–18:15 → 17:15–19:15']);
  assert.deepEqual(lines(api, ent('record_delete', { before: sh('a', '11:15', '13:15') })), ['Xóa ca 11:15–13:15']);
  // ca qua nửa đêm: ngày khác ngày đang xem thì ghi kèm dd/mm
  const night = { ...sh('a', '22:00', '01:00'), end: '22/10/2026 01:00' };
  assert.deepEqual(lines(api, ent('record_add', { after: night })), ['Thêm ca 22:00–22/10 01:00 (Tăng ca tại công ty)']);
});

test('labels: other fields of an edited shift', () => {
  const { api } = fixture();
  const before = sh('a', '17:15', '18:15');
  const out = lines(api, ent('record_edit', {
    before,
    after: { ...before, jobContent: 'Dọn xưởng', note: 'gấp', workMode: 'Tăng ca tại nhà', overtimeType: 'Khoán', overrideHours: 1.5 }
  }));
  assert.deepEqual(out, [
    'Ca 17:15–18:15: Nội dung: “Làm theo kế hoạch” → “Dọn xưởng”',
    'Ca 17:15–18:15: Ghi chú: “” → “gấp”',
    'Ca 17:15–18:15: Hình thức: Tăng ca tại công ty → Tăng ca tại nhà',
    'Ca 17:15–18:15: Loại tăng ca: Ngoài khoán → Khoán',
    'Ca 17:15–18:15: Giờ chốt: tự tính → 1.5h'
  ]);
});

test('labels: move out/in paired by txid and shift id', () => {
  const { api } = fixture();
  const out = ent('record_move_out', { txid: 7, targetName: 'An', workDate: '21/10/2026', before: sh('m', '17:15', '18:15') });
  const inn = ent('record_move_in', { txid: 7, targetName: 'Bình', workDate: '22/10/2026', after: { ...sh('m', '17:15', '18:15'), start: '22/10/2026 17:15', end: '22/10/2026 18:15' } });
  const groups = api.auditGroupEntries([inn, out]);
  assert.equal(groups.length, 2);
  assert.deepEqual(plain(groups.find((g) => g.targetName === 'An').lines), ['Chuyển ca 17:15–18:15 sang Bình ngày 22/10']);
  assert.deepEqual(plain(groups.find((g) => g.targetName === 'Bình').lines), ['Nhận ca 17:15–18:15 từ An ngày 21/10']);
  assert.deepEqual(lines(api, out, {}), ['Chuyển ca 17:15–18:15 sang người / ngày khác']);
});

test('labels: status, lock, alerts, holidays', () => {
  const { api } = fixture();
  assert.deepEqual(lines(api, ent('status_set', { before: { leave: '', earlyHours: 0 }, after: { leave: 'MORNING', earlyHours: 0 } })),
    ['Nghỉ: Đủ ngày → Nghỉ sáng']);
  assert.deepEqual(lines(api, ent('status_set', { before: null, after: { leave: '', earlyHours: 1 } })), ['Về sớm: 0 → 1h']);
  assert.deepEqual(lines(api, ent('status_set', { before: { leave: 'FULL', earlyHours: 0 }, after: { leave: 'AFTERNOON', earlyHours: 0.5 } })),
    ['Nghỉ: Nghỉ cả ngày (P) → Nghỉ chiều', 'Về sớm: 0 → 0.5h']);
  assert.deepEqual(lines(api, ent('status_clear', { before: { leave: 'MORNING', earlyHours: 1 } })),
    ['Bỏ nghỉ / về sớm (Nghỉ sáng, về sớm 1h)']);
  assert.deepEqual(lines(api, ent('day_lock')), ['Chốt ngày']);
  assert.deepEqual(lines(api, ent('day_unlock')), ['Bỏ chốt ngày']);
  assert.deepEqual(lines(api, ent('alert_approve', { before: { beforeCode: 'X+2', afterCode: 'X+3' } })),
    ['Duyệt sửa sau chốt: X+2 → X+3']);
  assert.deepEqual(lines(api, ent('holiday_set', { after: { name: 'Quốc khánh' } })), ['Ngày lễ: Quốc khánh']);
  assert.deepEqual(lines(api, ent('holiday_delete', { before: { name: 'Quốc khánh' } })), ['Bỏ ngày lễ: Quốc khánh']);
});

test('labels: accounts', () => {
  const { api } = fixture();
  const acc = (action, o) => lines(api, ent(action, { workDate: null, ...o }));
  assert.match(acc('account_create', { after: { username: 'an', role: 'worker', hasTimesheet: true, startDate: null } })[0], /^Tạo tài khoản/);
  assert.deepEqual(acc('account_update', { before: { role: 'worker' }, after: { role: 'admin' } }),
    ['Đổi quyền: Công nhân → Admin – Quản đốc']);
  assert.deepEqual(acc('account_update', { before: { hasTimesheet: true }, after: { hasTimesheet: false } }), ['Tắt chấm công cá nhân']);
  assert.deepEqual(acc('account_update', { before: { hasTimesheet: false }, after: { hasTimesheet: true } }), ['Bật chấm công cá nhân']);
  assert.deepEqual(acc('account_update', { before: { notifyManager: false }, after: { notifyManager: true } }),
    ['Nhận báo cáo quản lý: Tắt → Bật']);
  assert.deepEqual(acc('account_update', { before: { startDate: null }, after: { startDate: '2026-10-01' } }),
    ['Ngày bắt đầu: (trống) → 01/10/2026']);
  assert.deepEqual(acc('password_reset'), ['Đặt lại mật khẩu']);
  assert.deepEqual(acc('password_change'), ['Tự đổi mật khẩu']);
  assert.match(acc('account_delete', { before: { username: 'an', role: 'worker' } })[0], /^Xóa tài khoản \(an, Công nhân\)/);
});

test('unknown action and missing payload never crash', () => {
  const { api } = fixture();
  assert.deepEqual(lines(api, ent('brand_new_thing')), ['Thay đổi: brand_new_thing']);
  assert.doesNotThrow(() => api.auditGroupsHtml([ent('record_edit'), ent('record_add'), ent('status_set'), { id: 1, action: null }], true));
});

test('grouping: consecutive same (txid, target, day) is one block; header names actor and role', () => {
  const { api } = fixture();
  const a = ent('record_add', { txid: 5, after: sh('a', '17:15', '18:15') });
  const b = ent('status_set', { txid: 5, after: { leave: '', earlyHours: 1 } });
  const c = ent('day_lock', { txid: 6, targetName: null, workDate: '21/10/2026', actorName: null, actorRole: null, source: 'sql' });
  const w = ent('day_lock', { txid: 7, actorName: 'Công', actorRole: 'worker' });
  assert.equal(api.auditGroupEntries([a, b]).length, 1);
  assert.equal(api.auditGroupEntries([a, ent('record_add', { txid: 5, workDate: '22/10/2026', after: sh('x', '17:15', '18:15') })]).length, 2);
  assert.equal(api.auditGroupEntries([a, c, ent('record_add', { txid: 5 })]).length, 3, 'only consecutive entries merge');
  const html = api.auditGroupsHtml([w, c, a, b], true);
  assert.match(html, /21\/10\/2026 16:05 · Quản đốc \(Quản đốc\) · An ngày 21\/10\/2026/);
  assert.match(html, /Công \(Công nhân\)/);
  assert.match(html, /SQL Editor/);
  assert.equal(html.match(/audit-group"/g).length, 3);
  // trong 1 khối: đọc theo thứ tự đã xảy ra (dòng cũ trước)
  assert.ok(html.indexOf('Về sớm') < html.indexOf('Thêm ca'));
  assert.doesNotMatch(api.auditGroupsHtml([a], false), / · An ngày/, 'modal view omits the person/day');
});

test('escapeHtml on every server string', () => {
  const { api } = fixture();
  const evil = '<img src=x onerror=alert(1)>';
  const html = api.auditGroupsHtml([
    ent('record_edit', { actorName: evil, targetName: evil, atVn: evil, before: sh('a', '17:15', '18:15', { note: evil }), after: sh('a', '17:15', '18:15', { note: '"><script>x</script>', jobContent: evil }) }),
    ent('holiday_set', { txid: 2, after: { name: evil } }),
    ent('alert_approve', { txid: 3, before: { beforeCode: evil, afterCode: evil } }),
    ent('mystery', { txid: 4, action: evil }),
    ent('account_update', { txid: 8, before: { username: evil }, after: { username: evil } })
  ], true);
  assert.doesNotMatch(html, /<img|<script/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

function entriesResponse(entries, more = false) {
  return { status: 200, body: { ok: true, entries, more } };
}

test('modal: details fetch args, loading text, render, no fetch before open', async () => {
  const { api, calls, el } = fixture({
    respond: () => entriesResponse([ent('record_edit', { before: sh('a', '17:15', '18:15'), after: sh('a', '17:15', '19:15') })])
  });
  seed(api);
  api.openMatrixCellQuickModal('An', '21/10/2026');
  await flush();
  assert.equal(calls.length, 0, 'closed details do not call the server');
  assert.equal(el('matrixQuickAudit').style.display, '', 'visible for remote admin');
  assert.equal(el('matrixQuickAudit').open, false, 'closed by default');
  el('matrixQuickAudit').open = true;
  api.loadQuickAudit(false);
  assert.match(el('matrixQuickAuditBody').innerHTML, /Đang tải…/);
  await flush();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].fn, 'app_audit_list');
  assert.deepEqual(calls[0].args, {
    p_token: 'tok', p_from: '2026-10-21', p_to: '2026-10-21', p_employee: 'An', p_before_id: null, p_limit: 30
  });
  assert.match(el('matrixQuickAuditBody').innerHTML, /Đổi ca 17:15–18:15 → 17:15–19:15/);
  api.loadQuickAudit(false); // mở lại / toggle lần nữa: không gọi lại
  await flush();
  assert.equal(calls.length, 1);
  // vẽ lại hộp sau khi sửa không đụng tới mục lịch sử
  api.renderMatrixCellQuickModal();
  assert.match(el('matrixQuickAuditBody').innerHTML, /Đổi ca/);
  assert.equal(el('matrixQuickAudit').open, true);
});

test('modal: late result for cell A is never rendered into cell B', async () => {
  const gates = {};
  const { api, calls, el } = fixture({
    respond: (fn, args) => {
      gates[args.p_employee] = deferred();
      return gates[args.p_employee].promise;
    }
  });
  seed(api);
  api.openMatrixCellQuickModal('An', '21/10/2026');
  el('matrixQuickAudit').open = true;
  api.loadQuickAudit(false);
  await flush();
  api.openMatrixCellQuickModal('Bình', '22/10/2026'); // đổi sang ô khác khi A chưa trả về
  el('matrixQuickAudit').open = true;
  api.loadQuickAudit(false);
  await flush();
  assert.equal(calls.length, 1, 'request queue: B waits for A');
  gates['An'].resolve(entriesResponse([ent('holiday_set', { after: { name: 'CHỈ-CỦA-AN' } })]));
  await flush();
  assert.doesNotMatch(el('matrixQuickAuditBody').innerHTML, /CHỈ-CỦA-AN/, 'late result of A must not draw into B');
  assert.equal(calls.length, 2);
  gates['Bình'].resolve(entriesResponse([ent('day_lock', { targetName: 'Bình' })]));
  await flush();
  const html = el('matrixQuickAuditBody').innerHTML;
  assert.match(html, /Chốt ngày/);
  assert.doesNotMatch(html, /CHỈ-CỦA-AN/);
});

test('modal: late result of A is also ignored when it returns before B finishes loading', async () => {
  const gates = [];
  const { api, el } = fixture({ respond: () => { const g = deferred(); gates.push(g); return g.promise; } });
  seed(api);
  api.openMatrixCellQuickModal('An', '21/10/2026');
  el('matrixQuickAudit').open = true;
  api.loadQuickAudit(false);
  await flush();
  api.openMatrixCellQuickModal('Bình', '21/10/2026');
  el('matrixQuickAudit').open = true;
  api.loadQuickAudit(false);
  await flush();
  gates[0].resolve(entriesResponse([ent('holiday_set', { after: { name: 'CỦA-AN' } })]));
  await flush();
  assert.doesNotMatch(el('matrixQuickAuditBody').innerHTML, /CỦA-AN/);
  assert.match(el('matrixQuickAuditBody').innerHTML, /Đang tải…/);
});

test('modal: hidden in local demo mode and for non-remote sessions', async () => {
  const { api, calls, el } = fixture({ remoteMode: false });
  seed(api);
  api.openMatrixCellQuickModal('An', '21/10/2026');
  assert.equal(el('matrixQuickAudit').style.display, 'none');
  el('matrixQuickAudit').open = true;
  api.loadQuickAudit(false);
  await flush();
  assert.equal(calls.length, 0);
});

test('modal: old server (PGRST202) shows the upgrade message', async () => {
  const { api, el } = fixture({ respond: () => ({ status: 404, body: { code: 'PGRST202', message: 'Could not find the function' } }) });
  seed(api);
  api.openMatrixCellQuickModal('An', '21/10/2026');
  el('matrixQuickAudit').open = true;
  api.loadQuickAudit(false);
  await flush();
  assert.match(el('matrixQuickAuditBody').innerHTML, /Máy chủ chưa có Lịch sử sửa đổi — Quản trị viên chạy lại supabase_setup\.sql/);
});

test('modal: reload after a successful push only while modal and details are open', async () => {
  const { api, calls, el } = fixture({
    respond: (fn) => (fn === 'app_push' ? { status: 200, body: { ok: true, receipts: {} } } : entriesResponse([ent('day_lock')]))
  });
  seed(api);
  api.openMatrixCellQuickModal('An', '21/10/2026');
  el('matrixQuickAudit').open = true;
  api.loadQuickAudit(false);
  await flush();
  assert.equal(calls.filter((c) => c.fn === 'app_audit_list').length, 1);

  api.remote.snapshot = R.snapshotFromState(api.state, 'ADMIN');
  api.state.dayStatuses['21/10/2026::An'] = { leave: 'MORNING', earlyHours: 0 };
  const res = await api.remotePushInner();
  assert.equal(res.ok, true);
  await flush();
  const order = calls.map((c) => c.fn);
  assert.deepEqual(order, ['app_audit_list', 'app_push', 'app_audit_list'], 'history is re-read AFTER the push');

  // push rỗng (count 0) hoặc hộp đóng thì không tải lại
  await api.remotePushInner();
  el('modalMatrixCellQuick').classList.remove('open');
  api.state.dayStatuses['22/10/2026::An'] = { leave: 'FULL', earlyHours: 0 };
  await api.remotePushInner();
  await flush();
  assert.deepEqual(calls.map((c) => c.fn), ['app_audit_list', 'app_push', 'app_audit_list', 'app_push']);
});

test('modal: history request waits for a pending push in the queue', async () => {
  const gate = deferred();
  const { api, calls, el } = fixture({
    respond: (fn) => (fn === 'app_push' ? gate.promise : entriesResponse([]))
  });
  seed(api);
  api.openMatrixCellQuickModal('An', '21/10/2026');
  el('matrixQuickAudit').open = true;
  api.remote.snapshot = R.snapshotFromState(api.state, 'ADMIN');
  api.state.dayStatuses['21/10/2026::An'] = { leave: 'MORNING', earlyHours: 0 };
  const pushing = api.remotePush(); // đi qua hàng đợi như syncWithCentralServer
  api.loadQuickAudit(false);
  await flush();
  assert.deepEqual(calls.map((c) => c.fn), ['app_push'], 'audit read must wait until the pending push finishes');
  gate.resolve({ status: 200, body: { ok: true, receipts: {} } });
  await pushing;
  await flush();
  assert.ok(calls.map((c) => c.fn).includes('app_audit_list'));
  assert.equal(calls.map((c) => c.fn).indexOf('app_push'), 0);
});

test('modal: "Xem tất cả" switches to the history tab with employee and day filters', async () => {
  const { api, calls, el } = fixture({ respond: () => entriesResponse([]) });
  seed(api);
  api.openMatrixCellQuickModal('An', '21/10/2026');
  api.jumpQuickAuditToHistoryTab();
  assert.equal(api.state.activeExcelSheet, 'SHEET_HISTORY');
  assert.equal(api.state.adminFilterEmp, 'An');
  assert.equal(api.state.adminFilterDay, '2026-10-21');
  assert.equal(el('modalMatrixCellQuick').classList.contains('open'), false);
  await flush();
  const c = calls.filter((x) => x.fn === 'app_audit_list');
  assert.equal(c.length, 1);
  // từ 1 ô bảng công: xem các lần sửa công CỦA NGÀY ĐÓ
  assert.deepEqual(c[0].args, { p_token: 'tok', p_from: '2026-10-21', p_to: '2026-10-21', p_employee: 'An', p_before_id: null, p_limit: 100, p_by: 'work' });
});

test('tab: fetches only when active, caches by filter, month range and ALL -> null', async () => {
  const { api, calls, el } = fixture({ respond: () => entriesResponse([ent('day_lock')]) });
  seed(api);
  api.renderAdminDashboard();
  await flush();
  assert.equal(calls.length, 0, 'tab hidden: no request');
  assert.equal(el('sheetViewHistory').style.display, 'none');

  api.state.activeExcelSheet = 'SHEET_HISTORY';
  api.renderAdminDashboard();
  await flush();
  assert.equal(el('sheetViewHistory').style.display, 'block');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, { p_token: 'tok', p_from: '2026-10-01', p_to: '2026-10-31', p_employee: null, p_before_id: null, p_limit: 100, p_by: 'edit' });
  assert.match(el('sheetViewHistory').innerHTML, /Chốt ngày/);
  assert.match(el('sheetViewHistory').innerHTML, /chọn Nhân viên = Tất cả/);

  api.renderAdminDashboard();
  api.renderAdminDashboard();
  await flush();
  assert.equal(calls.length, 1, 'same filter: cached');

  api.state.adminFilterEmp = 'An';
  api.renderAdminDashboard();
  await flush();
  assert.equal(calls.length, 2);
  assert.equal(calls[1].args.p_employee, 'An');

  api.state.adminFilterDay = '2026-10-05';
  api.renderAdminDashboard();
  await flush();
  assert.equal(calls.length, 3);
  assert.equal(calls[2].args.p_from, '2026-10-05');
  assert.equal(calls[2].args.p_to, '2026-10-05');
});

test('tab: mặc định lọc theo NGÀY SỬA (hôm nay sửa công ngày 09 thì lọc hôm nay là thấy); chọn "Ngày công bị sửa" thì lọc theo ngày công', async () => {
  const { api, calls, el } = fixture({
    respond: () => entriesResponse([ent('record_edit', { atVn: '22/10/2026 10:00', workDate: '09/10/2026',
      before: { ...sh('a', '17:15', '18:15'), start: '09/10/2026 17:15', end: '09/10/2026 18:15' },
      after: { ...sh('a', '17:15', '19:15'), start: '09/10/2026 17:15', end: '09/10/2026 19:15' } })])
  });
  seed(api);
  api.state.adminFilterDay = '2026-10-22';
  api.state.activeExcelSheet = 'SHEET_HISTORY';
  api.renderAdminDashboard();
  await flush();
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, { p_token: 'tok', p_from: '2026-10-22', p_to: '2026-10-22', p_employee: null, p_before_id: null, p_limit: 100, p_by: 'edit' });
  let html = el('sheetViewHistory').innerHTML;
  assert.match(html, /<option value="edit" selected>Ngày sửa \(lúc bấm Lưu\)<\/option>/);
  assert.match(html, /những gì đã sửa trong ngày 22\/10\/2026/);
  assert.match(html, /An ngày 09\/10\/2026/, 'khối ghi rõ công của ngày nào bị sửa');

  api.auditTab.by = 'work'; // như khi chọn "Ngày công bị sửa"
  api.renderAuditHistorySheet();
  await flush();
  assert.equal(calls.length, 2, 'đổi cách lọc thì tải lại');
  assert.equal(calls[1].args.p_by, 'work');
  html = el('sheetViewHistory').innerHTML;
  assert.match(html, /<option value="work" selected>Ngày công bị sửa<\/option>/);
  assert.match(html, /các lần sửa công của ngày 22\/10\/2026/);

  // Xem thêm giữ nguyên cách lọc
  api.auditTab.more = true;
  api.auditTabLoadMore();
  await flush();
  assert.equal(calls[2].args.p_by, 'work');
});

test('remote.js auditList: chỉ gửi p_by khi có (máy chủ tự hiểu mặc định là ngày công)', async () => {
  const sent = [];
  global.fetch = async (url, opts) => {
    sent.push(JSON.parse(opts.body));
    return { ok: true, status: 200, json: async () => ({ ok: true, entries: [], more: false }) };
  };
  try {
    const c = R.createClient({ url: 'https://x.invalid', key: 'k' });
    await c.auditList('tok', { from: '2026-10-22', to: '2026-10-22', by: 'edit' });
    await c.auditList('tok', { from: '2026-10-09', to: '2026-10-09', employee: 'An' });
    assert.equal(sent[0].p_by, 'edit');
    assert.equal('p_by' in sent[1], false);
  } finally {
    global.fetch = realFetch;
  }
});

test('tab: "Xem thêm" pages with p_before_id = last id and appends', async () => {
  const page1 = [ent('day_lock', { id: 50, txid: 50 }), ent('day_unlock', { id: 49, txid: 49 })];
  const page2 = [ent('holiday_set', { id: 48, txid: 48, after: { name: 'Lễ cũ' } })];
  const { api, calls, el } = fixture({
    respond: (fn, args) => (args.p_before_id ? entriesResponse(page2, false) : entriesResponse(page1, true))
  });
  seed(api);
  api.state.activeExcelSheet = 'SHEET_HISTORY';
  api.renderAdminDashboard();
  await flush();
  assert.match(el('sheetViewHistory').innerHTML, /data-audit-more/);
  api.auditTabLoadMore();
  await flush();
  assert.equal(calls.length, 2);
  assert.equal(calls[1].args.p_before_id, 49);
  const html = el('sheetViewHistory').innerHTML;
  assert.match(html, /Chốt ngày/);
  assert.match(html, /Ngày lễ: Lễ cũ/);
  assert.doesNotMatch(html, /data-audit-more/);
});

test('tab: local demo mode shows the notice and never calls the server', async () => {
  const { api, calls, el } = fixture({ remoteMode: false });
  seed(api);
  api.state.activeExcelSheet = 'SHEET_HISTORY';
  api.renderAdminDashboard();
  await flush();
  assert.match(el('sheetViewHistory').innerHTML, /Lịch sử sửa đổi chỉ có khi kết nối máy chủ \(Supabase\)\./);
  assert.equal(calls.length, 0);
});

test('tab: old server (PGRST202) shows the upgrade message and does not loop', async () => {
  const { api, calls, el } = fixture({ respond: () => ({ status: 404, body: { code: 'PGRST202', message: 'x' } }) });
  seed(api);
  api.state.activeExcelSheet = 'SHEET_HISTORY';
  api.renderAdminDashboard();
  await flush();
  api.renderAdminDashboard();
  await flush();
  assert.match(el('sheetViewHistory').innerHTML, /Máy chủ chưa có Lịch sử sửa đổi — Quản trị viên chạy lại supabase_setup\.sql/);
  assert.equal(calls.length, 1);
});

test('tab: forbidden hint (worker) shows a plain message', async () => {
  const { api, el } = fixture({ respond: () => ({ status: 400, body: { code: 'P0001', message: 'forbidden', hint: 'forbidden' } }) });
  seed(api);
  api.state.activeExcelSheet = 'SHEET_HISTORY';
  api.renderAdminDashboard();
  await flush();
  assert.match(el('sheetViewHistory').innerHTML, /Chỉ Quản đốc xem được/);
});

test('remote.js auditList: arguments, defaults and missing-function flag', async () => {
  const sent = [];
  let status = 200;
  let body = { ok: true, entries: [], more: false };
  global.fetch = async (url, opts) => {
    sent.push({ url, args: JSON.parse(opts.body) });
    return { ok: status === 200, status, json: async () => body };
  };
  try {
    const c = R.createClient({ url: 'https://x.invalid/', key: 'k' });
    let res = await c.auditList('tok', { from: '2026-10-01', to: '2026-10-31', employee: 'An', beforeId: 9, limit: 50 });
    assert.equal(res.ok, true);
    assert.match(sent[0].url, /\/rest\/v1\/rpc\/app_audit_list$/);
    assert.deepEqual(sent[0].args, { p_token: 'tok', p_from: '2026-10-01', p_to: '2026-10-31', p_employee: 'An', p_before_id: 9, p_limit: 50 });
    await c.auditList('tok', {});
    assert.deepEqual(sent[1].args, { p_token: 'tok', p_from: null, p_to: null, p_employee: null, p_before_id: null, p_limit: 100 });
    for (const [st, code] of [[404, 'PGRST202'], [404, '42883'], [404, '']]) {
      status = st;
      body = { code, message: 'nope' };
      res = await c.auditList('tok', {});
      assert.equal(res.ok, false);
      assert.equal(res.auditMissing, true);
      assert.equal(res.message, 'Máy chủ chưa có Lịch sử sửa đổi — Quản trị viên chạy lại supabase_setup.sql');
    }
    status = 400;
    body = { code: 'P0001', message: 'forbidden', hint: 'forbidden' };
    res = await c.auditList('tok', {});
    assert.equal(res.auditMissing, undefined);
    assert.equal(res.hint, 'forbidden');
  } finally {
    global.fetch = realFetch;
  }
});

test('remote.js stays CRLF only', () => {
  const raw = fs.readFileSync(path.join(__dirname, '../remote.js'), 'utf8');
  assert.equal(/(^|[^\r])\n/.test(raw), false);
});

test('tab view: day-level entries (no person) still show the day; modal view shows no place', () => {
  const { api } = fixture();
  const lock = ent('day_lock');
  const hol = ent('holiday_set', { txid: 2, after: { name: 'Quốc khánh' } });
  const html = api.auditGroupsHtml([lock, hol], true);
  assert.equal((html.match(/· ngày 21\/10\/2026/g) || []).length, 2);
  const modal = api.auditGroupsHtml([lock], false);
  assert.match(modal, /Chốt ngày/);
  assert.doesNotMatch(modal, /ngày 21/);
  assert.match(api.auditGroupsHtml([ent('password_reset')], true), /· An<\/div>/);
});

test('move without a pair uses toEmployee/toDate and fromEmployee/fromDate, escaped', () => {
  const { api } = fixture();
  const evil = '<b>x</b>';
  const out = ent('record_move_out', { txid: 3, before: sh('m', '17:15', '18:15'), after: { toEmployee: evil, toDate: '22/10/2026' } });
  const inn = ent('record_move_in', { txid: 4, after: sh('n', '17:15', '18:15'), before: { fromEmployee: 'Bình', fromDate: '20/10/2026' } });
  assert.deepEqual(lines(api, out, {}), ['Chuyển ca 17:15–18:15 sang <b>x</b> ngày 22/10']);
  assert.deepEqual(lines(api, inn, {}), ['Nhận ca 17:15–18:15 từ Bình ngày 20/10']);
  const html = api.auditGroupsHtml([out, inn], true);
  assert.doesNotMatch(html, /<b>/);
  assert.match(html, /&lt;b&gt;x&lt;\/b&gt; ngày 22\/10/);
});

test('modal: collapse -> successful push -> reopen fetches again and shows the new entry', async () => {
  let n = 0;
  const { api, calls, el } = fixture({
    respond: (fn) => (fn === 'app_push' ? { status: 200, body: { ok: true, receipts: {} } }
      : entriesResponse([ent('holiday_set', { after: { name: n++ ? 'MỚI' : 'CŨ' } })]))
  });
  seed(api);
  api.openMatrixCellQuickModal('An', '21/10/2026');
  el('matrixQuickAudit').open = true;
  api.loadQuickAudit(false);
  await flush();
  assert.match(el('matrixQuickAuditBody').innerHTML, /CŨ/);
  el('matrixQuickAudit').open = false; // thu gọn
  api.remote.snapshot = R.snapshotFromState(api.state, 'ADMIN');
  api.state.dayStatuses['21/10/2026::An'] = { leave: 'MORNING', earlyHours: 0 };
  await api.remotePushInner();
  await flush();
  assert.equal(calls.filter((c) => c.fn === 'app_audit_list').length, 1, 'collapsed: no fetch yet');
  el('matrixQuickAudit').open = true;
  api.loadQuickAudit(false); // sự kiện toggle khi mở lại
  await flush();
  assert.equal(calls.filter((c) => c.fn === 'app_audit_list').length, 2);
  assert.match(el('matrixQuickAuditBody').innerHTML, /MỚI/);
});
