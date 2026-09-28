# Payment System — Stripe Webhook + Apple IAP

Two separate payment rails now converge on one write path
(`applyEntitlement()` in `server.js`) that sets `userPlan`/`subStatus`/
`subCurrentPeriodEnd`/`billingCycle`/`subSource` on `users/{uid}` — the same
fields `GET /api/user/plan` already reads. Neither rail knows about the
other; a user who subscribes on both platforms just has whichever one wrote
last win, which is an acceptable v1 trade-off (cross-platform subscription
merging is a real product decision, not a technical default to bake in here).

## 1. Stripe webhook — real, not a skeleton, just needs configuring

This closes a pre-existing gap: no Stripe webhook existed anywhere in this
codebase, so `userPlan`/`subStatus` never actually updated after a real
checkout completed — see `PHASE2-NOTES.md` gap #6.

1. Stripe Dashboard → Developers → Webhooks → **Add endpoint**.
2. URL: `https://<your-backend>/api/stripe/webhook`.
3. Events to send: `checkout.session.completed`, `customer.subscription.created`,
   `customer.subscription.updated`, `customer.subscription.deleted`,
   `invoice.payment_failed`.
4. Copy the **Signing secret** → `STRIPE_WEBHOOK_SECRET` env var.
5. Test with the Stripe CLI: `stripe listen --forward-to localhost:PORT/api/stripe/webhook`,
   then `stripe trigger checkout.session.completed`.

Nothing else to build here — `/api/stripe/create-checkout-session` and
`/api/stripe/portal` (both pre-existing) already set the `username`/`plan`/
`billing` metadata the webhook reads.

## 2. Apple IAP — built; needs App Store Connect setup, then switch on

iOS subscriptions go through StoreKit (Guideline 3.1.1) in every storefront,
including the EU. Code: `src/routes/appleIap.js` (tests:
`scripts/test-apple-iap.js`), client in TrainingLog-mobile `src/js/payments.js`
using `@capgo/native-purchases`.

How it fits together:
- The app asks `GET /api/iap/apple/account-token` for the user's UUID
  (`users/{uid}.appleAccountToken`; Apple requires a UUID and Firebase uids
  aren't) and passes it to StoreKit as `appAccountToken`.
- After purchase or restore it sends StoreKit 2's signed transaction to
  `POST /api/iap/apple/verify`, which checks it up to Apple Root CA - G3
  (`certs/AppleRootCA-G3.cer`), requires the token to match the signed-in
  account, and grants the plan if the transaction is live.
- Renewals, expiries and refunds arrive at `POST /api/iap/apple/notifications`
  and are matched by token, falling back to `appleOriginalTransactionId`.
- Production **and** sandbox purchases are accepted (production first). App
  Review and TestFlight always buy in the sandbox.

### 2a. App Store Connect
1. Business → sign the **Paid Apps** agreement and add bank/tax details
   (products can't be sold until this is active). Enrol in the **App Store
   Small Business Program** for the 15% rate.
2. Your app → Monetization → Subscriptions → create one subscription group
   ("Pocket Coach") with these four auto-renewable products, **exactly these
   ids**:
   - `com.pocketcoach.app.pro.monthly`, `com.pocketcoach.app.pro.annual`
   - `com.pocketcoach.app.coach.monthly`, `com.pocketcoach.app.coach.annual`
   Rank Coach above Pro in the group so moving between them is an upgrade.
   Set prices per country (EUR for the EU), and add a **1-week free trial
   introductory offer** to each if you want to keep the 7-day trial.
3. App Information → **App Store Server Notifications** → Version 2, both
   Production and Sandbox URLs:
   `https://us-central1-pocketcoach-280c4.cloudfunctions.net/api/api/iap/apple/notifications`
4. Note the app's numeric **Apple ID** (App Information).
5. Users and Access → Sandbox → create a sandbox tester for your own testing.

### 2b. Backend
In the deployed `.env`: `APPLE_IAP_ENABLED=true`, `APPLE_APP_ID=<numeric Apple ID>`.
Without `APPLE_APP_ID` only sandbox purchases verify, which is enough for
TestFlight and App Review but not for real customers.

### 2c. Testing
Install a TestFlight build, buy with a sandbox tester, and check:
- `users/{uid}` gets `userPlan`, `subSource: 'apple'`, `appleOriginalTransactionId`
- Restore Purchases on a second device signed into the same account
- A renewal (sandbox renews monthly subscriptions every few minutes)
  arrives at `/notifications` and extends `subCurrentPeriodEnd`

## 3. What deliberately isn't handled yet

- Cross-platform subscription reconciliation (user has both a Stripe and an
  Apple subscription active at once).
- Apple subscription cancellation from our side — not possible; Apple is the
  merchant of record. `DELETE /account` only cancels the Stripe rail; an
  Apple subscriber must cancel via iOS Settings → [name] → Subscriptions, or
  we let it lapse naturally since deleting the account removes the Firestore
  doc that grants access either way.
- Coach-tier per-seat billing, if that's ever built — today `coach` is a
  flat-fee plan, same shape on both rails.
