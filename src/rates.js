import { ASSETS } from './config.js';
import { HttpError } from './errors.js';

// RATES_SOURCE=sample  Fixed placeholder prices. For testing only.
// RATES_SOURCE=live    Reads naira prices from a CoinGecko-style endpoint (RATES_URL).
//
// Safety rules for live prices:
//  - a price must be a positive number for every coin, or the whole reading is rejected
//  - a reading that jumps more than 30% from the last one (within 10 minutes) is rejected as suspect
//  - readings are cached for 30 seconds, and a cached reading up to 5 minutes old is used if the feed is down
//  - past that, quotes and trades stop with a clear "rates unavailable" message instead of using a stale price
// The live adapter has not been run against the real CoinGecko service from the build environment.
// It is tested against a local mock. Check a few quotes against another source before launch.

const SAMPLE_MID_NAIRA = { USDT: 1500, BTC: 150000000, ETH: 5200000, SOL: 260000 };
const IDS = { USDT: 'tether', BTC: 'bitcoin', ETH: 'ethereum', SOL: 'solana' };
const FRESH_MS = 30 * 1000;
const MAX_STALE_MS = 5 * 60 * 1000;
const JUMP_WINDOW_MS = 10 * 60 * 1000;

const cache = new Map(); // url -> { at, rates }
export const resetRateCache = () => cache.clear();

async function fetchLive(config) {
  const url = config.ratesUrl;
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < FRESH_MS) return hit.rates;
  try {
    const res = await fetch(`${url}?ids=${Object.values(IDS).join(',')}&vs_currencies=ngn`, {
      signal: AbortSignal.timeout(5000), headers: { accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`feed answered ${res.status}`);
    const json = await res.json();
    const rates = {};
    for (const [coin, id] of Object.entries(IDS)) {
      const n = json?.[id]?.ngn;
      if (!Number.isFinite(n) || n <= 0) throw new Error(`bad price for ${coin}`);
      rates[coin] = Math.round(n * 100); // kobo per coin
      const prev = hit && Date.now() - hit.at < JUMP_WINDOW_MS ? hit.rates[coin] : null;
      if (prev && (rates[coin] / prev > 1.3 || rates[coin] / prev < 0.7)) throw new Error(`suspicious jump in ${coin}`);
    }
    cache.set(url, { at: Date.now(), rates });
    return rates;
  } catch (err) {
    if (hit && Date.now() - hit.at < MAX_STALE_MS) return hit.rates;
    console.error('Rate feed problem:', err.message);
    throw new HttpError(503, 'Rates are unavailable right now. Try again in a minute.', 'rates_unavailable');
  }
}

// Mid-market price per coin, in kobo.
export async function getMidRates(config) {
  if (config.ratesSource === 'live') return fetchLive(config);
  const out = {};
  for (const coin of Object.keys(ASSETS)) out[coin] = SAMPLE_MID_NAIRA[coin] * 100;
  return out;
}

// What the customer is paid per coin: mid price minus your spread.
export async function getSellRates(config) {
  const mid = await getMidRates(config);
  const out = {};
  for (const [coin, kobo] of Object.entries(mid)) {
    out[coin] = Math.floor((kobo * (10000 - config.spreadBps)) / 10000);
  }
  return out;
}
