import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { ASSETS } from './config.js';
import { openDb, tx } from './db.js';
import {
  hashPassword, verifyPassword, signToken, verifyToken, verifyWebhook,
  newEmailToken, hashEmailToken, encryptSecret, decryptSecret,
} from './auth.js';
import { createProviders } from './providers/index.js';
import { createMailer } from './mail.js';
import { newSecret, verifyCode, otpauthUri } from './totp.js';
import { getSellRates } from './rates.js';
import { formatNaira, formatAmount } from './money.js';
import {
  HttpError, tradeView, createTrade, priceTrade, applyDeposit, retryPayout, expireStaleTrades,
} from './trades.js';

const MAX_BODY = 100 * 1024;
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;
const WEB_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web');
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};
const CSP = [
  "default-src 'self'", "script-src 'self'", "style-src 'self' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com", "img-src 'self' data:", "connect-src 'self'",
  "frame-ancestors 'none'", "base-uri 'none'", "form-action 'self'",
].join('; ');

export function createApp(config, opts = {}) {
  const db = opts.db ?? openDb(config.dbPath);
  const providers = opts.providers ?? createProviders(config);
  const mailer = opts.mailer ?? createMailer(config);
  const ctxBase = { db, config, providers };
  const routes = [];
  const route = (method, p, handler, o = {}) =>
    routes.push({ method, re: new RegExp('^' + p.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), handler, ...o });

  // Small in-memory limiter. Use a shared store (such as Redis) if you run several servers.
  const hits = new Map();
  const limited = (key, limit = config.authAttemptsPer15Min, windowMs = 15 * 60 * 1000) => {
    const now = Date.now();
    const list = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
    list.push(now);
    hits.set(key, list);
    return list.length > limit;
  };
  const guard = (...keys) => {
    if (keys.some((k) => limited(k))) throw new HttpError(429, 'Too many attempts. Try again in a few minutes.', 'rate_limited');
  };

  const newId = (p) => `${p}_${crypto.randomBytes(8).toString('hex')}`;
  const userView = (u) => ({
    id: u.id, email: u.email, kyc_status: u.kyc_status,
    email_verified: !!u.email_verified, totp_enabled: !!u.totp_enabled,
  });
  const tokenFor = (u) => signToken({ sub: u.id, v: u.token_version }, config.tokenSecret, config.tokenTtlSeconds);
  const clientIp = (req) => {
    if (config.trustProxy) {
      const parts = String(req.headers['x-forwarded-for'] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
      if (parts.length) return parts[parts.length - 1]; // the address our own proxy saw
    }
    return req.socket.remoteAddress ?? 'unknown';
  };

  async function sendMail(to, subject, text) {
    try { await mailer.send({ to, subject, text }); }
    catch (err) { console.error('Could not send email:', err.message); }
  }

  async function sendVerification(user) {
    const { token, hash } = newEmailToken();
    db.prepare('INSERT INTO email_tokens (token_hash, user_id, purpose, expires_at) VALUES (?, ?, ?, ?)')
      .run(hash, user.id, 'verify', Date.now() + 24 * 3600 * 1000);
    // A 6-digit code the customer types into the app. Only its hash is stored, and it allows 5 wrong tries.
    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    db.prepare('UPDATE users SET verify_code_hash = ?, verify_code_expires = ?, verify_code_attempts = 0 WHERE id = ?')
      .run(hashEmailToken(`${user.id}:${code}`), Date.now() + 15 * 60 * 1000, user.id);
    await sendMail(user.email, `Your Kobodesk code is ${code}`,
      `Your Kobodesk verification code is:\n\n${code}\n\nType it into the app to confirm your email. It works for 15 minutes.\n\nOr open this link instead:\n${config.publicUrl}/app.html#verify=${token}\n\nIf you did not create a Kobodesk account, ignore this email. Never share this code with anyone.`);
  }

  // Looks up a one-time email token and returns its row, or null.
  function findEmailToken(token, purpose) {
    const row = db.prepare('SELECT * FROM email_tokens WHERE token_hash = ?').get(hashEmailToken(token));
    if (!row || row.purpose !== purpose || row.used_at || row.expires_at < Date.now()) return null;
    return row;
  }

  function checkPassword(password) {
    if (typeof password !== 'string' || password.length < 10 || password.length > 200) {
      throw new HttpError(400, 'Use a password of at least 10 characters.', 'weak_password');
    }
  }

  // Checks a 2FA code, refusing a code that was already used. Returns true on success.
  function checkTotp(user, code) {
    if (!user.totp_secret) return false;
    const step = verifyCode(decryptSecret(user.totp_secret, config.dataKey), code, user.totp_last_step);
    if (step == null) return false;
    db.prepare('UPDATE users SET totp_last_step = ? WHERE id = ?').run(step, user.id);
    return true;
  }

  // ---------- Public ----------
  route('GET', '/api/health', () => ({ body: { ok: true, mode: config.mode } }));

  route('GET', '/api/assets', () => ({
    body: Object.entries(ASSETS).map(([coin, a]) => ({ coin, name: a.name, networks: a.networks })),
  }));

  route('GET', '/api/rates', async () => {
    const rates = await getSellRates(config);
    return {
      body: {
        sample: config.mode === 'sandbox',
        rates: Object.entries(rates).map(([coin, kobo]) => ({ coin, rate_kobo: kobo, rate_naira: formatNaira(kobo) })),
      },
    };
  });

  route('GET', '/api/quote', async ({ query }) => {
    const q = await priceTrade(config, {
      coin: query.get('coin'), network: query.get('network'), amount: query.get('amount'),
    });
    return {
      body: {
        coin: q.coin, network: q.network, amount: formatAmount(q.scaled),
        rate_kobo: q.rate, quote_kobo: q.quote, quote_naira: formatNaira(q.quote),
        valid_for_seconds: config.quoteTtlSeconds,
      },
    };
  });

  route('GET', '/api/banks', async () => ({ body: await providers.payout.listBanks() }));

  // ---------- Auth ----------
  route('POST', '/api/auth/signup', async ({ body, ip }) => {
    guard(`ip:${ip}`);
    const email = String(body.email ?? '').trim().toLowerCase();
    if (!EMAIL_RE.test(email)) throw new HttpError(400, 'Enter a valid email address.', 'bad_email');
    checkPassword(body.password);
    if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) {
      throw new HttpError(409, 'An account with this email already exists.', 'email_taken');
    }
    const id = newId('usr');
    db.prepare('INSERT INTO users (id, email, password_hash, kyc_status, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, email, hashPassword(body.password), 'unverified', Date.now());
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    await sendVerification(user);
    return { status: 201, body: { token: tokenFor(user), user: userView(user) } };
  });

  route('POST', '/api/auth/login', async ({ body, ip }) => {
    const email = String(body.email ?? '').trim().toLowerCase();
    guard(`ip:${ip}`, `email:${email}`);
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    // Same message for unknown email and wrong password.
    if (!user || !verifyPassword(String(body.password ?? ''), user.password_hash)) {
      throw new HttpError(401, 'Email or password is incorrect.', 'bad_credentials');
    }
    if (user.totp_enabled) {
      if (!body.code) throw new HttpError(401, 'Enter the 6-digit code from your authenticator app.', 'totp_required');
      if (!checkTotp(user, body.code)) throw new HttpError(401, 'That code is not right. Try the next one.', 'bad_totp');
    }
    return { body: { token: tokenFor(user), user: userView(user) } };
  });

  route('POST', '/api/auth/verify-email', ({ body }) => {
    const row = findEmailToken(String(body.token ?? ''), 'verify');
    if (!row) throw new HttpError(400, 'This link has expired or was already used. Request a new one from your settings.', 'bad_token');
    tx(db, () => {
      db.prepare('UPDATE users SET email_verified = 1 WHERE id = ?').run(row.user_id);
      db.prepare('UPDATE email_tokens SET used_at = ? WHERE token_hash = ?').run(Date.now(), row.token_hash);
    });
    return { body: { ok: true } };
  });

  route('POST', '/api/auth/verify-code', ({ user, body }) => {
    if (user.email_verified) return { body: { ok: true } };
    if (!user.verify_code_hash || user.verify_code_expires < Date.now()) {
      throw new HttpError(400, 'This code has expired. Ask for a new one.', 'code_expired');
    }
    if (user.verify_code_attempts >= 5) {
      throw new HttpError(429, 'Too many wrong codes. Ask for a new one.', 'too_many_codes');
    }
    const given = hashEmailToken(`${user.id}:${String(body.code ?? '').replace(/\s+/g, '')}`);
    if (!crypto.timingSafeEqual(Buffer.from(given), Buffer.from(user.verify_code_hash))) {
      db.prepare('UPDATE users SET verify_code_attempts = verify_code_attempts + 1 WHERE id = ?').run(user.id);
      throw new HttpError(400, 'That code is not right. Check the email and try again.', 'bad_code');
    }
    db.prepare('UPDATE users SET email_verified = 1, verify_code_hash = NULL WHERE id = ?').run(user.id);
    return { body: { ok: true } };
  }, { auth: true });

  route('POST', '/api/auth/forgot-password', async ({ body, ip }) => {
    const email = String(body.email ?? '').trim().toLowerCase();
    guard(`ip:${ip}`, `email:${email}`);
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (user) {
      const { token, hash } = newEmailToken();
      db.prepare('INSERT INTO email_tokens (token_hash, user_id, purpose, expires_at) VALUES (?, ?, ?, ?)')
        .run(hash, user.id, 'reset', Date.now() + 3600 * 1000);
      await sendMail(user.email, 'Reset your Kobodesk password',
        `Choose a new password:\n\n${config.publicUrl}/app.html#reset=${token}\n\nThe link works for 1 hour. If you did not ask for this, ignore this email. Your password has not changed.`);
    }
    // Same answer whether or not the email has an account.
    return { body: { ok: true, message: 'If that email has an account, we sent a reset link.' } };
  });

  route('POST', '/api/auth/reset-password', ({ body, ip }) => {
    guard(`ip:${ip}`);
    checkPassword(body.password);
    const row = findEmailToken(String(body.token ?? ''), 'reset');
    if (!row) throw new HttpError(400, 'This link has expired or was already used. Ask for a new one.', 'bad_token');
    tx(db, () => {
      // Raising token_version signs out every device.
      db.prepare('UPDATE users SET password_hash = ?, token_version = token_version + 1 WHERE id = ?')
        .run(hashPassword(body.password), row.user_id);
      db.prepare('UPDATE email_tokens SET used_at = ? WHERE token_hash = ?').run(Date.now(), row.token_hash);
    });
    return { body: { ok: true } };
  });

  // ---------- Signed in ----------
  route('GET', '/api/me', ({ user }) => ({ body: userView(user) }), { auth: true });

  const lastResend = new Map();
  route('POST', '/api/auth/resend-verification', async ({ user }) => {
    if (user.email_verified) return { body: { ok: true } };
    if (Date.now() - (lastResend.get(user.id) ?? 0) < 60 * 1000) {
      throw new HttpError(429, 'Wait a minute before asking for another email.', 'rate_limited');
    }
    lastResend.set(user.id, Date.now());
    await sendVerification(user);
    return { body: { ok: true } };
  }, { auth: true });

  route('POST', '/api/auth/change-password', ({ user, body, ip }) => {
    guard(`ip:${ip}`);
    if (!verifyPassword(String(body.current ?? ''), user.password_hash)) {
      throw new HttpError(401, 'Your current password is not right.', 'bad_credentials');
    }
    checkPassword(body.next);
    db.prepare('UPDATE users SET password_hash = ?, token_version = token_version + 1 WHERE id = ?')
      .run(hashPassword(body.next), user.id);
    const fresh = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
    return { body: { token: tokenFor(fresh) } }; // this device stays signed in; all others are signed out
  }, { auth: true });

  route('POST', '/api/auth/logout-all', ({ user }) => {
    db.prepare('UPDATE users SET token_version = token_version + 1 WHERE id = ?').run(user.id);
    return { body: { ok: true } };
  }, { auth: true });

  route('POST', '/api/2fa/setup', ({ user }) => {
    if (user.totp_enabled) throw new HttpError(409, 'Two-factor sign-in is already on.', 'already_enabled');
    const secret = newSecret();
    db.prepare('UPDATE users SET totp_secret = ?, totp_last_step = 0 WHERE id = ?')
      .run(encryptSecret(secret, config.dataKey), user.id);
    return { body: { secret, otpauth_uri: otpauthUri(secret, user.email) } };
  }, { auth: true });

  route('POST', '/api/2fa/enable', ({ user, body }) => {
    if (user.totp_enabled) throw new HttpError(409, 'Two-factor sign-in is already on.', 'already_enabled');
    if (!user.totp_secret) throw new HttpError(400, 'Start setup first.', 'no_setup');
    if (!checkTotp(user, body.code)) throw new HttpError(400, 'That code is not right. Check the app and try again.', 'bad_totp');
    db.prepare('UPDATE users SET totp_enabled = 1 WHERE id = ?').run(user.id);
    return { body: { ok: true } };
  }, { auth: true });

  route('POST', '/api/2fa/disable', ({ user, body, ip }) => {
    guard(`ip:${ip}`);
    if (!user.totp_enabled) throw new HttpError(409, 'Two-factor sign-in is not on.', 'not_enabled');
    if (!verifyPassword(String(body.password ?? ''), user.password_hash)) {
      throw new HttpError(401, 'Your password is not right.', 'bad_credentials');
    }
    if (!checkTotp(user, body.code)) throw new HttpError(400, 'That code is not right.', 'bad_totp');
    db.prepare('UPDATE users SET totp_enabled = 0, totp_secret = NULL WHERE id = ?').run(user.id);
    return { body: { ok: true } };
  }, { auth: true });

  route('GET', '/api/bank-accounts', ({ user }) => ({
    body: db.prepare('SELECT id, bank_code, bank_name, account_number, account_name FROM bank_accounts WHERE user_id = ? ORDER BY created_at').all(user.id),
  }), { auth: true });

  route('POST', '/api/bank-accounts', async ({ user, body }) => {
    const bank_code = String(body.bank_code ?? '');
    const account_number = String(body.account_number ?? '');
    if (!/^\d{10}$/.test(account_number)) throw new HttpError(400, 'Account numbers have 10 digits.', 'bad_account_number');
    const bank = (await providers.payout.listBanks()).find((b) => b.code === bank_code);
    if (!bank) throw new HttpError(400, 'Choose a bank from the list.', 'bad_bank');
    const resolved = await providers.payout.resolveAccount({ bank_code, account_number });
    if (!resolved) throw new HttpError(422, 'We could not find that account. Check the number and bank.', 'account_not_found');
    const id = newId('bnk');
    try {
      db.prepare('INSERT INTO bank_accounts (id, user_id, bank_code, bank_name, account_number, account_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(id, user.id, bank_code, bank.name, account_number, resolved.account_name, Date.now());
    } catch {
      throw new HttpError(409, 'You already saved this account.', 'duplicate_account');
    }
    return { status: 201, body: { id, bank_code, bank_name: bank.name, account_number, account_name: resolved.account_name } };
  }, { auth: true });

  route('POST', '/api/trades', async ({ user, body }) => {
    const trade = await createTrade({ ...ctxBase, user, input: body });
    return { status: 201, body: tradeView(trade) };
  }, { auth: true });

  route('GET', '/api/trades', ({ user }) => {
    expireStaleTrades(db);
    return { body: db.prepare('SELECT * FROM trades WHERE user_id = ? ORDER BY created_at DESC LIMIT 100').all(user.id).map(tradeView) };
  }, { auth: true });

  route('GET', '/api/trades/:id', ({ user, params }) => {
    expireStaleTrades(db);
    const t = db.prepare('SELECT * FROM trades WHERE id = ? AND user_id = ?').get(params.id, user.id);
    if (!t) throw new HttpError(404, 'Trade not found.', 'not_found');
    return { body: tradeView(t) };
  }, { auth: true });

  // ---------- Crypto provider webhook ----------
  route('POST', '/api/webhooks/crypto', async ({ body, raw, req }) => {
    if (!verifyWebhook(raw, req.headers['x-signature'], config.webhookSecret)) {
      throw new HttpError(401, 'Bad signature.', 'bad_signature');
    }
    return { body: await applyDeposit(ctxBase, body) };
  });

  // ---------- Sandbox only: simulate a deposit so you can try the whole flow ----------
  if (config.mode === 'sandbox') {
    route('POST', '/api/sandbox/trades/:id/deposit', async ({ user, params, body }) => {
      const t = db.prepare('SELECT * FROM trades WHERE id = ? AND user_id = ?').get(params.id, user.id);
      if (!t) throw new HttpError(404, 'Trade not found.', 'not_found');
      const required = ASSETS[t.coin].requiredConfirmations[t.network];
      const result = await applyDeposit(ctxBase, {
        address: t.deposit_address, coin: t.coin, network: t.network,
        amount: body.amount ?? formatAmount(t.amount_scaled),
        confirmations: body.confirmations ?? required,
        tx_hash: body.tx_hash ?? `sandbox-tx-${t.id}`,
      });
      return { body: { ...result, trade: tradeView(db.prepare('SELECT * FROM trades WHERE id = ?').get(t.id)) } };
    }, { auth: true });
  }

  // ---------- Admin ----------
  route('GET', '/api/admin/trades', ({ query }) => {
    const status = query.get('status');
    const rows = status
      ? db.prepare('SELECT * FROM trades WHERE status = ? ORDER BY created_at DESC LIMIT 200').all(status)
      : db.prepare('SELECT * FROM trades ORDER BY created_at DESC LIMIT 200').all();
    return { body: rows.map(tradeView) };
  }, { auth: true, admin: true });

  route('POST', '/api/admin/trades/:id/retry-payout', async ({ params }) => ({
    body: await retryPayout(ctxBase, params.id),
  }), { auth: true, admin: true });

  route('POST', '/api/admin/users/:id/kyc', ({ params, body }) => {
    const status = String(body.status ?? '');
    if (!['unverified', 'pending', 'verified', 'rejected'].includes(status)) {
      throw new HttpError(400, 'Unknown status.', 'bad_status');
    }
    const r = db.prepare('UPDATE users SET kyc_status = ? WHERE id = ?').run(status, params.id);
    if (r.changes !== 1) throw new HttpError(404, 'User not found.', 'not_found');
    return { body: { id: params.id, kyc_status: status } };
  }, { auth: true, admin: true });

  // For a customer who lost their phone. Confirm who they are first.
  route('POST', '/api/admin/users/:id/reset-2fa', ({ params }) => {
    const r = db.prepare('UPDATE users SET totp_enabled = 0, totp_secret = NULL, token_version = token_version + 1 WHERE id = ?').run(params.id);
    if (r.changes !== 1) throw new HttpError(404, 'User not found.', 'not_found');
    return { body: { ok: true } };
  }, { auth: true, admin: true });

  // ---------- HTTP plumbing ----------
  async function readBody(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BODY) throw new HttpError(413, 'Request too large.', 'too_large');
      chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString('utf8');
  }

  const baseHeaders = () => {
    const h = {
      'access-control-allow-origin': config.corsOrigin,
      'access-control-allow-headers': 'authorization, content-type',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'x-frame-options': 'DENY',
    };
    if (config.publicUrl.startsWith('https://')) h['strict-transport-security'] = 'max-age=31536000; includeSubDomains';
    return h;
  };

  async function serveStatic(req, res, pathname) {
    let rel = decodeURIComponent(pathname);
    if (rel === '/') rel = '/index.html';
    if (!/^\/[a-zA-Z0-9._\-\/]+$/.test(rel) || rel.includes('..')) throw new HttpError(404, 'Not found.', 'not_found');
    const file = path.join(WEB_ROOT, rel);
    const type = TYPES[path.extname(file)];
    if (!type || !file.startsWith(WEB_ROOT + path.sep)) throw new HttpError(404, 'Not found.', 'not_found');
    let data;
    try { data = await fs.readFile(file); } catch { throw new HttpError(404, 'Not found.', 'not_found'); }
    const headers = { ...baseHeaders(), 'content-type': type, 'cache-control': type.startsWith('text/html') ? 'no-cache' : 'public, max-age=3600' };
    if (type.startsWith('text/html')) headers['content-security-policy'] = CSP;
    res.writeHead(200, headers);
    res.end(req.method === 'HEAD' ? undefined : data);
  }

  const server = http.createServer(async (req, res) => {
    const sendJson = (status, body) => {
      res.writeHead(status, { ...baseHeaders(), 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    try {
      if (req.method === 'OPTIONS') { res.writeHead(204, baseHeaders()); return res.end(); }
      const url = new URL(req.url, 'http://local');

      if (!url.pathname.startsWith('/api/')) {
        if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed.', 'method_not_allowed');
        return await serveStatic(req, res, url.pathname);
      }

      const match = routes.find((r) => r.method === req.method && r.re.test(url.pathname));
      if (!match) throw new HttpError(404, 'Not found.', 'not_found');
      const params = url.pathname.match(match.re).groups ?? {};

      let user = null;
      if (match.auth) {
        const header = String(req.headers.authorization ?? '');
        const payload = header.startsWith('Bearer ') ? verifyToken(header.slice(7), config.tokenSecret) : null;
        user = payload && db.prepare('SELECT * FROM users WHERE id = ?').get(payload.sub);
        if (!user || payload.v !== user.token_version) throw new HttpError(401, 'Sign in to continue.', 'unauthorized');
        if (match.admin && !config.adminEmails.includes(user.email)) throw new HttpError(403, 'Not allowed.', 'forbidden');
      }

      let body = {}, raw = '';
      if (req.method === 'POST') {
        raw = await readBody(req);
        if (raw) {
          try { body = JSON.parse(raw); } catch { throw new HttpError(400, 'Body must be valid JSON.', 'bad_json'); }
          if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'Body must be a JSON object.', 'bad_json');
        }
      }
      const out = await match.handler({ req, params, query: url.searchParams, body, raw, user, ip: clientIp(req) });
      sendJson(out.status ?? 200, out.body);
    } catch (err) {
      if (err instanceof HttpError) {
        if (!res.headersSent && !String(req.url).startsWith('/api/')) {
          res.writeHead(err.status, { ...baseHeaders(), 'content-type': 'text/plain; charset=utf-8' });
          return res.end(err.message);
        }
        return sendJson(err.status, { error: { code: err.code, message: err.message } });
      }
      console.error('Unhandled error:', err);
      if (!res.headersSent) sendJson(500, { error: { code: 'server_error', message: 'Something went wrong on our side.' } });
    }
  });

  const sweeper = setInterval(() => expireStaleTrades(db), 60 * 1000);
  sweeper.unref();
  server.on('close', () => clearInterval(sweeper));

  return { server, db, providers, mailer };
}
