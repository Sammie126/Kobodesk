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
  const port = int(env.PORT, 3000);

  const cfg = {
    mode,
    port,
    dbPath: env.DB_PATH || './data/kobodesk.db',
    publicUrl: (env.PUBLIC_URL || `http://localhost:${port}`).replace(/\/+$/, ''),
    tokenSecret: env.TOKEN_SECRET || '',
    webhookSecret: env.WEBHOOK_SECRET || '',
    dataKey: env.DATA_ENCRYPTION_KEY || '',
    corsOrigin: env.CORS_ORIGIN || '',
    trustProxy: env.TRUST_PROXY === '1',
    adminEmails: (env.ADMIN_EMAILS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
    mailProvider: env.MAIL_PROVIDER || 'console',
    mailApiKey: env.MAIL_API_KEY || '',
    mailFrom: env.MAIL_FROM || (env.SMTP_USER ? `Kobodesk <${env.SMTP_USER}>` : ''),
    smtpHost: env.SMTP_HOST || 'smtp.gmail.com',
    smtpPort: int(env.SMTP_PORT, 465),
    smtpSecure: env.SMTP_SECURE !== '0',
    smtpUser: env.SMTP_USER || '',
    smtpPass: env.SMTP_PASS || '',
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
    // Random secrets are fine in sandbox. Sessions and saved 2FA secrets stop working after a restart
    // unless you set TOKEN_SECRET and DATA_ENCRYPTION_KEY.
    if (!cfg.tokenSecret) cfg.tokenSecret = crypto.randomBytes(32).toString('hex');
    if (!cfg.webhookSecret) cfg.webhookSecret = crypto.randomBytes(32).toString('hex');
    if (!cfg.dataKey) cfg.dataKey = crypto.randomBytes(32).toString('hex');
    if (!cfg.corsOrigin) cfg.corsOrigin = '*';
  } else {
    for (const [name, value] of [['TOKEN_SECRET', cfg.tokenSecret], ['WEBHOOK_SECRET', cfg.webhookSecret], ['DATA_ENCRYPTION_KEY', cfg.dataKey]]) {
      if (value.length < 32) throw new Error(`${name} must be at least 32 characters outside sandbox mode.`);
    }
    if (new Set([cfg.tokenSecret, cfg.webhookSecret, cfg.dataKey]).size !== 3) {
      throw new Error('TOKEN_SECRET, WEBHOOK_SECRET and DATA_ENCRYPTION_KEY must all be different.');
    }
    if (!cfg.publicUrl.startsWith('https://')) throw new Error('PUBLIC_URL must start with https:// outside sandbox mode.');
    if (!['smtp', 'resend'].includes(cfg.mailProvider)) throw new Error('Set MAIL_PROVIDER to a real email provider (smtp or resend) outside sandbox mode.');
    if (cfg.mailProvider === 'resend' && (!cfg.mailApiKey || !cfg.mailFrom)) throw new Error('MAIL_API_KEY and MAIL_FROM are required for the resend provider.');
    if (cfg.mailProvider === 'smtp' && (!cfg.smtpUser || !cfg.smtpPass)) throw new Error('SMTP_USER and SMTP_PASS are required for the smtp provider.');
    if (!cfg.corsOrigin) cfg.corsOrigin = new URL(cfg.publicUrl).origin;
    if (cfg.corsOrigin === '*') throw new Error('CORS_ORIGIN cannot be * outside sandbox mode.');
  }
  return cfg;
}
