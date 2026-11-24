import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { loadConfig } from '../src/config.js';
import { createApp } from '../src/server.js';
import { getSellRates, resetRateCache } from '../src/rates.js';
import { alertStuck } from '../src/ops.js';

let app, base, config;

before(async () => {
  config = loadConfig({
    mode: 'sandbox', dbPath: ':memory:', adminEmails: ['admin@example.com'], authAttemptsPer15Min: 100000, quiet: true, kycBeforeFirstTrade: false, amlMaxTrades10Min: 100000, tradeCreatesPerHour: 100000, dailyLimitKoboUnverified: 10**13, dailyLimitKoboVerified: 10**13, reviewThresholdKobo: 10**13, kycRequireDocument: false, apiPerMinute: 100000,
    publicUrl: 'https://kobodesk.example', companyName: 'Kobodesk Ltd', supportEmail: 'help@kobodesk.example',
    rcNumber: 'RC1234567', supportHours: '8am to 8pm', payoutTime: '5 minutes',
  });
  app = createApp(config);
  await new Promise((r) => app.server.listen(0, r));
  base = `http://localhost:${app.server.address().port}`;
});
after(() => app.server.close());

async function api(path, { method = 'GET', body, token } = {}) {
  const res = await fetch(base + path, {
    method, body: body === undefined ? undefined : JSON.stringify(body),
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(token ? { authorization: `Bearer ${token}` } : {}) },
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, json, headers: res.headers };
}
async function newUser(email, extra = {}) {
  const r = await api('/api/auth/signup', { method: 'POST', body: { email, password: 'a-long-password', ...extra } });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  app.db.prepare('UPDATE users SET email_verified = 1 WHERE email = ?').run(email);
  return r.json.token;
}
let acct = 2000000000;
async function bank(token, number = String(++acct)) {
  return (await api('/api/bank-accounts', { method: 'POST', token, body: { bank_code: '058', account_number: number } })).json.id;
}
async function paidTrade(token, bankId, amount = '100') {
  const t = (await api('/api/trades', { method: 'POST', token, body: { coin: 'USDT', network: 'TRC20', amount, bank_account_id: bankId } })).json;
  const dep = await api(`/api/sandbox/trades/${t.id}/deposit`, { method: 'POST', token, body: {} });
  return dep.json.trade;
}
const mailTo = (to) => app.mailer.outbox.filter((m) => m.to === to);

// A fake price feed shaped like CoinGecko's.
function priceServer(prices) {
  let hits = 0;
  const server = http.createServer((req, res) => {
    hits++;
    if (prices === 'error') { res.writeHead(500); return res.end('no'); }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(prices));
  });
  return new Promise((r) => server.listen(0, () => r({ server, url: `http://localhost:${server.address().port}/simple/price`, hits: () => hits })));
}
const FEED = { tether: { ngn: 1480.5 }, bitcoin: { ngn: 150000000 }, ethereum: { ngn: 5200000 }, solana: { ngn: 260000 } };

test('live rates: reads the feed, applies the spread, caches, and rejects bad data', async () => {
  resetRateCache();
  const feed = await priceServer(FEED);
  try {
    const cfg = { ...config, ratesSource: 'live', ratesUrl: feed.url };
    const rates = await getSellRates(cfg);
    assert.equal(rates.USDT, Math.floor((148050 * 9850) / 10000)); // 1,480.50 naira in kobo, minus 1.5%
    await getSellRates(cfg);
    assert.equal(feed.hits(), 1, 'second call should come from the cache');
  } finally { feed.server.close(); }

  resetRateCache();
  const bad = await priceServer({ ...FEED, tether: { ngn: -5 } });
  try {
    await assert.rejects(getSellRates({ ...config, ratesSource: 'live', ratesUrl: bad.url }), (e) => e.status === 503 && e.code === 'rates_unavailable');
  } finally { bad.server.close(); }

  resetRateCache();
  const down = await priceServer('error');
  try {
    await assert.rejects(getSellRates({ ...config, ratesSource: 'live', ratesUrl: down.url }), (e) => e.status === 503);
  } finally { down.server.close(); }
});

