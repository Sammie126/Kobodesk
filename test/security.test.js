import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { loadConfig } from '../src/config.js';
import { createApp } from '../src/server.js';
import { codeAt, base32Encode, base32Decode } from '../src/totp.js';
import { encryptSecret, decryptSecret } from '../src/auth.js';

let app, base, port;

before(async () => {
  const config = loadConfig({ mode: 'sandbox', dbPath: ':memory:', authAttemptsPer15Min: 1000, quiet: true });
  app = createApp(config);
  await new Promise((r) => app.server.listen(0, r));
  port = app.server.address().port;
  base = `http://localhost:${port}`;
});
after(() => app.server.close());

async function api(path, { method = 'GET', body, token } = {}) {
  const res = await fetch(base + path, {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(token ? { authorization: `Bearer ${token}` } : {}) },
  });
  return { status: res.status, json: await res.json() };
}

const linkToken = (mail, key) => mail.text.match(new RegExp(`#${key}=([\\w-]+)`))[1];
const lastMail = () => app.mailer.outbox[app.mailer.outbox.length - 1];

test('TOTP matches the RFC 6238 test vector, and base32 round-trips', () => {
  const secret = base32Encode(Buffer.from('12345678901234567890'));
  assert.equal(secret, 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  assert.equal(codeAt(secret, 59000, 8), '94287082');
  assert.equal(codeAt(secret, 1111111109000, 8), '07081804');
  assert.equal(base32Decode(secret).toString(), '12345678901234567890');
});

test('stored secrets are encrypted and tamper-proof', () => {
  const stored = encryptSecret('JBSWY3DPEHPK3PXP', 'k'.repeat(40));
  assert.ok(!stored.includes('JBSWY3DPEHPK3PXP'));
  assert.equal(decryptSecret(stored, 'k'.repeat(40)), 'JBSWY3DPEHPK3PXP');
  assert.throws(() => decryptSecret(stored, 'z'.repeat(40)));
});

test('email must be verified before trading, and the link works once', async () => {
  const signup = await api('/api/auth/signup', { method: 'POST', body: { email: 'new@example.com', password: 'a-long-password' } });
  const token = signup.json.token;
  assert.equal(signup.json.user.email_verified, false);
  assert.equal(lastMail().to, 'new@example.com');

  const bank = (await api('/api/bank-accounts', { method: 'POST', token, body: { bank_code: '058', account_number: '0123456789' } })).json.id;
  const blocked = await api('/api/trades', { method: 'POST', token, body: { coin: 'USDT', network: 'TRC20', amount: '100', bank_account_id: bank } });
  assert.equal(blocked.status, 403);
  assert.equal(blocked.json.error.code, 'verify_email');

  const link = linkToken(lastMail(), 'verify');
  assert.equal((await api('/api/auth/verify-email', { method: 'POST', body: { token: link } })).status, 200);
  assert.equal((await api('/api/auth/verify-email', { method: 'POST', body: { token: link } })).status, 400);
  assert.equal((await api('/api/auth/verify-email', { method: 'POST', body: { token: 'nonsense' } })).status, 400);
  assert.equal((await api('/api/me', { token })).json.email_verified, true);

  const ok = await api('/api/trades', { method: 'POST', token, body: { coin: 'USDT', network: 'TRC20', amount: '100', bank_account_id: bank } });
  assert.equal(ok.status, 201);
});

test('the 6-digit email code confirms an account, locks after 5 wrong tries, and a new code works', async () => {
  const signup = await api('/api/auth/signup', { method: 'POST', body: { email: 'code@example.com', password: 'a-long-password' } });
  const token = signup.json.token;
  const codeFrom = (mail) => mail.text.match(/verification code is:\n\n(\d{6})/)[1];
  assert.match(lastMail().subject, /^Your Kobodesk code is \d{6}$/);
  const first = codeFrom(lastMail());

  const wrong = first === '000000' ? '111111' : '000000';
  for (let i = 0; i < 5; i++) {
    const r = await api('/api/auth/verify-code', { method: 'POST', token, body: { code: wrong } });
    assert.equal(r.json.error.code, 'bad_code');
  }
  // Locked, even for the right code.
  const locked = await api('/api/auth/verify-code', { method: 'POST', token, body: { code: first } });
  assert.equal(locked.status, 429);

  assert.equal((await api('/api/auth/resend-verification', { method: 'POST', token, body: {} })).status, 200);
  const second = codeFrom(lastMail());
  assert.equal((await api('/api/auth/verify-code', { method: 'POST', token, body: { code: second } })).status, 200);
  assert.equal((await api('/api/me', { token })).json.email_verified, true);
  // The code does not work for anyone else.
  const other = (await api('/api/auth/signup', { method: 'POST', body: { email: 'code2@example.com', password: 'a-long-password' } })).json.token;
  assert.equal((await api('/api/auth/verify-code', { method: 'POST', token: other, body: { code: second } })).status, 400);
});

test('password reset works once, signs out old sessions, and hides which emails exist', async () => {
  const signup = await api('/api/auth/signup', { method: 'POST', body: { email: 'reset@example.com', password: 'first-password-1' } });
  const oldToken = signup.json.token;

  const unknown = await api('/api/auth/forgot-password', { method: 'POST', body: { email: 'nobody@example.com' } });
  const known = await api('/api/auth/forgot-password', { method: 'POST', body: { email: 'reset@example.com' } });
  assert.deepEqual(unknown.json, known.json);

  const link = linkToken(lastMail(), 'reset');
  assert.equal((await api('/api/auth/reset-password', { method: 'POST', body: { token: link, password: 'short' } })).status, 400);
  assert.equal((await api('/api/auth/reset-password', { method: 'POST', body: { token: link, password: 'second-password-2' } })).status, 200);
  assert.equal((await api('/api/auth/reset-password', { method: 'POST', body: { token: link, password: 'third-password-3' } })).status, 400);

  assert.equal((await api('/api/me', { token: oldToken })).status, 401);
  assert.equal((await api('/api/auth/login', { method: 'POST', body: { email: 'reset@example.com', password: 'first-password-1' } })).status, 401);
  assert.equal((await api('/api/auth/login', { method: 'POST', body: { email: 'reset@example.com', password: 'second-password-2' } })).status, 200);
});

test('change password keeps this device signed in and signs out the others', async () => {
  const a = (await api('/api/auth/signup', { method: 'POST', body: { email: 'chg@example.com', password: 'first-password-1' } })).json.token;
  const b = (await api('/api/auth/login', { method: 'POST', body: { email: 'chg@example.com', password: 'first-password-1' } })).json.token;
  assert.equal((await api('/api/auth/change-password', { method: 'POST', token: a, body: { current: 'wrong-password', next: 'second-password-2' } })).status, 401);
  const changed = await api('/api/auth/change-password', { method: 'POST', token: a, body: { current: 'first-password-1', next: 'second-password-2' } });
  assert.equal(changed.status, 200);
  assert.equal((await api('/api/me', { token: changed.json.token })).status, 200);
  assert.equal((await api('/api/me', { token: a })).status, 401);
  assert.equal((await api('/api/me', { token: b })).status, 401);

  assert.equal((await api('/api/auth/logout-all', { method: 'POST', token: changed.json.token })).status, 200);
  assert.equal((await api('/api/me', { token: changed.json.token })).status, 401);
});

test('two-factor sign-in: setup, enable, login needs a fresh code, disable', async () => {
  const email = 'twofa@example.com', password = 'a-long-password';
  const token = (await api('/api/auth/signup', { method: 'POST', body: { email, password } })).json.token;

  const setup = await api('/api/2fa/setup', { method: 'POST', token });
  assert.match(setup.json.otpauth_uri, /^otpauth:\/\/totp\//);
  const secret = setup.json.secret;
  const row = app.db.prepare('SELECT totp_secret FROM users WHERE email = ?').get(email);
  assert.ok(!row.totp_secret.includes(secret), 'secret must not be stored in plain text');

  assert.equal((await api('/api/2fa/enable', { method: 'POST', token, body: { code: '000000' } })).status, 400);
  assert.equal((await api('/api/2fa/enable', { method: 'POST', token, body: { code: codeAt(secret, Date.now()) } })).status, 200);

  const noCode = await api('/api/auth/login', { method: 'POST', body: { email, password } });
  assert.equal(noCode.json.error.code, 'totp_required');
  // The code used to enable cannot be used again.
  const replay = await api('/api/auth/login', { method: 'POST', body: { email, password, code: codeAt(secret, Date.now()) } });
  assert.equal(replay.json.error.code, 'bad_totp');
  const next = await api('/api/auth/login', { method: 'POST', body: { email, password, code: codeAt(secret, Date.now() + 30000) } });
  assert.equal(next.status, 200);
  assert.equal(next.json.user.totp_enabled, true);

  app.db.prepare('UPDATE users SET totp_last_step = 0 WHERE email = ?').run(email); // pretend 30 seconds passed
  const code = codeAt(secret, Date.now());
  assert.equal((await api('/api/2fa/disable', { method: 'POST', token: next.json.token, body: { password: 'wrong', code } })).status, 401);
  assert.equal((await api('/api/2fa/disable', { method: 'POST', token: next.json.token, body: { password, code } })).status, 200);
  assert.equal((await api('/api/auth/login', { method: 'POST', body: { email, password } })).status, 200);
});

test('the website is served with security headers and nothing outside web/ leaks', async () => {
  const page = await fetch(base + '/');
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /text\/html/);
  assert.match(page.headers.get('content-security-policy'), /script-src 'self'/);
  assert.equal(page.headers.get('x-frame-options'), 'DENY');
  assert.equal((await fetch(base + '/app.html')).status, 200);
  assert.equal((await fetch(base + '/src/server.js')).status, 404);
  assert.equal((await fetch(base + '/package.json')).status, 404);

  const status = await new Promise((resolve, reject) => {
    http.get({ host: 'localhost', port, path: '/..%2fsrc%2fserver.js' }, (res) => { res.resume(); resolve(res.statusCode); }).on('error', reject);
  });
  assert.equal(status, 404);
});

test('public quote endpoint prices a trade and rejects bad input', async () => {
  const q = await api('/api/quote?coin=USDT&network=TRC20&amount=100');
  assert.equal(q.json.quote_kobo, 14775000);
  assert.equal(q.json.quote_naira, '147,750.00');
  assert.equal((await api('/api/quote?coin=USDT&network=BTC&amount=100')).status, 400);
  assert.equal((await api('/api/quote?coin=USDT&network=TRC20&amount=abc')).status, 400);
});

test('live mode refuses weak configuration', () => {
  const good = { mode: 'live', ratesSource: 'live', companyName: 'Kobodesk Ltd', supportEmail: 'help@kobodesk.example', supportHours: '8am to 8pm', payoutTime: '5 minutes', adminEmails: ['ops@kobodesk.example'], tokenSecret: 'a'.repeat(32), webhookSecret: 'b'.repeat(32), dataKey: 'c'.repeat(32),
    publicUrl: 'https://kobodesk.example', mailProvider: 'resend', mailApiKey: 'k', mailFrom: 'Kobodesk <no-reply@kobodesk.example>' };
  assert.doesNotThrow(() => loadConfig(good));
  assert.throws(() => loadConfig({ ...good, publicUrl: 'http://kobodesk.example' }), /https/);
  assert.throws(() => loadConfig({ ...good, dataKey: 'a'.repeat(32) }), /different/);
  assert.throws(() => loadConfig({ ...good, mailProvider: 'console' }), /email provider/);
  assert.throws(() => loadConfig({ ...good, tokenSecret: 'short' }), /TOKEN_SECRET/);
  assert.throws(() => loadConfig({ ...good, ratesSource: 'sample' }), /RATES_SOURCE/);
  assert.throws(() => loadConfig({ ...good, companyName: '' }), /COMPANY_NAME/);
  assert.throws(() => loadConfig({ ...good, adminEmails: [] }), /ADMIN_EMAILS/);
});
