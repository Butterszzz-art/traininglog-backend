const test = require('node:test');
const assert = require('node:assert/strict');
const { createCoachCodes, normalizeCode, formatCode, generateCode, wantedStatus } = require('../src/coachCode');

// Minimal in-memory Firestore: docs keyed by path.
function fakeDb() {
  const store = new Map();
  const snap = (path) => {
    const data = store.get(path);
    return { exists: data !== undefined, data: () => (data ? { ...data } : undefined), get: k => (data ? data[k] : undefined) };
  };
  const doc = (path) => ({
    get: async () => snap(path),
    set: async (data, opts) => { store.set(path, opts && opts.merge ? { ...(store.get(path) || {}), ...data } : { ...data }); },
    create: async (data) => {
      if (store.has(path)) { const e = new Error('6 ALREADY_EXISTS: doc already exists'); e.code = 6; throw e; }
      store.set(path, { ...data });
    },
    delete: async () => { store.delete(path); },
    collection: name => collection(`${path}/${name}`),
  });
  const collection = (path) => ({ doc: id => doc(`${path}/${id}`) });
  return { store, collection };
}

function setup({ coachPlan = true, randomSeq } = {}) {
  const db = fakeDb();
  const plan = { has: coachPlan, calls: 0 };
  const clock = { now: new Date('2026-11-04T10:00:00Z') };
  let i = 0;
  const randomInt = randomSeq ? () => randomSeq[i++ % randomSeq.length] : undefined;
  const svc = createCoachCodes({
    db,
    clock: () => clock.now,
    coachHasPlan: async () => { plan.calls++; return plan.has; },
    ...(randomInt ? { randomInt } : {}),
    log: { warn() {} },
  });
  return { db, plan, clock, svc };
}

const link = (db, clientUid, coachUid, status = 'active') =>
  db.store.set(`users/${clientUid}/coachInvites/${coachUid}`, { status, coachUsername: 'coachy' });

test('normalizeCode accepts dashes, spaces and lower case; rejects bad input', () => {
  assert.equal(normalizeCode(' abcd-efgh '), 'ABCDEFGH');
  assert.equal(normalizeCode('ABCD EFGH'), 'ABCDEFGH');
  assert.equal(normalizeCode('ABCDEFG'), null, 'too short');
  assert.equal(normalizeCode('ABCDEFG0'), null, '0 is not in the alphabet');
  assert.equal(normalizeCode(null), null);
  assert.equal(formatCode('ABCDEFGH'), 'ABCD-EFGH');
});

test('generateCode makes 8 characters from the alphabet', () => {
  const code = generateCode();
  assert.equal(code.length, 8);
  assert.equal(normalizeCode(code), code);
});

test('wantedStatus: no link → revoked, lapsed coach → paused', () => {
  assert.equal(wantedStatus({ linked: false, coachHasPlan: true }), 'revoked');
  assert.equal(wantedStatus({ linked: true, coachHasPlan: false }), 'paused');
  assert.equal(wantedStatus({ linked: true, coachHasPlan: true }), 'active');
});

test('getOrCreate makes one code per coach and returns it again', async () => {
  const { db, svc } = setup();
  const code = await svc.getOrCreate('c1', 'coachy');
  assert.equal(await svc.getOrCreate('c1', 'coachy'), code);
  assert.equal(db.store.get(`coachCodes/${code}`).coachUid, 'c1');
  assert.equal(db.store.get('users/c1').coachCode, code);
});

test('a taken code is skipped, never shared between coaches', async () => {
  // First two codes collide (all zeros → AAAAAAAA), third differs.
  const { svc } = setup({ randomSeq: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1] });
  const a = await svc.getOrCreate('c1', 'one');
  const b = await svc.getOrCreate('c2', 'two');
  assert.equal(a, 'AAAAAAAA');
  assert.notEqual(b, a);
});

