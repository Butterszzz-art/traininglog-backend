// pocketcoach.plan/2: schema reader, phase ops, revise, and the coach plan
// routes end to end with Gael's plan (Cut 12 wk → Maintain 3 wk → Deload 1 wk,
// X-frame linked per phase, training/rest-day nutrition).
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const fs = require('fs');
const path = require('path');
const { createRegistry } = require('../src/rules/registry');
const { createCoachPlansRouter, createClientPlanRouter } = require('../src/routes/plans');
const schema = require('../src/plan/schema');
const lifecycle = require('../src/plan/lifecycle');
const imp = require('../src/coach/programImport');

const registry = createRegistry();
const v1Fixture = () => ({
  schema: 'pocketcoach.plan/1', planId: 'pln_00000000-0000-4000-8000-000000000001', status: 'published', version: 1, supersedes: null,
  client: { uid: 'u1', coachUid: 'c1' },
  package: { id: 'cut_cycle_32', name: 'Cut Cycle', tier: 'medium', totalWeeks: 16, billing: { blockWeeks: 4, blocks: 4, startDate: '2026-11-09' } },
  phases: [
    { phaseId: 'ph1', order: 1, type: 'cut', goal: 'vetverlies', plannedStart: '2026-11-09', plannedEnd: '2027-01-31', caps: { maxWeeks: 12 }, endCriteria: { any: [{ kind: 'timeCap', weeks: 12 }] },
      nutrition: { restDay: { kcal: 2000, proteinG: 165, fatG: 65, carbG: 190 }, trainingDay: { kcal: 2350, proteinG: 165, fatG: 65, carbG: 275 } }, training: { programRef: null } },
    { phaseId: 'ph2', order: 2, type: 'maintain', goal: 'onderhoud', plannedStart: '2027-02-01', plannedEnd: '2027-02-28', caps: { maxWeeks: 4 }, endCriteria: { any: [{ kind: 'timeCap', weeks: 4 }] },
      nutrition: { restDay: { kcal: 2700, proteinG: 165, fatG: 65, carbG: 364 }, trainingDay: { kcal: 2700, proteinG: 165, fatG: 65, carbG: 364 } }, training: { programRef: null } },
  ],
  overrides: [], adjustments: [], approval: { publishedAt: '2026-11-01T00:00:00Z' },
});

test('upgradePlan reads /1: weeks, startWeek, startDate, source; idempotent', () => {
  const p = schema.upgradePlan(v1Fixture());
  assert.equal(p.schema, 'pocketcoach.plan/2');
  assert.equal(p.startDate, '2026-11-09');
  assert.deepEqual(p.phases.map(x => [x.startWeek, x.weeks, x.plannedStart, x.plannedEnd, x.nutrition.source]),
    [[1, 12, '2026-11-09', '2027-01-31', 'generated'], [13, 4, '2027-02-01', '2027-02-28', 'generated']]);
  assert.deepEqual(schema.upgradePlan(p), p);
});

