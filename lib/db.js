// ชั้นติดต่อ Supabase ผ่าน REST (PostgREST) — ใช้ service key ฝั่งเซิร์ฟเวอร์เท่านั้น
// ทุกฟังก์ชันโยน error ถ้า Supabase ตอบไม่ปกติ ให้ผู้เรียกตัดสินใจตอบผู้ใช้เอง

const CFG = {
  url: () => (process.env.SUPABASE_URL || '').replace(/\/$/, ''),
  key: () => process.env.SUPABASE_SERVICE_KEY || '',
  trialDays: () => +(process.env.TRIAL_DAYS || 14),
  price: () => +(process.env.PRICE_THB || 199)
};

function ready() { return !!(CFG.url() && CFG.key()); }

async function sb(path, { method = 'GET', body, headers = {} } = {}) {
  const res = await fetch(CFG.url() + '/rest/v1' + path, {
    method,
    headers: {
      apikey: CFG.key(),
      Authorization: 'Bearer ' + CFG.key(),
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
      ...headers
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const txt = await res.text();
  if (!res.ok) throw new Error('supabase ' + res.status + ' ' + path + ': ' + txt.slice(0, 300));
  return txt ? JSON.parse(txt) : null;
}

function genCode() {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';           // ตัดตัวที่อ่านสับสน (I,L,O,0,1)
  let c = 'NT';
  for (let i = 0; i < 4; i++) c += chars[Math.floor(Math.random() * chars.length)];
  return c;
}

async function getUser(id) {
  const rows = await sb(`/users?id=eq.${encodeURIComponent(id)}&limit=1`);
  return rows && rows[0] || null;
}

async function getOrCreateUser(id, displayName) {
  const found = await getUser(id);
  if (found) return found;
  const trialEnds = new Date(Date.now() + CFG.trialDays() * 86400e3).toISOString();
  const rows = await sb('/users', {
    method: 'POST',
    body: { id, display_name: displayName || '', code: genCode(), trial_ends_at: trialEnds },
    headers: { Prefer: 'return=representation,resolution=merge-duplicates' }
  });
  return rows[0];
}

async function userByCode(code) {
  const rows = await sb(`/users?code=eq.${encodeURIComponent(code.toUpperCase())}&limit=1`);
  return rows && rows[0] || null;
}

async function saveUserFields(id, fields) {
  await sb(`/users?id=eq.${encodeURIComponent(id)}`, { method: 'PATCH', body: fields });
}

// สถานะสมาชิก: trial (ยังอยู่ช่วงทดลอง) / active (จ่ายแล้ว) / expired
function subscription(user) {
  const now = Date.now();
  const paid = user.paid_until ? Date.parse(user.paid_until) : 0;
  const trial = user.trial_ends_at ? Date.parse(user.trial_ends_at) : 0;
  if (paid > now) return { status: 'active', paidUntil: user.paid_until, price: CFG.price() };
  if (trial > now) return { status: 'trial', trialEndsAt: user.trial_ends_at, daysLeft: Math.ceil((trial - now) / 86400e3), price: CFG.price() };
  return { status: 'expired', price: CFG.price() };
}

/* ---------- รายการเงิน ---------- */

async function upsertTxs(userId, txs) {
  if (!txs.length) return 0;
  const rows = txs.map(t => ({
    id: String(t.id), user_id: userId, date: t.date, type: t.type,
    amount: +t.amount, cat: t.cat || 'other', note: t.note || '', source: t.source || 'app'
  }));
  await sb('/transactions', {
    method: 'POST', body: rows,
    headers: { Prefer: 'return=minimal,resolution=merge-duplicates' }
  });
  return rows.length;
}

async function addTx(userId, tx) {
  const id = tx.id || (Date.now() + '' + Math.floor(Math.random() * 1000));
  await upsertTxs(userId, [{ ...tx, id }]);
  return id;
}

async function deleteTx(userId, id) {
  await sb(`/transactions?user_id=eq.${encodeURIComponent(userId)}&id=eq.${encodeURIComponent(id)}`, { method: 'DELETE' });
}

async function listTxs(userId, { from, to, limit = 5000 } = {}) {
  let q = `/transactions?user_id=eq.${encodeURIComponent(userId)}&order=date.desc,created_at.desc&limit=${limit}`;
  if (from) q += `&date=gte.${from}`;
  if (to) q += `&date=lte.${to}`;
  return await sb(q) || [];
}

async function lastTx(userId) {
  const rows = await sb(`/transactions?user_id=eq.${encodeURIComponent(userId)}&order=created_at.desc&limit=1`);
  return rows && rows[0] || null;
}

// ยอดรวมวันนี้ + เดือนนี้ (คิดจากรายการจริงเท่านั้น)
async function summary(userId) {
  const now = new Date();
  const y = now.getFullYear(), m = String(now.getMonth() + 1).padStart(2, '0');
  const today = `${y}-${m}-${String(now.getDate()).padStart(2, '0')}`;
  const monthTxs = await listTxs(userId, { from: `${y}-${m}-01`, to: `${y}-${m}-31` });
  const sum = (list, type) => list.filter(t => t.type === type).reduce((s, t) => s + +t.amount, 0);
  const dayTxs = monthTxs.filter(t => t.date === today);
  return {
    today: { in: sum(dayTxs, 'in'), out: sum(dayTxs, 'out') },
    month: { in: sum(monthTxs, 'in'), out: sum(monthTxs, 'out') },
    monthTxs
  };
}

/* ---------- การชำระเงิน ---------- */

async function createPayment(userId, slipMessageId) {
  const rows = await sb('/payments', { method: 'POST', body: { user_id: userId, slip_message_id: slipMessageId || null } });
  return rows[0];
}

async function approveUser(code, days = 365) {
  const user = await userByCode(code);
  if (!user) return null;
  const base = Math.max(Date.now(), user.paid_until ? Date.parse(user.paid_until) : 0);
  const paidUntil = new Date(base + days * 86400e3).toISOString();
  await saveUserFields(user.id, { paid_until: paidUntil });
  await sb(`/payments?user_id=eq.${encodeURIComponent(user.id)}&status=eq.pending`, {
    method: 'PATCH', body: { status: 'approved', decided_at: new Date().toISOString() }
  });
  return { ...user, paid_until: paidUntil };
}

async function rejectUser(code) {
  const user = await userByCode(code);
  if (!user) return null;
  await sb(`/payments?user_id=eq.${encodeURIComponent(user.id)}&status=eq.pending`, {
    method: 'PATCH', body: { status: 'rejected', decided_at: new Date().toISOString() }
  });
  return user;
}

module.exports = {
  ready, CFG, getUser, getOrCreateUser, userByCode, saveUserFields, subscription,
  upsertTxs, addTx, deleteTx, listTxs, lastTx, summary,
  createPayment, approveUser, rejectUser
};
