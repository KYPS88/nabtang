// เซิร์ฟเวอร์ "นับตัง" บน Railway — Node ล้วน ไม่ใช้ไลบรารีภายนอก
// หน้าที่: 1) เสิร์ฟไฟล์แอพ (index.html / app.html)
//          2) API ให้แอพอ่าน/เขียนข้อมูลกลาง (ยืนยันตัวตนด้วย id_token ของ LIFF)
//          3) LINE webhook — จดเงินจากแชท/สลิป + สรุปเด้งกลับ + ระบบสมาชิก

const http = require('http');
const fs = require('fs');
const path = require('path');
const db = require('./lib/db');
const line = require('./lib/line');
const { parseEntry, guessCat } = require('./lib/parse');
const { readSlip, slipReady } = require('./lib/slip');

const ROOT = __dirname;
const PORT = process.env.PORT || 3000;
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.md': 'text/plain; charset=utf-8', '.sql': 'text/plain; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon'
};

const fmt = n => (Math.round(+n * 100) / 100).toLocaleString('en-US', { maximumFractionDigits: 2 });
const CAT_NAMES = {
  food: '🍜 อาหาร', travel: '🚗 เดินทาง', home: '🏠 ที่อยู่/บิล', shop: '🛍️ ช้อปปิ้ง',
  fun: '🎬 บันเทิง', health: '💊 สุขภาพ', edu: '📚 การศึกษา', family: '💝 ให้ครอบครัว',
  other: '📦 อื่น ๆ', salary: '💰 เงินเดือน', bonus: '🎁 โบนัส', inOther: '📦 รายได้อื่น'
};
const catName = c => CAT_NAMES[c] || '📦 อื่น ๆ';

/* ================= ข้อความตอบในแชท ================= */

function summaryText(s) {
  const lines = [`วันนี้: จ่าย ${fmt(s.today.out)}${s.today.in ? ' · รับ ' + fmt(s.today.in) : ''}`];
  lines.push(`เดือนนี้: จ่าย ${fmt(s.month.out)} · รับ ${fmt(s.month.in)} · เหลือ ${fmt(s.month.in - s.month.out)}`);
  return lines.join('\n');
}

function helpText() {
  return ['พิมพ์จดเงินได้เลย เช่น', '· ข้าวมันไก่ 60', '· ค่าไฟ 800', '· +เงินเดือน 30000',
    'หรือส่งรูปสลิปโอนเงินมา เดี๋ยวจดให้ ✨', '',
    'คำสั่งอื่น: "สรุป" · "สรุปเดือน" · "ลบล่าสุด" · "แอพ"'].join('\n');
}

// ช่องทางรับเงิน: บัญชีธนาคาร (BANK_*) และ/หรือ พร้อมเพย์ (PROMPTPAY_ID) — ตั้งอย่างน้อย 1 อย่าง
const bankAccountName = () => process.env.BANK_ACCOUNT_NAME || process.env.ACCOUNT_NAME || '';
function payMethodLines() {
  const lines = [];
  if (process.env.BANK_ACCOUNT) {
    lines.push(`โอนเข้าบัญชี${process.env.BANK_NAME ? ' ' + process.env.BANK_NAME : ''} เลขที่ ${process.env.BANK_ACCOUNT}` +
      (bankAccountName() ? `\nชื่อบัญชี: ${bankAccountName()}` : ''));
  }
  if (process.env.PROMPTPAY_ID) lines.push(`${lines.length ? 'หรือ' : ''}พร้อมเพย์: ${process.env.PROMPTPAY_ID}`);
  if (!lines.length) lines.push('ติดต่อแอดมินเพื่อชำระเงิน');
  return lines;
}
function paywallText(user, sub) {
  return [`หมดช่วงทดลองใช้ฟรีแล้วครับ 🙏`,
    `สมัครสมาชิกนับตัง ปีละ ${fmt(sub.price)} บาท`,
    ...payMethodLines(),
    `แล้วส่งรูปสลิปมาในแชทนี้ได้เลย เดี๋ยวเปิดให้ทันทีที่ตรวจสอบเสร็จ`,
    `(รหัสสมาชิกของคุณ: ${user.code})`].join('\n');
}

