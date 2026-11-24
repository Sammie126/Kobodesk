import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import { createApp } from '../src/server.js';
import { codeAt } from '../src/totp.js';
import { migrateEncryption, open as openSealed } from '../src/vault.js';

// A tiny valid PNG (1x1 pixel).
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

const HIGH = 10 ** 13;
const servers = [];
after(() => servers.forEach((s) => s.close()));
// Defaults here are the real ones (identity check before first trade, ID file required) unless a test overrides them.
async function boot(overrides = {}, opts = {}) {
  const config = loadConfig({
    mode: 'sandbox', dbPath: ':memory:', adminEmails: ['admin@example.com'], quiet: true,
    authAttemptsPer15Min: 100000, apiPerMinute: 100000, tradeCreatesPerHour: 100000, amlMaxTrades10Min: 100000,
    dailyLimitKoboUnverified: HIGH, dailyLimitKoboVerified: HIGH, reviewThresholdKobo: HIGH,
    publicUrl: 'https://kobodesk.example', supportEmail: 'help@kobodesk.example',
    ...overrides,
  });
  const app = createApp(config, opts);
  await new Promise((r) => app.server.listen(0, r));
  servers.push(app.server);
  const base = `http://localhost:${app.server.address().port}`;
  const api = async (path, { method = 'GET', body, token } = {}) => {
    const res = await fetch(base + path, {
      method, body: body === undefined ? undefined : JSON.stringify(body),
      headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    });
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { json = text; }
    return { status: res.status, json, headers: res.headers, text };
  };
  let n = 3000000000;
  const h = {
    app, api, config, base, close: () => app.server.close(),
    user: async (email, extra = {}) => {
      const r = await api('/api/auth/signup', { method: 'POST', body: { email, password: 'a-long-password', ...extra } });
      assert.equal(r.status, 201, JSON.stringify(r.json));
      app.db.prepare('UPDATE users SET email_verified = 1 WHERE email = ?').run(email);
      return r.json.token;
    },
    bank: async (token, number = String(++n)) => {
      const r = await api('/api/bank-accounts', { method: 'POST', token, body: { bank_code: '058', account_number: number } });
      assert.equal(r.status, 201, JSON.stringify(r.json));
      return r.json.id;
    },
    trade: (token, bank_account_id, amount = '100') =>
      api('/api/trades', { method: 'POST', token, body: { coin: 'USDT', network: 'TRC20', amount, bank_account_id } }),
    deposit: async (token, id) => (await api(`/api/sandbox/trades/${id}/deposit`, { method: 'POST', token, body: {} })).json,
    kyc: (token, over = {}) => api('/api/kyc', {
      method: 'POST', token,
      body: { full_name: 'Ada Lovelace Obi', dob: '1994-03-21', id_type: 'BVN', id_number: '22123456789', address: '12 Admiralty Way, Lekki, Lagos', id_document: { data: PNG_B64 }, ...over },
    }),
    setKyc: (email, status) => app.db.prepare('UPDATE users SET kyc_status = ? WHERE email = ?').run(status, email),
  };
  return h;
}

test('identity check is required before the first trade, and needs an ID file', async () => {
  const h = await boot();
  const token = await h.user('kyc1@example.com');
  const bank = await h.bank(token);
  const blocked = await h.trade(token, bank);
  assert.equal(blocked.status, 403);
  assert.equal(blocked.json.error.code, 'kyc_required');

  assert.equal((await h.kyc(token, { id_document: undefined })).json.error.code, 'document_required');
  const fake = Buffer.from('this is not an image, it is plain text pretending').toString('base64');
  assert.equal((await h.kyc(token, { id_document: { data: fake } })).json.error.code, 'bad_document');
  const big = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(3.5 * 1024 * 1024)]).toString('base64');
  assert.equal((await h.kyc(token, { id_document: { data: big } })).json.error.code, 'bad_document');

  assert.equal((await h.kyc(token)).status, 200);
  // Submitted and waiting for review: small trades may go ahead, within the unverified limit.
  assert.equal((await h.trade(token, bank)).status, 201);
  h.close();
});