test('ops: reshape Cut Cycle into 12/3/1 with a deload; every op logged with the reason', () => {
  let p = schema.blankPlan({ registry, packageId: 'cut_cycle_32', startDate: '2026-11-09', tier: 'medium', client: { uid: 'u1', coachUid: 'c1' }, now: new Date('2026-11-01') });
  assert.deepEqual(p.phases.map(x => x.weeks), [12, 4, 12, 4]);
  assert.throws(() => lifecycle.applyOps(p, [{ op: 'removePhase', phaseId: 'ph4' }], { by: 'coach', reason: ' ' }), { code: 'plan.reason_required' });
  p = lifecycle.applyOps(p, [
    { op: 'removePhase', phaseId: 'ph4' },
    { op: 'setPhase', phaseId: 'ph2', weeks: 3, goalText: 'Hold the new weight' },
    { op: 'setPhase', phaseId: 'ph3', type: 'deload', weeks: 1 },
    { op: 'setNutrition', phaseId: 'ph1', dayType: 'trainingDay', kcal: 2350, proteinG: 165, carbG: 275, fatG: 65 },
    { op: 'setNutrition', phaseId: 'ph1', dayType: 'restDay', kcal: 2000, proteinG: 165, carbG: 190, fatG: 65 },
    { op: 'setNutrition', phaseId: 'ph2', dayType: 'both', kcal: 2700, proteinG: 165, carbG: 364, fatG: 65 },
    { op: 'setNutrition', phaseId: 'ph3', dayType: 'both', kcal: 2700, proteinG: 165, carbG: 364, fatG: 65 },
  ], { by: 'coach', reason: 'Gael: 16-week cut cycle agreed at intake', at: new Date('2026-11-01T10:00:00Z') });
  assert.deepEqual(p.phases.map(x => [x.type, x.startWeek, x.weeks, x.plannedStart, x.plannedEnd]), [
    ['cut', 1, 12, '2026-11-09', '2027-01-31'],
    ['maintain', 13, 3, '2027-02-01', '2027-02-21'],
    ['deload', 16, 1, '2027-02-22', '2027-02-28'],
  ]);
  assert.equal(p.package.totalWeeks, 16);
  assert.deepEqual(p.phases[0].nutrition.restDay, { kcal: 2000, proteinG: 165, carbG: 190, fatG: 65 });
  assert.equal(p.overrides.length, 3 + 2 + 2 + 2); // 3 phase ops, ph1 ×2, and ph2/ph3 'both' log one entry per day type
  assert.ok(p.overrides.every(o => o.reason === 'Gael: 16-week cut cycle agreed at intake' && o.by === 'coach'));
  assert.deepEqual(p.overrides[1], { at: '2026-11-01T10:00:00.000Z', by: 'coach', op: 'setPhase', phaseId: 'ph2', from: { type: 'maintain', weeks: 4, goalText: '' }, to: { type: 'maintain', weeks: 3, goalText: 'Hold the new weight' }, reason: 'Gael: 16-week cut cycle agreed at intake' });
});

test('ops: add, move, bad input; editing an approved plan sends it back to draft', () => {
  let p = schema.blankPlan({ registry, packageId: 'physique_28', startDate: '2026-11-09', tier: 'medium' });
  p = lifecycle.applyOps(p, [{ op: 'addPhase', type: 'deload', weeks: 1, afterPhaseId: 'ph1' }], { by: 'c', reason: 'x' });
  assert.deepEqual(p.phases.map(x => [x.phaseId, x.type]), [['ph1', 'build'], ['ph4', 'deload'], ['ph2', 'maintain'], ['ph3', 'cut']]);
  p = lifecycle.applyOps(p, [{ op: 'movePhase', phaseId: 'ph4', toIndex: 3 }], { by: 'c', reason: 'x' });
  assert.equal(p.phases[3].phaseId, 'ph4');
  assert.equal(p.phases[3].startWeek, 29);
  for (const bad of [{ op: 'setPhase', phaseId: 'ph1', type: 'bulk' }, { op: 'setPhase', phaseId: 'ph1', weeks: 0 }, { op: 'setNutrition', phaseId: 'ph1', dayType: 'restDay', kcal: 50 },
    { op: 'setStart', startDate: '2026-11-10' }, { op: 'nope' }, { op: 'removePhase', phaseId: 'ph9' }]) {
    assert.throws(() => lifecycle.applyOps(p, [bad], { by: 'c', reason: 'x' }), /./, JSON.stringify(bad));
  }
  const approved = lifecycle.approve(p, { by: 'c' });
  const edited = lifecycle.applyOps(approved, [{ op: 'setStart', startDate: '2026-11-16' }], { by: 'c', reason: 'Start a week later' });
  assert.equal(edited.status, 'draft');
  assert.equal(edited.phases[0].plannedStart, '2026-11-16');
});

