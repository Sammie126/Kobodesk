import { sandboxCrypto, sandboxPayout } from './sandbox.js';

// Providers are the only places that touch money or blockchains.
//
// A crypto provider must implement:
//   newDepositAddress({ coin, network, tradeId }) -> string
//   and must POST signed deposit events to /api/webhooks/crypto (see README for the body).
//
// A payout provider must implement:
//   listBanks() -> [{ code, name }]
//   resolveAccount({ bank_code, account_number }) -> { account_name } | null
//   transfer({ reference, bank_code, account_number, account_name, amount_kobo }) -> { ok, reference?, error? }
//   transfer must treat `reference` as an idempotency key.
export function createProviders(config) {
  if (config.mode === 'sandbox') {
    return { crypto: sandboxCrypto, payout: { ...sandboxPayout, _paid: new Set() } };
  }
  // Fail closed: never run live mode on fake providers.
  throw new Error(
    'No live providers configured. Implement the crypto and payout providers in src/providers/ and return them here.'
  );
}
