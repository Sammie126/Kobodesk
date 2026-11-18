# Providers

Kobodesk talks to the outside world through two provider objects in `src/providers/`. `sandbox.js` simulates both. Add a real one and register it in `src/providers/index.js`.

## Crypto provider
- `newDepositAddress({coin, network})`: return a deposit address unique to each trade.
- Send a signed webhook to `POST /api/webhooks/crypto` with `{address, coin, network, amount, confirmations, tx_hash}`. The signature is HMAC-SHA256 of the raw body in the `x-signature` header, using WEBHOOK_SECRET.

## Payout provider
- `transfer({reference, account_number, amount_kobo, ...})`. `reference` is `kd_<tradeId>`; the provider must treat it as an idempotency key so retries never pay twice.
- Throw on failure. The trade moves to `payout_failed` and an admin can retry from the Admin page.

## Bank list and account name lookup
- `listBanks()` and `resolveAccount({bank_code, account_number})` return the bank list and the account name; customers can only be paid to an account in their name.

## Choosing
Pick providers licensed to operate in Nigeria and ask them about SEC rules for your use. Live rates, SMTP and Resend are tested only against mock servers here, so test each with real credentials before launch.
