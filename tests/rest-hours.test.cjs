// Run: node --test tests/rest-hours.test.cjs
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function fixture({ remoteMode = false } = {}) {
  const elements = {};
  for (const [id, value] of Object.entries({
    mobileWorkDate: '2020-10-18', restStart: '07:15', restEnd: '17:15',
    restActualHours: '8', mobileJobContent: 'Làm theo kế hoạch', mobileNoteInput: '',
    restWorkCheck: '', btnRestFull: '', btnRestHalf: ''
  })) {
    elements[id] = {
      value, checked: id === 'restWorkCheck', validity: {}, handlers: {}, style: {},
      classList: { add() {}, remove() {}, toggle() {} },
      addEventListener(event, fn) { this.handlers[event] = fn; },
      focus() {}, setAttribute() {}, setCustomValidity() {}
    };
  }
  const document = {
    readyState: 'loading', addEventListener() {},
    getElementById: id => elements[id] || null,
    querySelectorAll: () => [], querySelector: () => null
  };
  const storage = { getItem: () => null, setItem() {}, removeItem() {} };
  const window = { location: { protocol: 'file:' }, addEventListener() {}, history: {}, scrollTo() {} };
  if (remoteMode) {
    window.APP_CONFIG = { supabaseUrl: 'https://test.invalid', supabaseKey: 'test-only' };
    window.OTRemote = require('../remote.js');
  }
  const ctx = { window, document, navigator: {}, localStorage: storage, sessionStorage: storage,
    console, TextEncoder, URL, Blob, setTimeout, clearTimeout, setInterval, clearInterval };
  let src = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');
  const tail = src.lastIndexOf('})();');
  src = src.slice(0, tail) + `
    // Stub only rendering and IO; retain the actual form/save/validation/export logic.
    renderAll = () => {}; renderWorkerMobileView = () => {};
    showToast = (message) => { window.lastToast = message; };
    syncWithCentralServer = async () => ({});
    window.api = { state, remote, computeCurrentMobileDailySlots, handleWorkerMobileSubmit,
      loadExistingDayIntoMobileForm, inheritAdminFieldsForResave, getEmployeeDaySummary,
      generateExactTemplateXlsxBytes, bindAllEvents, resetWorkerForm };
  ` + src.slice(tail);
  vm.runInNewContext(src, ctx);
  const api = window.api;
  Object.assign(api.state, {
    employees: [{ name: 'Test Worker', defaultOvertimeType: 'Ngoài khoán', defaultWorkMode: 'Tăng ca tại công ty' }],
    selectedEmployeeName: 'Test Worker', loggedInEmployeeName: 'Test Worker', authRole: 'WORKER',
    records: [], offlineQueue: [], holidays: {}, dayStatuses: {}, lockedDays: {},
    matrixMonth: '2020-10', lastSubmitServerMs: 0, isWaitingServerAck: false
  });
  return { api, elements, window };
}

test('Sunday 07:15–17:15: save 8h, reload, change only hours to 10h; totals and Excel follow', async () => {
  const { api, elements } = fixture();
  assert.equal(api.computeCurrentMobileDailySlots().totalHours, 8);
  await api.handleWorkerMobileSubmit();
  assert.equal(api.state.records.length, 1);
  assert.equal(api.state.records[0].overrideHours, 8);
  assert.equal(api.state.records[0].endTime, '18/10/2020 17:15');
  const id = api.state.records[0].id;
  api.loadExistingDayIntoMobileForm('Test Worker', '2020-10-18');
  assert.equal(elements.restActualHours.value, '8');
  elements.restActualHours.value = '10';
  api.state.lastSubmitServerMs = 0;
  await api.handleWorkerMobileSubmit();
  assert.equal(api.state.records.length, 1);
  assert.equal(api.state.records[0].id, id);
  assert.equal(api.state.records[0].overrideHours, 10);
  assert.equal(api.getEmployeeDaySummary('Test Worker', '18/10/2020').totalHours, 10);
  const xml = Buffer.from(api.generateExactTemplateXlsxBytes(api.state.records)).toString('utf8');
  assert.equal(xml.match(/<c r="F8"[^>]*><v>([^<]*)<\/v><\/c>/)?.[1], '10');
});

