const test = require('node:test');
const assert = require('node:assert/strict');
const { createClientPro, evaluate } = require('../src/clientPro');
const { createEntitlements, pickEffective } = require('../src/entitlements');
const { tierFor, decide } = require('../src/aiMeter');
const LIMITS = require('../src/config/aiLimits');

const DAY = 86400000;
const T0 = new Date('2026-10-01T12:00:00Z');
const after = d => new Date(T0.getTime() + d * DAY);

// In-memory Firestore: docs keyed by full path; collection().get() lists direct children.
function fakeDb(data = {}) {
  const store = new Map(Object.entries(data));
  const docRef = path => ({
    async get() { return { exists: store.has(path), data: () => store.get(path) }; },
    async set(v, o) { store.set(path, o && o.merge ? { ...(store.get(path) || {}), ...v } : v); },
    async delete() { store.delete(path); },
    collection: n => colRef(`${path}/${n}`),
  });
  const colRef = path => ({
    doc: id => docRef(`${path}/${id}`),
    async get() {
      const p = path + '/';
      return { docs: [...store.entries()].filter(([k]) => k.startsWith(p) && !k.slice(p.length).includes('/'))
        .map(([k, v]) => ({ id: k.slice(p.length), data: () => v })) };
    },
  });
  return { store, collection: colRef };
}

// coach "c1" coaching client "a1"
function world({ linkStatus = 'active', inviteStatus = 'active', acceptedAt = T0, clientUser = {} } = {}) {
  return fakeDb({
    'users/a1': clientUser,
    'users/a1/coachInvites/c1': { coachUsername: 'coachcarl', status: inviteStatus },
    'coaches/c1/clients/a1': { status: linkStatus, acceptedAt },
  });
}

function setup(db, { coachPlan = true, now = T0 } = {}) {
  const clock = { now };
  const plan = { has: coachPlan };
  const svc = createClientPro({ db, clock: () => clock.now, coachHasCoachPlan: async () => plan.has, log: { warn() {} } });
  const ents = createEntitlements({ db, clock: () => clock.now, log: { warn() {} } });
  const effective = () => ents.resolveEffectivePlan('a1', clock.now);
  return { svc, clock, plan, effective, ent: () => db.store.get('users/a1/entitlements/coach_client_c1') };
}

test('evaluate: the rules', () => {
  const link = { status: 'active', acceptedAt: T0 };
  assert.deepEqual(evaluate({ link, coachHasCoachPlan: true, now: after(10) }), { eligible: true, reason: null });
  assert.equal(evaluate({ link: { status: 'pending' }, coachHasCoachPlan: true, now: T0 }).reason, 'unlinked');
  assert.equal(evaluate({ link: null, coachHasCoachPlan: true, now: T0 }).reason, 'unlinked');
  assert.equal(evaluate({ link, coachHasCoachPlan: false, now: T0 }).reason, 'coach_plan_lapsed');
  assert.equal(evaluate({ link, coachHasCoachPlan: true, now: after(31) }).reason, 'inactive');
  assert.equal(evaluate({ link: { ...link, lastCoachActivityAt: after(20) }, coachHasCoachPlan: true, now: after(31) }).eligible, true);
});

test('accepting an invite from a Coach-plan coach grants Pro via coach_client', async () => {
  const db = world();
  const { svc, effective, ent } = setup(db);
  const summary = await svc.sync('a1');
  assert.equal(ent().status, 'active');
  assert.equal(ent().source, 'coach_client');
  assert.equal(ent().expiresAt, null);
  const eff = await effective();
  assert.equal(eff.plan, 'pro');
  assert.equal(eff.source, 'coach_client');
  assert.equal(summary.active, true);
  assert.equal(summary.coachName, 'coachcarl');
  assert.equal(db.store.get('coaches/c1/clients/a1').clientPro, 'active');
});

test('a pending invite gives nothing', async () => {
  const db = world({ linkStatus: 'pending', inviteStatus: 'pending', acceptedAt: null });
  const { svc, effective, ent } = setup(db);
  assert.equal(await svc.sync('a1'), null);
  assert.equal(ent(), undefined);
  assert.equal((await effective()).plan, 'free');
});

