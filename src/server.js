import http from 'node:http';
import crypto from 'node:crypto';
import { ASSETS } from './config.js';
import { openDb } from './db.js';
import { hashPassword, verifyPassword, signToken, verifyToken, verifyWebhook } from './auth.js';
import { createProviders } from './providers/index.js';
import { getSellRates } from './rates.js';
import { formatNaira, formatAmount } from './money.js';
import {
  HttpError, tradeView, createTrade, applyDeposit, retryPayout, expireStaleTrades,
} from './trades.js';

const MAX_BODY = 100 * 1024;
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;

export function createApp(config, opts = {}) {
  const db = opts.db ?? openDb(config.dbPath);
  const providers = opts.providers ?? createProviders(config);
  const ctxBase = { db, config, providers };
  const routes = [];
  const route = (method, path, handler, o = {}) =>
    routes.push({ method, re: new RegExp('^' + path.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), handler, ...o });

  // Small in-memory limiter for sign-up and login. Use a shared store if you run several servers.
  const hits = new Map();
  const limited = (ip, limit = config.authAttemptsPer15Min, windowMs = 15 * 60 * 1000) => {
    const now = Date.now();
    const list = (hits.get(ip) ?? []).filter((t) => now - t < windowMs);
    list.push(now);
    hits.set(ip, list);
    return list.length > limit;
  };

  const newId = (p) => `${p}_${crypto.randomBytes(8).toString('hex')}`;
  const userView = (u) => ({ id: u.id, email: u.email, kyc_status: u.kyc_status });
  const tokenFor = (u) => signToken({ sub: u.id }, config.tokenSecret, config.tokenTtlSeconds);

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

  route('GET', '/api/banks', async () => ({ body: await providers.payout.listBanks() }));

  // ---------- Auth ----------
  route('POST', '/api/auth/signup', async ({ body, ip }) => {
    if (limited(ip)) throw new HttpError(429, 'Too many attempts. Try again later.', 'rate_limited');
    const email = String(body.email ?? '').trim().toLowerCase();
    const password = String(body.password ?? '');
    if (!EMAIL_RE.test(email)) throw new HttpError(400, 'Enter a valid email address.', 'bad_email');
    if (password.length < 10 || password.length > 200) {
      throw new HttpError(400, 'Use a password of at least 10 characters.', 'weak_password');
    }
    if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) {
      throw new HttpError(409, 'An account with this email already exists.', 'email_taken');
    }
    const user = { id: newId('usr'), email, kyc_status: 'unverified' };
    db.prepare('INSERT INTO users (id, email, password_hash, kyc_status, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(user.id, email, hashPassword(password), user.kyc_status, Date.now());
    return { status: 201, body: { token: tokenFor(user), user: userView(user) } };
  });

  route('POST', '/api/auth/login', async ({ body, ip }) => {
    if (limited(ip)) throw new HttpError(429, 'Too many attempts. Try again later.', 'rate_limited');
    const email = String(body.email ?? '').trim().toLowerCase();
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    // Same message for unknown email and wrong password.
    if (!user || !verifyPassword(String(body.password ?? ''), user.password_hash)) {
      throw new HttpError(401, 'Email or password is incorrect.', 'bad_credentials');
    }
    return { body: { token: tokenFor(user), user: userView(user) } };
  });

  // ---------- Signed in ----------
  route('GET', '/api/me', ({ user }) => ({ body: userView(user) }), { auth: true });

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

  const headers = () => ({
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': config.corsOrigin,
    'access-control-allow-headers': 'authorization, content-type',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'x-content-type-options': 'nosniff',
    'cache-control': 'no-store',
  });

  const server = http.createServer(async (req, res) => {
    const send = (status, body) => {
      res.writeHead(status, headers());
      res.end(JSON.stringify(body));
    };
    try {
      if (req.method === 'OPTIONS') { res.writeHead(204, headers()); return res.end(); }
      const url = new URL(req.url, 'http://local');
      const match = routes.find((r) => r.method === req.method && r.re.test(url.pathname));
      if (!match) throw new HttpError(404, 'Not found.', 'not_found');
      const params = url.pathname.match(match.re).groups ?? {};

      let user = null;
      if (match.auth) {
        const header = String(req.headers.authorization ?? '');
        const payload = header.startsWith('Bearer ') ? verifyToken(header.slice(7), config.tokenSecret) : null;
        user = payload && db.prepare('SELECT * FROM users WHERE id = ?').get(payload.sub);
        if (!user) throw new HttpError(401, 'Sign in to continue.', 'unauthorized');
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
      const ip = req.socket.remoteAddress ?? 'unknown';
      const out = await match.handler({ req, params, query: url.searchParams, body, raw, user, ip });
      send(out.status ?? 200, out.body);
    } catch (err) {
      if (err instanceof HttpError) return send(err.status, { error: { code: err.code, message: err.message } });
      console.error('Unhandled error:', err);
      send(500, { error: { code: 'server_error', message: 'Something went wrong on our side.' } });
    }
  });

  const sweeper = setInterval(() => expireStaleTrades(db), 60 * 1000);
  sweeper.unref();
  server.on('close', () => clearInterval(sweeper));

  return { server, db, providers };
}