test('personal data and ID files are encrypted at rest, and older plain data is sealed on start', async () => {
  const h = await boot({ kycBeforeFirstTrade: false });
  const token = await h.user('enc@example.com');
  const bank = await h.bank(token, '0123456781');
  await h.kyc(token);

  const b = h.app.db.prepare('SELECT * FROM bank_accounts WHERE id = ?').get(bank);
  assert.ok(!b.account_number.includes('0123456781'), 'account number is not stored in plain text');
  assert.ok(!b.account_name.includes('SANDBOX'), 'account name is not stored in plain text');
  assert.equal(b.account_last4, '6781');
  const k = h.app.db.prepare('SELECT * FROM kyc_submissions').get();
  for (const f of ['full_name', 'dob', 'address', 'id_number_enc']) {
    assert.ok(!/Ada|Lovelace|1994|Admiralty|22123456789/.test(k[f]), `${f} is not stored in plain text`);
  }
  const doc = h.app.db.prepare('SELECT * FROM kyc_documents').get();
  assert.ok(!Buffer.from(doc.data_enc).includes(Buffer.from('PNG')), 'the ID file is not stored as readable bytes');
  // The customer still sees their own details.
  assert.equal((await h.api('/api/bank-accounts', { token })).json[0].account_number, '0123456781');
  assert.equal((await h.api('/api/kyc', { token })).json.submission.full_name, 'Ada Lovelace Obi');

  // An older database with plain values is sealed the next time the server starts.
  h.app.db.prepare("INSERT INTO users (id, email, password_hash, created_at) VALUES ('old', 'old@example.com', 'x', 1)").run();
  h.app.db.prepare("INSERT INTO bank_accounts (id, user_id, bank_code, bank_name, account_number, account_name, created_at) VALUES ('bnk_old', 'old', '058', 'GTB', '0999999111', 'OLD NAME', 1)").run();
  migrateEncryption(h.app.db, h.config.dataKey);
  const old = h.app.db.prepare("SELECT * FROM bank_accounts WHERE id = 'bnk_old'").get();
  assert.ok(old.account_number.startsWith('v1:') && !old.account_number.includes('0999999111'));
  assert.equal(openSealed(old.account_number, h.config.dataKey), '0999999111');
  assert.ok(old.account_hash && old.account_last4 === '9111');
  h.close();
});

test('admin can view the ID file; viewing is logged; others cannot', async () => {
  const h = await boot({ kycBeforeFirstTrade: false });
  const admin = await h.user('admin@example.com');
  const token = await h.user('doc@example.com');
  await h.kyc(token);
  const uid = h.app.db.prepare("SELECT id FROM users WHERE email = 'doc@example.com'").get().id;
  assert.equal((await h.api(`/api/admin/kyc/${uid}/document`, { token })).status, 403);
  const r = await h.api(`/api/admin/kyc/${uid}/document`, { token: admin });
  assert.equal(r.status, 200);
  assert.equal(r.json.mime, 'image/png');
  assert.equal(r.json.data, PNG_B64);
  assert.ok(h.app.db.prepare("SELECT 1 FROM events WHERE type = 'kyc_document_viewed'").get());
  // The admin cannot approve their own identity check.
  await h.kyc(admin);
  const adminId = h.app.db.prepare("SELECT id FROM users WHERE email = 'admin@example.com'").get().id;
  const self = await h.api(`/api/admin/kyc/${adminId}/decision`, { method: 'POST', token: admin, body: { status: 'verified' } });
  assert.equal(self.json.error.code, 'self_review');
  h.close();
});

