// แปลงข้อความแชทเป็นรายการเงิน เช่น "ข้าวมันไก่ 60" → {type:'out', amount:60, cat:'food', note:'ข้าวมันไก่'}
// และเดาหมวดหมู่จากคำ (ใช้ร่วมกับการอ่านบันทึกบนสลิป)

const CAT_KEYWORDS = {
  food:   ['ข้าว','ก๋วยเตี๋ยว','อาหาร','กาแฟ','ชา','นม','ขนม','เค้ก','หมูกระทะ','ชาบู','บุฟเฟ่','ปิ้งย่าง','ส้มตำ','พิซซ่า','เบอร์เกอร์','ไก่ทอด','กับข้าว','มื้อ','เที่ยง','อาหารเช้า','อาหารเย็น','ร้านอาหาร','kfc','mk','โจ๊ก','ผลไม้','น้ำ','เครื่องดื่ม','คาเฟ่'],
  travel: ['วิน','แท็กซี่','taxi','รถเมล์','รถไฟ','bts','mrt','แกร็บ','grab','โบลท์','bolt','น้ำมัน','ทางด่วน','ค่ารถ','เดินทาง','มอไซค์','เรือ','เครื่องบิน','ตั๋ว','จอดรถ'],
  home:   ['ค่าไฟ','ค่าน้ำ','ค่าเน็ต','เน็ตบ้าน','ค่าหอ','ค่าบ้าน','ค่าเช่า','บิล','โทรศัพท์','มือถือ','ไฟฟ้า','ประปา','ais','true','dtac','ซ่อมบ้าน','เฟอร์นิเจอร์'],
  shop:   ['เสื้อ','กางเกง','รองเท้า','กระเป๋า','shopee','ช้อปปี้','lazada','ลาซาด้า','ช้อป','เครื่องสำอาง','สกินแคร์','ของใช้','ซูเปอร์','โลตัส','บิ๊กซี','เซเว่น','7-11'],
  fun:    ['หนัง','เกม','เหล้า','เบียร์','ปาร์ตี้','เที่ยว','คอนเสิร์ต','netflix','youtube','spotify','สปอติฟาย','คาราโอเกะ','บอล','หวย'],
  health: ['หมอ','ยา','โรงพยาบาล','รพ','คลินิก','ฟิตเนส','ยิม','นวด','ทำฟัน','ตรวจสุขภาพ','วิตามิน'],
  edu:    ['หนังสือ','เรียน','คอร์ส','ติว','สัมมนา','อบรม'],
  family: ['ให้แม่','ให้พ่อ','ให้ลูก','ให้ที่บ้าน','ค่าเทอมลูก','ให้ยาย','ให้ตา','ให้น้อง','ค่านมลูก']
};

const INCOME_KEYWORDS = ['เงินเดือน','โบนัส','ขายของ','ขายได้','รายรับ','รับเงิน','ได้เงิน','ดอกเบี้ย','ปันผล','เงินคืน','คืนเงิน','โอที','ค่าคอม','รับจ้าง','ฟรีแลนซ์'];

function guessCat(text) {
  const t = (text || '').toLowerCase();
  for (const [cat, words] of Object.entries(CAT_KEYWORDS)) {
    if (words.some(w => t.includes(w))) return cat;
  }
  return 'other';
}

function guessIncomeCat(text) {
  const t = text || '';
  if (t.includes('เงินเดือน')) return 'salary';
  if (t.includes('โบนัส')) return 'bonus';
  return 'inOther';
}

// คืน {type, amount, cat, note} หรือ null ถ้าไม่ใช่ข้อความจดเงิน
function parseEntry(text) {
  if (!text) return null;
  let t = text.trim();
  if (t.length > 120) return null;                       // ข้อความยาว ๆ ไม่ใช่การจดเงิน
  const plusIncome = t.startsWith('+');
  if (plusIncome) t = t.slice(1).trim();
  // หาเลขตัวสุดท้ายในข้อความ = จำนวนเงิน (รองรับ 1,234.50)
  const nums = t.match(/\d[\d,]*(?:\.\d{1,2})?/g);
  if (!nums) return null;
  const amtStr = nums[nums.length - 1];
  const amount = parseFloat(amtStr.replace(/,/g, ''));
  if (!amount || amount <= 0 || amount > 99999999) return null;
  // ตัดจำนวนเงินกับคำว่า บาท ออก เหลือเป็นโน้ต
  const idx = t.lastIndexOf(amtStr);
  let note = (t.slice(0, idx) + ' ' + t.slice(idx + amtStr.length)).replace(/บาท|฿|thb/gi, '').replace(/\s+/g, ' ').trim();
  if (!note && nums.length === 1 && /^[\d,.\s฿]+(บาท)?$/i.test(text.trim().replace(/^\+/, ''))) {
    note = '';                                            // ส่งมาแต่ตัวเลข ก็จดให้ (หมวดอื่น ๆ)
  }
  const isIncome = plusIncome || INCOME_KEYWORDS.some(w => note.includes(w));
  if (isIncome) {
    return { type: 'in', amount, cat: guessIncomeCat(note), note };
  }
  return { type: 'out', amount, cat: guessCat(note), note };
}

module.exports = { parseEntry, guessCat, CAT_KEYWORDS };
