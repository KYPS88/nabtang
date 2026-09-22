// ติดต่อ LINE Platform: ตรวจลายเซ็น webhook, ตอบ/ส่งข้อความ, ดึงรูป, ตรวจ id_token ของ LIFF
// base URL override ได้ด้วย env (ไว้ใช้ตอนเทสต์กับเซิร์ฟเวอร์จำลอง)

const crypto = require('crypto');

const API = () => process.env.LINE_API_BASE || 'https://api.line.me';
const DATA = () => process.env.LINE_DATA_BASE || 'https://api-data.line.me';

const CFG = {
  secret: () => process.env.LINE_CHANNEL_SECRET || '',
  token: () => process.env.LINE_CHANNEL_ACCESS_TOKEN || '',
  loginChannelId: () => process.env.LINE_LOGIN_CHANNEL_ID || '',
  adminId: () => process.env.ADMIN_LINE_USER_ID || '',
  liffUrl: () => process.env.LIFF_URL || ''
};

function botReady() { return !!(CFG.secret() && CFG.token()); }

// ตรวจว่า webhook มาจาก LINE จริง (HMAC-SHA256 ของ raw body ด้วย channel secret)
function verifySignature(rawBody, signature) {
  if (!CFG.secret() || !signature) return false;
  const mac = crypto.createHmac('sha256', CFG.secret()).update(rawBody).digest('base64');
  try {
    return crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(signature));
  } catch { return false; }
}

async function lineFetch(base, path, opts = {}) {
  const res = await fetch(base + path, {
    ...opts,
    headers: { Authorization: 'Bearer ' + CFG.token(), ...(opts.headers || {}) }
  });
  if (!res.ok) throw new Error('line ' + res.status + ' ' + path + ': ' + (await res.text()).slice(0, 300));
  return res;
}

// ปุ่มลัดลอยเหนือแป้นพิมพ์ (quick reply) — เด้งมากับทุกข้อความที่บอทตอบ
function defaultQuickReply() {
  return { items: [
    { type: 'action', action: { type: 'message', label: '📊 สรุปวันนี้', text: 'สรุป' } },
    { type: 'action', action: { type: 'message', label: '🗓️ สรุปเดือน', text: 'สรุปเดือน' } },
    { type: 'action', action: { type: 'message', label: '🗑️ ลบล่าสุด', text: 'ลบล่าสุด' } },
    ...(CFG.liffUrl() ? [{ type: 'action', action: { type: 'uri', label: '🧮 คำนวณภาษี', uri: CFG.liffUrl() + '?view=tax' } }] : []),
    { type: 'action', action: { type: 'message', label: '❓ วิธีใช้', text: 'ช่วยเหลือ' } },
    { type: 'action', action: { type: 'message', label: '💚 สมัครสมาชิก', text: 'สมัคร' } }
  ] };
}
function asMessages(msgs) {
  const arr = (Array.isArray(msgs) ? msgs : [msgs]).map(m => typeof m === 'string' ? { type: 'text', text: m.slice(0, 4900) } : m);
  // LINE แสดง quick reply ของข้อความสุดท้ายในชุดเท่านั้น
  if (arr.length && !arr[arr.length - 1].quickReply) arr[arr.length - 1].quickReply = defaultQuickReply();
  return arr;
}

// reply ฟรีไม่จำกัด — ใช้เป็นหลัก
async function reply(replyToken, messages) {
  await lineFetch(API(), '/v2/bot/message/reply', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ replyToken, messages: asMessages(messages) })
  });
}

// push กินโควตารายเดือนของ OA — ใช้เท่าที่จำเป็น (แจ้งแอดมิน/แจ้งผลอนุมัติ)
async function push(to, messages) {
  await lineFetch(API(), '/v2/bot/message/push', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ to, messages: asMessages(messages) })
  });
}

// ดึงไฟล์รูปที่ผู้ใช้ส่งมา (เช่น สลิป)
async function getContent(messageId) {
  const res = await lineFetch(DATA(), `/v2/bot/message/${messageId}/content`);
  const buf = Buffer.from(await res.arrayBuffer());
  return { buf, mediaType: res.headers.get('content-type') || 'image/jpeg' };
}

// ตรวจ id_token จาก LIFF → ได้ userId (sub) + ชื่อ · แคชผลไว้กันยิงซ้ำ
const tokenCache = new Map();
async function verifyIdToken(idToken) {
  if (!idToken || !CFG.loginChannelId()) return null;
  const hit = tokenCache.get(idToken);
  if (hit && hit.exp > Date.now()) return hit.value;
  const res = await fetch(API() + '/oauth2/v2.1/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ id_token: idToken, client_id: CFG.loginChannelId() })
  });
  if (!res.ok) return null;
  const data = await res.json();
  if (!data.sub) return null;
  const value = { userId: data.sub, name: data.name || '' };
  tokenCache.set(idToken, { value, exp: Date.now() + 10 * 60e3 });
  if (tokenCache.size > 5000) tokenCache.clear();
  return value;
}

/* ---- Rich menu: เมนูถาวรใต้ช่องแชท ---- */
async function listRichMenus() {
  const res = await lineFetch(API(), '/v2/bot/richmenu/list');
  return (await res.json()).richmenus || [];
}
async function deleteRichMenu(id) {
  await lineFetch(API(), '/v2/bot/richmenu/' + encodeURIComponent(id), { method: 'DELETE' });
}
async function createRichMenu(def) {
  const res = await lineFetch(API(), '/v2/bot/richmenu', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(def)
  });
  return (await res.json()).richMenuId;
}
async function uploadRichMenuImage(id, buf) {
  await lineFetch(DATA(), `/v2/bot/richmenu/${encodeURIComponent(id)}/content`, {
    method: 'POST', headers: { 'Content-Type': 'image/png' }, body: buf
  });
}
async function setDefaultRichMenu(id) {
  await lineFetch(API(), '/v2/bot/user/all/richmenu/' + encodeURIComponent(id), { method: 'POST' });
}

module.exports = { CFG, botReady, verifySignature, reply, push, getContent, verifyIdToken,
  listRichMenus, deleteRichMenu, createRichMenu, uploadRichMenuImage, setDefaultRichMenu };
