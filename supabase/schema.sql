-- สคีมาฐานข้อมูล "นับตัง PRO" — รันครั้งเดียวใน Supabase (SQL Editor → New query → วางทั้งไฟล์ → Run)
-- เข้าถึงผ่านเซิร์ฟเวอร์ของเราเท่านั้น (service key) ผู้ใช้ไม่แตะฐานข้อมูลตรง ๆ

create table if not exists users (
  id            text primary key,              -- LINE userId (U...)
  display_name  text,
  code          text unique,                   -- รหัสลูกค้าสั้น ๆ ไว้ให้แอดมินพิมพ์อนุมัติ เช่น NT4F2K
  trial_ends_at timestamptz not null,          -- หมดเขตทดลองฟรี
  paid_until    timestamptz,                   -- จ่ายแล้วใช้ได้ถึงเมื่อไหร่ (null = ยังไม่เคยจ่าย)
  tax_profile   jsonb,                         -- ข้อมูลภาษี (โครงตาม SPEC.md)
  categories    jsonb,                         -- หมวดหมู่ที่ผู้ใช้ปรับแต่ง
  settings      jsonb,
  created_at    timestamptz not null default now()
);

create table if not exists transactions (
  id         text primary key,                 -- id จากฝั่งแอพ/บอท (กัน sync ซ้ำ)
  user_id    text not null references users(id) on delete cascade,
  date       date not null,
  type       text not null check (type in ('in','out')),
  amount     numeric(14,2) not null check (amount > 0),
  cat        text not null,
  note       text not null default '',
  source     text not null default 'app',      -- app | chat | slip
  created_at timestamptz not null default now()
);
create index if not exists idx_tx_user_date on transactions (user_id, date);

create table if not exists payments (
  id              bigint generated always as identity primary key,
  user_id         text not null references users(id) on delete cascade,
  status          text not null default 'pending',   -- pending | approved | rejected
  slip_message_id text,                              -- id รูปสลิปใน LINE (ไว้ตรวจย้อนหลัง)
  amount          numeric(14,2),
  created_at      timestamptz not null default now(),
  decided_at      timestamptz
);
create index if not exists idx_pay_user on payments (user_id, status);
