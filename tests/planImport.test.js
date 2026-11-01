// Master plan import (src/plan/planImport.js) and the plan routes that turn a
// reviewed import into a draft, attach the coach's PDF and hand it to the
// client on publish. The AI reply below mirrors what Gael's first check-in
// PDF states: both day types for the cut, only "~2700 kcal/day" for
// maintenance and the deload.
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { normalizeImportedPlan, sanitizeImported } = require('../src/plan/planImport');
const { createRegistry } = require('../src/rules/registry');
const { createCoachPlansRouter, createClientPlanRouter } = require('../src/routes/plans');
const lifecycle = require('../src/plan/lifecycle');

const day = (kcal, proteinG, carbG, fatG) => ({ kcal, proteinG, carbG, fatG });
const NULLS = day(null, null, null, null);
const aiReply = () => ({
  isPlan: true,
  name: '16-week X-frame plan',
  startDate: null,
  phases: [
    { type: 'cut', weeks: 12, goal: 'Lose ~0.4–0.6 kg per week while keeping strength', averageKcal: 2200, trainingDay: day(2350, 165, 275, 65), restDay: day(2000, 165, 190, 65) },
    { type: 'maintain', weeks: 3, goal: 'Maintenance break', averageKcal: 2700, trainingDay: NULLS, restDay: NULLS },
    { type: 'deload', weeks: 1, goal: 'Lighter week to recover, then measure and decide the next block', averageKcal: 2700, trainingDay: NULLS, restDay: NULLS },
  ],
  notes: 'Protein about 2 g/kg every day. Go by the weekly average weigh-in.',
  warnings: [],
});

test('stated numbers are kept; gaps are filled and listed as suggestions', () => {
  const plan = normalizeImportedPlan(aiReply());
  assert.equal(plan.name, '16-week X-frame plan');
  assert.deepEqual(plan.phases.map(p => [p.type, p.weeks]), [['cut', 12], ['maintain', 3], ['deload', 1]]);
  assert.deepEqual(plan.phases[0].trainingDay, day(2350, 165, 275, 65));
  assert.deepEqual(plan.phases[0].suggested, []);
  assert.deepEqual(plan.phases[1].trainingDay, day(2700, 165, 364, 65));
  assert.deepEqual(plan.phases[1].restDay, day(2700, 165, 364, 65));
  assert.deepEqual(plan.phases[2].restDay, day(2700, 165, 364, 65));
  assert.deepEqual(plan.phases[1].suggested.sort(), ['restDay.carbG', 'restDay.fatG', 'restDay.kcal', 'restDay.proteinG', 'trainingDay.carbG', 'trainingDay.fatG', 'trainingDay.kcal', 'trainingDay.proteinG']);
  assert.equal(plan.suggested, 16);
});

test('one day type stated → the other copies it; a phase with nothing copies the phase before', () => {
  const plan = normalizeImportedPlan({
    isPlan: true, name: 'x', startDate: '2026-11-09', notes: '', warnings: [],
    phases: [
      { type: 'build', weeks: 8, goal: '', averageKcal: null, trainingDay: day(3000, 180, null, 80), restDay: NULLS },
      { type: 'deload', weeks: 1, goal: '', averageKcal: null, trainingDay: NULLS, restDay: NULLS },
    ],
  });
  assert.equal(plan.startDate, '2026-11-09');
  assert.deepEqual(plan.phases[0].trainingDay, day(3000, 180, 390, 80));
  assert.deepEqual(plan.phases[0].restDay, day(3000, 180, 390, 80));
  assert.deepEqual(plan.phases[1].trainingDay, plan.phases[0].trainingDay);
});

test('not a plan → null; out-of-range numbers are dropped', () => {
  assert.equal(normalizeImportedPlan({ isPlan: false, phases: [] }), null);
  assert.equal(normalizeImportedPlan({ isPlan: true, phases: [] }), null);
  const p = normalizeImportedPlan({ isPlan: true, name: '', phases: [{ type: 'bulk', weeks: 0, goal: '', averageKcal: 99999, trainingDay: day(50, 165, 200, 60), restDay: NULLS }] });
  assert.deepEqual([p.phases[0].type, p.phases[0].weeks, p.phases[0].trainingDay.kcal], ['maintain', 1, 2000]);
  assert.ok(p.phases[0].suggested.includes('trainingDay.kcal'));
});

test('sanitizeImported keeps valid suggestions only and never fills gaps', () => {
  const s = sanitizeImported({ name: 'x', phases: [{ type: 'cut', weeks: 2, goalText: 'g', trainingDay: day(2000, 150, null, 60), restDay: NULLS, suggested: ['trainingDay.kcal', 'evil.path'] }] });
  assert.deepEqual(s.phases[0].suggested, ['trainingDay.kcal']);
  assert.equal(s.phases[0].trainingDay.carbG, null);
  assert.equal(sanitizeImported({ phases: [] }), null);
});

// ── routes ──────────────────────────────────────────────────────────────────