/* ================= LINE webhook ================= */

async function handleTextMessage(ev) {
  const userId = ev.source.userId;
  const text = (ev.message.text || '').trim();
  const isAdmin = userId && userId === line.CFG.adminId();

  // ----- คำสั่งแอดมิน: อนุมัติ/ปฏิเสธ การชำระเงิน -----
  if (isAdmin && /^(อนุมัติ|ปฏิเสธ)\s+/.test(text)) {
    const [cmd, code] = text.split(/\s+/);
    if (cmd === 'อนุมัติ') {
      const user = await db.approveUser(code);
      if (!user) return line.reply(ev.replyToken, `ไม่พบรหัส ${code} ครับ`);
      const until = new Date(user.paid_until).toLocaleDateString('th-TH', { dateStyle: 'long' });
      await line.push(user.id, `ยืนยันการชำระเงินแล้ว 🎉 ขอบคุณที่สมัครนับตัง!\nใช้งานได้ถึง ${until} — จดเงินต่อได้เลยครับ`).catch(() => {});
      return line.reply(ev.replyToken, `อนุมัติ ${user.display_name || code} แล้ว ✓ ใช้ได้ถึง ${until}`);
    } else {
      const user = await db.rejectUser(code);
      return line.reply(ev.replyToken, user ? `ปฏิเสธรายการของ ${code} แล้ว` : `ไม่พบรหัส ${code} ครับ`);
    }
  }

  const profile = { name: '' };
  const user = await db.getOrCreateUser(userId, profile.name);
  const sub = db.subscription(user);

  // ----- คำสั่งทั่วไป -----
  const cmd = text.replace(/\s+/g, '');
  if (['สรุป', 'สรุปวันนี้'].includes(cmd)) {
    const s = await db.summary(userId);
    return line.reply(ev.replyToken, '📊 ' + summaryText(s));
  }
  if (['สรุปเดือน', 'สรุปเดือนนี้'].includes(cmd)) {
    const s = await db.summary(userId);
    const byCat = {};
    s.monthTxs.filter(t => t.type === 'out').forEach(t => byCat[t.cat] = (byCat[t.cat] || 0) + +t.amount);
    const top = Object.entries(byCat).sort((a, b) => b[1] - a[1]).slice(0, 5)
      .map(([c, v]) => `${catName(c)} ${fmt(v)}`).join('\n');
    return line.reply(ev.replyToken, `📊 เดือนนี้\nรับ ${fmt(s.month.in)} · จ่าย ${fmt(s.month.out)} · เหลือ ${fmt(s.month.in - s.month.out)}` + (top ? `\n\nจ่ายเยอะสุด:\n${top}` : ''));
  }
  if (['ลบล่าสุด', 'ยกเลิก', 'ลบ'].includes(cmd)) {
    const last = await db.lastTx(userId);
    if (!last) return line.reply(ev.replyToken, 'ยังไม่มีรายการให้ลบครับ');
    await db.deleteTx(userId, last.id);
    const s = await db.summary(userId);
    return line.reply(ev.replyToken, `ลบ "${catName(last.cat)} ${fmt(last.amount)}" แล้ว ✓\n` + summaryText(s));
  }
  if (['แอพ', 'แอป', 'เมนู', 'app'].includes(cmd.toLowerCase())) {
    return line.reply(ev.replyToken, `เปิดแอพนับตังได้ที่นี่เลย 👇\n${line.CFG.liffUrl() || 'ยังไม่ได้ตั้งค่าลิงก์แอพ (LIFF_URL)'}`);
  }
  if (['ช่วยเหลือ', 'help', 'วิธีใช้'].includes(cmd.toLowerCase())) {
    return line.reply(ev.replyToken, helpText());
  }
  if (['สมัคร', 'ซื้อ', 'ต่ออายุ', 'ราคา'].includes(cmd)) {
    return line.reply(ev.replyToken, sub.status === 'active'
      ? `เป็นสมาชิกอยู่แล้วครับ 🎉 ใช้ได้ถึง ${new Date(user.paid_until).toLocaleDateString('th-TH', { dateStyle: 'long' })}`
      : paywallText(user, sub));
  }

  // ----- จดเงินจากข้อความ -----
  const entry = parseEntry(text);
  if (!entry) return line.reply(ev.replyToken, helpText());
  if (sub.status === 'expired') return line.reply(ev.replyToken, paywallText(user, sub));
  const today = new Date();
  const date = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  await db.addTx(userId, { ...entry, date, source: 'chat' });
  const s = await db.summary(userId);
  const sign = entry.type === 'in' ? '+' : '−';
  return line.reply(ev.replyToken,
    `จดแล้ว ✓ ${catName(entry.cat)} ${sign}${fmt(entry.amount)}${entry.note ? ` (${entry.note})` : ''}\n` + summaryText(s));
}

