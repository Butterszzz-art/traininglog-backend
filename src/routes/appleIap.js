// Apple In-App Purchase — the iOS payment rail (Stripe stays for web/Android).
//
// Apple Guideline 3.1.1: digital subscriptions sold inside the iOS app must
// use StoreKit. The app (src/js/payments.js in TrainingLog-mobile) buys with
// @capgo/native-purchases, then sends the StoreKit 2 signed transaction here.
// Both rails converge on applyEntitlement() in server.js.
//
// Routes (mounted at /api/iap/apple):
//   GET  /account-token   (auth)  the UUID the app passes to StoreKit as
//                                 appAccountToken — Apple requires a UUID, and
//                                 Firebase uids aren't, so each user gets one
//                                 stored as users/{uid}.appleAccountToken
//   POST /verify          (auth)  { signedTransaction } right after a purchase
//                                 or restore; grants the plan immediately
//   POST /notifications   (none)  App Store Server Notifications V2 — renewals,
//                                 expiries, refunds
//
// Verification: every JWS is checked up to Apple Root CA - G3 by Apple's own
// library. Production AND sandbox are accepted (production first) — App
// Review and TestFlight always buy in the sandbox, so a production-only
// backend fails review.
const express = require('express');
const crypto = require('crypto');

const PRODUCT_PLAN_MAP = {
  'com.pocketcoach.app.pro.monthly':   { plan: 'pro',   billingCycle: 'monthly' },
  'com.pocketcoach.app.pro.annual':    { plan: 'pro',   billingCycle: 'annual'  },
  'com.pocketcoach.app.coach.monthly': { plan: 'coach', billingCycle: 'monthly' },
  'com.pocketcoach.app.coach.annual':  { plan: 'coach', billingCycle: 'annual'  },
};

// Builds one SignedDataVerifier per environment we accept. Production needs
// the app's numeric Apple ID (App Store Connect → App Information → Apple ID),
// so until APPLE_APP_ID is set only sandbox purchases verify.
function createAppleVerifiers({ SignedDataVerifier, Environment, rootCertificates, bundleId, appAppleId }) {
  const verifiers = [];
  if (appAppleId) {
    verifiers.push(new SignedDataVerifier(rootCertificates, true, Environment.PRODUCTION, bundleId, Number(appAppleId)));
  }
  verifiers.push(new SignedDataVerifier(rootCertificates, true, Environment.SANDBOX, bundleId));
  return verifiers;
}