test('live rates: a sudden 3x jump is rejected and the last good price is used', async () => {
  resetRateCache();
  let prices = FEED;
  const server = http.createServer((req, res) => { res.writeHead(200); res.end(JSON.stringify(prices)); });
  await new Promise((r) => server.listen(0, r));
  const cfg = { ...config, ratesSource: 'live', ratesUrl: `http://localhost:${server.address().port}/p` };
  try {
    const first = await getSellRates(cfg);
    // Pretend the 30-second cache has just run out, so the next call asks the feed again.
    const realNow = Date.now;
    Date.now = () => realNow() + 31000;
    try {
      prices = { ...FEED, bitcoin: { ngn: 450000000 } };
      const second = await getSellRates(cfg);
      assert.equal(second.BTC, first.BTC, 'the suspicious price is ignored and the last good one is kept');
    } finally { Date.now = realNow; }
  } finally { server.close(); }
});

test('company settings are public and fill the pages', async () => {
  const c = (await api('/api/site-config')).json;
  assert.equal(c.company_name, 'Kobodesk Ltd');
  assert.equal(c.payout_time, '5 minutes');
  const html = (await api('/')).json;
  assert.ok(html.includes('https://kobodesk.example/og.png'));
  assert.ok(!html.includes('%PUBLIC_URL%'));
  const robots = (await api('/robots.txt')).json;
  assert.match(robots, /Disallow: \/api\//);
  assert.match(robots, /Sitemap: https:\/\/kobodesk\.example\/sitemap\.xml/);
  assert.match((await api('/sitemap.xml')).json, /<loc>https:\/\/kobodesk\.example\/<\/loc>/);
  const manifest = await api('/manifest.webmanifest');
  assert.equal(manifest.status, 200);
  assert.match(manifest.headers.get('content-type'), /manifest\+json/);
  assert.equal((await fetch(base + '/sw.js')).status, 200);
  assert.equal((await fetch(base + '/icon-512.png')).status, 200);
  assert.equal((await fetch(base + '/og.png')).status, 200);
  assert.equal((await fetch(base + '/%E0%A4%A')).status, 404);
});

test('analytics is off by default and only added when configured', async () => {
  assert.ok(!(await api('/')).json.includes('plausible'));
  const a2 = createApp(loadConfig({ mode: 'sandbox', dbPath: ':memory:', quiet: true, analyticsDomain: 'kobodesk.example' }));
  await new Promise((r) => a2.server.listen(0, r));
  try {
    const res = await fetch(`http://localhost:${a2.server.address().port}/`);
    assert.ok((await res.text()).includes('data-domain="kobodesk.example"'));
    assert.match(res.headers.get('content-security-policy'), /plausible\.io/);
  } finally { a2.server.close(); }
  assert.throws(() => loadConfig({ mode: 'sandbox', analyticsDomain: 'bad"><script>' }), /ANALYTICS_DOMAIN/);
});

test('emails: customer is told when the deposit lands and when they are paid', async () => {
  const token = await newUser('mail1@example.com');
  const b = await bank(token);
  const t = (await api('/api/trades', { method: 'POST', token, body: { coin: 'USDT', network: 'TRC20', amount: '100', bank_account_id: b } })).json;
  await api(`/api/sandbox/trades/${t.id}/deposit`, { method: 'POST', token, body: { confirmations: 3, tx_hash: 'e-1' } });
  await api(`/api/sandbox/trades/${t.id}/deposit`, { method: 'POST', token, body: { confirmations: 4, tx_hash: 'e-1' } });
  await api(`/api/sandbox/trades/${t.id}/deposit`, { method: 'POST', token, body: { tx_hash: 'e-1' } });
  const subjects = mailTo('mail1@example.com').map((m) => m.subject);
  assert.equal(subjects.filter((s) => s.includes('received your USDT deposit')).length, 1, 'only one "received" email');
  assert.equal(subjects.filter((s) => s.startsWith('Paid: ')).length, 1);
  assert.ok(subjects.some((s) => s.includes('147,750.00')));
});

test('emails: a failed payout warns the customer and the admins, and stuck alerts fire once', async () => {
  const token = await newUser('mail2@example.com');
  const b = await bank(token, '0123459999'); // sandbox: this account fails to pay
  const t = await paidTrade(token, b, '50');
  assert.equal(t.status, 'payout_failed');
  assert.ok(mailTo('mail2@example.com').some((m) => m.subject.startsWith('Action needed')));
  assert.ok(mailTo('admin@example.com').some((m) => m.subject === `Payout failed: ${t.id}`));

  const before = mailTo('admin@example.com').length;
  assert.ok((await alertStuck({ db: app.db, config, notifier: app.notifier })) >= 1);
  assert.equal(mailTo('admin@example.com').length, before + 1);
  assert.equal(await alertStuck({ db: app.db, config, notifier: app.notifier }), 0, 'reported only once');

  // A trade stuck in paying_out is reported after the wait time, not before.
  const t2 = (await api('/api/trades', { method: 'POST', token, body: { coin: 'USDT', network: 'TRC20', amount: '60', bank_account_id: b } })).json;
  app.db.prepare("UPDATE trades SET status = 'paying_out', updated_at = ? WHERE id = ?").run(Date.now(), t2.id);
  assert.equal(await alertStuck({ db: app.db, config, notifier: app.notifier }), 0);
  assert.equal(await alertStuck({ db: app.db, config, notifier: app.notifier }, Date.now() + 11 * 60000), 1);
});

test('receipts: paid trades only, owner only, with the real rate', async () => {
  const token = await newUser('rcpt@example.com');
  const other = await newUser('rcpt2@example.com');
  const b = await bank(token, '3333336789');
  const open = (await api('/api/trades', { method: 'POST', token, body: { coin: 'USDT', network: 'TRC20', amount: '10', bank_account_id: b } })).json;
  assert.equal((await api(`/api/trades/${open.id}/receipt`, { token })).status, 409);
  const paid = await paidTrade(token, b);
  const r = await api(`/api/trades/${paid.id}/receipt`, { token });
  assert.equal(r.status, 200);
  assert.equal(r.json.payout_naira, '147,750.00');
  assert.equal(r.json.rate_naira, '1,477.50');
  assert.equal(r.json.account_last4, '6789');
  assert.match(r.json.receipt_no, /^KD-/);
  assert.equal(r.json.company_name, 'Kobodesk Ltd');
  assert.equal((await api(`/api/trades/${paid.id}/receipt`, { token: other })).status, 404);
});

test('referrals count sign-ups and customers who got paid', async () => {
  const a = await newUser('ref-a@example.com');
  const info = (await api('/api/referrals', { token: a })).json;
  assert.match(info.code, /^[0-9A-F]{10}$/);
  assert.equal(info.link, `https://kobodesk.example/app.html?ref=${info.code}#/signup`);
  const b = await newUser('ref-b@example.com', { ref: info.code.toLowerCase() });
  await newUser('ref-c@example.com', { ref: 'NOTACODE00' }); // unknown code is ignored, sign-up still works
  assert.equal((await api('/api/referrals', { token: a })).json.signups, 1);
  assert.equal((await api('/api/referrals', { token: a })).json.paid_trades, 0);
  await paidTrade(b, await bank(b));
  assert.equal((await api('/api/referrals', { token: a })).json.paid_trades, 1);
});

test('identity check: validation, encrypted storage, admin review, and higher limits', async () => {
  const token = await newUser('kyc@example.com');
  const adminToken = await newUser('admin@example.com');
  const good = { full_name: 'Ada Lovelace Obi', dob: '1994-03-21', id_type: 'BVN', id_number: '22123456789', address: '12 Admiralty Way, Lekki, Lagos' };
  const post = (over) => api('/api/kyc', { method: 'POST', token, body: { ...good, ...over } });

  assert.equal((await post({ full_name: 'Ada' })).json.error.code, 'bad_name');
  assert.equal((await post({ dob: '1994-02-31' })).json.error.code, 'bad_dob');
  assert.equal((await post({ dob: '2015-01-01' })).json.error.code, 'bad_age');
  assert.equal((await post({ id_type: 'PASSPORT' })).json.error.code, 'bad_id_type');
  assert.equal((await post({ id_number: '123' })).json.error.code, 'bad_id_number');
  assert.equal((await post({ address: 'Lagos' })).json.error.code, 'bad_address');

  // Over the unverified limit (default 500,000 naira): 400 USDT is about 590,000.
  const b = await bank(token);
  const big = { coin: 'USDT', network: 'TRC20', amount: '400', bank_account_id: b };
  assert.equal((await api('/api/trades', { method: 'POST', token, body: big })).json.error.code, 'above_limit');

  assert.equal((await post({})).json.status, 'pending');
  assert.equal((await post({})).status, 409);
  const raw = app.db.prepare('SELECT * FROM kyc_submissions').all().find((r) => r.id_last4 === '6789');
  assert.ok(!raw.id_number_enc.includes('22123456789'), 'ID number must not be stored in plain text');
  assert.equal((await api('/api/kyc', { token })).json.status, 'pending');

  // Only admins can review.
  assert.equal((await api('/api/admin/kyc', { token })).status, 403);
  const list = (await api('/api/admin/kyc', { token: adminToken })).json;
  const row = list.find((r) => r.email === 'kyc@example.com');
  assert.equal(row.id_last4, '6789');
  assert.ok(!JSON.stringify(list).includes('22123456789'), 'the list shows only the last 4 digits');
  const detail = (await api(`/api/admin/kyc/${row.user_id}`, { token: adminToken })).json;
  assert.equal(detail.id_number, '22123456789');
  assert.ok(app.db.prepare("SELECT 1 FROM events WHERE type = 'kyc_viewed'").get(), 'viewing details is logged');

  // Rejecting needs a reason, and the customer can try again.
  const decide = (status, note) => api(`/api/admin/kyc/${row.user_id}/decision`, { method: 'POST', token: adminToken, body: { status, note } });
  assert.equal((await decide('rejected', '')).json.error.code, 'note_required');
  assert.equal((await decide('rejected', 'Name does not match BVN')).status, 200);
  assert.ok(mailTo('kyc@example.com').some((m) => m.text.includes('Name does not match BVN')));
  assert.equal((await post({ full_name: 'Ada Lovelace Obi' })).json.status, 'pending');

  assert.equal((await decide('verified')).status, 200);
  assert.equal((await api('/api/me', { token })).json.kyc_status, 'verified');
  assert.ok(mailTo('kyc@example.com').some((m) => m.subject === 'Your identity is verified'));
  assert.equal((await api('/api/trades', { method: 'POST', token, body: big })).status, 201, 'verified customers get the higher limit');
  assert.equal((await post({})).json.error.code, 'already_verified');
});

test('admin overview needs an admin and counts trades', async () => {
  const token = await newUser('plain@example.com');
  assert.equal((await api('/api/admin/overview', { token })).status, 403);
  const adminToken = (await api('/api/auth/login', { method: 'POST', body: { email: 'admin@example.com', password: 'a-long-password' } })).json.token;
  const o = (await api('/api/admin/overview', { token: adminToken })).json;
  assert.ok(o.users >= 5);
  assert.ok(o.trades_by_status.paid_out >= 1);
  assert.match(o.paid_out_naira, /^[\d,]+\.\d{2}$/);
  const me = (await api('/api/me', { token: adminToken })).json;
  assert.equal(me.is_admin, true);
});
