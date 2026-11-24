import crypto from 'node:crypto';
import { encryptSecret, decryptSecret } from './auth.js';

// Field-level encryption for personal data. Values are encrypted with AES-256-GCM before they are written
// to the database, so a copy of the database file alone does not reveal them. The key (DATA_ENCRYPTION_KEY)
// lives only in the server's settings, never in the database.
//
// Sealed text looks like "v1:<iv>.<tag>.<data>". Older plain values (no prefix) still read back unchanged,
// and migrateEncryption() seals them the first time the server starts.
const PREFIX = 'v1:';

export const seal = (plain, key) => PREFIX + encryptSecret(String(plain), key);

export function open(stored, key) {
  if (stored == null) return stored;
  const s = String(stored);
  if (!s.startsWith(PREFIX)) return s; // legacy plain value
  try { return decryptSecret(s.slice(PREFIX.length), key); }
  catch { return null; } // wrong key or damaged value; callers treat null as "unavailable"
}

// A keyed fingerprint lets us find the same bank account under several users without storing it in plain text.
export const blindIndex = (plain, key) =>
  crypto.createHmac('sha256', `kobodesk-blind:${key}`).update(String(plain)).digest('hex');

// Files (ID uploads) are sealed as raw bytes: iv (12) + tag (16) + ciphertext.
const fileKey = (key) => crypto.createHash('sha256').update(`kobodesk-files:${key}`).digest();
export function sealBytes(buf, key) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', fileKey(key), iv);
  const enc = Buffer.concat([c.update(buf), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]);
}
export function openBytes(blob, key) {
  const b = Buffer.from(blob);
  const d = crypto.createDecipheriv('aes-256-gcm', fileKey(key), b.subarray(0, 12));
  d.setAuthTag(b.subarray(12, 28));
  return Buffer.concat([d.update(b.subarray(28)), d.final()]);
}

export const last4 = (s) => String(s).slice(-4);

// Bank account rows with the number and name readable. Use this whenever code needs the real values.
export function bankView(row, key) {
  if (!row) return row;
  return { ...row, account_number: open(row.account_number, key), account_name: open(row.account_name, key) };
}

// Encrypts any older plain values. Safe to run on every start.
export function migrateEncryption(db, key) {
  for (const r of db.prepare('SELECT * FROM bank_accounts').all()) {
    if (r.account_hash && String(r.account_number).startsWith(PREFIX)) continue;
    const number = open(r.account_number, key);
    if (number == null) continue;
    db.prepare('UPDATE bank_accounts SET account_number = ?, account_name = ?, account_hash = ?, account_last4 = ? WHERE id = ?')
      .run(String(r.account_number).startsWith(PREFIX) ? r.account_number : seal(number, key),
        String(r.account_name).startsWith(PREFIX) ? r.account_name : seal(r.account_name, key),
        blindIndex(`${r.bank_code}:${number}`, key), last4(number), r.id);
  }
  for (const r of db.prepare('SELECT * FROM kyc_submissions').all()) {
    if (String(r.full_name).startsWith(PREFIX)) continue;
    db.prepare('UPDATE kyc_submissions SET full_name = ?, dob = ?, address = ? WHERE user_id = ?')
      .run(seal(r.full_name, key), seal(r.dob, key), seal(r.address, key), r.user_id);
  }
}
