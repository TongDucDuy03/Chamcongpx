/**
 * Kết nối Supabase cho "Chấm công tăng ca".
 * File này chỉ chứa phần thuần (không đụng giao diện):
 *  - createClient: gọi các hàm app_* trên Supabase qua REST.
 *  - computeOps: so sánh trạng thái đã đồng bộ với trạng thái hiện tại, ra danh sách thay đổi
 *    TỪNG DÒNG (thêm/sửa/xóa). Nhờ vậy nhiều người báo cùng lúc không ghi đè dữ liệu của nhau.
 */
(function (root) {
  'use strict';

  function createClient(cfg) {
    const url = String((cfg && cfg.url) || '').trim().replace(/\/+$/, '');
    const key = String((cfg && cfg.key) || '').trim();
    // Khóa kiểu cũ (anon) là JWT cần gửi cả header Authorization; khóa Publishable mới thì chỉ cần apikey
    const isJwt = /^eyJ/.test(key);
    const TIMEOUT_MS = 20000;

    async function rpc(fn, args) {
      const headers = { apikey: key, 'Content-Type': 'application/json' };
      if (isJwt) headers.Authorization = 'Bearer ' + key;

      const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const timer = ctrl ? setTimeout(() => ctrl.abort(), TIMEOUT_MS) : null;
      let res;
      try {
        res = await fetch(`${url}/rest/v1/rpc/${fn}`, {
          method: 'POST',
          headers,
          body: JSON.stringify(args || {}),
          cache: 'no-store',
          signal: ctrl ? ctrl.signal : undefined
        });
      } catch (_) {
        return { ok: false, network: true, message: 'Không kết nối được máy chủ. Hãy kiểm tra mạng rồi thử lại.' };
      } finally {
        if (timer) clearTimeout(timer);
      }

      let body = null;
      try {
        body = await res.json();
      } catch (_) {
        body = null;
      }
      if (res.ok) return { ok: true, data: body };

      const status = res.status;
      const code = body && body.code ? String(body.code) : '';
      let message = body && body.message ? String(body.message) : `Lỗi máy chủ (${status}).`;
      if (code === 'PGRST202' || code === '42883') {
        message = 'Chưa cài đặt cơ sở dữ liệu: hãy chạy file supabase_setup.sql trong Supabase (SQL Editor).';
      } else if (status === 401 || (status === 403 && !(body && body.hint))) {
        message = 'Khóa Supabase trong config.js chưa đúng hoặc đã bị tắt.';
      }
      return {
        ok: false,
        status,
        code,
        hint: body && body.hint ? String(body.hint) : '',
        message,
        retryable: status >= 500 || status === 429 || status === 408
      };
    }

    return { rpc, url };
  }

  function isRetryable(res) {
    return Boolean(res && (res.network || res.retryable));
  }

  // ---------------------------------------------------------------------------
  // Dạng chuẩn để so sánh (chỉ các trường thật sự lưu trên máy chủ)
  // ---------------------------------------------------------------------------

  function str(v) {
    return v === null || v === undefined ? '' : String(v);
  }

  function canonRecord(r) {
    const o = r.overrideHours;
    const overrideHours = o === null || o === undefined || o === '' || isNaN(Number(o)) ? null : Number(o);
    return {
      id: str(r.id),
      employeeName: str(r.employeeName),
      jobContent: str(r.jobContent).trim(),
      startTime: str(r.startTime).trim(),
      endTime: str(r.endTime).trim(),
      workDate: str(r.workDate).trim(),
      overrideHours,
      overtimeType: str(r.overtimeType),
      workMode: str(r.workMode),
      note: str(r.note).trim(),
      modifiedAfterLock: Boolean(r.modifiedAfterLock),
      modifiedAt: str(r.modifiedAt)
    };
  }

  function canonEmployee(e) {
    return {
      name: str(e.name),
      username: str(e.username).toLowerCase(),
      defaultOvertimeType: str(e.defaultOvertimeType),
      defaultWorkMode: str(e.defaultWorkMode),
      startDate: e.startDate || null,
      endDate: e.endDate || null
    };
  }

  /** Chụp lại trạng thái hiện tại thành các chuỗi để so sánh nhanh. */
  function snapshotFromState(st, role) {
    const snap = { records: {}, employees: {}, holidays: {}, locked: {}, alerts: {} };
    (st.records || []).forEach((r) => {
      snap.records[r.id] = JSON.stringify(canonRecord(r));
    });
    if (role === 'ADMIN') {
      (st.employees || []).forEach((e) => {
        snap.employees[e.name] = JSON.stringify(canonEmployee(e));
      });
      Object.keys(st.holidays || {}).forEach((k) => {
        snap.holidays[k] = str(st.holidays[k]);
      });
      Object.keys(st.lockedDays || {}).forEach((k) => {
        snap.locked[k] = JSON.stringify(st.lockedDays[k]);
      });
    }
    Object.keys(st.dayModAlerts || {}).forEach((k) => {
      snap.alerts[k] = JSON.stringify(st.dayModAlerts[k]);
    });
    return snap;
  }

  /**
   * So sánh `prev` (đã đồng bộ) với trạng thái hiện tại `st`.
   * Trả về { ops, count, sentSnapshot, passwords }.
   *  - ops: đúng định dạng hàm app_push nhận
   *  - sentSnapshot: ảnh chụp tại đúng thời điểm tính, dùng làm "đã đồng bộ" khi gửi thành công
   *  - passwords: mật khẩu mới đang chờ gửi (để xóa khỏi bộ nhớ sau khi gửi xong)
   */
  function computeOps(prev, st, role) {
    const ops = {};
    let count = 0;
    const add = (k, v) => {
      (ops[k] = ops[k] || []).push(v);
      count += 1;
    };
    const cur = snapshotFromState(st, role);
    const passwords = {};

    const recById = {};
    (st.records || []).forEach((r) => {
      recById[r.id] = r;
    });
    Object.keys(cur.records).forEach((id) => {
      if (prev.records[id] !== cur.records[id]) add('recordsUpsert', canonRecord(recById[id]));
    });
    Object.keys(prev.records).forEach((id) => {
      if (!(id in cur.records)) add('recordsDelete', id);
    });

    Object.keys(cur.alerts).forEach((k) => {
      if (prev.alerts[k] !== cur.alerts[k]) add('alertsUpsert', { key: k, data: st.dayModAlerts[k] });
    });

    if (role === 'ADMIN') {
      Object.keys(prev.alerts).forEach((k) => {
        if (!(k in cur.alerts)) add('alertsDelete', k);
      });

      (st.employees || []).forEach((e) => {
        const pw = e.password ? String(e.password) : '';
        if (prev.employees[e.name] !== cur.employees[e.name] || pw) {
          const o = canonEmployee(e);
          if (pw) {
            o.password = pw;
            passwords[e.name] = pw;
          }
          add('employeesUpsert', o);
        }
      });
      Object.keys(prev.employees).forEach((n) => {
        if (!(n in cur.employees)) add('employeesDelete', n);
      });

      Object.keys(cur.holidays).forEach((k) => {
        if (prev.holidays[k] !== cur.holidays[k]) add('holidaysUpsert', { date: k, name: cur.holidays[k] });
      });
      Object.keys(prev.holidays).forEach((k) => {
        if (!(k in cur.holidays)) add('holidaysDelete', k);
      });

      Object.keys(cur.locked).forEach((k) => {
        if (prev.locked[k] !== cur.locked[k]) add('lockedUpsert', { date: k, data: st.lockedDays[k] });
      });
      Object.keys(prev.locked).forEach((k) => {
        if (!(k in cur.locked)) add('lockedDelete', k);
      });
    }

    return { ops, count, sentSnapshot: cur, passwords };
  }

  /** Chia nhỏ khi gửi quá nhiều dòng (ví dụ nhập file sao lưu lớn). */
  function chunkOps(ops, size) {
    const limit = size || 200;
    const ups = ops.recordsUpsert || [];
    const dels = ops.recordsDelete || [];
    if (ups.length + dels.length <= limit) return [ops];
    const chunks = [];
    const rest = Object.assign({}, ops);
    delete rest.recordsUpsert;
    delete rest.recordsDelete;
    if (Object.keys(rest).length) chunks.push(rest); // nhân viên/ngày lễ... trước, để ca tham chiếu được
    for (let i = 0; i < dels.length; i += limit) chunks.push({ recordsDelete: dels.slice(i, i + limit) });
    for (let i = 0; i < ups.length; i += limit) chunks.push({ recordsUpsert: ups.slice(i, i + limit) });
    return chunks;
  }

  const api = { createClient, isRetryable, canonRecord, canonEmployee, snapshotFromState, computeOps, chunkOps };
  root.OTRemote = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
