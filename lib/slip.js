// อ่านรูปสลิปโอนเงินด้วย Claude API (vision) — raw HTTP ไม่ใช้ไลบรารีภายนอก
// คืน {is_slip, amount, date, memo, receiver} หรือ {error}
// โมเดลตั้งได้ด้วย env CLAUDE_MODEL (ค่าเริ่มต้น claude-opus-5 — ประหยัดลงได้ด้วย claude-haiku-4-5)

const ANTHROPIC_BASE = () => process.env.ANTHROPIC_BASE || 'https://api.anthropic.com';
const MODEL = () => process.env.CLAUDE_MODEL || 'claude-opus-5';

function slipReady() { return !!process.env.ANTHROPIC_API_KEY; }

const PROMPT = `รูปนี้ผู้ใช้ส่งมาในแอปจดบันทึกรายรับรายจ่าย
ถ้าเป็นสลิปโอนเงิน/จ่ายเงิน (ธนาคารไทย, พร้อมเพย์, ทรูมันนี่ ฯลฯ) ให้ตอบเป็น JSON เท่านั้น รูปแบบนี้:
{"is_slip":true,"amount":จำนวนเงินเป็นตัวเลข,"date":"วันที่บนสลิปแบบ YYYY-MM-DD (ปี ค.ศ.) หรือ null ถ้าอ่านไม่ได้","memo":"ข้อความบันทึกช่วยจำ/โน้ตบนสลิป ถ้าไม่มีให้เป็นสตริงว่าง","receiver":"ชื่อบัญชีผู้รับเงิน ถ้าอ่านไม่ได้ให้เป็นสตริงว่าง"}
ถ้ารูปไม่ใช่สลิปการเงิน ให้ตอบ {"is_slip":false}
ห้ามมีข้อความอื่นใดนอกเหนือจาก JSON`;

async function readSlip(buf, mediaType) {
  if (!slipReady()) return { error: 'no_key' };
  const media = /png/.test(mediaType || '') ? 'image/png' : 'image/jpeg';
  const res = await fetch(ANTHROPIC_BASE() + '/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: MODEL(),
      max_tokens: 1024,
      output_config: { effort: 'low' },              // งานอ่านค่าจากรูป ใช้ effort ต่ำพอ ประหยัดสุด
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: media, data: buf.toString('base64') } },
          { type: 'text', text: PROMPT }
        ]
      }]
    })
  });
  if (!res.ok) {
    console.warn('อ่านสลิปไม่สำเร็จ:', res.status, (await res.text()).slice(0, 300));
    return { error: 'api_' + res.status };
  }
  const data = await res.json();
  if (data.stop_reason === 'refusal') return { error: 'refused' };
  const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  try {
    const json = JSON.parse(text.replace(/```json|```/g, '').trim());
    if (json.is_slip && (!json.amount || json.amount <= 0)) return { error: 'no_amount' };
    return json;
  } catch {
    console.warn('สลิป: ตอบกลับไม่ใช่ JSON:', text.slice(0, 200));
    return { error: 'bad_json' };
  }
}

module.exports = { readSlip, slipReady };
