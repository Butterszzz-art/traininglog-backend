const test = require('node:test');
const assert = require('node:assert/strict');
const sb = require('../src/stripeBilling');
const { legacyEntitlement, pickEffective } = require('../src/entitlements');

test('trial: 7 days for a new account, none once a trial or subscription happened', () => {
  assert.equal(sb.trialDaysFor({ userDoc: {} }), 7);
  assert.equal(sb.trialDaysFor({ userDoc: { stripeTrialUsedAt: '2026-11-01T00:00:00Z' } }), 0);
  assert.equal(sb.trialDaysFor({ userDoc: { stripeCustomerId: 'cus_1' } }), 0);
  assert.equal(sb.trialDaysFor({}), 7);
});

test('trial: referral credits still give free months', () => {
  assert.equal(sb.trialDaysFor({ credits: 2, userDoc: { stripeCustomerId: 'cus_1' } }), 60);
});

test('pickLiveSubscription: newest live one, ignores ended', () => {
  const subs = [
    { id: 'a', status: 'canceled', created: 30 },
    { id: 'b', status: 'active', created: 10 },
    { id: 'c', status: 'trialing', created: 20 },
  ];
  assert.equal(sb.pickLiveSubscription(subs).id, 'c');
  assert.equal(sb.pickLiveSubscription([{ id: 'x', status: 'incomplete_expired' }]), null);
  assert.equal(sb.pickLiveSubscription(undefined), null);
});

test('planChange: same price vs switch', () => {
  const live = { items: { data: [{ id: 'si_1', price: { id: 'price_pro_m' } }] } };
  assert.equal(sb.planChange(live, 'price_pro_m'), 'same');
  assert.equal(sb.planChange(live, 'price_coach_m'), 'switch');
});

test('stale events: deleting an old subscription never ends the current one', () => {
  const doc = { stripeSubscriptionId: 'sub_new' };
  assert.equal(sb.isStaleSubscriptionEvent(doc, 'sub_old', { deleted: true }), true);
  assert.equal(sb.isStaleSubscriptionEvent(doc, 'sub_new', { deleted: true }), false);
  assert.equal(sb.isStaleSubscriptionEvent(doc, 'sub_old', { status: 'canceled' }), true);
  // A live subscription replaces the recorded one.
  assert.equal(sb.isStaleSubscriptionEvent(doc, 'sub_other', { status: 'active' }), false);
  // Nothing recorded yet (older accounts): handle as before.
  assert.equal(sb.isStaleSubscriptionEvent({}, 'sub_old', { deleted: true }), false);
});

test('legacy plan stops counting once the subscription has ended', () => {
  for (const subStatus of ['unpaid', 'canceled', 'incomplete_expired']) {
    assert.equal(legacyEntitlement({ userPlan: 'pro', subSource: 'stripe', subStatus }), null);
    assert.equal(legacyEntitlement({ userPlan: 'pro', subSource: 'apple', subStatus }), null);
  }
  assert.equal(pickEffective([legacyEntitlement({ userPlan: 'pro', subSource: 'stripe', subStatus: 'unpaid' })].filter(Boolean)).plan, 'free');
  // Still live while Stripe retries, and plans set by hand are untouched.
  assert.equal(legacyEntitlement({ userPlan: 'pro', subSource: 'stripe', subStatus: 'past_due' }).plan, 'pro');
  assert.equal(legacyEntitlement({ userPlan: 'pro', subStatus: 'canceled' }).source, 'admin');
});