test('a coach on Pro (not Coach) gives nothing', async () => {
  const db = world();
  const { svc, ent } = setup(db, { coachPlan: false });
  await svc.sync('a1');
  assert.equal(ent(), undefined);
});

test('removing the client / the client leaving revokes; data untouched', async () => {
  const db = world();
  db.store.set('users/a1/workouts/w1', { kg: 100 });
  const { svc, effective, ent } = setup(db);
  await svc.sync('a1');
  db.store.delete('coaches/c1/clients/a1');
  db.store.delete('users/a1/coachInvites/c1');
  const summary = await svc.sync('a1');
  assert.equal(ent().status, 'revoked');
  assert.equal(ent().revokedReason, 'unlinked');
  assert.equal(summary.active, false);
  assert.equal((await effective()).plan, 'free');
  assert.deepEqual(db.store.get('users/a1/workouts/w1'), { kg: 100 });
});

test("the coach's plan ending revokes; it coming back re-grants", async () => {
  const db = world();
  const { svc, plan, ent, clock } = setup(db);
  await svc.sync('a1');
  plan.has = false;
  clock.now = after(2);
  await svc.sync('a1');
  assert.equal(ent().revokedReason, 'coach_plan_lapsed');
  plan.has = true;
  clock.now = after(4);
  const s = await svc.sync('a1');
  assert.equal(ent().status, 'active');
  assert.equal(s.regrantedAt, after(4).toISOString());
});

test('30 days without coach activity revokes; the next activity re-grants', async () => {
  const db = world();
  const { svc, ent, clock } = setup(db);
  await svc.sync('a1');
  clock.now = after(31);
  await svc.sync('a1');
  assert.equal(ent().status, 'revoked');
  assert.equal(ent().revokedReason, 'inactive');
  assert.equal(db.store.get('coaches/c1/clients/a1').clientPro, 'paused_inactive');

  clock.now = after(33);
  await svc.touch('c1', ['a1']);
  assert.equal(ent().status, 'active');
  assert.equal(db.store.get('coaches/c1/clients/a1').clientPro, 'active');
});

test('touch ignores clients not on the roster', async () => {
  const db = world();
  const { svc } = setup(db);
  await svc.touch('c1', ['stranger']);
  assert.equal(db.store.has('coaches/c1/clients/stranger'), false);
});

test("a client's own Pro subscription keeps planSource over coach_client", async () => {
  const db = world({ clientUser: { userPlan: 'pro', subSource: 'stripe', subStatus: 'active' } });
  const { svc, effective } = setup(db);
  await svc.sync('a1');
  const eff = await effective();
  assert.equal(eff.plan, 'pro');
  assert.equal(eff.source, 'stripe_sub');
});

test('ranking: own pass beats coach_client, coach_client beats a trial, coach plan beats both', () => {
  const now = T0;
  const cc = { plan: 'pro', source: 'coach_client', status: 'active', expiresAt: null };
  assert.equal(pickEffective([cc, { plan: 'pro', source: 'prep_pass', status: 'active', expiresAt: after(30) }], now).source, 'prep_pass');
  assert.equal(pickEffective([{ plan: 'pro', source: 'reverse_trial', status: 'active', expiresAt: after(10) }, cc], now).source, 'coach_client');
  assert.equal(pickEffective([cc, { plan: 'coach', source: 'stripe_sub', status: 'active', expiresAt: null }], now).plan, 'coach');
});

test('coach_client AI: 30 a month, no program generator', () => {
  const tier = tierFor('pro', 'coach_client');
  assert.equal(tier, 'coach_client');
  assert.equal(decide({ tier, feature: LIMITS.FEATURES['/generate-program'] }).code, 'plan.upgrade_required');
  assert.equal(decide({ tier, feature: LIMITS.FEATURES['/sleep-insight'], usage: { total: 29, byFeature: {} } }).ok, true);
  assert.equal(decide({ tier, feature: LIMITS.FEATURES['/sleep-insight'], usage: { total: 30, byFeature: {} } }).code, 'ai.quota_exceeded');
});