test('daily limit counts the last 24 hours and ignores expired quotes', async () => {
  const h = await boot({ kycBeforeFirstTrade: false, dailyLimitKoboUnverified: 30000000 }); // ₦300,000 a day
  const token = await h.user('daily@example.com');
  const bank = await h.bank(token);
  assert.equal((await h.trade(token, bank)).status, 201); // ₦147,750
  const second = await h.trade(token, bank);
  assert.equal(second.status, 201); // ₦295,500 in total
  const third = await h.trade(token, bank);
  assert.equal(third.status, 400);
  assert.equal(third.json.error.code, 'above_daily_limit');
  assert.match(third.json.error.message, /daily limit/);
  const lim = await h.api('/api/limits', { token });
  assert.equal(lim.json.daily_naira, '300,000.00');
  assert.equal(lim.json.used_today_naira, '295,500.00');
  // Quotes that ran out unused stop counting.
  h.app.db.prepare("UPDATE trades SET expires_at = ? WHERE status = 'awaiting_deposit'").run(Date.now() - 1000);
  assert.equal((await h.trade(token, bank)).status, 201, 'expired quotes no longer count, even before the sweeper runs');
  h.close();
});

test('large payouts are held for review; a second admin releases or rejects', async () => {
  const h = await boot({ kycBeforeFirstTrade: false, reviewThresholdKobo: 10000000 }); // hold at ₦100,000
  const admin = await h.user('admin@example.com');
  const token = await h.user('big@example.com');
  const bank = await h.bank(token);
  const t = (await h.trade(token, bank)).json; // ₦147,750
  const dep = await h.deposit(token, t.id);
  assert.equal(dep.result, 'held_for_review');
  assert.equal(h.app.providers.payout._paid.has(`kd_${t.id}`), false, 'nothing was sent');

  const mine = (await h.api(`/api/trades/${t.id}`, { token })).json;
  assert.equal(mine.status, 'held_for_review');
  assert.equal(mine.hold_reason, undefined, 'customers never see the internal reason');
  const list = (await h.api('/api/admin/trades?status=held_for_review', { token: admin })).json;
  assert.equal(list.length, 1);
  assert.match(list[0].hold_reason, /review threshold/);
  assert.ok(h.app.mailer.outbox.some((m) => m.to === 'admin@example.com' && /held for review/i.test(m.subject)));

  assert.equal((await h.api(`/api/admin/trades/${t.id}/review`, { method: 'POST', token, body: { decision: 'release' } })).status, 403);
  assert.equal((await h.api(`/api/admin/trades/${t.id}/review`, { method: 'POST', token: admin, body: { decision: 'reject' } })).json.error.code, 'note_required');
  const rel = await h.api(`/api/admin/trades/${t.id}/review`, { method: 'POST', token: admin, body: { decision: 'release', note: 'Source of funds checked' } });
  assert.equal(rel.json.result, 'paid_out');
  assert.equal((await h.api(`/api/admin/trades/${t.id}/review`, { method: 'POST', token: admin, body: { decision: 'release' } })).status, 409, 'cannot release twice');

  // Reject path.
  const t2 = (await h.trade(token, bank)).json;
  await h.deposit(token, t2.id);
  const rej = await h.api(`/api/admin/trades/${t2.id}/review`, { method: 'POST', token: admin, body: { decision: 'reject', note: 'Could not verify the source of funds' } });
  assert.equal(rej.json.result, 'review_rejected');
  assert.equal((await h.api(`/api/trades/${t2.id}`, { token })).json.status, 'review_rejected');
  assert.ok(h.app.mailer.outbox.some((m) => m.to === 'big@example.com' && /could not complete/i.test(m.subject)));

  // An admin cannot decide on their own trade.
  const adminBank = await h.bank(admin);
  const own = (await h.trade(admin, adminBank)).json;
  await h.deposit(admin, own.id);
  assert.equal((await h.api(`/api/admin/trades/${own.id}/review`, { method: 'POST', token: admin, body: { decision: 'release' } })).json.error.code, 'self_review');
  h.close();
});

test('unverified accounts cannot get a large payout released without review', async () => {
  const h = await boot({ kycBeforeFirstTrade: false, maxTradeKoboUnverified: 20000000 });
  const token = await h.user('unv@example.com');
  const bank = await h.bank(token);
  const t = (await h.trade(token, bank)).json;
  // The deposit is bigger than the quote (customer sent more), which pushes the payout over the limit.
  const dep = (await h.api(`/api/sandbox/trades/${t.id}/deposit`, { method: 'POST', token, body: { amount: '200' } })).json;
  assert.equal(dep.result, 'held_for_review');
  h.close();
});

