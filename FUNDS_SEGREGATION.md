# Customer funds: what the code does, and what you must confirm

**The software cannot prove that customer funds are kept apart from your operating funds.** That is decided by
how your bank accounts, custody provider and payout provider are set up, not by this code. Do not tell customers
that funds are segregated until the checklist below is true and someone accountable has signed it off.

## What the code does
- Kobodesk never holds a naira balance for a customer. There is no wallet, ledger balance or stored value.
- Each trade gets its own crypto deposit address from your custody provider. The code records the deposit and does not move crypto.
- Naira leaves through your payout provider to the customer's own bank account, one transfer per trade, using a reference unique to the trade.
- Every status change is written to an append-only audit log (admin page, Audit log), so each trade can be reconciled.
- Large or unusual trades are held before payout until a person releases them.

## What you must confirm (outside the code)
Fill this in with your accountant and lawyer, then keep it with your compliance records.

| Question | Your answer and evidence |
|---|---|
| Which account receives crypto deposits (custody provider, wallet structure)? Are customer deposits kept apart from the company's own crypto? | |
| Which bank account funds naira payouts? Is it a separate account used only for customer payouts, or the operating account? | |
| Who can move money out of each account, and is approval by two people required? | |
| How often do you reconcile deposits received, payouts sent and account balances? Who signs it off? | |
| Where do fees and margin go, and when are they moved to the operating account? | |
| What happens to a customer's deposit if a trade is rejected? Who refunds it, and how fast? | |
| What does your payout or custody provider's contract say about safeguarding client money? | |

## Reconciliation you can do today
Use the admin page: Overview shows total paid out, and the Audit log shows every deposit and payout with times.
Compare these with your bank statement and custody provider statement at least daily.

## Statement for customers
The Terms of Service has a bracketed FUNDS HANDLING sentence. Replace it with wording your lawyer approves
only after the table above is complete.
