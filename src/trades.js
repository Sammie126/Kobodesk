import crypto from 'node:crypto';
import { ASSETS } from './config.js';
import { tx, logEvent } from './db.js';
import { parseAmount, formatAmount, toKobo, formatNaira } from './money.js';
import { getSellRates } from './rates.js';

export class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// Trade life cycle:
//   awaiting_deposit -> confirming -> paying_out -> paid_out
//   awaiting_deposit -> expired            (no deposit before the quote ran out)
//   paying_out -> payout_failed            (retry from the admin route)
// A deposit that arrives after expiry is still paid, at the current rate instead of the locked one.

export function tradeView(t) {
  return {
    id: t.id,
    coin: t.coin,
    network: t.network,
    amount: formatAmount(t.amount_scaled),
    deposit_address: t.deposit_address,
    status: t.status,
    rate_kobo: t.rate_kobo,
    fee_kobo: t.fee_kobo,
    quote_kobo: t.quote_kobo,
    quote_naira: formatNaira(t.quote_kobo),
    received_amount: t.received_scaled == null ? null : formatAmount(t.received_scaled),
    payout_kobo: t.payout_kobo,
    payout_naira: t.payout_kobo == null ? null : formatNaira(t.payout_kobo),
    failure_reason: t.failure_reason,
    expires_at: new Date(t.expires_at).toISOString(),
    created_at: new Date(t.created_at).toISOString(),
  };
}

export function expireStaleTrades(db) {
  return db
    .prepare("UPDATE trades SET status = 'expired', updated_at = ? WHERE status = 'awaiting_deposit' AND expires_at < ?")
    .run(Date.now(), Date.now()).changes;
}

export async function createTrade({ db, config, providers, user, input }) {
  const coin = String(input.coin ?? '').toUpperCase();
  const network = String(input.network ?? '').toUpperCase();
  const asset = ASSETS[coin];
  if (!asset) throw new HttpError(400, 'Unsupported coin.', 'bad_coin');
  if (!asset.networks.includes(network)) {
    throw new HttpError(400, `${coin} can be sent on: ${asset.networks.join(', ')}.`, 'bad_network');
  }
  const scaled = parseAmount(input.amount);
  if (scaled == null) throw new HttpError(400, 'Enter an amount with up to 8 decimal places.', 'bad_amount');

  const account = db
    .prepare('SELECT * FROM bank_accounts WHERE id = ? AND user_id = ?')
    .get(String(input.bank_account_id ?? ''), user.id);
  if (!account) throw new HttpError(400, 'Choose one of your saved bank accounts.', 'bad_bank_account');

  const rates = await getSellRates(config);
  const rate = rates[coin];
  const gross = toKobo(scaled, rate);
  const quote = gross - config.flatFeeKobo;
  if (quote < config.minTradeKobo) {
    throw new HttpError(400, `The minimum trade is ₦${formatNaira(config.minTradeKobo)}.`, 'below_minimum');
  }
  const cap = user.kyc_status === 'verified' ? config.maxTradeKoboVerified : config.maxTradeKoboUnverified;
  if (quote > cap) {
    throw new HttpError(
      400,
      `This trade is above your limit of ₦${formatNaira(cap)}.` +
        (user.kyc_status === 'verified' ? '' : ' Verify your identity to raise it.'),
      'above_limit'
    );
  }

  const id = `trd_${crypto.randomBytes(8).toString('hex')}`;
  const address = await providers.crypto.newDepositAddress({ coin, network, tradeId: id });
  const now = Date.now();
  db.prepare(
    `INSERT INTO trades (id, user_id, bank_account_id, coin, network, amount_scaled, rate_kobo, fee_kobo, quote_kobo,
       deposit_address, status, expires_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'awaiting_deposit', ?, ?, ?)`
  ).run(id, user.id, account.id, coin, network, scaled, rate, config.flatFeeKobo, quote, address,
    now + config.quoteTtlSeconds * 1000, now, now);
  logEvent(db, id, 'trade_created', { coin, network, amount: formatAmount(scaled) });
  return db.prepare('SELECT * FROM trades WHERE id = ?').get(id);
}