test('audit log: every status change with a timestamp, admin only, append-only', async () => {
  const h = await boot({ kycBeforeFirstTrade: false });
  const admin = await h.user('admin@example.com');
  const token = await h.user('audit@example.com');
  const bank = await h.bank(token);
  const t = (await h.trade(token, bank)).json;
  await h.deposit(token, t.id);

  assert.equal((await h.api('/api/admin/audit', { token })).status, 403);
  const log = (await h.api(`/api/admin/audit?trade_id=${t.id}`, { token: admin })).json;
  const types = log.map((e) => e.type).reverse();
  for (const needed of ['trade_created', 'deposit_address_generated', 'deposit_seen', 'deposit_confirmed', 'payout_sent']) {
    assert.ok(types.includes(needed), `audit log has ${needed}`);
  }
  assert.ok(types.indexOf('trade_created') < types.indexOf('deposit_address_generated'));
  assert.ok(types.indexOf('deposit_seen') < types.indexOf('payout_sent'));
  const steps = log.filter((e) => e.type === 'status_changed').map((e) => `${e.detail.from}>${e.detail.to}`).reverse();
  assert.deepEqual(steps, ['null>awaiting_deposit', 'awaiting_deposit>paying_out', 'paying_out>paid_out']);
  assert.ok(log.every((e) => !Number.isNaN(Date.parse(e.at))), 'every entry has a timestamp');
  assert.throws(() => h.app.db.prepare("UPDATE events SET type = 'x'").run(), /append-only/);
  assert.throws(() => h.app.db.prepare('DELETE FROM events').run(), /append-only/);
  h.close();
});

test('AML: many trades in a short time pause the account and flag it', async () => {
  const h = await boot({ kycBeforeFirstTrade: false, amlMaxTrades10Min: 3 });
  const admin = await h.user('admin@example.com');
  const token = await h.user('fast@example.com');
  const bank = await h.bank(token);
  for (let i = 0; i < 3; i++) assert.equal((await h.trade(token, bank)).status, 201);
  const paused = await h.trade(token, bank);
  assert.equal(paused.status, 403);
  assert.equal(paused.json.error.code, 'account_review');
  assert.equal((await h.api('/api/me', { token })).json.paused, true);

  const flags = (await h.api('/api/admin/flags', { token: admin })).json;
  assert.equal(flags.length, 1);
  assert.match(flags[0].flag_reason, /within 10 minutes/);
  assert.ok(h.app.mailer.outbox.some((m) => /flagged/i.test(m.subject)));

  // A flagged account's in-flight trade is held, not paid.
  const open = h.app.db.prepare("SELECT id FROM trades WHERE status = 'awaiting_deposit' LIMIT 1").get();
  assert.equal((await h.deposit(token, open.id)).result, 'held_for_review');

  const uid = flags[0].id;
  assert.equal((await h.api(`/api/admin/users/${uid}/flag`, { method: 'POST', token: admin, body: { action: 'clear' } })).json.error.code, 'note_required');
  assert.equal((await h.api(`/api/admin/users/${uid}/flag`, { method: 'POST', token: admin, body: { action: 'clear', note: 'Customer confirmed by phone' } })).status, 200);
  h.app.db.prepare("UPDATE trades SET created_at = created_at - 3600000").run(); // the 10-minute window has passed
  assert.equal((await h.trade(token, bank)).status, 201);
  assert.ok(h.app.db.prepare("SELECT 1 FROM events WHERE type = 'flag_cleared'").get());
  h.close();
});

