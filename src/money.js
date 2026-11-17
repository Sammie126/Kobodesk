// Money rules:
//  - Naira is stored as integer kobo (100 kobo = 1 naira).
//  - Crypto amounts are stored as integers scaled by 1e8 (so 0.5 BTC = 50000000).
//  - Rates are kobo per ONE whole coin.
// Never use floating point for any of these.

export const SCALE = 100000000n;

// Accepts a decimal string like "12.5" with up to 8 decimals. Returns the scaled integer, or null.
export function parseAmount(input) {
  const s = String(input ?? '').trim();
  if (!/^\d{1,9}(\.\d{1,8})?$/.test(s)) return null;
  const [whole, frac = ''] = s.split('.');
  const scaled = BigInt(whole) * SCALE + BigInt(frac.padEnd(8, '0'));
  if (scaled <= 0n) return null;
  return Number(scaled);
}

export function formatAmount(scaled) {
  const n = BigInt(scaled);
  const whole = n / SCALE;
  const frac = (n % SCALE).toString().padStart(8, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : `${whole}`;
}

// scaled crypto amount x rate (kobo per coin) -> kobo, rounded down.
export function toKobo(scaledAmount, rateKobo) {
  return Number((BigInt(scaledAmount) * BigInt(rateKobo)) / SCALE);
}

export function formatNaira(kobo) {
  const n = BigInt(kobo);
  const whole = (n / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const cents = (n % 100n).toString().padStart(2, '0');
  return `${whole}.${cents}`;
}
