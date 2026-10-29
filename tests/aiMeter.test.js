const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { createAiMeter, decide, tierFor } = require('../src/aiMeter');
const LIMITS = require('../src/config/aiLimits');

const F = LIMITS.FEATURES;

// In-memory Firestore with serialized transactions (one at a time, like
// Firestore's retry-until-consistent result).
function fakeDb() {
  const store = new Map();
  let queue = Promise.resolve();
  const ref = path => ({
    path,
    async get() { return { exists: store.has(path), data: () => store.get(path) }; },
  });
  return {
    store,
    collection: name => ({ doc: id => ref(`${name}/${id}`) }),
    runTransaction(fn) {
      const run = queue.then(async () => {
        await new Promise(r => setImmediate(r)); // let other callers interleave
        const writes = [];
        const tx = {
          get: async r => ({ exists: store.has(r.path), data: () => store.get(r.path) }),
          set: (r, v) => writes.push([r.path, v]),
        };
        const out = await fn(tx);
        for (const [p, v] of writes) store.set(p, v);
        return out;
      });
      queue = run.catch(() => {});
      return run;
    },
  };
}

const at = iso => () => new Date(iso);
const sendError = (res, status, code, message) => res.status(status).json({ success: false, error: { code, message } });

test('decide: free may use allowed features, not the program generator', () => {
  assert.deepEqual(decide({ tier: 'free', feature: F['/sleep-insight'], usage: null }), { ok: true, remaining: 4 });
  assert.equal(decide({ tier: 'free', feature: F['/generate-program'] }).code, 'plan.upgrade_required');
  assert.equal(decide({ tier: 'free', feature: F['/coach'] }).code, 'plan.upgrade_required');
  assert.equal(decide({ tier: 'free', feature: F['/coach/brief'] }).code, 'plan.upgrade_required');
});

test('decide: pro has no coach drafts', () => {
  assert.equal(decide({ tier: 'pro', feature: F['/coach-draft-message'] }).code, 'plan.upgrade_required');
  assert.equal(decide({ tier: 'coach', feature: F['/coach-draft-message'] }).ok, true);
});

test('tierFor: unknown plans are free; a matching source tier wins', () => {
  assert.equal(tierFor('pro', 'prep_pass'), 'pro');
  assert.equal(tierFor('weird', null), 'free');
  assert.equal(tierFor('pro', 'coach_client', { ...LIMITS, coach_client: { monthly: 30 } }), 'coach_client');
});

test('free: the 6th allowed call in a month is quota_exceeded', async () => {
  const db = fakeDb();
  const meter = createAiMeter({ db, resolvePlan: async () => ({}), sendError });
  const now = new Date('2026-10-29T10:00:00Z');
  for (let i = 0; i < 5; i++) {
    assert.equal((await meter.consume('u1', 'free', F['/sleep-insight'], now)).ok, true);
  }
  const sixth = await meter.consume('u1', 'free', F['/macro-advice'], now);
  assert.equal(sixth.code, 'ai.quota_exceeded');
  assert.equal(db.store.get('aiUsage/u1_2026-10').total, 5);
});

test('pro: the 11th program generation is quota_exceeded', async () => {
  const db = fakeDb();
  const meter = createAiMeter({ db, resolvePlan: async () => ({}), sendError });
  const now = new Date('2026-10-29T10:00:00Z');
  for (let i = 0; i < 10; i++) assert.equal((await meter.consume('u2', 'pro', F['/generate-program'], now)).ok, true);
  assert.equal((await meter.consume('u2', 'pro', F['/generate-program'], now)).code, 'ai.quota_exceeded');
  // other features still work
  assert.equal((await meter.consume('u2', 'pro', F['/sleep-insight'], now)).ok, true);
});

test('background AI has its own cap and does not spend credits', async () => {
  const db = fakeDb();
  const meter = createAiMeter({ db, resolvePlan: async () => ({}), sendError });
  const now = new Date('2026-10-29T10:00:00Z');
  for (let i = 0; i < 100; i++) await meter.consume('u3', 'pro', F['/coach/brief'], now);
  assert.equal((await meter.consume('u3', 'pro', F['/coach/brief'], now)).code, 'ai.quota_exceeded');
  const doc = db.store.get('aiUsage/u3_2026-10');
  assert.equal(doc.total, 0);
  assert.equal(doc.byFeature['home-brief'], 100);
});