// Tries each verifier in turn (production first); the first that accepts the
// JWS wins. Throws the last error if none do.
async function verifyWithAny(verifiers, method, jws) {
  let lastErr = new Error('No Apple verifiers configured');
  for (const verifier of verifiers) {
    try {
      return await verifier[method](jws);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

// Maps Apple's V2 notificationType to an entitlement change. Anything not
// listed (SUBSCRIBED, DID_RENEW, DID_CHANGE_RENEWAL_STATUS, …) means "still
// active" — the transaction's own expiresDate is what actually gates access.
function entitlementFromNotification(notificationType) {
  if (['REFUND', 'REVOKE'].includes(notificationType)) {
    return { plan: 'free', status: 'canceled', revoked: true };
  }
  if (['EXPIRED', 'GRACE_PERIOD_EXPIRED'].includes(notificationType)) {
    return { plan: 'free', status: 'canceled' };
  }
  if (notificationType === 'DID_FAIL_TO_RENEW') return { status: 'past_due' };
  return { status: 'active' };
}

function isTransactionActive(tx, nowMs) {
  if (tx.revocationDate) return false;
  return !tx.expiresDate || Number(tx.expiresDate) > nowMs;
}

function createAppleIapRouter({
  db, enabled, verifiers, applyEntitlement, resolveUid, authenticate, sendError, sendSuccess,
  productPlanMap = PRODUCT_PLAN_MAP, now = () => Date.now(), randomUUID = () => crypto.randomUUID(),
}) {
  const router = express.Router();
  const users = () => db.collection('users');
  const ready = () => enabled && verifiers.length > 0;

  async function callerUid(req) {
    return req.user?.uid || (await resolveUid(req.user?.username)) || null;
  }

  async function uidForTransaction(tx) {
    if (tx.appAccountToken) {
      const snap = await users().where('appleAccountToken', '==', String(tx.appAccountToken).toLowerCase()).limit(1).get();
      if (!snap.empty) return snap.docs[0].id;
    }
    if (tx.originalTransactionId) {
      const snap = await users().where('appleOriginalTransactionId', '==', String(tx.originalTransactionId)).limit(1).get();
      if (!snap.empty) return snap.docs[0].id;
    }
    return null;
  }

  // GET /account-token — creates the user's token on first use.
  router.get('/account-token', authenticate, async (req, res) => {
    if (!ready()) return sendError(res, 503, 'iap.apple_disabled', 'In-app purchases aren’t available yet.');
    try {
      const uid = await callerUid(req);
      if (!uid) return sendError(res, 400, 'iap.no_account', 'No account found for this session.');
      const ref = users().doc(uid);
      const snap = await ref.get();
      let token = snap.exists ? snap.get('appleAccountToken') : null;
      if (!token) {
        token = randomUUID().toLowerCase();
        await ref.set({ appleAccountToken: token }, { merge: true });
      }
      return sendSuccess(res, 200, { appAccountToken: token });
    } catch (err) {
      console.error('[Apple IAP] account-token failed:', err.message);
      return sendError(res, 500, 'iap.server_error', 'Could not start the purchase.');
    }
  });

  // POST /verify — { signedTransaction }. Only grants access for a live
  // transaction bought by THIS account (its appAccountToken), so one person
  // can't share a receipt to unlock someone else's account.
  router.post('/verify', authenticate, async (req, res) => {
    if (!ready()) return sendError(res, 503, 'iap.apple_disabled', 'In-app purchases aren’t available yet.');
    const { signedTransaction } = req.body || {};
    if (!signedTransaction) return sendError(res, 400, 'iap.missing_transaction', 'signedTransaction is required.');

    let tx;
    try {
      tx = await verifyWithAny(verifiers, 'verifyAndDecodeTransaction', signedTransaction);
    } catch (err) {
      console.error('[Apple IAP] Transaction verification failed:', err.message);
      return sendError(res, 400, 'iap.verification_failed', 'Could not verify the purchase with Apple.');
    }

    try {
      const mapped = productPlanMap[tx.productId];
      if (!mapped) return sendError(res, 400, 'iap.unknown_product', 'Unrecognized product.');

      const uid = await callerUid(req);
      if (!uid) return sendError(res, 400, 'iap.no_account', 'No account found for this session.');
      const snap = await users().doc(uid).get();
      const token = snap.exists ? snap.get('appleAccountToken') : null;
      if (!token || String(tx.appAccountToken || '').toLowerCase() !== token) {
        return sendError(res, 403, 'iap.account_mismatch',
          'This subscription was bought from a different Pocket Coach account. Sign in to that account to use it.');
      }

      if (!isTransactionActive(tx, now())) {
        return sendSuccess(res, 200, { active: false, plan: snap.get('userPlan') || 'free' });
      }

      await applyEntitlement({
        uid, plan: mapped.plan, status: 'active', billingCycle: mapped.billingCycle,
        periodEnd: tx.expiresDate ? new Date(Number(tx.expiresDate)).toISOString() : null,
        source: 'apple', sourceCustomerId: String(tx.originalTransactionId || ''),
      });
      return sendSuccess(res, 200, { active: true, plan: mapped.plan });
    } catch (err) {
      console.error('[Apple IAP] verify failed:', err.message);
      return sendError(res, 500, 'iap.server_error', 'Could not apply the purchase.');
    }
  });

  // POST /notifications — Apple retries on non-2xx, so answer 200 once the
  // payload is applied or safely ignorable.
  router.post('/notifications', async (req, res) => {
    if (!ready()) {
      console.warn('[Apple IAP] Notification received but IAP is not enabled/configured — ignoring.');
      return res.status(503).send('Apple IAP not configured');
    }
    const signedPayload = req.body?.signedPayload;
    if (!signedPayload) return res.status(400).send('Missing signedPayload');

    let notification;
    let tx = null;
    try {
      notification = await verifyWithAny(verifiers, 'verifyAndDecodeNotification', signedPayload);
      if (notification.data?.signedTransactionInfo) {
        tx = await verifyWithAny(verifiers, 'verifyAndDecodeTransaction', notification.data.signedTransactionInfo);
      }
    } catch (err) {
      console.error('[Apple IAP] Notification verification failed:', err.message);
      return res.status(400).send('Invalid notification');
    }

    try {
      if (!tx?.productId) return res.status(200).send();
      const mapped = productPlanMap[tx.productId];
      if (!mapped) {
        console.warn(`[Apple IAP] Unrecognized productId "${tx.productId}".`);
        return res.status(200).send();
      }
      const uid = await uidForTransaction(tx);
      if (!uid) {
        console.warn(`[Apple IAP] ${notification.notificationType}: no account for transaction ${tx.originalTransactionId}.`);
        return res.status(200).send();
      }
      const derived = entitlementFromNotification(notification.notificationType);
      await applyEntitlement({
        uid,
        plan: derived.plan || mapped.plan,
        status: derived.status,
        billingCycle: mapped.billingCycle,
        periodEnd: tx.expiresDate ? new Date(Number(tx.expiresDate)).toISOString() : null,
        source: 'apple',
        sourceCustomerId: String(tx.originalTransactionId || ''),
        revoked: derived.revoked === true,
      });
      return res.status(200).send();
    } catch (err) {
      console.error('[Apple IAP] Failed handling notification:', err.message);
      return res.status(500).send('Notification handler failed');
    }
  });

  return router;
}

module.exports = {
  createAppleIapRouter, createAppleVerifiers, verifyWithAny, entitlementFromNotification,
  isTransactionActive, PRODUCT_PLAN_MAP,
};
