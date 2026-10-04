// Route tests for src/routes/plans.js against an in-memory stand-in for the
// parts of Firestore it uses. Run: node scripts/test-plan-routes.js
'use strict';

const path = require('path');
const express = require('express');
const root = path.join(__dirname, '..');
const { createRegistry } = require(path.join(root, 'src', 'rules', 'registry'));
const { createCoachPlansRouter, createClientPlanRouter } = require(path.join(root, 'src', 'routes', 'plans'));

const results = [];
const check = (label, cond) => results.push({ label, pass: !!cond });

// ── In-memory Firestore ─────────────────────────────────────────────────────
function fakeDb() {
  const docs = new Map(); // "a/b/c/d" -> data
  const snap = (p, data) => ({
    id: p.split('/').pop(), exists: data !== undefined, ref: docRef(p),
    data: () => (data === undefined ? undefined : JSON.parse(JSON.stringify(data))),
    get: f => f.split('.').reduce((o, k) => (o == null ? undefined : o[k]), data),
  });
  const docRef = p => ({
    id: p.split('/').pop(),
    get: async () => snap(p, docs.get(p)),
    set: async (data, opts) => { docs.set(p, opts?.merge ? { ...(docs.get(p) || {}), ...data } : data); },
    delete: async () => { docs.delete(p); },
  });
  const coll = (p, filters = []) => ({
    doc: id => docRef(`${p}/${id}`),
    where: (f, op, v) => coll(p, [...filters, [f, v]]),
    get: async () => ({
      docs: [...docs.entries()]
        .filter(([k]) => k.startsWith(`${p}/`) && !k.slice(p.length + 1).includes('/'))
        .filter(([, d]) => filters.every(([f, v]) => f.split('.').reduce((o, k) => o?.[k], d) === v))
        .map(([k, d]) => snap(k, d)),
    }),
  });
  return {
    docs,
    collection: coll,
    batch: () => {
      const ops = [];
      return { set: (ref, data, opts) => ops.push(() => ref.set(data, opts)), commit: async () => { for (const op of ops) await op(); } };
    },
  };
}

const sendError = (res, status, code, message) => res.status(status).json({ success: false, error: { code, message } });
const sendSuccess = (res, status, data = {}) => res.status(status).json({ success: true, ...data });