async function handleImageMessage(ev) {
  const userId = ev.source.userId;
  const user = await db.getOrCreateUser(userId, '');
  const sub = db.subscription(user);

  // หมดอายุสมาชิก → รูปที่ส่งมาคือสลิปชำระเงินสมัครสมาชิก
  if (sub.status === 'expired') {
    await db.createPayment(userId, ev.message.id);
    if (line.CFG.adminId()) {
      await line.push(line.CFG.adminId(),
        `💰 มีสลิปสมัครสมาชิกใหม่\nจาก: ${user.display_name || userId}\nรหัส: ${user.code}\nเช็คเงินเข้าแล้วพิมพ์: อนุมัติ ${user.code}`).catch(() => {});
    }
    return line.reply(ev.replyToken, `ได้รับสลิปแล้วครับ 🙏 กำลังตรวจสอบ\nปกติไม่เกินไม่กี่ชั่วโมง เดี๋ยวแจ้งผลในแชทนี้ทันทีที่เปิดใช้งานให้`);
  }

  // สมาชิกปกติ → อ่านสลิปเป็นรายจ่าย
  if (!slipReady()) {
    return line.reply(ev.replyToken, 'ระบบอ่านสลิปยังไม่เปิดใช้งานครับ พิมพ์จดแทนได้เลย เช่น "ค่าไฟ 800"');
  }
  const { buf, mediaType } = await line.getContent(ev.message.id);
  const slip = await readSlip(buf, mediaType);
  if (slip.error || !slip.is_slip) {
    return line.reply(ev.replyToken, slip.is_slip === false
      ? 'รูปนี้ดูไม่ใช่สลิปโอนเงินครับ 🤔 ถ้าอยากจดรายการ พิมพ์มาได้เลย เช่น "ข้าว 60"'
      : 'อ่านสลิปไม่สำเร็จครับ 🙏 ลองส่งรูปที่ชัดขึ้น หรือพิมพ์จดแทน เช่น "ค่าไฟ 800"');
  }
  // อ่านหมวดจาก "บันทึกช่วยจำ" บนสลิปก่อน ถ้าไม่มีค่อยดูชื่อผู้รับ
  const memo = (slip.memo || '').trim();
  const cat = guessCat(memo || slip.receiver || '');
  const note = memo || (slip.receiver ? 'โอนถึง ' + slip.receiver : 'จากสลิป');
  const today = new Date();
  const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const date = /^\d{4}-\d{2}-\d{2}$/.test(slip.date || '') ? slip.date : todayStr;
  await db.addTx(userId, { type: 'out', amount: +slip.amount, cat, note, date, source: 'slip' });
  const s = await db.summary(userId);
  return line.reply(ev.replyToken,
    `อ่านสลิปแล้ว ✓ จดให้เป็น ${catName(cat)} −${fmt(slip.amount)}\n(${memo ? 'จากบันทึก: ' + memo : note})\n` + summaryText(s));
}