// Called when the crypto provider reports a deposit (or the sandbox simulates one).
// Safe to call many times for the same tx_hash: confirmations update, but money moves once.
export async function applyDeposit({ db, config, providers }, event) {
  const required = (trade) => ASSETS[trade.coin]?.requiredConfirmations?.[trade.network] ?? 12;
  const received = parseAmount(event.amount);
  const confirmations = Number.parseInt(event.confirmations, 10);
  const txHash = String(event.tx_hash ?? '');
  if (!received || !Number.isInteger(confirmations) || confirmations < 0 || !txHash) {
    throw new HttpError(400, 'Malformed deposit event.', 'bad_event');
  }

  const trade = db.prepare('SELECT * FROM trades WHERE deposit_address = ?').get(String(event.address ?? ''));
  if (!trade) {
    logEvent(db, null, 'deposit_unknown_address', { address: event.address, tx_hash: txHash });
    return { result: 'ignored_unknown_address' };
  }
  if (String(event.coin).toUpperCase() !== trade.coin || String(event.network).toUpperCase() !== trade.network) {
    // Wrong coin or network sent to this address. Needs a person to look at it.
    logEvent(db, trade.id, 'deposit_coin_mismatch', event);
    return { result: 'ignored_mismatch' };
  }

  const claimed = tx(db, () => {
    const t = db.prepare('SELECT * FROM trades WHERE id = ?').get(trade.id);
    const now = Date.now();
    const seen = db.prepare('SELECT * FROM deposits WHERE tx_hash = ?').get(txHash);
    if (!seen) {
      db.prepare('INSERT INTO deposits (tx_hash, trade_id, amount_scaled, confirmations, first_seen_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(txHash, t.id, received, confirmations, now, now);
    } else if (seen.trade_id === t.id) {
      db.prepare('UPDATE deposits SET confirmations = MAX(confirmations, ?), updated_at = ? WHERE tx_hash = ?')
        .run(confirmations, now, txHash);
    }
    if (!['awaiting_deposit', 'expired', 'confirming'].includes(t.status)) return { done: t.status };

    const dep = db.prepare('SELECT * FROM deposits WHERE tx_hash = ?').get(txHash);
    if (dep.confirmations < required(t)) {
      db.prepare("UPDATE trades SET status = 'confirming', received_scaled = ?, updated_at = ? WHERE id = ?")
        .run(dep.amount_scaled, now, t.id);
      return { waiting: true };
    }
    // Enough confirmations: claim the payout exactly once.
    const claim = db
      .prepare("UPDATE trades SET status = 'paying_out', received_scaled = ?, updated_at = ? WHERE id = ? AND status IN ('awaiting_deposit','expired','confirming')")
      .run(dep.amount_scaled, now, t.id);
    return claim.changes === 1 ? { go: true, deposit: dep, trade: t } : { done: 'already_claimed' };
  });

  if (claimed.done) return { result: `already_${claimed.done}` };
  if (claimed.waiting) return { result: 'confirming' };

  // Price the payout: locked rate if the deposit was first seen before the quote expired.
  const { deposit, trade: t } = claimed;
  let rate = t.rate_kobo;
  if (deposit.first_seen_at > t.expires_at) {
    rate = (await getSellRates(config))[t.coin];
    logEvent(db, t.id, 'repriced_after_expiry', { rate_kobo: rate });
  }
  const payout = toKobo(deposit.amount_scaled, rate) - t.fee_kobo;
  if (payout <= 0) {
    db.prepare("UPDATE trades SET status = 'payout_failed', failure_reason = ?, updated_at = ? WHERE id = ?")
      .run('Deposit too small to pay out after fees.', Date.now(), t.id);
    return { result: 'payout_failed' };
  }
  db.prepare('UPDATE trades SET payout_kobo = ?, updated_at = ? WHERE id = ?').run(payout, Date.now(), t.id);
  return runPayout({ db, providers }, t.id);
}

export async function runPayout({ db, providers }, tradeId) {
  const t = db.prepare('SELECT * FROM trades WHERE id = ?').get(tradeId);
  const account = db.prepare('SELECT * FROM bank_accounts WHERE id = ?').get(t.bank_account_id);
  const reference = `kd_${t.id}`; // same reference on every retry, so the bank never pays twice
  let outcome;
  try {
    outcome = await providers.payout.transfer({
      reference,
      bank_code: account.bank_code,
      account_number: account.account_number,
      account_name: account.account_name,
      amount_kobo: t.payout_kobo,
    });
  } catch (err) {
    outcome = { ok: false, error: `Payout provider error: ${err.message}` };
  }
  if (outcome.ok) {
    db.prepare("UPDATE trades SET status = 'paid_out', payout_ref = ?, failure_reason = NULL, updated_at = ? WHERE id = ?")
      .run(outcome.reference ?? reference, Date.now(), t.id);
    logEvent(db, t.id, 'paid_out', { payout_kobo: t.payout_kobo });
    return { result: 'paid_out' };
  }
  db.prepare("UPDATE trades SET status = 'payout_failed', failure_reason = ?, updated_at = ? WHERE id = ?")
    .run(String(outcome.error ?? 'Payout failed'), Date.now(), t.id);
  logEvent(db, t.id, 'payout_failed', { error: outcome.error });
  return { result: 'payout_failed' };
}

export function retryPayout(ctx, tradeId) {
  const claim = ctx.db
    .prepare("UPDATE trades SET status = 'paying_out', updated_at = ? WHERE id = ? AND status = 'payout_failed' AND payout_kobo IS NOT NULL")
    .run(Date.now(), tradeId);
  if (claim.changes !== 1) throw new HttpError(409, 'Only trades with a failed payout can be retried.', 'not_retryable');
  return runPayout(ctx, tradeId);
}