(async () => {
  const db = fakeDb();
  const registry = createRegistry();
  const notified = [];
  const users = { coach: { uid: 'c1', username: 'arman' }, other: { uid: 'c2', username: 'other' }, client: { uid: 'u1', username: 'ana' } };

  // Coach c1 has client u1 and one intake lead.
  db.docs.set('coaches/c1/clients/u1', { athleteDisplayName: 'ana', status: 'active' });
  db.docs.set('coaches/c1/leads/L1', {
    naam: 'Ana', status: 'new',
    intake: { persoonsgegevens: { gewicht: 70, vetpercentage: 24, geslacht: 'vrouw', trainingservaring: 1 }, trainingsfrequentie: { huidig: 3 }, lifestyle: { activityLevel: 'licht actief' } },
    instellingen: { eiwitFactor: 2.0 },
  });

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = users[req.get('x-user')]; next(); });
  const deps = { db, FieldValue: { serverTimestamp: () => 'ts' }, registry, sendError, sendSuccess, resolveCallerUid: async u => u?.uid || null, now: () => new Date('2026-10-04T09:00:00Z') };
  app.use('/api/coach/plans', createCoachPlansRouter({ ...deps, notifyPlanPublished: async x => { notified.push(x); } }));
  app.use('/api/client/plan', createClientPlanRouter(deps));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, user, body) => {
    const r = await fetch(base + url, { method, headers: { 'content-type': 'application/json', 'x-user': user }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json() };
  };

  const req = { clientUid: 'u1', leadId: 'L1', packageId: 'physique_28', startDate: '2026-10-12', tier: 'medium' };

  let r = await call('GET', '/api/coach/plans/meta', 'coach');
  check('meta lists both packages', r.status === 200 && r.body.packages.map(p => p.id).sort().join() === 'cut_cycle_32,physique_28');

  r = await call('POST', '/api/coach/plans/preview', 'coach', req);
  check('preview returns a plan', r.status === 200 && r.body.plan.phases.length === 3);
  check('preview saves nothing', ![...db.docs.keys()].some(k => k.includes('/plans/')));
  check('lead settings are applied (protein 2.0 g/kg)', r.body.plan.phases[0].nutrition.restDay.proteinG === 140);

  r = await call('POST', '/api/coach/plans/preview', 'coach', { ...req, packageId: 'nope' });
  check('bad package → 422', r.status === 422 && r.body.error.code === 'plan.invalid_input');
  r = await call('POST', '/api/coach/plans/preview', 'other', req);
  check("another coach can't use this coach's lead", r.status === 404);

  r = await call('POST', '/api/coach/plans', 'coach', { ...req, clientUid: 'stranger' });
  check('client must be on the roster', r.status === 404 && r.body.error.code === 'coach.not_linked');

  r = await call('POST', '/api/coach/plans', 'coach', req);
  check('create saves a draft', r.status === 201 && r.body.plan.status === 'draft');
  const planId = r.body.plan.planId;
  check('draft is stored coach-side only', db.docs.has(`coaches/c1/plans/${planId}`) && !db.docs.has(`users/u1/plans/${planId}`));

  r = await call('GET', '/api/client/plan', 'client');
  check('client sees no plan before publication', r.status === 200 && r.body.plan === null);

  r = await call('GET', '/api/coach/plans?clientUid=u1', 'coach');
  check('list shows the plan summary', r.body.plans.length === 1 && r.body.plans[0].planId === planId);
  r = await call('GET', `/api/coach/plans/${planId}`, 'other');
  check("another coach can't read the plan", r.status === 404);

  r = await call('POST', `/api/coach/plans/${planId}/publish`, 'coach');
  check('publishing a draft is refused', r.status === 409 && r.body.error.code === 'plan.not_approved');

  r = await call('PATCH', `/api/coach/plans/${planId}`, 'coach', { changes: [{ path: 'phases[2].nutrition.restDay.kcal', value: 1700, reason: 'client prefers a slower cut' }] });
  check('patch applies and logs the override', r.status === 200 && r.body.plan.phases[2].nutrition.restDay.kcal === 1700 && r.body.plan.overrides.at(-1).by === 'arman');
  r = await call('PATCH', `/api/coach/plans/${planId}`, 'coach', { changes: [{ path: 'status', value: 'published' }] });
  check('status cannot be patched', r.status === 422);

  r = await call('POST', `/api/coach/plans/${planId}/approve`, 'coach');
  check('approve', r.status === 200 && r.body.plan.status === 'approved');
  r = await call('POST', `/api/coach/plans/${planId}/publish`, 'coach');
  check('publish', r.status === 200 && r.body.plan.status === 'published');
  check('published copy written for the client', db.docs.get(`users/u1/plans/${planId}`)?.status === 'published');
  check('client copy has no override log or provenance', (() => {
    const c = db.docs.get(`users/u1/plans/${planId}`);
    return !c.overrides && !c.unverifiedRules && !c.phases[0].nutrition.provenance && !c.phases[0].redFlags;
  })());
  check('coach assignment fields updated for older app screens', /Physique Plan/.test(db.docs.get('users/u1/coachAssignment/c1')?.currentProgram || ''));
  check('client was notified', notified.length === 1 && notified[0].clientUid === 'u1');

  r = await call('GET', '/api/client/plan', 'client');
  check('client now reads the published plan', r.body.plan?.planId === planId && r.body.plan.phases[2].nutrition.restDay.kcal === 1700);

  r = await call('PATCH', `/api/coach/plans/${planId}`, 'coach', { changes: [{ path: 'phases[0].nutrition.restDay.kcal', value: 1 }] });
  check('a published plan cannot be patched', r.status === 409);

  // A second plan supersedes the first on publication.
  r = await call('POST', '/api/coach/plans', 'coach', { ...req, packageId: 'cut_cycle_32' });
  const second = r.body.plan.planId;
  await call('POST', `/api/coach/plans/${second}/approve`, 'coach');
  r = await call('POST', `/api/coach/plans/${second}/publish`, 'coach');
  check('new plan records what it supersedes', r.body.plan.supersedes === planId);
  check('previous plan marked superseded on both sides', db.docs.get(`users/u1/plans/${planId}`).status === 'superseded' && db.docs.get(`coaches/c1/plans/${planId}`).status === 'superseded');
  r = await call('GET', '/api/client/plan', 'client');
  check('client reads only the newest plan', r.body.plan.planId === second);

  r = await call('GET', '/api/coach/plans/not-an-id', 'coach');
  check('invalid plan id → 422', r.status === 422);

  server.close();
  for (const x of results) console.log(`${x.pass ? 'PASS' : 'FAIL'}  ${x.label}`);
  const failed = results.filter(x => !x.pass).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})();
