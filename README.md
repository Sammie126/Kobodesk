# Kobodesk

A crypto-to-naira trading service: website, customer app and API in one server. **To put it online, read `DEPLOY.md`.**

It handles accounts, email confirmation codes, two-factor sign-in, saved bank accounts, rate quotes, trades, deposit confirmation and bank payouts. Pages are in `web/`, the API is in `src/`.

It has **no dependencies**. It needs Node 22.5 or newer (it uses the built-in SQLite module).

**It runs in sandbox mode only.** Deposit addresses and bank payouts are fake, so no real money moves. Before you can go live, you must connect a real crypto provider and a real payout provider (see "Going live").

## Run it

```
cp .env.example .env      # optional; sandbox mode works without it
npm start                 # http://localhost:3000
npm test                  # 21 tests: trade flow, accounts, email codes, 2FA, mail sending
```

Node does not read `.env` files by itself. Either export the variables in your shell, or start with `node --env-file=.env --no-warnings src/index.js`.

## How a trade works

1. The customer saves a bank account. The payout provider confirms the account name.
2. `POST /api/trades` locks a rate for 15 minutes and returns a deposit address.
3. The customer sends crypto to that address.
4. Your crypto provider calls `POST /api/webhooks/crypto` with a signed event.
5. At the required number of confirmations, the naira payout is sent to the customer's bank.

Trade statuses: `awaiting_deposit`, `confirming`, `paying_out`, `paid_out`, `expired`, `payout_failed`.

## Endpoints

| Method | Path | Notes |
|---|---|---|
| GET | `/api/health` | |
| GET | `/api/assets` | Coins and networks |
| GET | `/api/rates` | Sell rate per coin, in kobo and naira |
| GET | `/api/banks` | Bank list from the payout provider |
| POST | `/api/auth/signup` | `{ email, password }` (10+ characters) |
| POST | `/api/auth/login` | `{ email, password, code? }` (`code` only if 2FA is on) |
| POST | `/api/auth/verify-code` | `{ code }`. The 6-digit code from the sign-up email |
| POST | `/api/auth/resend-verification` | Sends a new code |
| POST | `/api/auth/forgot-password`, `/api/auth/reset-password` | Email reset link |
| POST | `/api/auth/change-password`, `/api/auth/logout-all` | |
| POST | `/api/2fa/setup`, `/api/2fa/enable`, `/api/2fa/disable` | Authenticator app sign-in |
| GET | `/api/quote?coin=&network=&amount=` | Public price check |
| GET | `/api/me` | Needs `Authorization: Bearer <token>` |
| GET, POST | `/api/bank-accounts` | POST `{ bank_code, account_number }` |
| POST | `/api/trades` | `{ coin, network, amount, bank_account_id }` |
| GET | `/api/trades`, `/api/trades/:id` | Your own trades |
| POST | `/api/webhooks/crypto` | Signed with `x-signature` (see below) |
| POST | `/api/sandbox/trades/:id/deposit` | Sandbox only. Simulates a deposit |
| GET | `/api/admin/trades?status=` | Admins only (`ADMIN_EMAILS`) |
| POST | `/api/admin/trades/:id/retry-payout` | Admins only |
| POST | `/api/admin/users/:id/kyc` | Admins only. `{ status }` |

Errors look like `{ "error": { "code": "bad_network", "message": "..." } }`. The `message` is written to be shown to the customer.

### Webhook format

Body (JSON):
```
{ "address": "...", "coin": "USDT", "network": "TRC20", "amount": "100", "confirmations": 25, "tx_hash": "..." }
```
Header `x-signature`: the hex HMAC-SHA256 of the raw request body, using `WEBHOOK_SECRET`. Repeated events for the same `tx_hash` are safe. Confirmations update, and money moves once.

## Try the whole flow in sandbox

```
curl -s localhost:3000/api/auth/signup -H 'content-type: application/json' -d '{"email":"you@example.com","password":"a-long-password"}'
# copy the token, then:
curl -s localhost:3000/api/bank-accounts -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{"bank_code":"058","account_number":"0123456789"}'
curl -s localhost:3000/api/trades -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{"coin":"USDT","network":"TRC20","amount":"100","bank_account_id":"<id from above>"}'
curl -s -X POST localhost:3000/api/sandbox/trades/<trade id>/deposit -H "authorization: Bearer $TOKEN"
```

Sandbox test accounts: an account number ending in `0000` is "not found", and one ending in `9999` makes the payout fail.

## Rules the code follows

- Naira is integer kobo. Crypto amounts are integers scaled by 1e8. No floating point is used for money.
- A rate is locked for the quote window. A deposit that arrives after the window is paid at the current rate.
- Each trade pays out at most once. The payout reference is `kd_<trade id>` on every retry, and the payout provider must treat it as an idempotency key.
- The user's limit depends on `kyc_status`. Limits and fees are samples. Set your own.
- Passwords use scrypt. Webhooks and tokens are HMAC-signed and compared in constant time.

## Going live

This is the part that is not done yet, and it needs real accounts and legal approval.

1. **Crypto provider.** Pick a custody or payment provider, implement `newDepositAddress` in `src/providers/`, and point its deposit webhooks at `/api/webhooks/crypto`. Map its event fields to the format above. Check the number of confirmations you require in `src/config.js`.
2. **Payout provider.** Pick a Nigerian payments provider that can name-check and pay bank accounts. Implement `listBanks`, `resolveAccount` and `transfer` in `src/providers/`.
3. **Live rates.** Replace the sample prices in `src/rates.js` with a real price feed.
4. **Identity checks (KYC).** Connect a verification service that sets `kyc_status`. Decide your limits with a lawyer.
5. **Compliance.** Company registration and the licensing rules for crypto in Nigeria apply to you. Get legal advice before you take real customers.
6. **Operations.** Move from SQLite to a managed database if you run more than one server. Put the API behind HTTPS and a proxy. Add alerts for `payout_failed` trades and for events logged as `deposit_coin_mismatch` or `deposit_unknown_address`, which need a person to review them.

Setting `MODE` to anything other than `sandbox` makes the server refuse to start until step 1 and 2 are done. This is deliberate.

## Known limits

- The sign-in rate limiter is in memory and keys on the connection address. Behind a proxy, every user shares one address, so add trusted `X-Forwarded-For` handling first.
- Customers must confirm their email with a 6-digit code before they can trade. Email is sent through Gmail SMTP or Resend; neither has been run against the live service from the build environment, so send yourself a test first.
- Identity checks (KYC) are not built. Every customer stays "unverified" and gets the lower limit until an admin sets their status.
- Sessions are 7-day tokens. A customer can log out of every device, but not one at a time.


## Features added for launch
Identity check (manual review), receipts (print/PDF), referral links, admin page (overview, failed payout retry, KYC review), email alerts for deposits/payouts/stuck trades, legal page drafts, SEO/sharing tags, optional analytics, installable app (PWA). See LAUNCH_CHECKLIST.md and PROVIDERS.md.
