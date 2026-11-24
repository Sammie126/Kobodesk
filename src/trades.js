import crypto from 'node:crypto';
import { ASSETS } from './config.js';
import { tx, logEvent } from './db.js';
import { parseAmount, formatAmount, toKobo, formatNaira } from './money.js';
import { getSellRates } from './rates.js';
import { bankView } from './vault.js';
import { limitsFor, usedToday, recentTradeCount, flagUser, holdReason } from './compliance.js';

import { HttpError } from './errors.js';
export { HttpError };

// Trade life cycle:
//   awaiting_deposit -> confirming -> paying_out -> paid_out
//   awaiting_deposit -> expired            (no deposit before the quote ran out)
//   paying_out -> payout_failed            (retry from the admin route)
//   confirming -> held_for_review          (large payout, flagged account: a person decides)
//   held_for_review -> paying_out | review_rejected
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
  const now = Date.now();
  let n = 0;
  for (const { id } of db.prepare("SELECT id FROM trades WHERE status = 'awaiting_deposit' AND expires_at < ?").all(now)) {
    const r = db.prepare("UPDATE trades SET status = 'expired', updated_at = ? WHERE id = ? AND status = 'awaiting_deposit'").run(now, id);
    if (r.changes === 1) { n++; logEvent(db, id, 'status_changed', { from: 'awaiting_deposit', to: 'expired' }); }
  }
  return n;
}

// What an admin sees: the customer's trade plus the internal review reason, which customers never see.
export function adminTradeView(t, email) {
  return { ...tradeView(t), user_id: t.user_id, user_email: email, hold_reason: t.hold_reason, review_note: t.review_note };
}

// Validates coin, network and amount, then prices the trade. Used by both /api/quote and createTrade.
export async function priceTrade(config, input) {
  const coin = String(input.coin ?? '').toUpperCase();
  const network = String(input.network ?? '').toUpperCase();
  const asset = ASSETS[coin];
  if (!asset) throw new HttpError(400, 'Unsupported coin.', 'bad_coin');
  if (!asset.networks.includes(network)) {
    throw new HttpError(400, `${coin} can be sent on: ${asset.networks.join(', ')}.`, 'bad_network');
  }
  const scaled = parseAmount(input.amount);
  if (scaled == null) throw new HttpError(400, 'Enter an amount with up to 8 decimal places.', 'bad_amount');

  const rate = (await getSellRates(config))[coin];
  const quote = toKobo(scaled, rate) - config.flatFeeKobo;
  if (quote < config.minTradeKobo) {
    throw new HttpError(400, `The minimum trade is ₦${formatNaira(config.minTradeKobo)}.`, 'below_minimum');
  }
  return { coin, network, scaled, rate, quote };
}

const ctxFor = (db, notifier) => ({ db, notifier });

