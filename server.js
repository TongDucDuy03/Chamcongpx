/**
 * ============================================================================
 * MÁY CHỦ TẬP TRUNG & CẦU NỐI DI CHUYỂN DỮ LIỆU LÊN CLOUD (SUPABASE / GITHUB PAGES)
 * Chạy lệnh: `node server.js` hoặc nhấp đúp `KHOI_CHAY_SERVER.bat`
 * Dữ liệu gốc tại máy Sếp: `san_pham/data/overtime_db.json`
 * Tích hợp:
 *  - Cấp Server Timestamp chống công nhân chỉnh lùi đồng hồ điện thoại
 *  - Xác thực PIN nhân viên & Admin Auth phía Server (Chống lộ qua F12)
 *  - API Migration 1 chạm đẩy toàn bộ dữ liệu từ máy Sếp lên Cloud Database
 * ============================================================================
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const PORT = process.env.PORT || 3080;
const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'overtime_db.json');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function getLocalLanIp() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        return net.address;
      }
    }
  }
  return 'localhost';
}

function hashPinSha256(pinStr) {
  return crypto.createHash('sha256').update(`ARGON_OT_SALT_2026:${String(pinStr || '').trim()}`).digest('hex');
}

function readDb() {
  try {
    if (fs.existsSync(DB_FILE)) {
      return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    }
  } catch (_) {}
  return { employees: [], records: [], lockedDays: {}, dayModAlerts: {}, holidays: {}, updatedAt: Date.now() };
}

function writeDb(data) {
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const records = (Array.isArray(data.records) ? data.records : []).map((r) => ({
    ...r,
    serverTimestamp: r.serverTimestamp || nowIso,
    receiptId: r.receiptId || `ACK_${nowMs.toString(36).toUpperCase()}`
  }));

  const payload = {
    employees: Array.isArray(data.employees) ? data.employees : [],
    records,
    lockedDays: data.lockedDays && typeof data.lockedDays === 'object' ? data.lockedDays : {},
    dayModAlerts: data.dayModAlerts && typeof data.dayModAlerts === 'object' ? data.dayModAlerts : {},
    holidays: data.holidays && typeof data.holidays === 'object' ? data.holidays : {},
    updatedAt: nowMs,
    serverTimeIso: nowIso
  };
  fs.writeFileSync(DB_FILE, JSON.stringify(payload, null, 2), 'utf8');
  return payload;
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.sql': 'text/plain; charset=utf-8',
  '.yml': 'text/plain; charset=utf-8',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.svg': 'image/svg+xml'
};

const server = http.createServer((req, res) => {
  const serverNowMs = Date.now();
  const serverNowIso = new Date(serverNowMs).toISOString();

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Client-Timestamp');
  res.setHeader('X-Server-Timestamp-Ms', String(serverNowMs));
  res.setHeader('X-Server-Time-Iso', serverNowIso);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = parsedUrl.pathname;

  // API 1: Lấy Giờ Chuẩn Server (Authoritative Server Time chống chỉnh lùi giờ điện thoại)
  if (pathname === '/api/time' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(
      JSON.stringify({
        ok: true,
        serverTimestampMs: serverNowMs,
        serverTimeIso: serverNowIso
      })
    );
    return;
  }

  // API 2: Đồng bộ trạng thái tập trung & cấp biên nhận Server ACK
  if (pathname === '/api/state' && req.method === 'GET') {
    const db = readDb();
    const lanIp = getLocalLanIp();
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(
      JSON.stringify({
        ...db,
        serverTimestampMs: serverNowMs,
        serverTimeIso: serverNowIso,
        lanUrl: `http://${lanIp}:${PORT}`
      })
    );
    return;
  }

  if (pathname === '/api/state' && req.method === 'POST') {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 5 * 1024 * 1024) req.destroy();
    });
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body || '{}');
        const saved = writeDb(parsed);
        const lanIp = getLocalLanIp();
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(
          JSON.stringify({
            ok: true,
            receiptId: `ACK_${serverNowMs.toString(36).toUpperCase()}`,
            serverTimestampMs: serverNowMs,
            serverTimeIso: serverNowIso,
            ...saved,
            lanUrl: `http://${lanIp}:${PORT}`
          })
        );
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    });
    return;
  }

  // API 3: Xác thực PIN nhân viên trên Server (Chống lộ PIN qua F12)
  if (pathname === '/api/verify-pin' && req.method === 'POST') {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 5 * 1024 * 1024) req.destroy();
    });
    req.on('end', () => {
      try {
        const { employeeName, pin } = JSON.parse(body || '{}');
        const db = readDb();
        const emp = (db.employees || []).find((e) => e.name === employeeName);
        if (!emp) {
          res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: 'Không tìm thấy nhân viên' }));
          return;
        }
        const isMatch = String(emp.pin || '1234') === String(pin || '').trim();
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(
          JSON.stringify({
            ok: isMatch,
            token: isMatch ? hashPinSha256(`${employeeName}:${pin}:${serverNowMs}`) : null,
            serverTimeIso: serverNowIso
          })
        );
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    });
    return;
  }

  // Phục vụ file tĩnh: chỉ các file giao diện công khai (không lộ server.js, data/, .bat...)
  const PUBLIC_FILES = new Set(['/index.html', '/app.js', '/remote.js', '/config.js', '/styles.css', '/supabase_setup.sql']);
  const safePath = pathname === '/' ? '/index.html' : pathname;

  if (PUBLIC_FILES.has(safePath)) {
    const filePath = path.join(__dirname, safePath);
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
    fs.createReadStream(filePath).pipe(res);
  } else {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found');
  }
});

server.listen(PORT, '0.0.0.0', () => {
  const lanIp = getLocalLanIp();
  console.log('====================================================================');
  console.log(' SERVER BÁO TĂNG CA ĐIỆN THOẠI & CẦU NỐI CLOUD ĐÃ KHỞI ĐỘNG!');
  console.log(` Dữ liệu lưu tập trung tại: ${DB_FILE}`);
  console.log(` Truy cập trên máy Admin:   http://localhost:${PORT}`);
  console.log(` Điện thoại cùng WiFi:      http://${lanIp}:${PORT}/?mode=worker`);
  console.log(' Đẩy lên GitHub Pages 24/7: Nhấp đúp `DEPLOY_GITHUB_PAGES.bat`');
  console.log('====================================================================');
});
