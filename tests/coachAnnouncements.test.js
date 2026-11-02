// What a client is told when the coach publishes a plan or sends a program:
// the notification text (push + in-app) and the announcement the app's
// "New from your coach" sheet reads.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

// Stub the notifier coachNotifications.js uses, before loading it.
const sent = [];
const notificationsPath = require.resolve(path.join(__dirname, '../src/routes/notifications'));
require.cache[notificationsPath] = { id: notificationsPath, filename: notificationsPath, loaded: true, exports: { notify: async (_db, opts) => { sent.push(opts); return 1; }, collapsedRef: () => null } };
const { notifyCoachPlan } = require('../src/coachNotifications');

test('plan published: names the plan; a new version says so; the note is quoted short', async () => {
  sent.length = 0;
  await notifyCoachPlan({}, { coachUsername: 'arman', clientUsername: 'client', fields: {}, announce: { kind: 'plan', name: '16-week X-frame plan', version: 1, message: '', key: 'plan:pln_1' } });
  assert.equal(sent[0].text, 'published your plan: 16-week X-frame plan');
  assert.deepEqual([sent[0].type, sent[0].data.kind, sent[0].data.key], ['coach_plan', 'plan', 'plan:pln_1']);

  await notifyCoachPlan({}, { coachUsername: 'arman', clientUsername: 'client', announce: { kind: 'plan', name: 'x', version: 2, message: 'Start Monday, weigh in every morning and message me if anything hurts or feels off during the first week.' } });
  assert.match(sent[1].text, /^published version 2 of your plan · "Start Monday, weigh in every morning and message me if anything hur…"$/);
  assert.ok(sent[1].text.length <= 160);
  assert.equal(sent[1].data.message.startsWith('Start Monday'), true);
});

test('program sent: names the program', async () => {
  sent.length = 0;
  await notifyCoachPlan({}, { coachUsername: 'arman', clientUsername: 'client', fields: { currentProgram: 'X-frame' }, announce: { kind: 'program', name: 'X-frame', message: 'Lower days first.', key: 'program:p1:abc' } });
  assert.equal(sent[0].text, 'sent you a new program: X-frame · "Lower days first."');
  assert.equal(sent[0].data.kind, 'program');
});

test('without an announcement the old wording stays', async () => {
  sent.length = 0;
  await notifyCoachPlan({}, { coachUsername: 'arman', clientUsername: 'client', fields: { nutritionSummary: 'x' } });
  assert.equal(sent[0].text, 'updated your nutrition');
});

test('publish stores the note on the plan and hands it to the notification', async () => {
  const express = require('express');
  const { createRegistry } = require('../src/rules/registry');
  const { createCoachPlansRouter, createClientPlanRouter } = require('../src/routes/plans');
  const docs = new Map();
  const snap = (p, data) => ({ id: p.split('/').pop(), exists: data !== undefined, ref: ref(p), data: () => (data === undefined ? undefined : JSON.parse(JSON.stringify(data))), get: f => f.split('.').reduce((o, k) => (o == null ? undefined : o[k]), data) });
  const ref = p => ({ id: p.split('/').pop(), get: async () => snap(p, docs.get(p)), set: async (d, o) => { docs.set(p, JSON.parse(JSON.stringify(o?.merge ? { ...(docs.get(p) || {}), ...d } : d))); } });
  const coll = (p, f = []) => ({ doc: id => ref(`${p}/${id}`), where: (k, _o, v) => coll(p, [...f, [k, v]]), get: async () => ({ docs: [...docs.entries()].filter(([k]) => k.startsWith(`${p}/`) && !k.slice(p.length + 1).includes('/')).filter(([, d]) => f.every(([k, v]) => k.split('.').reduce((o, x) => o?.[x], d) === v)).map(([k, d]) => snap(k, d)) }) });
  const db = { collection: coll, batch: () => { const ops = []; return { set: (r, d, o) => ops.push(() => r.set(d, o)), commit: async () => { for (const op of ops) await op(); } }; } };
  docs.set('coaches/c1/clients/u1', { status: 'active' });
  const told = [];
  const deps = {
    db, FieldValue: { serverTimestamp: () => 'ts' }, registry: createRegistry(),
    sendError: (res, s, code, message) => res.status(s).json({ success: false, error: { code, message } }),
    sendSuccess: (res, s, d = {}) => res.status(s).json({ success: true, ...d }),
    resolveCallerUid: async u => u?.uid || null, now: () => new Date('2026-11-02T10:00:00Z'),
  };
  const app = express();
  app.use(express.json());
  app.use((req, _r, next) => { req.user = { coach: { uid: 'c1', username: 'arman' }, client: { uid: 'u1', username: 'client' } }[req.get('x-user')]; next(); });
  app.use('/api/coach/plans', createCoachPlansRouter({ ...deps, notifyPlanPublished: async x => { told.push(x); } }));
  app.use('/api/client/plan', createClientPlanRouter(deps));
  const srv = app.listen(0);
  const call = async (method, url, user, body) => { const r = await fetch(`http://127.0.0.1:${srv.address().port}${url}`, { method, headers: { 'content-type': 'application/json', 'x-user': user }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json() }; };
  try {
    const d = (kcal, proteinG, carbG, fatG) => ({ kcal, proteinG, carbG, fatG });
    let r = await call('POST', '/api/coach/plans', 'coach', { clientUid: 'u1', startDate: '2026-11-09', tier: 'medium', imported: { name: '16-week plan', phases: [{ type: 'cut', weeks: 2, goalText: '', trainingDay: d(2350, 165, 275, 65), restDay: d(2000, 165, 190, 65) }] } });
    const id = r.body.plan.planId;
    await call('POST', `/api/coach/plans/${id}/approve`, 'coach');
    r = await call('POST', `/api/coach/plans/${id}/publish`, 'coach', { message: '  Start Monday. Weigh in daily.  ' });
    assert.equal(r.status, 200);
    assert.deepEqual(told[0].announce, { kind: 'plan', name: '16-week plan', version: 1, message: 'Start Monday. Weigh in daily.', key: `plan:${id}` });
    r = await call('GET', '/api/client/plan', 'client');
    assert.deepEqual(r.body.plan.announcement, { message: 'Start Monday. Weigh in daily.', at: '2026-11-02T10:00:00.000Z', version: 1, key: `plan:${id}` });
  } finally {
    srv.close();
  }
});
