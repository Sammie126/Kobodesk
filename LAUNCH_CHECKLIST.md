# Launch checklist

Kobodesk's code is built, but these items need you before real customers use it.

## Legal and regulatory (do first)
- [ ] Take web/terms.html and web/privacy.html to a Nigerian lawyer. Fill every [BRACKET], remove the DRAFT notice.
- [ ] Get legal advice on SEC registration for digital asset services, plus CAC registration and AML/KYC duties.
- [ ] Set COMPANY_NAME, RC_NUMBER, SEC_REGISTRATION in the environment so they appear on the site and receipts.

## Providers (the server refuses to go live without them)
- [ ] Crypto custody/deposit provider: implement the interface in PROVIDERS.md, set the webhook secret.
- [ ] Naira payout provider: implement payout with `kd_<tradeId>` as the idempotency key.
- [ ] Identity provider (BVN/NIN lookup): today KYC is manual review in the Admin page.
- [ ] Live rates: set RATES_SOURCE=live and test against the real source.

## Hosting and email
- [ ] Deploy over HTTPS (see DEPLOY.md), set PUBLIC_URL to the https address.
- [ ] Gmail app password or Resend key; send yourself a test sign-up code.
- [ ] Set ADMIN_EMAILS to the people who may use the Admin page.
- [ ] Strong, distinct secrets (32+ characters each). Back up the data folder.

## Trust content
- [ ] Replace sample reviews/numbers on the landing page with real ones. Do not publish invented testimonials.
- [ ] Set SUPPORT_EMAIL, SUPPORT_WHATSAPP, SUPPORT_HOURS to real, monitored contacts.

## Before announcing
- [ ] Run `npm test`. Do a small real trade end to end. Test a failed payout and the Retry button.
- [ ] Test on a low-end Android phone and an older iPhone.

## Compliance (see COMPLIANCE.md and FUNDS_SEGREGATION.md)
- [ ] Complete the funds table in FUNDS_SEGREGATION.md and have it signed off before you state anything about segregation.
- [ ] Appoint a compliance officer, write the AML/CFT policy, and set REVIEW_THRESHOLD_KOBO and the daily limits with them.
- [ ] Create Cloudflare Turnstile keys and set TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY.
- [ ] Set SECURITY_EMAIL to a mailbox that is read, and check /.well-known/security.txt after deploying.
- [ ] Every admin turns on two-factor sign-in in Settings before using the admin page.
- [ ] Keep DATA_ENCRYPTION_KEY backed up separately from the database. Test restoring a backup.
- [ ] Have a lawyer set the retention periods and approve Terms and Privacy.
- [ ] Review the held-trades and flagged-accounts lists every day.