async function handleWebhookEvent(ev) {
  try {
    if (ev.type === 'follow') {
      const user = await db.getOrCreateUser(ev.source.userId, '');
      const days = db.subscription(user).daysLeft || db.CFG.trialDays();
      return line.reply(ev.replyToken,
        `สวัสดีครับ ยินดีต้อนรับสู่นับตัง 💚\nทดลองใช้ฟรี ${days} วันเต็ม ๆ\n\n` + helpText());
    }
    if (ev.type === 'message' && ev.message.type === 'text') return await handleTextMessage(ev);
    if (ev.type === 'message' && ev.message.type === 'image') return await handleImageMessage(ev);
  } catch (e) {
    console.error('webhook event error:', e.message);
    if (ev.replyToken) await line.reply(ev.replyToken, 'ขอโทษครับ ระบบขัดข้องชั่วคราว ลองใหม่อีกครั้งนะครับ 🙏').catch(() => {});
  }
}

/* ================= API ของแอพ (LIFF) ================= */

async function authUser(req) {
  const m = (req.headers.authorization || '').match(/^Bearer (.+)$/);
  if (!m) return null;
  return await line.verifyIdToken(m[1]);
}

async function handleApi(req, res, pathname, body) {
  const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); };

  if (pathname === '/api/health') {
    const missing = [];
    if (!db.ready()) missing.push('SUPABASE_URL / SUPABASE_SERVICE_KEY');
    if (!line.botReady()) missing.push('LINE_CHANNEL_SECRET / LINE_CHANNEL_ACCESS_TOKEN');
    if (!line.CFG.loginChannelId()) missing.push('LINE_LOGIN_CHANNEL_ID');
    if (!line.CFG.adminId()) missing.push('ADMIN_LINE_USER_ID');
    if (!slipReady()) missing.push('ANTHROPIC_API_KEY (อ่านสลิป)');
    if (!process.env.BANK_ACCOUNT && !process.env.PROMPTPAY_ID) missing.push('BANK_ACCOUNT หรือ PROMPTPAY_ID (ช่องทางรับเงิน ตอนเปิดขาย)');
    if (!line.CFG.liffUrl()) missing.push('LIFF_URL');
    const database = db.ready() ? await db.ping() : { ok: false, message: 'ยังไม่ได้ตั้งค่า SUPABASE_URL / SUPABASE_SERVICE_KEY' };
    return json(200, {
      ok: missing.length === 0 && database.ok,
      database,
      missing,
      hint: missing.length ? 'ดูวิธีตั้งค่าใน SETUP-PRO.md' : (database.ok ? 'พร้อมใช้งานครบ ✓' : 'ตัวแปรครบ แต่ฐานข้อมูลยังมีปัญหา — ดูช่อง database')
    });
  }

  if (!db.ready()) return json(503, { error: 'ยังไม่ได้ตั้งค่าฐานข้อมูล (ดู SETUP-PRO.md)' });
  const auth = await authUser(req);
  if (!auth) return json(401, { error: 'ยืนยันตัวตนไม่สำเร็จ — เปิดแอพผ่านไลน์แล้วลองใหม่' });
  const user = await db.getOrCreateUser(auth.userId, auth.name);
  if (auth.name && !user.display_name) db.saveUserFields(user.id, { display_name: auth.name }).catch(() => {});
  const sub = db.subscription(user);
  const subOut = {
    ...sub, code: user.code,
    promptpayId: process.env.PROMPTPAY_ID || '',
    bankName: process.env.BANK_NAME || '', bankAccount: process.env.BANK_ACCOUNT || '',
    bankAccountName: bankAccountName()
  };

  if (pathname === '/api/data' && req.method === 'GET') {
    const txs = await db.listTxs(user.id);
    return json(200, {
      subscription: subOut,
      displayName: user.display_name || auth.name || '',
      transactions: txs.map(t => ({ id: t.id, date: t.date, type: t.type, amount: +t.amount, cat: t.cat, note: t.note, source: t.source })),
      taxProfile: user.tax_profile, categories: user.categories, settings: user.settings
    });
  }

  if (pathname === '/api/sync' && req.method === 'POST') {
    const d = body || {};
    let count = 0;
    if (Array.isArray(d.transactions) && d.transactions.length) {
      const valid = d.transactions.filter(t => t.id && t.date && ['in', 'out'].includes(t.type) && +t.amount > 0).slice(0, 5000);
      count = await db.upsertTxs(user.id, valid);
    }
    const fields = {};
    if (d.taxProfile !== undefined) fields.tax_profile = d.taxProfile;
    if (d.categories !== undefined) fields.categories = d.categories;
    if (d.settings !== undefined) fields.settings = d.settings;
    if (Object.keys(fields).length) await db.saveUserFields(user.id, fields);
    return json(200, { ok: true, synced: count, subscription: subOut });
  }

  if (pathname === '/api/tx' && req.method === 'POST') {
    const { action, tx } = body || {};
    if (action === 'delete' && tx && tx.id) { await db.deleteTx(user.id, String(tx.id)); return json(200, { ok: true }); }
    if ((action === 'add' || action === 'update') && tx) {
      if (sub.status === 'expired') return json(402, { error: 'หมดช่วงทดลองใช้ — สมัครสมาชิกเพื่อจดต่อ', subscription: subOut });
      await db.upsertTxs(user.id, [tx]);
      return json(200, { ok: true });
    }
    return json(400, { error: 'action ไม่ถูกต้อง' });
  }

  return json(404, { error: 'not found' });
}

