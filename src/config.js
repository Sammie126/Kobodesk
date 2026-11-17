import crypto from 'node:crypto';

// Coins and the networks each one can be deposited on.
// requiredConfirmations is a placeholder; set values that match your risk policy.
export const ASSETS = {
  USDT: { name: 'Tether', networks: ['TRC20', 'ERC20'], requiredConfirmations: { TRC20: 20, ERC20: 12 } },
  BTC: { name: 'Bitcoin', networks: ['BTC'], requiredConfirmations: { BTC: 2 } },
  ETH: { name: 'Ethereum', networks: ['ERC20'], requiredConfirmations: { ERC20: 12 } },
  SOL: { name: 'Solana', networks: ['SOL'], requiredConfirmations: { SOL: 32 } },
};

const int = (v, d) => (v === undefined || v === '' ? d : Number.parseInt(v, 10));

export function loadConfig(overrides = {}) {
  const env = process.env;
  const mode = overrides.mode ?? env.MODE ?? 'sandbox';

  const cfg = {
    mode,
    port: int(env.PORT, 3000),
    dbPath: env.DB_PATH || './data/kobodesk.db',
    tokenSecret: env.TOKEN_SECRET || '',
    webhookSecret: env.WEBHOOK_SECRET || '',
    corsOrigin: env.CORS_ORIGIN || '*',
    adminEmails: (env.ADMIN_EMAILS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
    spreadBps: int(env.SPREAD_BPS, 150),
    flatFeeKobo: int(env.FLAT_FEE_KOBO, 0),
    quoteTtlSeconds: int(env.QUOTE_TTL_SECONDS, 900),
    minTradeKobo: int(env.MIN_TRADE_KOBO, 100000),
    maxTradeKoboUnverified: int(env.MAX_TRADE_KOBO_UNVERIFIED, 50000000),
    maxTradeKoboVerified: int(env.MAX_TRADE_KOBO_VERIFIED, 5000000000),
    tokenTtlSeconds: 60 * 60 * 24 * 7,
    authAttemptsPer15Min: int(env.AUTH_ATTEMPTS_PER_15_MIN, 10),
    ...overrides,
  };

  if (mode === 'sandbox') {
    // Random secrets are fine in sandbox. Tokens stop working after a restart.
    if (!cfg.tokenSecret) cfg.tokenSecret = crypto.randomBytes(32).toString('hex');
    if (!cfg.webhookSecret) cfg.webhookSecret = crypto.randomBytes(32).toString('hex');
  } else {
    if (cfg.tokenSecret.length < 32) throw new Error('TOKEN_SECRET must be at least 32 characters outside sandbox mode.');
    if (cfg.webhookSecret.length < 32) throw new Error('WEBHOOK_SECRET must be at least 32 characters outside sandbox mode.');
    if (cfg.corsOrigin === '*') throw new Error('Set CORS_ORIGIN to your website origin outside sandbox mode.');
  }
  return cfg;
}