export async function createTrade({ db, config, providers, notifier, user, input }) {
  if (!user.email_verified) {
    throw new HttpError(403, 'Verify your email address before you trade. Check your inbox for the link.', 'verify_email');
  }
  if (user.flagged_at) {
    throw new HttpError(403, 'We have paused new trades on your account while we complete a routine safety check. Contact support if you have questions.', 'account_review');
  }
  if (config.kycBeforeFirstTrade && !['pending', 'verified'].includes(user.kyc_status)) {
    throw new HttpError(403, 'Verify your identity before your first trade. It takes a few minutes: go to Settings, then Identity check.', 'kyc_required');
  }
  // Many trades in a short time is a warning sign. Pause the account and let a person look.
  if (recentTradeCount(db, user.id, 10) >= config.amlMaxTrades10Min) {
    flagUser(ctxFor(db, notifier), user.id, `Started ${config.amlMaxTrades10Min} or more trades within 10 minutes.`);
    throw new HttpError(403, 'We have paused new trades on your account while we complete a routine safety check. Contact support if you have questions.', 'account_review');
  }
  const { coin, network, scaled, rate, quote } = await priceTrade(config, input);

  const account = db
    .prepare('SELECT * FROM bank_accounts WHERE id = ? AND user_id = ?')
    .get(String(input.bank_account_id ?? ''), user.id);
  if (!account) throw new HttpError(400, 'Choose one of your saved bank accounts.', 'bad_bank_account');

  const { perTrade: cap, daily } = limitsFor(config, user);
  if (quote > cap) {
    throw new HttpError(
      400,
      `This trade is above your limit of ₦${formatNaira(cap)}.` +
        (user.kyc_status === 'verified' ? '' : ' Get your identity verified to raise it.'),
      'above_limit'
    );
  }
  const used = usedToday(db, user.id);
  if (used + quote > daily) {
    const left = Math.max(0, daily - used);
    throw new HttpError(
      400,
      `This would take you over your daily limit of ₦${formatNaira(daily)}. You have ₦${formatNaira(left)} left in the last 24 hours.` +
        (user.kyc_status === 'verified' ? '' : ' Get your identity verified to raise it.'),
      'above_daily_limit'
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
  logEvent(db, id, 'trade_created', { user: user.id, coin, network, amount: formatAmount(scaled), quote_kobo: quote });
  logEvent(db, id, 'deposit_address_generated', { address, provider: providers.crypto.name ?? 'unknown' });
  logEvent(db, id, 'status_changed', { from: null, to: 'awaiting_deposit' });
  return db.prepare('SELECT * FROM trades WHERE id = ?').get(id);
}

// Called when the crypto provider reports a deposit (or the sandbox simulates one).
// Safe to call many times for the same tx_hash: confirmations update, but money moves once.
export async function applyDeposit({ db, config, providers, notifier }, event) {
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
      logEvent(db, t.id, 'deposit_seen', { tx_hash: txHash, amount: formatAmount(received), confirmations });
    } else if (seen.trade_id === t.id) {
      db.prepare('UPDATE deposits SET confirmations = MAX(confirmations, ?), updated_at = ? WHERE tx_hash = ?')
        .run(confirmations, now, txHash);
      if (confirmations > seen.confirmations) logEvent(db, t.id, 'deposit_confirmations', { tx_hash: txHash, confirmations });
    }
    if (!['awaiting_deposit', 'expired', 'confirming'].includes(t.status)) return { done: t.status };

    const dep = db.prepare('SELECT * FROM deposits WHERE tx_hash = ?').get(txHash);
    if (dep.confirmations < required(t)) {
      db.prepare("UPDATE trades SET status = 'confirming', received_scaled = ?, updated_at = ? WHERE id = ?")
        .run(dep.amount_scaled, now, t.id);
      if (t.status !== 'confirming') logEvent(db, t.id, 'status_changed', { from: t.status, to: 'confirming' });
      return { waiting: true, first: t.status !== 'confirming' };
    }
    // Enough confirmations: claim the payout exactly once.
    const claim = db
      .prepare("UPDATE trades SET status = 'paying_out', received_scaled = ?, updated_at = ? WHERE id = ? AND status IN ('awaiting_deposit','expired','confirming')")
      .run(dep.amount_scaled, now, t.id);
    if (claim.changes === 1) {
      logEvent(db, t.id, 'deposit_confirmed', { tx_hash: txHash, confirmations: dep.confirmations, required: required(t) });
      logEvent(db, t.id, 'status_changed', { from: t.status, to: 'paying_out' });
    }
    return claim.changes === 1 ? { go: true, deposit: dep, trade: t } : { done: 'already_claimed' };
  });

  if (claimed.done) return { result: `already_${claimed.done}` };
  if (claimed.waiting) {
    if (claimed.first) await notifier?.trade(trade.id, 'deposit_seen');
    return { result: 'confirming' };
  }

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
    logEvent(db, t.id, 'status_changed', { from: 'paying_out', to: 'payout_failed', reason: 'too_small' });
    await notifier?.trade(t.id, 'payout_failed');
    return { result: 'payout_failed' };
  }
  db.prepare('UPDATE trades SET payout_kobo = ?, updated_at = ? WHERE id = ?').run(payout, Date.now(), t.id);

  // Large payouts and flagged accounts wait for a person. The deposit is safe; nothing is sent yet.
  const owner = db.prepare('SELECT * FROM users WHERE id = ?').get(t.user_id);
  const reason = holdReason(db, config, owner, payout);
  if (reason) {
    db.prepare("UPDATE trades SET status = 'held_for_review', hold_reason = ?, updated_at = ? WHERE id = ?").run(reason, Date.now(), t.id);
    logEvent(db, t.id, 'payout_held', { reason, payout_kobo: payout });
    logEvent(db, t.id, 'status_changed', { from: 'paying_out', to: 'held_for_review' });
    await notifier?.trade(t.id, 'held');
    return { result: 'held_for_review' };
  }
  return runPayout({ db, config, providers, notifier }, t.id);
}