test('Blank hours restores elapsed time; fractional actual hours survive saving', async () => {
  const { api, elements } = fixture();
  elements.restActualHours.value = '8.5';
  await api.handleWorkerMobileSubmit();
  assert.equal(api.state.records[0].overrideHours, 8.5);
  api.loadExistingDayIntoMobileForm('Test Worker', '2020-10-18');
  elements.restActualHours.value = '';
  api.state.lastSubmitServerMs = 0;
  await api.handleWorkerMobileSubmit();
  assert.equal(api.state.records[0].overrideHours, null);
  assert.equal(api.getEmployeeDaySummary('Test Worker', '18/10/2020').totalHours, 10);
  api.loadExistingDayIntoMobileForm('Test Worker', '2020-10-18');
  assert.equal(elements.restActualHours.value, '');
});

test('Invalid hours or time range never deletes or changes the previously saved shift', async () => {
  for (const raw of ['0', '-1', '11', 'NaN', 'Infinity', '8.123']) {
    const { api, elements, window } = fixture();
    await api.handleWorkerMobileSubmit();
    const before = JSON.stringify(api.state.records);
    api.loadExistingDayIntoMobileForm('Test Worker', '2020-10-18');
    elements.restActualHours.value = raw;
    api.state.lastSubmitServerMs = 0;
    await api.handleWorkerMobileSubmit();
    assert.equal(JSON.stringify(api.state.records), before, raw);
    assert.match(window.lastToast, /Số giờ làm thực tế/);
    elements.restActualHours.value = '';
    elements.restEnd.value = '07:15';
    await api.handleWorkerMobileSubmit();
    assert.equal(JSON.stringify(api.state.records), before);
    assert.match(window.lastToast, /Giờ kết thúc/);
  }
});

test('Holiday uses actual hours; weekday slots and admin overrides remain unchanged', () => {
  const { api, elements } = fixture();
  elements.mobileWorkDate.value = '2020-10-19';
  api.state.holidays['19/10/2020'] = 'Ngày lễ kiểm thử';
  assert.equal(api.computeCurrentMobileDailySlots().totalHours, 8);
  delete api.state.holidays['19/10/2020'];
  assert.equal(api.computeCurrentMobileDailySlots().totalHours, 0);
  const old = { id: 'existing', startTime: '19/10/2020 17:15', endTime: '19/10/2020 18:15', overrideHours: 0.5 };
  assert.equal(api.inheritAdminFieldsForResave({ ...old, overrideHours: null }, 'EVENING', [old], new Set()).overrideHours, 0.5);
});

test('Presets set actual hours, time edits reset them, opening an empty day resets stale values', () => {
  const { api, elements } = fixture();
  api.bindAllEvents();
  elements.btnRestHalf.handlers.click();
  assert.equal(elements.restEnd.value, '11:15');
  assert.equal(elements.restActualHours.value, '4');
  elements.btnRestFull.handlers.click();
  assert.equal(elements.restEnd.value, '17:15');
  assert.equal(elements.restActualHours.value, '8');
  elements.restEnd.value = '16:15';
  elements.restEnd.handlers.input();
  assert.equal(elements.restActualHours.value, '');
  assert.equal(api.computeCurrentMobileDailySlots().totalHours, 9);
  api.loadExistingDayIntoMobileForm('Test Worker', '2020-10-25');
  assert.equal(elements.restActualHours.value, '8');
  assert.equal(elements.restEnd.value, '17:15');
  assert.equal(elements.restWorkCheck.checked, false);
});

test('An old Supabase version cannot silently discard worker actual hours', async () => {
  const { api, window } = fixture({ remoteMode: true });
  await api.handleWorkerMobileSubmit();
  assert.equal(api.state.records.length, 0);
  assert.match(window.lastToast, /Máy chủ chưa hỗ trợ/);
  api.remote.supportsRestHours = true;
  await api.handleWorkerMobileSubmit();
  assert.equal(api.state.records[0].overrideHours, 8);
});