test('regenerate retires the old code', async () => {
  const { db, svc } = setup();
  const old = await svc.getOrCreate('c1', 'coachy');
  const fresh = await svc.regenerate('c1', 'coachy');
  assert.notEqual(fresh, old);
  assert.equal(await svc.lookup(old), null);
  assert.equal((await svc.lookup(fresh)).coachUid, 'c1');
  assert.equal(db.store.get('users/c1').coachCode, fresh);
});

test('lookup finds the coach from a typed code', async () => {
  const { svc } = setup();
  const code = await svc.getOrCreate('c1', 'coachy');
  const found = await svc.lookup(formatCode(code).toLowerCase());
  assert.deepEqual(found, { code, coachUid: 'c1', coachUsername: 'coachy' });
  assert.equal(await svc.lookup('ZZZZZZZZ'), null);
  assert.equal(await svc.lookup('nope'), null);
});

test('grant writes an active Pro entitlement naming the coach', async () => {
  const { db, svc } = setup();
  await svc.grant('a1', { coachUid: 'c1', coachUsername: 'coachy', code: 'ABCDEFGH' });
  const ent = db.store.get('users/a1/entitlements/coach_code');
  assert.equal(ent.plan, 'pro');
  assert.equal(ent.source, 'coach_code');
  assert.equal(ent.ref, 'c1');
  assert.equal(ent.status, 'active');
  assert.equal(ent.expiresAt, null);
});

test('verify: null when no code was used', async () => {
  const { svc } = setup();
  assert.equal(await svc.verify('a1'), null);
});

test('verify keeps Pro active while linked and the coach has the plan', async () => {
  const { db, svc } = setup();
  link(db, 'a1', 'c1');
  await svc.grant('a1', { coachUid: 'c1', coachUsername: 'coachy' });
  assert.deepEqual(await svc.verify('a1'), { status: 'active', coachUsername: 'coachy' });
});

test('verify pauses Pro when the coach plan lapses and resumes when it returns', async () => {
  const { db, plan, clock, svc } = setup();
  link(db, 'a1', 'c1');
  await svc.grant('a1', { coachUid: 'c1', coachUsername: 'coachy' });
  plan.has = false;
  svc.forgetCoach('c1');
  assert.equal((await svc.verify('a1')).status, 'paused');
  assert.equal(db.store.get('users/a1/entitlements/coach_code').status, 'paused');
  plan.has = true;
  clock.now = new Date(clock.now.getTime() + 6 * 60 * 1000); // past the cache
  assert.equal((await svc.verify('a1')).status, 'active');
});

test('verify revokes Pro once the link is gone, and it stays revoked', async () => {
  const { db, svc } = setup();
  link(db, 'a1', 'c1');
  await svc.grant('a1', { coachUid: 'c1', coachUsername: 'coachy' });
  db.store.delete('users/a1/coachInvites/c1');
  assert.equal((await svc.verify('a1')).status, 'revoked');
  link(db, 'a1', 'c1'); // re-invited later: needs the code again
  assert.equal((await svc.verify('a1')).status, 'revoked');
});

test('a pending link does not give Pro', async () => {
  const { db, svc } = setup();
  link(db, 'a1', 'c1', 'pending');
  await svc.grant('a1', { coachUid: 'c1', coachUsername: 'coachy' });
  assert.equal((await svc.verify('a1')).status, 'revoked');
});

test('the coach plan check is cached for a few minutes', async () => {
  const { db, plan, svc } = setup();
  link(db, 'a1', 'c1');
  link(db, 'a2', 'c1');
  await svc.grant('a1', { coachUid: 'c1' });
  await svc.grant('a2', { coachUid: 'c1' });
  await svc.verify('a1');
  await svc.verify('a2');
  await svc.verify('a1');
  assert.equal(plan.calls, 1);
});

test('removeForCoach deletes only the coach\'s own code', async () => {
  const { db, svc } = setup();
  const code = await svc.getOrCreate('c1', 'coachy');
  await svc.removeForCoach('c1');
  assert.equal(db.store.has(`coachCodes/${code}`), false);
  await svc.removeForCoach('nobody'); // no-op
});