test('path changes on /2 need a reason and keep weeks/dates in step', () => {
  const p = schema.upgradePlan({ ...v1Fixture(), status: 'draft' });
  assert.throws(() => lifecycle.applyOverride(p, { path: 'phases[0].nutrition.restDay.kcal', value: 1900, by: 'c', reason: '' }), { code: 'plan.reason_required' });
  const q = lifecycle.applyOverride(p, { path: 'phases[0].caps.maxWeeks', value: 10, by: 'c', reason: 'shorter cut' });
  assert.equal(q.phases[0].weeks, 10);
  assert.equal(q.phases[1].plannedStart, '2027-01-18');
  const r = lifecycle.applyOverride(p, { path: 'phases[0].nutrition.restDay.kcal', value: 1950, by: 'c', reason: 'stall' });
  assert.equal(r.phases[0].nutrition.source, 'coach');
});

test('revise: new draft version that supersedes the published one', () => {
  const pub = v1Fixture();
  const next = lifecycle.revise(pub, { by: 'c', newPlanId: 'pln_00000000-0000-4000-8000-000000000002', at: new Date('2026-12-01') });
  assert.deepEqual([next.status, next.version, next.supersedes, next.schema], ['draft', 2, pub.planId, 'pocketcoach.plan/2']);
  assert.equal(next.overrides.at(-1).op, 'revise');
  assert.throws(() => lifecycle.revise({ ...pub, status: 'draft' }, { by: 'c', newPlanId: 'x' }), { code: 'plan.not_published' });
});

// ── routes, end to end ──────────────────────────────────────────────────────

function fakeDb() {
  const docs = new Map();
  const snap = (p, data) => ({
    id: p.split('/').pop(), exists: data !== undefined, ref: docRef(p),
    data: () => (data === undefined ? undefined : JSON.parse(JSON.stringify(data))),
    get: f => f.split('.').reduce((o, k) => (o == null ? undefined : o[k]), data),
  });
  const docRef = p => ({
    id: p.split('/').pop(),
    get: async () => snap(p, docs.get(p)),
    set: async (data, opts) => { docs.set(p, JSON.parse(JSON.stringify(opts?.merge ? { ...(docs.get(p) || {}), ...data } : data))); },
  });
  const coll = (p, filters = []) => ({
    doc: id => docRef(`${p}/${id}`),
    where: (f, _op, v) => coll(p, [...filters, [f, v]]),
    get: async () => ({
      docs: [...docs.entries()]
        .filter(([k]) => k.startsWith(`${p}/`) && !k.slice(p.length + 1).includes('/'))
        .filter(([, d]) => filters.every(([f, v]) => f.split('.').reduce((o, k) => o?.[k], d) === v))
        .map(([k, d]) => snap(k, d)),
    }),
  });
  return {
    docs, collection: coll,
    batch: () => { const ops = []; return { set: (ref, data, opts) => ops.push(() => ref.set(data, opts)), commit: async () => { for (const op of ops) await op(); } }; },
  };
}

