import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  kyc_status TEXT NOT NULL DEFAULT 'unverified',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS bank_accounts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  bank_code TEXT NOT NULL,
  bank_name TEXT NOT NULL,
  account_number TEXT NOT NULL,
  account_name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (user_id, bank_code, account_number)
);

CREATE TABLE IF NOT EXISTS trades (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  bank_account_id TEXT NOT NULL REFERENCES bank_accounts(id),
  coin TEXT NOT NULL,
  network TEXT NOT NULL,
  amount_scaled INTEGER NOT NULL,
  rate_kobo INTEGER NOT NULL,
  fee_kobo INTEGER NOT NULL,
  quote_kobo INTEGER NOT NULL,
  deposit_address TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  received_scaled INTEGER,
  payout_kobo INTEGER,
  payout_ref TEXT,
  failure_reason TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS trades_user_idx ON trades(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS trades_status_idx ON trades(status, expires_at);

CREATE TABLE IF NOT EXISTS deposits (
  tx_hash TEXT PRIMARY KEY,
  trade_id TEXT NOT NULL REFERENCES trades(id),
  amount_scaled INTEGER NOT NULL,
  confirmations INTEGER NOT NULL,
  first_seen_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS kyc_submissions (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  full_name TEXT NOT NULL,
  dob TEXT NOT NULL,
  id_type TEXT NOT NULL,
  id_number_enc TEXT NOT NULL,
  id_last4 TEXT NOT NULL,
  address TEXT NOT NULL,
  status TEXT NOT NULL,
  note TEXT,
  submitted_at INTEGER NOT NULL,
  reviewed_at INTEGER
);

CREATE TABLE IF NOT EXISTS email_tokens (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  purpose TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trade_id TEXT,
  type TEXT NOT NULL,
  detail TEXT,
  created_at INTEGER NOT NULL
);
`;

// Columns added after the first version. Older databases get them on start-up.
const USER_COLUMNS = [
  ['email_verified', 'INTEGER NOT NULL DEFAULT 0'],
  ['token_version', 'INTEGER NOT NULL DEFAULT 0'],
  ['totp_secret', 'TEXT'],
  ['totp_enabled', 'INTEGER NOT NULL DEFAULT 0'],
  ['totp_last_step', 'INTEGER NOT NULL DEFAULT 0'],
  ['verify_code_hash', 'TEXT'],
  ['verify_code_expires', 'INTEGER NOT NULL DEFAULT 0'],
  ['verify_code_attempts', 'INTEGER NOT NULL DEFAULT 0'],
  ['referral_code', 'TEXT'],
  ['referred_by', 'TEXT'],
];

export function openDb(dbPath) {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  const have = new Set(db.prepare('PRAGMA table_info(users)').all().map((c) => c.name));
  for (const [name, def] of USER_COLUMNS) {
    if (!have.has(name)) db.exec(`ALTER TABLE users ADD COLUMN ${name} ${def}`);
  }
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS users_referral_idx ON users(referral_code)');
  db.exec('CREATE INDEX IF NOT EXISTS users_referred_by_idx ON users(referred_by)');
  return db;
}

// Runs fn inside a write transaction. Rolls back if fn throws.
export function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function logEvent(db, tradeId, type, detail) {
  db.prepare('INSERT INTO events (trade_id, type, detail, created_at) VALUES (?, ?, ?, ?)')
    .run(tradeId ?? null, type, detail === undefined ? null : JSON.stringify(detail), Date.now());
}
