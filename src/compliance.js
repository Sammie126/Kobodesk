import { logEvent } from './db.js';
import { formatNaira } from './money.js';

// Limits, review holds and basic anti-money-laundering (AML) flags. These are controls for people to act on:
// the code pauses and flags, and a person on your team decides.

export const limitsFor = (config, user) => ({
  perTrade: user.kyc_status === 'verified' ? config.maxTradeKoboVerified : config.maxTradeKoboUnverified,
  daily: user.kyc_status === 'verified' ? config.dailyLimitKoboVerified : config.dailyLimitKoboUnverified,
});

// Naira value of trades the user started in the last 24 hours. Quotes that expired unused do not count.
export function usedToday(db, userId, now = Date.now()) {
  return db.prepare(
    `SELECT COALESCE(SUM(quote_kobo), 0) s FROM trades
     WHERE user_id = ? AND created_at > ? AND status NOT IN ('expired', 'review_rejected')
       AND NOT (status = 'awaiting_deposit' AND expires_at < ?)`
  ).get(userId, now - 24 * 3600 * 1000, now).s;
}

export const recentTradeCount = (db, userId, minutes, now = Date.now()) =>
  db.prepare('SELECT COUNT(*) n FROM trades WHERE user_id = ? AND created_at > ?').get(userId, now - minutes * 60000).n;

// Flags an account for manual review. Returns true if it was newly flagged.
export function flagUser({ db, notifier }, userId, reason, detail = {}) {
  const r = db.prepare('UPDATE users SET flagged_at = ?, flag_reason = ? WHERE id = ? AND flagged_at IS NULL').run(Date.now(), reason, userId);
  if (r.changes !== 1) return false;
  logEvent(db, null, 'user_flagged', { user: userId, reason, ...detail });
  const u = db.prepare('SELECT email FROM users WHERE id = ?').get(userId);
  notifier?.toAdmins('Account flagged for review', `${u?.email ?? userId} was flagged: ${reason}\nNew trades are paused and payouts are held until a team member clears the flag in the admin page.`);
  return true;
}

export function clearFlag({ db }, userId, admin, note) {
  const r = db.prepare('UPDATE users SET flagged_at = NULL, flag_reason = NULL WHERE id = ? AND flagged_at IS NOT NULL').run(userId);
  if (r.changes === 1) logEvent(db, null, 'flag_cleared', { user: userId, admin, note });
  return r.changes === 1;
}

// Why a confirmed deposit should wait for a person instead of paying out automatically. null means pay out.
export function holdReason(db, config, user, payoutKobo) {
  if (payoutKobo >= config.reviewThresholdKobo) {
    return `Payout of ₦${formatNaira(payoutKobo)} is at or above the review threshold of ₦${formatNaira(config.reviewThresholdKobo)}.`;
  }
  if (user.flagged_at) return `Account is flagged: ${user.flag_reason}`;
  if (user.kyc_status !== 'verified' && payoutKobo > config.maxTradeKoboUnverified) {
    return `Payout is above the ₦${formatNaira(config.maxTradeKoboUnverified)} limit for accounts without a verified identity.`;
  }
  return null;
}
