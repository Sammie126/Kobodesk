# Compliance and security controls

This lists what the software does for each control, what it does not do, and what needs a person or a professional.
It is not legal advice.

| # | Control | Built in the code | Still needs you |
|---|---|---|---|
| 1 | Identity check before first trade | Full name, date of birth, address, BVN or NIN and a government ID photo/PDF (JPEG, PNG or PDF, 3 MB). Everything is encrypted. A person approves or rejects in the admin page. Submitting is required before the first trade; larger trades need the approved status. | A real identity-verification provider (automatic BVN/NIN lookup, document and face checks). Today a person looks at the ID by eye. |
| 2 | Limits and manual review | Per-trade limit and per-24-hour limit (lower until verified). Any payout at or above `REVIEW_THRESHOLD_KOBO` (default N2,000,000), any flagged account, and any unverified account above its limit is held until another admin releases or rejects it. | Choose limits and thresholds with your compliance officer. A rejected trade does not refund crypto by itself: refund it by hand. |
| 3 | Terms and Privacy pages | Published at /terms.html and /privacy.html: data collected, retention, deletion requests (in-app button and admin queue), automated flags, not-a-bank clause. | **A Nigerian lawyer must review and complete both pages.** They are drafts with [BRACKETS] and a visible notice. Retention periods must be set by your lawyer. |
| 4 | Audit log | Every trade: created, address generated, deposit seen, confirmations, deposit confirmed, held, released or rejected, payout sent or failed, each status change with a time. Also KYC views, decisions, flags and deletion requests. Admin only. The database refuses to edit or delete entries. | Back up the database. Decide how long to keep logs. A person with database access can still alter the file itself, so restrict hosting access. |
| 5 | Rate limits and CAPTCHA | Per-IP limit on all API calls, tighter limits on login, sign-up and trades. Cloudflare Turnstile on sign-up, login, forgot-password and trade creation, checked on the server, fails closed. Required outside sandbox mode. | Create Turnstile keys. Limits are kept in server memory, so run one server or move them to a shared store such as Redis. |
| 6 | security.txt and disclosure page | /.well-known/security.txt (contact, expiry, policy) and /security.html. Uses `SECURITY_EMAIL`, or `SUPPORT_EMAIL`. | Use a mailbox someone reads. Decide your response time and whether to offer rewards or a legal safe-harbour statement (ask your lawyer). |
| 7 | Funds not mixed with operating funds | The code never holds a customer balance and logs every movement (see FUNDS_SEGREGATION.md). | **Cannot be confirmed by code.** It depends on your bank, custody and payout set-up. Complete the table in FUNDS_SEGREGATION.md. |
| 8 | Suspicious-activity flags | Pauses and flags an account that starts many trades in 10 minutes, or saves a bank account that is also on another customer account. Flagged accounts cannot start trades and their payouts are held. An admin clears a flag with a written reason. | An AML/CFT policy, a compliance officer, sanctions and watch-list screening, and the process for filing suspicious-transaction reports with the authorities. The flags are basic rules, not a monitoring system. |
| 9 | Encryption at rest | Encrypted before storage (AES-256-GCM): full name, date of birth, address, BVN/NIN, ID file, bank account number and name, authenticator key. Passwords are hashed. Bank accounts use a keyed fingerprint so duplicates can be found without storing the number. | Keep `DATA_ENCRYPTION_KEY` secret and backed up separately: if it is lost, the data cannot be read. Email addresses and trade amounts are stored in plain text (needed for login and reports). Ask your host about disk-level encryption and database backups. |
| 10 | Disclaimer and contact | "Kobodesk is not a bank" and rates-can-change notice on the home page, every signed-in page and the Terms, with support contacts. | Set `SUPPORT_EMAIL`, `SUPPORT_WHATSAPP` and `SUPPORT_HOURS`. |

Also added: admins must use two-factor sign-in outside sandbox mode, and an admin cannot approve their own identity check, trades or flags.

## Things that need a separate legal or compliance step
These cannot be solved by code. Ask a Nigerian lawyer which apply to your business and how.

- Whether and how you must register or be licensed with the Securities and Exchange Commission for digital-asset services, and with the Corporate Affairs Commission as a company.
- Anti-money-laundering obligations: registering with the relevant authorities, a written AML/CFT policy, a named compliance officer, staff training, sanctions screening, record keeping, and reporting suspicious transactions.
- Data protection: whether you must register with the Nigeria Data Protection Commission, appoint a data protection officer, and carry out a data protection impact assessment. Contracts with providers who process personal data, and rules for sending data abroad.
- Your banking and payout providers' own rules about crypto-related business.
- Tax registration and filings.
- Insurance and a plan for incidents such as a data breach (including who you notify and how fast).
- The Terms of Service, Privacy Policy, retention periods and the funds-handling statement.