test('AML: the same bank account on two customer accounts flags both', async () => {
  const h = await boot({ kycBeforeFirstTrade: false });
  const a = await h.user('sharea@example.com');
  const b = await h.user('shareb@example.com');
  const bankA = await h.bank(a, '4000000001');
  const second = await h.api('/api/bank-accounts', { method: 'POST', token: b, body: { bank_code: '058', account_number: '4000000001' } });
  assert.equal(second.status, 201);
  assert.equal(second.json.paused, true);
  assert.equal((await h.trade(a, bankA)).json.error.code, 'account_review');
  assert.equal((await h.trade(b, second.json.id)).json.error.code, 'account_review');
  assert.ok(h.app.db.prepare("SELECT 1 FROM events WHERE type = 'shared_bank_account'").get());
  // The customer is never told which other account matched.
  assert.ok(!JSON.stringify(second.json).includes('shareA'));
  h.close();
});

test('CAPTCHA is checked on sign-up, login, forgot-password and trade creation', async () => {
  const calls = [];
  const fakeFetch = async (url, init) => {
    const form = new URLSearchParams(init.body);
    calls.push({ url, secret: form.get('secret'), response: form.get('response') });
    if (form.get('response') === 'network-down-token') throw new Error('offline');
    return { json: async () => ({ success: form.get('response') === 'good-token-12345' }) };
  };
  const h = await boot({ kycBeforeFirstTrade: false, turnstileSiteKey: 'site', turnstileSecret: 'secret-key' }, { fetch: fakeFetch });
  const body = { email: 'bot@example.com', password: 'a-long-password' };
  assert.equal((await h.api('/api/auth/signup', { method: 'POST', body })).json.error.code, 'captcha_failed');
  assert.equal((await h.api('/api/auth/signup', { method: 'POST', body: { ...body, captcha_token: 'bad-token-123456' } })).json.error.code, 'captcha_failed');
  assert.equal((await h.api('/api/auth/signup', { method: 'POST', body: { ...body, captcha_token: 'network-down-token' } })).status, 503, 'fails closed');
  const ok = await h.api('/api/auth/signup', { method: 'POST', body: { ...body, captcha_token: 'good-token-12345' } });
  assert.equal(ok.status, 201);
  assert.equal(calls.at(-1).url, 'https://challenges.cloudflare.com/turnstile/v0/siteverify');
  assert.equal(calls.at(-1).secret, 'secret-key');

  assert.equal((await h.api('/api/auth/login', { method: 'POST', body })).json.error.code, 'captcha_failed');
  assert.equal((await h.api('/api/auth/login', { method: 'POST', body: { ...body, captcha_token: 'good-token-12345' } })).status, 200);
  assert.equal((await h.api('/api/auth/forgot-password', { method: 'POST', body: { email: body.email } })).json.error.code, 'captcha_failed');

  const token = ok.json.token;
  h.app.db.prepare('UPDATE users SET email_verified = 1').run();
  const bank = await h.bank(token);
  const payload = { coin: 'USDT', network: 'TRC20', amount: '100', bank_account_id: bank };
  assert.equal((await h.api('/api/trades', { method: 'POST', token, body: payload })).json.error.code, 'captcha_failed');
  assert.equal((await h.api('/api/trades', { method: 'POST', token, body: { ...payload, captcha_token: 'good-token-12345' } })).status, 201);

  assert.equal((await h.api('/api/site-config')).json.captcha_site_key, 'site');
  const page = await fetch(h.base + '/app.html');
  assert.match(page.headers.get('content-security-policy'), /challenges\.cloudflare\.com/);
  h.close();
});

test('rate limits stop floods of trades and API calls', async () => {
  const h = await boot({ kycBeforeFirstTrade: false, tradeCreatesPerHour: 2 });
  const token = await h.user('flood@example.com');
  const bank = await h.bank(token);
  assert.equal((await h.trade(token, bank)).status, 201);
  assert.equal((await h.trade(token, bank)).status, 201);
  const limited = await h.trade(token, bank);
  assert.equal(limited.status, 429);
  assert.equal(limited.json.error.code, 'rate_limited');
  h.close();

  const g = await boot({ apiPerMinute: 5 });
  const codes = [];
  for (let i = 0; i < 8; i++) codes.push((await g.api('/api/health')).status);
  assert.deepEqual(codes.slice(0, 5), [200, 200, 200, 200, 200]);
  assert.equal(codes[7], 429);
  g.close();
});

