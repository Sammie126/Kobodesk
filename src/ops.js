import { logEvent } from './db.js';
import { formatNaira, formatAmount } from './money.js';

// Emails to customers and to your team. A failed email never stops a trade; it is logged instead.
export function makeNotifier({ db, config, mailer }) {
  const send = async (to, subject, text) => {
    try { await mailer.send({ to, subject, text }); }
    catch (err) { console.error('Could not send email:', err.message); }
  };
  const sign = `\n\nKobodesk${config.supportEmail ? `\nNeed help? Write to ${config.supportEmail}` : ''}`;
  const toAdmins = (subject, text) => Promise.all(config.adminEmails.map((a) => send(a, subject, text)));

  return {
    send,
    toAdmins,
    async trade(tradeId, kind) {
      const t = db.prepare('SELECT * FROM trades WHERE id = ?').get(tradeId);
      if (!t) return;
      const u = db.prepare('SELECT email FROM users WHERE id = ?').get(t.user_id);
      const label = `${formatAmount(t.amount_scaled)} ${t.coin}`;
      if (kind === 'deposit_seen') {
        await send(u.email, `We received your ${t.coin} deposit`,
          `We saw your deposit for the ${label} trade (ID ${t.id}). We are waiting for the network to confirm it. We will email you when your naira is paid.${sign}`);
      } else if (kind === 'paid_out') {
        await send(u.email, `Paid: ₦${formatNaira(t.payout_kobo)} is on its way`,
          `Your ${label} trade (ID ${t.id}) is complete. ₦${formatNaira(t.payout_kobo)} was sent to your bank account. Open the app and go to My trades to see your receipt.${sign}`);
      } else if (kind === 'held') {
        await send(u.email, `Your ${t.coin} trade is being reviewed`,
          `Your deposit for the ${label} trade (ID ${t.id}) is confirmed. Before we pay out, our team needs to complete a routine review of this trade. You do not need to send anything again. We will email you as soon as it is done.${sign}`);
        await toAdmins(`Trade held for review: ${t.id}`,
          `Trade ${t.id} (${label}) for ${u.email} is waiting for a decision.\nReason: ${t.hold_reason ?? 'not recorded'}\nOpen the admin page to release or reject it.`);
      } else if (kind === 'review_rejected') {
        await send(u.email, `We could not complete your ${t.coin} trade`,
          `After review, we could not complete the ${label} trade (ID ${t.id}). Please contact support and quote the trade ID so we can help with your deposit.${sign}`);
      } else if (kind === 'payout_failed') {
        await send(u.email, `Action needed on your ${t.coin} trade`,
          `Your deposit for the ${label} trade (ID ${t.id}) arrived, but the bank transfer did not go through. Our team is looking into it. You do not need to send anything again.${sign}`);
        await toAdmins(`Payout failed: ${t.id}`,
          `Trade ${t.id} (${label}) for ${u.email} has a failed payout.\nReason: ${t.failure_reason ?? 'unknown'}\nOpen the admin page to retry it.`);
      }
    },
    async kyc(userId, status, note) {
      const u = db.prepare('SELECT email FROM users WHERE id = ?').get(userId);
      if (!u) return;
      if (status === 'verified') {
        await send(u.email, 'Your identity is verified',
          `Your identity check is complete. Your higher trade limit is now active.${sign}`);
      } else if (status === 'rejected') {
        await send(u.email, 'We could not verify your identity',
          `We could not verify your identity.\nReason: ${note || 'The details did not match.'}\nYou can check your details and submit them again in the app, under Settings.${sign}`);
      }
    },
  };
}

// Emails your admins about trades that need a person. Each trade and state is reported once.
export async function alertStuck({ db, config, notifier }, now = Date.now()) {
  if (!config.adminEmails.length) return 0;
  const rules = [['payout_failed', 0], ['held_for_review', 4 * 3600000], ['paying_out', config.stuckMinutes * 60000], ['confirming', 120 * 60000]];
  const found = [];
  for (const [status, age] of rules) {
    for (const t of db.prepare('SELECT * FROM trades WHERE status = ? AND updated_at < ?').all(status, now - age)) {
      const key = `${t.id}:${status}`;
      if (db.prepare("SELECT 1 FROM events WHERE type = 'stuck_alert' AND detail = ?").get(JSON.stringify(key))) continue;
      found.push({ t, status, key });
    }
  }
  if (!found.length) return 0;
  const lines = found.map(({ t, status }) => `- ${t.id}: ${formatAmount(t.amount_scaled)} ${t.coin}, ${status}`);
  await notifier.toAdmins(`${found.length} Kobodesk trade(s) need attention`, `${lines.join('\n')}\n\nOpen the admin page to review them.`);
  for (const { t, key } of found) logEvent(db, t.id, 'stuck_alert', key);
  return found.length;
}