/* ================= HTTP server ================= */

function readBody(req, limit = 5 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', c => { size += c.length; if (size > limit) { reject(new Error('body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  let pathname;
  try { pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname); }
  catch { res.writeHead(400); return res.end(); }

  try {
    // ---- LINE webhook ----
    if (pathname === '/webhook' && req.method === 'POST') {
      const raw = await readBody(req);
      if (!line.botReady() || !db.ready()) { res.writeHead(200); return res.end('not configured'); }
      if (!line.verifySignature(raw, req.headers['x-line-signature'])) { res.writeHead(403); return res.end(); }
      let payload;
      try { payload = JSON.parse(raw.toString('utf8')); } catch { res.writeHead(400); return res.end(); }
      // ตอบ 200 ให้ LINE ก่อน แล้วค่อยประมวลผล (กัน timeout ฝั่ง LINE)
      res.writeHead(200); res.end('ok');
      for (const ev of payload.events || []) await handleWebhookEvent(ev);
      return;
    }

    // ---- API ----
    if (pathname.startsWith('/api/')) {
      let body = null;
      if (req.method === 'POST') {
        const raw = await readBody(req);
        try { body = raw.length ? JSON.parse(raw.toString('utf8')) : {}; }
        catch { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end('{"error":"bad json"}'); }
      }
      return await handleApi(req, res, pathname, body);
    }

    // ---- static files ----
    let p = pathname === '/' ? '/index.html' : pathname;
    const file = path.normalize(path.join(ROOT, p));
    if (!file.startsWith(ROOT) || file.includes('lib' + path.sep) || p === '/server.js') { res.writeHead(403); return res.end(); }
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end('<meta charset="utf-8">ไม่พบหน้านี้ — <a href="/app.html">ไปที่แอพนับตัง</a>');
      }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream' });
      res.end(data);
    });
  } catch (e) {
    console.error('server error:', e.message);
    if (!res.headersSent) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end('{"error":"internal"}'); }
  }
});

if (require.main === module) {
  server.listen(PORT, () => console.log('นับตัง (NABTANG) serving on port ' + PORT));
}
module.exports = { server };
