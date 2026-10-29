// node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const { createEntitlements, pickEffective, legacyEntitlement } = require('../src/entitlements');

const NOW = new Date('2026-10-29T12:00:00Z');
const days = n => new Date(NOW.getTime() + n * 86400000);

// Minimal in-memory stand-in for the Firestore calls entitlements.js makes.
function fakeDb(data = {}) {
  const store = new Map(Object.entries(data)); // path -> doc data
  const docRef = path => ({
    async get() { return { exists: store.has(path), data: () => store.get(path) }; },
    async set(value, opts) {
      store.set(path, opts && opts.merge ? { ...(store.get(path) || {}), ...value } : value);
    },
    collection: name => colRef(`${path}/${name}`),
  });
  const colRef = path => ({
    doc: id => docRef(`${path}/${id}`),
    async get() {
      const prefix = path + '/';
      const docs = [...store.entries()]
        .filter(([k]) => k.startsWith(prefix) && !k.slice(prefix.length).includes('/'))
        .map(([k, v]) => ({ id: k.slice(prefix.length), data: () => v }));
      return { docs };
    },
  });
  return { store, collection: name => colRef(name) };
}

test('no entitlements → free', () => {
  assert.equal(pickEffective([], NOW).plan, 'free');
});

test('coach beats pro', () => {
  const r = pickEffective([
    { id: 'a', plan: 'pro', source: 'founder_lifetime', status: 'active', expiresAt: null },
    { id: 'b', plan: 'coach', source: 'stripe_sub', status: 'active', expiresAt: days(3) },
  ], NOW);
  assert.equal(r.plan, 'coach');
  assert.equal(r.source, 'stripe_sub');
});

test('expired, revoked and not-yet-started entitlements are ignored', () => {
  const r = pickEffective([
    { plan: 'coach', source: 'admin', status: 'active', expiresAt: days(-1) },
    { plan: 'coach', source: 'stripe_sub', status: 'revoked', expiresAt: null },
    { plan: 'coach', source: 'prep_pass', status: 'active', startsAt: days(5), expiresAt: days(60) },
  ], NOW);
  assert.equal(r.plan, 'free');
});

test('expiry exactly now counts as expired', () => {
  assert.equal(pickEffective([{ plan: 'pro', status: 'active', expiresAt: NOW }], NOW).plan, 'free');
});

test('lifetime (no expiry) beats a pass', () => {
  const r = pickEffective([
    { plan: 'pro', source: 'prep_pass', status: 'active', expiresAt: days(100) },
    { plan: 'pro', source: 'founder_lifetime', status: 'active', expiresAt: null },
  ], NOW);
  assert.equal(r.source, 'founder_lifetime');
  assert.equal(r.expiresAt, null);
});

test('two passes pick the later expiry', () => {
  const r = pickEffective([
    { id: 'p1', plan: 'pro', source: 'meet_pass', status: 'active', expiresAt: days(20) },
    { id: 'p2', plan: 'pro', source: 'prep_pass', status: 'active', expiresAt: days(90) },
  ], NOW);
  assert.equal(r.id, 'p2');
  assert.deepEqual(r.expiresAt, days(90));
});

test('Firestore Timestamps and ISO strings both work', () => {
  const ts = { toDate: () => days(10) };
  assert.equal(pickEffective([{ plan: 'pro', status: 'active', expiresAt: ts }], NOW).plan, 'pro');
  assert.equal(pickEffective([{ plan: 'pro', status: 'active', expiresAt: days(-2).toISOString() }], NOW).plan, 'free');
});

test('legacy user-doc plan maps to its subscription source', () => {
  assert.equal(legacyEntitlement({ userPlan: 'pro', subSource: 'stripe' }).source, 'stripe_sub');
  assert.equal(legacyEntitlement({ userPlan: 'coach', subSource: 'apple' }).source, 'apple_sub');
  assert.equal(legacyEntitlement({ userPlan: 'pro' }).source, 'admin');
  assert.equal(legacyEntitlement({ userPlan: 'free' }), null);
});

test('resolveEffectivePlan: existing subscriber with no entitlement docs keeps their plan', async () => {
  const db = fakeDb({ 'users/u1': { userPlan: 'coach', subSource: 'stripe', subStatus: 'active' } });
  const ents = createEntitlements({ db, clock: () => NOW });
  const r = await ents.resolveEffectivePlan('u1');
  assert.equal(r.plan, 'coach');
  assert.equal(r.source, 'stripe_sub');
});

test('resolveEffectivePlan: a pass upgrades a free account and lapsed docs get marked expired', async () => {
  const db = fakeDb({
    'users/u2': { userPlan: 'free' },
    'users/u2/entitlements/old': { plan: 'pro', source: 'meet_pass', status: 'active', expiresAt: days(-1) },
    'users/u2/entitlements/new': { plan: 'pro', source: 'prep_pass', status: 'active', expiresAt: days(30) },
  });
  const ents = createEntitlements({ db, clock: () => NOW, log: { warn() {} } });
  const r = await ents.resolveEffectivePlan('u2');
  assert.equal(r.plan, 'pro');
  assert.equal(r.source, 'prep_pass');
  await new Promise(res => setImmediate(res));
  assert.equal(db.store.get('users/u2/entitlements/old').status, 'expired');
});

test('mirrorSubscription: active, then cancelled, then refunded', async () => {
  const db = fakeDb({ 'users/u3': {} });
  const ents = createEntitlements({ db, clock: () => NOW });
  await ents.mirrorSubscription('u3', { plan: 'pro', status: 'active', rail: 'stripe', ref: 'cus_1' });
  let doc = db.store.get('users/u3/entitlements/stripe_sub');
  assert.equal(doc.status, 'active');
  assert.equal(doc.expiresAt, null);
  assert.deepEqual(doc.startsAt, NOW);

  await ents.mirrorSubscription('u3', { plan: 'free', status: 'canceled', rail: 'stripe', ref: 'cus_1' });
  doc = db.store.get('users/u3/entitlements/stripe_sub');
  assert.equal(doc.status, 'expired');
  assert.equal(doc.plan, 'pro'); // keeps what it was for history

  await ents.mirrorSubscription('u3', { plan: 'free', status: 'canceled', rail: 'apple', revoked: true });
  assert.equal(db.store.get('users/u3/entitlements/apple_sub').status, 'revoked');
});

test('mirrorSubscription: past_due stays active (Stripe is still retrying)', async () => {
  const db = fakeDb({ 'users/u4': {} });
  const ents = createEntitlements({ db, clock: () => NOW });
  await ents.mirrorSubscription('u4', { plan: 'coach', status: 'past_due', rail: 'stripe' });
  assert.equal(db.store.get('users/u4/entitlements/stripe_sub').status, 'active');
});
