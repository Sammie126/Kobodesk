import crypto from 'node:crypto';

// Fake crypto custody. Addresses are clearly labelled and cannot receive real funds.
export const sandboxCrypto = {
  name: 'sandbox-crypto',
  async newDepositAddress({ coin, network }) {
    return `SANDBOX-${coin}-${network}-${crypto.randomBytes(10).toString('hex')}`;
  },
};

const BANKS = [
  { code: '044', name: 'Access Bank' },
  { code: '011', name: 'First Bank of Nigeria' },
  { code: '058', name: 'Guaranty Trust Bank' },
  { code: '033', name: 'United Bank for Africa' },
  { code: '057', name: 'Zenith Bank' },
  { code: '035', name: 'Wema Bank' },
  { code: '232', name: 'Sterling Bank' },
  { code: '50211', name: 'Kuda Microfinance Bank' },
  { code: '50515', name: 'Moniepoint Microfinance Bank' },
  { code: '999992', name: 'OPay' },
];

// Fake bank payouts. Test hooks:
//   account number ending 0000 -> name lookup fails
//   account number ending 9999 -> transfer fails
export const sandboxPayout = {
  name: 'sandbox-payout',
  async listBanks() {
    return BANKS;
  },
  async resolveAccount({ bank_code, account_number }) {
    if (!BANKS.some((b) => b.code === bank_code)) return null;
    if (account_number.endsWith('0000')) return null;
    return { account_name: `SANDBOX ACCOUNT ${account_number.slice(-4)}` };
  },
  // reference doubles as an idempotency key: the same reference never pays twice.
  _paid: new Set(),
  async transfer({ reference, account_number, amount_kobo }) {
    if (this._paid.has(reference)) return { ok: true, reference, duplicate: true };
    if (account_number.endsWith('9999')) return { ok: false, error: 'Sandbox: simulated transfer failure' };
    if (!Number.isInteger(amount_kobo) || amount_kobo <= 0) return { ok: false, error: 'Invalid amount' };
    this._paid.add(reference);
    return { ok: true, reference };
  },
};
