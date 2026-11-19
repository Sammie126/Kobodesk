# Put Kobodesk online

The server serves the website and the API together, so one deployment is the whole product. Until you deploy it, the login and sign-up pages cannot work, because they need this server.

This guide puts the **test version** online (`MODE=sandbox`): fake deposits, fake payouts, no real money. It is safe to show to people. Do not take real customers on it. See the README, "Going live".

## 1. Set up Gmail to send the codes

New users get their 6-digit code from a Gmail account that you own. Use a new account for this, such as `kobodesk.noreply@gmail.com`, not your personal one.

1. Sign in to that Google account and turn on **2-Step Verification** (Google Account > Security).
2. Open **myaccount.google.com/apppasswords**, name the password "Kobodesk" and create it. Google shows a 16-letter password once. Copy it.
3. Use it as `SMTP_PASS`. Use the Gmail address as `SMTP_USER`. Never use your normal Google password.

Limits you should know about: a free Gmail account can send roughly 500 emails a day, and Google may flag a new account that suddenly sends many. This is fine for testing and a first launch. For a real service, move to a business email provider (set `MAIL_PROVIDER=resend` with a verified domain) so codes arrive reliably.

## 2. Choose where to host

Any host that runs a Docker container or Node 22 works, such as Render, Railway or Fly.io. They give you an https address and handle the certificate. Pick one that lets you attach a **persistent disk or volume**, because the database is a file.

1. Upload this folder to the host (the `Dockerfile` is included), or connect a Git repository that holds it.
2. Attach a volume and mount it at `/data`.
3. Add these environment variables:

| Name | Value |
|---|---|
| `MODE` | `sandbox` |
| `PUBLIC_URL` | your site address, for example `https://kobodesk.onrender.com` (no trailing slash) |
| `TOKEN_SECRET`, `WEBHOOK_SECRET`, `DATA_ENCRYPTION_KEY` | three different random strings of 32+ characters |
| `MAIL_PROVIDER` | `smtp` |
| `SMTP_USER` | the Gmail address |
| `SMTP_PASS` | the 16-letter app password |
| `ADMIN_EMAILS` | your own email, so you can use the admin routes |

`TRUST_PROXY=1` and the database path are already set in the Dockerfile.

To make a random string, run this on any computer with Node: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`

4. Deploy, then open your address. The home page should load, and "Log in" should open the login screen.

## 3. Check that the email works

Create an account on your live site with an email you control. You should get an email with a 6-digit code within a minute. Check the spam folder too. If nothing arrives, look at the host's logs. A line starting with "Could not send email" tells you why. The usual causes are a wrong app password, or 2-Step Verification not turned on.

## 4. Back up the database

All accounts and trades are in the file at `/data/kobodesk.db`. Turn on the host's volume snapshots, or copy the file on a schedule.


## New settings
See `.env.example` for RATES_SOURCE, COMPANY_NAME, RC_NUMBER, SUPPORT_EMAIL, SUPPORT_WHATSAPP, SUPPORT_HOURS, PAYOUT_TIME, ANALYTICS_DOMAIN and STUCK_MINUTES. In live mode the server will not start without the company, support and rates settings. Go through LAUNCH_CHECKLIST.md before taking customers.

## Render: settings that work
- **Runtime:** Node. **Build command:** leave empty (there is nothing to install; Kobodesk has no dependencies). **Start command:** `node --no-warnings src/index.js`.
- **Node version:** the repo pins Node 22 in `.node-version`. Render otherwise picks the newest Node, which has not been tested with Kobodesk.
- **Test deployment:** set `MODE=sandbox` and `PUBLIC_URL` to your onrender.com address. Without a disk, set `DB_PATH=./data/kobodesk.db`; the data is erased on every redeploy.
- **Real use:** attach a persistent disk (paid plan), mount it at `/var/data`, set `DB_PATH=/var/data/kobodesk.db`, and fill in every setting in `.env.example`.
- **If it fails to start:** the log now prints "Kobodesk could not start" followed by the reason and the fix. Send that line if you need help.
