// Stripe subscription rules shared by checkout and the webhook (server.js).
//
//   One subscription per account. Switching plan or billing cycle changes the
//   price on the live subscription instead of starting a second one, so a
//   user never pays twice and cancelling an old subscription can't wipe the
//   plan they now hold.
//   One free trial per account. Anyone who has had a Stripe subscription
//   before (we know their Stripe customer) or started a trial gets none.
//   Events for a subscription that isn't the account's current one are
//   ignored unless they bring a live subscription (which then becomes current).

// Statuses that still give access. past_due keeps access while Stripe retries.
const LIVE_STATUSES = new Set(['active', 'trialing', 'past_due']);
const STANDARD_TRIAL_DAYS = 7;

function isLiveStatus(status) {
  return LIVE_STATUSES.has(status);
}

// True once the account has had a Stripe trial or any Stripe subscription.
function trialUsed(userDoc) {
  const u = userDoc || {};
  return !!(u.stripeTrialUsedAt || u.stripeCustomerId);
}

// Trial days for a new subscription. Referral credits are earned free months
// and apply even after the standard trial is used.
function trialDaysFor({ credits = 0, userDoc } = {}) {
  const n = Number(credits) || 0;
  if (n > 0) return n * 30;
  return trialUsed(userDoc) ? 0 : STANDARD_TRIAL_DAYS;
}

// The newest live subscription in a Stripe list, or null.
function pickLiveSubscription(subscriptions) {
  const live = (subscriptions || []).filter(s => s && isLiveStatus(s.status));
  live.sort((a, b) => (b.created || 0) - (a.created || 0));
  return live[0] || null;
}

// 'same' when the live subscription already has this price, else 'switch'.
function planChange(liveSub, priceId) {
  const item = liveSub && liveSub.items && liveSub.items.data && liveSub.items.data[0];
  return item && item.price && item.price.id === priceId ? 'same' : 'switch';
}

// Whether a webhook event for subscription `subId` should be ignored because
// the account's current subscription is a different one.
//   deleted: ignored unless it is the current subscription.
//   created/updated/payment_failed: ignored unless it is current, or it is
//   live (a newer subscription replacing the recorded one).
function isStaleSubscriptionEvent(userDoc, subId, { status, deleted = false } = {}) {
  const current = userDoc && userDoc.stripeSubscriptionId;
  if (!current || !subId || current === subId) return false;
  if (deleted) return true;
  return !isLiveStatus(status);
}

module.exports = {
  LIVE_STATUSES,
  STANDARD_TRIAL_DAYS,
  isLiveStatus,
  trialUsed,
  trialDaysFor,
  pickLiveSubscription,
  planChange,
  isStaleSubscriptionEvent,
};
