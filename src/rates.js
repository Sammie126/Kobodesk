import { ASSETS } from './config.js';

// SAMPLE mid-market prices in naira per coin. These are placeholders for development.
// Replace getMidRates() with a call to a real price feed before going live.
const SAMPLE_MID_NAIRA = { USDT: 1500, BTC: 150000000, ETH: 5200000, SOL: 260000 };

export async function getMidRates() {
  const out = {};
  for (const coin of Object.keys(ASSETS)) out[coin] = SAMPLE_MID_NAIRA[coin] * 100; // kobo
  return out;
}

// What the customer is paid per coin: mid price minus your spread.
export async function getSellRates(config) {
  const mid = await getMidRates();
  const out = {};
  for (const [coin, kobo] of Object.entries(mid)) {
    out[coin] = Math.floor((kobo * (10000 - config.spreadBps)) / 10000);
  }
  return out;
}