export async function runPayout({ db, config, providers, notifier }, tradeId) {
  const t = db.prepare('SELECT * FROM trades WHERE id = ?').get(tradeId);
  const account = bankView(db.prepare('SELECT * FROM bank_accounts WHERE id = ?').get(t.bank_account_id), config.dataKey);
  if (account.account_number == null) {
    // The encryption key changed or the data is damaged. Never guess: stop and let a person fix it.
    db.prepare("UPDATE trades SET status = 'payout_failed', failure_reason = ?, updated_at = ? WHERE id = ?")
      .run('Bank details could not be read. Check DATA_ENCRYPTION_KEY.', Date.now(), t.id);
    logEvent(db, t.id, 'payout_failed', { error: 'bank_details_unreadable' });
    await notifier?.trade(t.id, 'payout_failed');
    return { result: 'payout_failed' };
  }
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
    logEvent(db, t.id, 'payout_sent', { payout_kobo: t.payout_kobo, reference: outcome.reference ?? reference });
    logEvent(db, t.id, 'paid_out', { payout_kobo: t.payout_kobo });
    logEvent(db, t.id, 'status_changed', { from: 'paying_out', to: 'paid_out' });
    await notifier?.trade(t.id, 'paid_out');
    return { result: 'paid_out' };
  }
  db.prepare("UPDATE trades SET status = 'payout_failed', failure_reason = ?, updated_at = ? WHERE id = ?")
    .run(String(outcome.error ?? 'Payout failed'), Date.now(), t.id);
  logEvent(db, t.id, 'payout_failed', { error: outcome.error });
  logEvent(db, t.id, 'status_changed', { from: 'paying_out', to: 'payout_failed' });
  await notifier?.trade(t.id, 'payout_failed');
  return { result: 'payout_failed' };
}

export function retryPayout(ctx, tradeId, admin) {
  const claim = ctx.db
    .prepare("UPDATE trades SET status = 'paying_out', updated_at = ? WHERE id = ? AND status = 'payout_failed' AND payout_kobo IS NOT NULL")
    .run(Date.now(), tradeId);
  if (claim.changes !== 1) throw new HttpError(409, 'Only trades with a failed payout can be retried.', 'not_retryable');
  logEvent(ctx.db, tradeId, 'payout_retry', { admin: admin ?? null });
  logEvent(ctx.db, tradeId, 'status_changed', { from: 'payout_failed', to: 'paying_out' });
  return runPayout(ctx, tradeId);
}

// A team member's decision on a held trade. Rejecting never moves crypto back by itself: refund it by hand.
export async function reviewTrade(ctx, tradeId, decision, note, admin) {
  const { db, notifier } = ctx;
  note = String(note ?? '').trim().slice(0, 300);
  if (!['release', 'reject'].includes(decision)) throw new HttpError(400, 'Choose release or reject.', 'bad_decision');
  if (decision === 'reject' && !note) throw new HttpError(400, 'Write a reason for rejecting.', 'note_required');
  if (decision === 'release') {
    const claim = db.prepare("UPDATE trades SET status = 'paying_out', review_note = ?, updated_at = ? WHERE id = ? AND status = 'held_for_review'")
      .run(note || null, Date.now(), tradeId);
    if (claim.changes !== 1) throw new HttpError(409, 'This trade is not waiting for review.', 'not_held');
    logEvent(db, tradeId, 'review_released', { admin, note });
    logEvent(db, tradeId, 'status_changed', { from: 'held_for_review', to: 'paying_out' });
    return runPayout(ctx, tradeId);
  }
  const r = db.prepare("UPDATE trades SET status = 'review_rejected', review_note = ?, failure_reason = ?, updated_at = ? WHERE id = ? AND status = 'held_for_review'")
    .run(note, note, Date.now(), tradeId);
  if (r.changes !== 1) throw new HttpError(409, 'This trade is not waiting for review.', 'not_held');
  logEvent(db, tradeId, 'review_rejected', { admin, note });
  logEvent(db, tradeId, 'status_changed', { from: 'held_for_review', to: 'review_rejected' });
  await notifier?.trade(tradeId, 'review_rejected');
  return { result: 'review_rejected' };
}