async function server() {
  const db = fakeDb();
  const coachShare = require('../src/coachShare');
  const { parseTables } = require('../src/coach/tableImport');
  const file = imp.readImportFile({ fileName: 'x.xlsx', data: fs.readFileSync(path.join(__dirname, 'fixtures', 'gael-xframe-weeks-1-4.xlsx')).toString('base64') });
  db.docs.set('coaches/c1/clients/u1', { status: 'active' });
  db.docs.set('coaches/c1/programs/prog_xframe', { ...coachShare.sanitizeCoachProgram(parseTables(file.sheets).program), updatedAt: '2026-11-01T09:00:00Z' });
  db.docs.set('coaches/c1/leads/L1', {
    naam: 'Gael', intake: { persoonsgegevens: { gewicht: 84, vetpercentage: 18, geslacht: 'man', trainingservaring: 1 }, trainingsfrequentie: { huidig: 4 }, lifestyle: { activityLevel: 'actief' } },
  });
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use((req, _res, next) => { req.user = { coach: { uid: 'c1', username: 'arman' }, client: { uid: 'u1', username: 'gael' } }[req.get('x-user')]; next(); });
  const deps = {
    db, FieldValue: { serverTimestamp: () => 'ts' }, registry,
    sendError: (res, status, code, message) => res.status(status).json({ success: false, error: { code, message } }),
    sendSuccess: (res, status, data = {}) => res.status(status).json({ success: true, ...data }),
    resolveCallerUid: async u => u?.uid || null, now: () => new Date('2026-11-01T10:00:00Z'),
  };
  app.use('/api/coach/plans', createCoachPlansRouter(deps));
  app.use('/api/client/plan', createClientPlanRouter(deps));
  const srv = app.listen(0);
  const base = `http://127.0.0.1:${srv.address().port}`;
  const call = async (method, url, user, body) => {
    const r = await fetch(base + url, { method, headers: { 'content-type': 'application/json', 'x-user': user }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json() };
  };
  return { db, srv, call };
}

test('Gael: generate → reshape → nutrition → link X-frame → approve → publish → revise → publish v2', async () => {
  const { db, srv, call } = await server();
  try {
    let r = await call('POST', '/api/coach/plans', 'coach', { clientUid: 'u1', leadId: 'L1', packageId: 'cut_cycle_32', startDate: '2026-11-09', tier: 'medium' });
    assert.equal(r.status, 201);
    assert.equal(r.body.plan.schema, 'pocketcoach.plan/2');
    const id = r.body.plan.planId;
    const reason = 'Cut cycle agreed with Gael';

    r = await call('PATCH', `/api/coach/plans/${id}`, 'coach', { ops: [{ op: 'removePhase', phaseId: 'ph4' }] });
    assert.equal(r.status, 422);
    assert.equal(r.body.error.code, 'plan.reason_required');
    r = await call('PATCH', `/api/coach/plans/${id}`, 'coach', { reason, ops: [{ op: 'linkProgram', phaseId: 'ph1', programId: 'nope' }] });
    assert.equal(r.status, 404);

    r = await call('PATCH', `/api/coach/plans/${id}`, 'coach', { reason, ops: [
      { op: 'removePhase', phaseId: 'ph4' },
      { op: 'setPhase', phaseId: 'ph2', weeks: 3 },
      { op: 'setPhase', phaseId: 'ph3', type: 'deload', weeks: 1 },
      { op: 'setNutrition', phaseId: 'ph1', dayType: 'trainingDay', kcal: 2350, proteinG: 165, carbG: 275, fatG: 65 },
      { op: 'setNutrition', phaseId: 'ph1', dayType: 'restDay', kcal: 2000, proteinG: 165, carbG: 190, fatG: 65 },
      { op: 'setNutrition', phaseId: 'ph2', dayType: 'both', kcal: 2700, proteinG: 165, carbG: 364, fatG: 65 },
      { op: 'setNutrition', phaseId: 'ph3', dayType: 'both', kcal: 2700, proteinG: 165, carbG: 364, fatG: 65 },
      { op: 'linkProgram', phaseId: 'ph1', programId: 'prog_xframe', weekOffset: 0 },
      { op: 'linkProgram', phaseId: 'ph2', programId: 'prog_xframe', weekOffset: 12 },
      { op: 'linkProgram', phaseId: 'ph3', programId: 'prog_xframe', weekOffset: 15 },
    ] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const plan = r.body.plan;
    assert.deepEqual(plan.phases.map(p => [p.type, p.startWeek, p.weeks]), [['cut', 1, 12], ['maintain', 13, 3], ['deload', 16, 1]]);
    assert.deepEqual(plan.phases[0].training.programRef, { programId: 'prog_xframe', name: 'X-frame', rev: '2026-11-01T09:00:00Z', weekOffset: 0 });

    assert.equal((await call('POST', `/api/coach/plans/${id}/publish`, 'coach')).status, 409, 'publish needs approval');
    assert.equal((await call('POST', `/api/coach/plans/${id}/approve`, 'coach')).status, 200);
    r = await call('POST', `/api/coach/plans/${id}/publish`, 'coach');
    assert.equal(r.status, 200, JSON.stringify(r.body));

    r = await call('GET', '/api/client/plan', 'client');
    const mine = r.body.plan;
    assert.equal(mine.planId, id);
    assert.equal(mine.overrides, undefined, 'change log stays coach-side');
    assert.equal(mine.programs.prog_xframe.weeks.length, 4);
    assert.deepEqual(mine.programs.prog_xframe.schedule.weekdays, [1, 2, 4, 5]);
    assert.deepEqual(mine.phases.map(p => [p.plannedStart, p.nutrition.trainingDay.kcal, p.nutrition.restDay.kcal]), [['2026-11-09', 2350, 2000], ['2027-02-01', 2700, 2700], ['2027-02-22', 2700, 2700]]);
    const asn = db.docs.get('users/u1/coachAssignment/c1');
    assert.equal(asn.program.title, 'X-frame', 'older app builds get the program too');
    assert.match(asn.nutritionSummary, /training day 2350 kcal/);

    // "Weeks 5–12 added later": edit the program, then publish a new version.
    const stored = db.docs.get('coaches/c1/programs/prog_xframe');
    db.docs.set('coaches/c1/programs/prog_xframe', { ...stored, weeks: stored.weeks.concat(stored.weeks.slice(2, 4).map(w => ({ ...w })).flatMap(w => [w, w, w, w])), updatedAt: '2026-11-20T09:00:00Z' });
    r = await call('POST', `/api/coach/plans/${id}/revise`, 'coach');
    assert.equal(r.status, 201);
    const id2 = r.body.plan.planId;
    assert.deepEqual([r.body.plan.version, r.body.plan.supersedes], [2, id]);
    assert.equal((await call('PATCH', `/api/coach/plans/${id}`, 'coach', { reason, ops: [{ op: 'setPhase', phaseId: 'ph1', weeks: 11 }] })).status, 409, 'published v1 is frozen');
    assert.equal((await call('POST', `/api/coach/plans/${id2}/approve`, 'coach')).status, 200);
    assert.equal((await call('POST', `/api/coach/plans/${id2}/publish`, 'coach')).status, 200);

    r = await call('GET', '/api/client/plan', 'client');
    assert.equal(r.body.plan.planId, id2);
    assert.equal(r.body.plan.programs.prog_xframe.weeks.length, 12);
    assert.equal(db.docs.get(`users/u1/plans/${id}`).status, 'superseded');
    assert.equal(db.docs.get(`coaches/c1/plans/${id}`).status, 'superseded');
    r = await call('GET', '/api/coach/plans?clientUid=u1', 'coach');
    assert.deepEqual(r.body.plans.map(p => [p.version, p.status]).sort(), [[1, 'superseded'], [2, 'published']]);
  } finally {
    srv.close();
  }
});

test('a blank plan cannot be published until every phase has both day types', async () => {
  const { srv, call } = await server();
  try {
    let r = await call('POST', '/api/coach/plans', 'coach', { clientUid: 'u1', blank: true, packageId: 'cut_cycle_32', startDate: '2026-11-09', tier: 'medium' });
    assert.equal(r.status, 201);
    const id = r.body.plan.planId;
    await call('POST', `/api/coach/plans/${id}/approve`, 'coach');
    r = await call('POST', `/api/coach/plans/${id}/publish`, 'coach');
    assert.equal(r.status, 409);
    assert.equal(r.body.error.code, 'plan.nutrition_missing');
  } finally {
    srv.close();
  }
});
