import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import { createApp } from '../src/server.js';
import { signWebhook } from '../src/auth.js';
import { parseAmount, formatAmount, toKobo, formatNaira } from '../src/money.js';

let app, base, config;

before(async () => {
  config = loadConfig({ mode: 'sandbox', dbPath: ':memory:', adminEmails: ['admin@example.com'], authAttemptsPer15Min: 1000, quiet: true });
  app = createApp(config);
  await new Promise((r) => app.server.listen(0, r));
  base = `http://localhost:${app.server.address().port}`;
});
after(() => app.server.close());

async function api(path, { method = 'GET', body, token, headers = {} } = {}) {
  const raw = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
  const res = await fetch(base + path, {
    method,
    body: raw,
    headers: { ...(raw ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
  });
  return { status: res.status, json: await res.json() };
}

async function newUser(email, password = 'a-long-password') {
  const r = await api('/api/auth/signup', { method: 'POST', body: { email, password } });
  assert.equal(r.status, 201);
  // These tests are about trading, so skip the email step. test/security.test.js covers it.
  app.db.prepare('UPDATE users SET email_verified = 1 WHERE email = ?').run(email);
  return r.json.token;
}

async function addBank(token, number = '0123456789') {
  const r = await api('/api/bank-accounts', { method: 'POST', token, body: { bank_code: '058', account_number: number } });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  return r.json.id;
}

test('money helpers use exact integer math', () => {
  assert.equal(parseAmount('0.1'), 10000000);
  assert.equal(parseAmount('1.123456789'), null);
  assert.equal(parseAmount('-1'), null);
  assert.equal(parseAmount('abc'), null);
  assert.equal(formatAmount(150000000), '1.5');
  assert.equal(toKobo(parseAmount('100'), 147750), 14775000); // 100 USDT at 1,477.50 naira
  assert.equal(formatNaira(14775000), '147,750.00');
});

test('sign up, log in, and reject bad credentials', async () => {
  await newUser('ada@example.com');
  const bad = await api('/api/auth/login', { method: 'POST', body: { email: 'ada@example.com', password: 'wrong-password' } });
  assert.equal(bad.status, 401);
  const good = await api('/api/auth/login', { method: 'POST', body: { email: 'ada@example.com', password: 'a-long-password' } });
  assert.equal(good.status, 200);
  const me = await api('/api/me', { token: good.json.token });
  assert.equal(me.json.email, 'ada@example.com');
  assert.equal((await api('/api/me')).status, 401);
  assert.equal((await api('/api/auth/signup', { method: 'POST', body: { email: 'ada@example.com', password: 'a-long-password' } })).status, 409);
  assert.equal((await api('/api/auth/signup', { method: 'POST', body: { email: 'x@example.com', password: 'short' } })).status, 400);
});

test('bank account validation', async () => {
  const token = await newUser('bank@example.com');
  const bad = await api('/api/bank-accounts', { method: 'POST', token, body: { bank_code: '058', account_number: '123' } });
  assert.equal(bad.status, 400);
  const missing = await api('/api/bank-accounts', { method: 'POST', token, body: { bank_code: '058', account_number: '1234560000' } });
  assert.equal(missing.status, 422);
  await addBank(token);
  const dup = await api('/api/bank-accounts', { method: 'POST', token, body: { bank_code: '058', account_number: '0123456789' } });
  assert.equal(dup.status, 409);
});

test('full trade: quote, deposit, payout, and no double payout', async () => {
  const token = await newUser('trade@example.com');
  const bank = await addBank(token);

  const created = await api('/api/trades', { method: 'POST', token, body: { coin: 'USDT', network: 'TRC20', amount: '100', bank_account_id: bank } });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const trade = created.json;
  assert.equal(trade.status, 'awaiting_deposit');
  assert.match(trade.deposit_address, /^SANDBOX-USDT-TRC20-/);
  // 1,500 naira mid, 1.5% spread -> 1,477.50 per USDT -> 147,750.00 for 100
  assert.equal(trade.quote_kobo, 14775000);

  // Forged webhook is rejected.
  const event = { address: trade.deposit_address, coin: 'USDT', network: 'TRC20', amount: '100', confirmations: 5, tx_hash: 'tx-1' };
  const forged = await api('/api/webhooks/crypto', { method: 'POST', body: event, headers: { 'x-signature': 'a'.repeat(64) } });
  assert.equal(forged.status, 401);

  // Signed webhook with too few confirmations -> confirming.
  const send = (e) => {
    const raw = JSON.stringify(e);
    return api('/api/webhooks/crypto', { method: 'POST', body: raw, headers: { 'x-signature': signWebhook(raw, config.webhookSecret) } });
  };
  const first = await send(event);
  assert.equal(first.json.result, 'confirming');
  assert.equal((await api(`/api/trades/${trade.id}`, { token })).json.status, 'confirming');

  // Enough confirmations -> paid out.
  const second = await send({ ...event, confirmations: 25 });
  assert.equal(second.json.result, 'paid_out');
  const after = (await api(`/api/trades/${trade.id}`, { token })).json;
  assert.equal(after.status, 'paid_out');
  assert.equal(after.payout_kobo, 14775000);

  // Same event again does nothing.
  const replay = await send({ ...event, confirmations: 30 });
  assert.match(replay.json.result, /^already_/);
  assert.equal(app.providers.payout._paid.size, 1);
});

test('rejects wrong network, tiny amounts, other people\'s accounts, and over-limit trades', async () => {
  const token = await newUser('limits@example.com');
  const bank = await addBank(token);
  const other = await newUser('other@example.com');
  const otherBank = await addBank(other, '0999999991');

  const wrongNet = await api('/api/trades', { method: 'POST', token, body: { coin: 'BTC', network: 'TRC20', amount: '1', bank_account_id: bank } });
  assert.equal(wrongNet.json.error.code, 'bad_network');
  const tiny = await api('/api/trades', { method: 'POST', token, body: { coin: 'USDT', network: 'TRC20', amount: '0.1', bank_account_id: bank } });
  assert.equal(tiny.json.error.code, 'below_minimum');
  const theirs = await api('/api/trades', { method: 'POST', token, body: { coin: 'USDT', network: 'TRC20', amount: '100', bank_account_id: otherBank } });
  assert.equal(theirs.json.error.code, 'bad_bank_account');
  const big = await api('/api/trades', { method: 'POST', token, body: { coin: 'USDT', network: 'TRC20', amount: '1000000', bank_account_id: bank } });
  assert.equal(big.json.error.code, 'above_limit');
});

test('failed payout can be retried by an admin, and pays exactly once', async () => {
  const token = await newUser('fail@example.com');
  const bank = await addBank(token, '0123459999'); // sandbox: transfers to this account fail
  const t = (await api('/api/trades', { method: 'POST', token, body: { coin: 'USDT', network: 'ERC20', amount: '50', bank_account_id: bank } })).json;
  const dep = await api(`/api/sandbox/trades/${t.id}/deposit`, { method: 'POST', token, body: {} });
  assert.equal(dep.json.trade.status, 'payout_failed');

  // Not an admin yet.
  assert.equal((await api(`/api/admin/trades/${t.id}/retry-payout`, { method: 'POST', token })).status, 403);

  const adminToken = await newUser('admin@example.com');
  // Fix the account the way an operator would after contacting the customer.
  app.db.prepare("UPDATE bank_accounts SET account_number = '0123450001' WHERE id = ?").run(bank);
  const retry = await api(`/api/admin/trades/${t.id}/retry-payout`, { method: 'POST', token: adminToken });
  assert.equal(retry.json.result, 'paid_out');
  const again = await api(`/api/admin/trades/${t.id}/retry-payout`, { method: 'POST', token: adminToken });
  assert.equal(again.status, 409);
});

test('a late deposit is paid at the current rate, not the locked one', async () => {
  const token = await newUser('late@example.com');
  const bank = await addBank(token);
  const t = (await api('/api/trades', { method: 'POST', token, body: { coin: 'USDT', network: 'TRC20', amount: '100', bank_account_id: bank } })).json;
  app.db.prepare('UPDATE trades SET expires_at = ? WHERE id = ?').run(Date.now() - 1000, t.id);
  assert.equal((await api(`/api/trades/${t.id}`, { token })).json.status, 'expired');
  const dep = await api(`/api/sandbox/trades/${t.id}/deposit`, { method: 'POST', token, body: {} });
  assert.equal(dep.json.trade.status, 'paid_out');
});

test('rates and assets are public; bad JSON is a clean 400', async () => {
  assert.equal((await api('/api/rates')).json.rates.length, 4);
  assert.equal((await api('/api/assets')).json.length, 4);
  const bad = await api('/api/auth/login', { method: 'POST', body: '{not json' });
  assert.equal(bad.status, 400);
});

test('live mode refuses to start on fake providers', () => {
  const live = loadConfig({
    mode: 'live', ratesSource: 'live', companyName: 'Kobodesk Ltd', supportEmail: 'help@kobodesk.example', supportHours: '8am to 8pm', payoutTime: '5 minutes', adminEmails: ['ops@kobodesk.example'], tokenSecret: 'x'.repeat(32), webhookSecret: 'y'.repeat(32), dataKey: 'z'.repeat(32),
    publicUrl: 'https://kobodesk.example', mailProvider: 'resend', mailApiKey: 'k', mailFrom: 'no-reply@kobodesk.example',
  });
  assert.throws(() => createApp(live, { db: app.db }), /No live providers/);
});
