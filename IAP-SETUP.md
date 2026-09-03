# Payment System — Stripe Webhook + Apple IAP Skeleton

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

## 2. Apple IAP — skeleton, several manual steps before this can go live

Why this exists at all: Apple Guideline 3.1.1 requires digital subscriptions
that unlock features *inside* the app to go through StoreKit on iOS — Stripe
checkout cannot be the purchase path in the App Store build. `APPLE_IAP_ENABLED`
defaults to `false`; every `/api/iap/apple/*` route 503s until it's explicitly
turned on, so an unfinished integration can't silently grant free access.

### 2a. App Store Connect

1. Create the app record (bundle id `com.pocketcoach.app`, matching
   `capacitor.config.json`) if it doesn't exist yet.
2. Monetization → Subscriptions → create a subscription group (e.g. "Pocket
   Coach Pro") with monthly/annual products. Update `APPLE_PRODUCT_PLAN_MAP`
   in `server.js` with the real product ids — the ones currently in the code
   (`com.pocketcoach.app.pro.monthly` etc.) are placeholders.
3. Users and Access → Integrations → In-App Purchase → generate an **App
   Store Server API key** (`.p8` file, Key ID, Issuer ID).
4. App Information → App Store Server Notifications — set both the
   Production and Sandbox URLs to `https://<your-backend>/api/iap/apple/notifications`.

### 2b. Backend

1. `npm install @apple/app-store-server-library` (already in `package.json`,
   just needs installing) — this is Apple's own library. It verifies the JWS
   signature chain up to Apple's Root CA, which is the one part of this that
   must not be hand-rolled: skip proper chain verification and anyone can
   POST a self-signed payload and grant themselves Pro for free. Confirm the
   `SignedDataVerifier` method names used in `server.js`
   (`verifyAndDecodeNotification`, `verifyAndDecodeTransaction`) against
   whatever version actually installs — they were written from the library's
   documented shape, not tested against a running instance.
2. Download Apple's Root CA - G3 certificate(s) from
   https://www.apple.com/certificateauthority/ and load them into the
   `appleRootCAs` array in `server.js` (currently empty, which is also why
   `appleSignedDataVerifier` can't verify anything until this is done).
3. Set `APPLE_IAP_SANDBOX=true`, `APPLE_BUNDLE_ID`, and flip
   `APPLE_IAP_ENABLED=true` only after sandbox testing passes.

### 2c. Frontend (not started)

- `src/js/payments.js` has the platform abstraction (`getEntitlement`,
  `purchase`, `restore`) but `purchaseViaIAP`/`restoreViaIAP` are stubs — they
  need a real Capacitor IAP plugin, which needs `ios/` to exist first (see the
  App Store readiness notes — no iOS platform has been generated locally yet).
- At purchase time, the client must set `appAccountToken` to the user's
  Firestore `uid` when starting the StoreKit purchase — that's how
  `/api/iap/apple/notifications` links an Apple transaction back to a Pocket
  Coach account (Apple's notifications carry a product id and transaction id,
  never a username).
- After a successful purchase, call `POST /api/iap/apple/verify` with
  StoreKit 2's `Transaction.jsonRepresentation` — this applies the
  entitlement immediately rather than waiting on the (sometimes delayed)
  server notification.

### 2d. Testing

Use App Store Connect's Sandbox testers (Users and Access → Sandbox) and a
TestFlight or local Xcode build — StoreKit purchases cannot be tested from a
plain web browser. Confirm both an initial purchase (`/api/iap/apple/verify`)
and a background renewal (`/api/iap/apple/notifications`, `DID_RENEW`) land
correctly on `users/{uid}`.

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