test('security.txt names a contact, an expiry and a policy', async () => {
  const h = await boot({ securityEmail: 'security@kobodesk.example' });
  for (const p of ['/.well-known/security.txt', '/security.txt']) {
    const r = await h.api(p);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /text\/plain/);
    assert.match(r.text, /^Contact: mailto:security@kobodesk\.example$/m);
    assert.match(r.text, /^Policy: https:\/\/kobodesk\.example\/security\.html$/m);
    const expires = Date.parse(r.text.match(/^Expires: (.+)$/m)[1]);
    assert.ok(expires > Date.now() && expires < Date.now() + 365 * 24 * 3600 * 1000, 'expires within a year');
  }
  h.close();
  const none = await boot({ supportEmail: '', securityEmail: '' });
  assert.equal((await none.api('/.well-known/security.txt')).status, 404);
  none.close();
});

test('admin pages need two-factor sign-in when it is required', async () => {
  const h = await boot({ adminRequire2fa: true });
  const admin = await h.user('admin@example.com');
  const blocked = await h.api('/api/admin/overview', { token: admin });
  assert.equal(blocked.status, 403);
  assert.equal(blocked.json.error.code, 'admin_2fa_required');
  assert.equal((await h.api('/api/me', { token: admin })).json.admin_needs_2fa, true);
  const setup = (await h.api('/api/2fa/setup', { method: 'POST', token: admin, body: {} })).json;
  assert.equal((await h.api('/api/2fa/enable', { method: 'POST', token: admin, body: { code: codeAt(setup.secret, Date.now()) } })).status, 200);
  assert.equal((await h.api('/api/admin/overview', { token: admin })).status, 200);
  h.close();
});

test('deletion requests are recorded, emailed and closed with a note', async () => {
  const h = await boot({ kycBeforeFirstTrade: false });
  const admin = await h.user('admin@example.com');
  const token = await h.user('leave@example.com');
  assert.equal((await h.api('/api/account/deletion-request', { method: 'POST', token, body: {} })).status, 200);
  assert.equal((await h.api('/api/account/deletion-request', { method: 'POST', token, body: {} })).status, 200);
  const open = (await h.api('/api/admin/deletion-requests', { token: admin })).json;
  assert.equal(open.length, 1, 'asking twice does not create two requests');
  assert.ok(h.app.mailer.outbox.some((m) => m.to === 'leave@example.com' && /deletion request/i.test(m.subject)));
  assert.equal((await h.api(`/api/admin/deletion-requests/${open[0].id}/close`, { method: 'POST', token: admin, body: {} })).json.error.code, 'note_required');
  assert.equal((await h.api(`/api/admin/deletion-requests/${open[0].id}/close`, { method: 'POST', token: admin, body: { note: 'Deleted profile; kept trade records for the legal retention period.' } })).status, 200);
  assert.equal((await h.api('/api/admin/deletion-requests', { token: admin })).json.length, 0);
  h.close();
});

test('live mode refuses to start without bot protection', () => {
  const good = {
    mode: 'live', ratesSource: 'live', companyName: 'Kobodesk Ltd', supportEmail: 'help@kobodesk.example', supportHours: '8am to 8pm',
    payoutTime: '5 minutes', adminEmails: ['ops@kobodesk.example'], tokenSecret: 'a'.repeat(32), webhookSecret: 'b'.repeat(32), dataKey: 'c'.repeat(32),
    publicUrl: 'https://kobodesk.example', mailProvider: 'resend', mailApiKey: 'k', mailFrom: 'Kobodesk <no-reply@kobodesk.example>',
    turnstileSiteKey: 's', turnstileSecret: 't',
  };
  const ok = loadConfig(good);
  assert.equal(ok.adminRequire2fa, true, 'admins need two-factor sign-in in live mode');
  assert.throws(() => loadConfig({ ...good, turnstileSecret: '' }), /TURNSTILE/);
});