function fakeDb() {
  const docs = new Map();
  const snap = (p, data) => ({ id: p.split('/').pop(), exists: data !== undefined, ref: docRef(p), data: () => (data === undefined ? undefined : JSON.parse(JSON.stringify(data))), get: f => f.split('.').reduce((o, k) => (o == null ? undefined : o[k]), data) });
  const docRef = p => ({ id: p.split('/').pop(), get: async () => snap(p, docs.get(p)), set: async (data, opts) => { docs.set(p, JSON.parse(JSON.stringify(opts?.merge ? { ...(docs.get(p) || {}), ...data } : data))); } });
  const coll = (p, filters = []) => ({
    doc: id => docRef(`${p}/${id}`),
    where: (f, _op, v) => coll(p, [...filters, [f, v]]),
    get: async () => ({ docs: [...docs.entries()].filter(([k]) => k.startsWith(`${p}/`) && !k.slice(p.length + 1).includes('/')).filter(([, d]) => filters.every(([f, v]) => f.split('.').reduce((o, k) => o?.[k], d) === v)).map(([k, d]) => snap(k, d)) }),
  });
  return { docs, collection: coll, batch: () => { const ops = []; return { set: (ref, data, opts) => ops.push(() => ref.set(data, opts)), commit: async () => { for (const op of ops) await op(); } }; } };
}

test('import → draft with the PDF attached → edit clears a suggestion → publish → client opens the PDF', async () => {
  const db = fakeDb();
  db.docs.set('coaches/c1/clients/u1', { status: 'active' });
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use((req, _res, next) => { req.user = { coach: { uid: 'c1', username: 'arman' }, client: { uid: 'u1', username: 'gael' } }[req.get('x-user')]; next(); });
  const deps = {
    db, FieldValue: { serverTimestamp: () => 'ts' }, registry: createRegistry(),
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
  try {
    const imported = normalizeImportedPlan(aiReply());
    const pdf = Buffer.from('%PDF-1.7\n% plan document\n%%EOF').toString('base64');
    const body = { clientUid: 'u1', imported, startDate: '2026-11-09', tier: 'medium', fileName: 'gael-first-check-in.pdf' };

    let r = await call('POST', '/api/coach/plans', 'coach', { ...body, attachment: { fileName: 'x.pdf', data: Buffer.from('not a pdf').toString('base64') } });
    assert.equal(r.status, 422);
    assert.equal(r.body.error.code, 'plan.attachment_type');

    r = await call('POST', '/api/coach/plans', 'coach', { ...body, attachment: { fileName: 'gael-first-check-in.pdf', data: pdf } });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const plan = r.body.plan;
    assert.deepEqual(plan.phases.map(p => [p.type, p.startWeek, p.weeks, p.plannedStart]), [['cut', 1, 12, '2026-11-09'], ['maintain', 13, 3, '2027-02-01'], ['deload', 16, 1, '2027-02-22']]);
    assert.equal(plan.package.name, '16-week X-frame plan');
    assert.equal(plan.overrides[0].op, 'import');
    assert.equal(plan.phases[1].nutrition.suggested.length, 8);
    assert.equal(plan.attachment.fileName, 'gael-first-check-in.pdf');

    r = await call('PATCH', `/api/coach/plans/${plan.planId}`, 'coach', { reason: 'Maintenance carbs agreed', ops: [{ op: 'setNutrition', phaseId: 'ph2', dayType: 'trainingDay', kcal: 2700, proteinG: 165, carbG: 350, fatG: 70 }] });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.plan.phases[1].nutrition.suggested.sort(), ['restDay.carbG', 'restDay.fatG', 'restDay.kcal', 'restDay.proteinG', 'trainingDay.kcal', 'trainingDay.proteinG'],
      'only the changed values stop being suggestions');

    await call('POST', `/api/coach/plans/${plan.planId}/approve`, 'coach');
    r = await call('POST', `/api/coach/plans/${plan.planId}/publish`, 'coach');
    assert.equal(r.status, 200, JSON.stringify(r.body));

    r = await call('GET', '/api/client/plan', 'client');
    assert.equal(r.body.plan.attachment.fileName, 'gael-first-check-in.pdf');
    assert.equal(r.body.plan.notes, imported.notes);
    r = await call('GET', `/api/client/plan/file/${r.body.plan.attachment.fileId}`, 'client');
    assert.equal(r.status, 200);
    assert.equal(Buffer.from(r.body.file.data, 'base64').toString('latin1').slice(0, 5), '%PDF-');
    assert.equal((await call('GET', '/api/client/plan/file/pf_00000000-0000-4000-8000-000000000000', 'client')).status, 404);
  } finally {
    srv.close();
  }
});

test('removeAttachment op', () => {
  const p = { schema: 'pocketcoach.plan/2', status: 'draft', startDate: '2026-11-09', phases: [{ phaseId: 'ph1', type: 'cut', weeks: 1, nutrition: {}, training: {} }], overrides: [], attachment: { fileId: 'pf_x', fileName: 'a.pdf' } };
  const q = lifecycle.applyOps(p, [{ op: 'removeAttachment' }], { by: 'c', reason: 'Old document' });
  assert.equal(q.attachment, undefined);
  assert.equal(q.overrides.at(-1).op, 'removeAttachment');
});