test('concurrent requests cannot push total over the limit', async () => {
  const db = fakeDb();
  const meter = createAiMeter({ db, resolvePlan: async () => ({}), sendError });
  const now = new Date('2026-10-29T10:00:00Z');
  const results = await Promise.all(Array.from({ length: 12 }, () => meter.consume('u4', 'free', F['/sleep-insight'], now)));
  assert.equal(results.filter(r => r.ok).length, 5);
  assert.equal(db.store.get('aiUsage/u4_2026-10').total, 5);
});

test('the counter resets on the 1st (UTC)', async () => {
  const db = fakeDb();
  const meter = createAiMeter({ db, resolvePlan: async () => ({}), sendError });
  const oct = new Date('2026-10-31T23:59:59Z');
  for (let i = 0; i < 5; i++) await meter.consume('u5', 'free', F['/sleep-insight'], oct);
  assert.equal((await meter.consume('u5', 'free', F['/sleep-insight'], oct)).code, 'ai.quota_exceeded');
  const nov = new Date('2026-11-01T00:00:00Z');
  assert.equal((await meter.consume('u5', 'free', F['/sleep-insight'], nov)).ok, true);
});

test('getUsage reports used, limit and the next reset', async () => {
  const db = fakeDb();
  const meter = createAiMeter({ db, resolvePlan: async () => ({}), sendError, clock: at('2026-10-29T10:00:00Z') });
  await meter.consume('u6', 'free', F['/sleep-insight'], new Date('2026-10-29T10:00:00Z'));
  assert.deepEqual(await meter.getUsage('u6', 'free'), {
    used: 1, limit: 5, resetsAt: '2026-11-01T00:00:00.000Z', byFeature: { 'sleep-insight': 1 },
  });
});

// ── Middleware over a real Express app ───────────────────────────────────────
async function serve(meter, routes) {
  const app = express();
  app.use((req, _res, next) => { req.user = { username: req.get('x-user') }; next(); });
  app.use('/api/ai', meter.meterAi(), routes);
  const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, close: () => new Promise(r => server.close(r)) };
}

function aiRoutes() {
  const r = express.Router();
  r.post('/sleep-insight', (_req, res) => res.json({ insight: 'ok' }));
  r.post('/macro-advice', (_req, res) => res.status(502).json({ error: 'model down' }));
  r.post('/checkin-summary', (_req, res) => res.json({ summary: '', source: 'rules', aiError: 'timeout' }));
  r.post('/generate-program', (_req, res) => res.json({ ok: true }));
  r.get('/health', (_req, res) => res.json({ ok: true }));
  return r;
}

test('middleware: header, upgrade_required, quota body, refunds, admin bypass', async () => {
  const db = fakeDb();
  const meter = createAiMeter({
    db, sendError, clock: at('2026-10-29T10:00:00Z'),
    resolvePlan: async req => ({ plan: 'free', source: null, userKey: req.user.username }),
    isAdmin: u => u === 'boss',
  });
  const { base, close } = await serve(meter, aiRoutes());
  const post = (path, user = 'ann') => fetch(base + '/api/ai' + path, { method: 'POST', headers: { 'x-user': user } });
  const settle = () => new Promise(r => setTimeout(r, 20));
  try {
    let res = await post('/sleep-insight');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-ai-remaining'), '4');

    res = await post('/generate-program');
    assert.equal(res.status, 403);
    assert.equal((await res.json()).error.code, 'plan.upgrade_required');

    // Model failure (502) and a rules fallback both give the use back.
    await post('/macro-advice');
    await post('/checkin-summary');
    await settle();
    assert.equal(db.store.get('aiUsage/ann_2026-10').total, 1);

    for (let i = 0; i < 4; i++) await post('/sleep-insight');
    res = await post('/sleep-insight');
    assert.equal(res.status, 403);
    assert.deepEqual((await res.json()).error, {
      code: 'ai.quota_exceeded', message: 'Monthly AI limit reached.', resetsAt: '2026-11-01T00:00:00.000Z',
    });

    assert.equal((await post('/generate-program', 'boss')).status, 200); // admin
    assert.equal((await fetch(base + '/api/ai/health', { headers: { 'x-user': 'ann' } })).status, 200);
  } finally {
    await close();
  }
});
