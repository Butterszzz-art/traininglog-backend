// Tests for a coach reading a client's food log: the summary maths
// (src/nutrition/diary.js), the sharing helpers (src/coachShare.js) and the
// route's server-side access checks (src/routes/coachNutrition.js).
// The client's entries go in through the real sync route, against an
// in-memory Firestore stand-in. No network, no Firebase project.
//
// Run: node scripts/test-coach-nutrition.js
'use strict';

const express = require('express');
const diary = require('../src/nutrition/diary');
const coachShare = require('../src/coachShare');
const { createSyncRouter, syncDocId } = require('../src/routes/sync');
const { createCoachNutritionRouter } = require('../src/routes/coachNutrition');

let failures = 0;
let total = 0;
const check = (label, cond, extra) => {
  total++;
  if (!cond) failures++;
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${label}${!cond && extra !== undefined ? ' → ' + JSON.stringify(extra) : ''}`);
};

// ── Pure: sharing ───────────────────────────────────────────────────────────
check('sharing: nutrition defaults off, others on',
  JSON.stringify(coachShare.normalizeSharing(null)) === JSON.stringify({ checkIns: true, bodyweight: true, workouts: true, nutrition: false, photos: false }));
check('sharing: undecided until set', coachShare.decidedSharing({ checkIns: true }).nutrition === false
  && coachShare.decidedSharing({ nutrition: false }).nutrition === true);
{
  const stored = coachShare.mergeSharing({ checkIns: true, bodyweight: true, workouts: true }, { workouts: false, junk: true, nutrition: 'yes' });
  check('sharing: merge keeps nutrition unset when another switch changes', !('nutrition' in stored) && stored.workouts === false && !('junk' in stored));
  check('sharing: merge sets nutrition when sent as boolean', coachShare.mergeSharing(stored, { nutrition: true }).nutrition === true);
}

// ── Pure: summaries ─────────────────────────────────────────────────────────
const TODAY = '2026-10-28';
const target = { kcal: 2500, protein: 180, carbs: 280, fat: 70 };
{
  const e = diary.sanitizeEntry({ id: 'x', date: '2026-10-27', meal: 'dinner', name: '  Kipfilet ', kcal: '210.4', protein: 40, carbs: 0, fat: 5, ironMg: 1, evil: '<b>', grams: 200, unit: 'g', amount: 200, source: 'off' });
  check('entry: sanitized fields', e && e.name === 'Kipfilet' && e.kcal === 210 && e.ironMg === 1 && e.evil === undefined && e.meal === 'dinner');
  check('entry: bad date dropped', diary.sanitizeEntry({ date: '2026-13-40', name: 'x' }) === null);
  check('entry: unknown meal → snacks', diary.sanitizeEntry({ date: TODAY, name: 'x', meal: 'brunch' }).meal === 'snacks');
  const fromPlan = diary.sanitizeEntry({ date: TODAY, name: 'Oats', meal: 'breakfast', grams: 100, coach: { mealName: 'Oats & whey', grams: 80, key: 'k' }, confirmed: true });
  check('entry: from the coach meal plan keeps meal name, planned grams, confirmed',
    fromPlan.fromCoach?.meal === 'Oats & whey' && fromPlan.fromCoach.plannedGrams === 80 && fromPlan.confirmed === true);
  check('entry: own food has no coach fields', diary.sanitizeEntry({ date: TODAY, name: 'x' }).fromCoach === undefined);
  check('entry: missing core numbers → 0, other nutrients stay absent', (() => { const x = diary.sanitizeEntry({ date: TODAY, name: 'x' }); return x.kcal === 0 && x.fiber === undefined; })());
}
check('totals: calories from macros + direct cals', diary.sanitizeTotals({ protein: 100, carbs: 100, fats: 50, cals: -10 }).kcal === 1240);
check('target: Airtable-style keys', diary.sanitizeTarget({ Calories: 2000, Protein: 150 }).kcal === 2000);
check('adherence levels', diary.adherenceLevel(28, 28, 25) === 'green' && diary.adherenceLevel(28, 16, 8) === 'amber'
  && diary.adherenceLevel(28, 5, 5) === 'red' && diary.adherenceLevel(28, 25, null) === 'logging');
{
  // 28 full days: logged every other day at exactly target; today partly.
  const entries = [];
  for (let i = 1; i <= 28; i += 2) {
    entries.push({ date: diary.addDays(TODAY, -i), name: 'Day food', meal: 'lunch', kcal: 2500, protein: 180, carbs: 280, fat: 70 });
  }
  entries.push({ date: TODAY, name: 'Breakfast', meal: 'breakfast', kcal: 500, protein: 30, carbs: 60, fat: 10 });
  const s = diary.summarize({ entries, totalsByDate: {}, target, today: TODAY, days: 28 });
  check('summary: 28 rows, newest first', s.days.length === 28 && s.days[0].date === TODAY && s.days[0].today);
  check('summary: today left out of averages', s.last7.days === 7 && s.last28.days === 28);
  check('summary: 28-day days logged', s.last28.daysLogged === 14, s.last28);
  check('summary: averages over logged days only', s.last28.average.kcal === 2500 && s.last28.vsTargetPercent.kcal === 0);
  check('summary: on-target days', s.last28.onTargetDays === 14);
  check('summary: logs half the days, all on target → amber', s.last28.adherence === 'amber', s.last28.adherence);
}
{
  // App's archived total includes 300 kcal quick-added on top of the foods.
  const entries = [{ date: '2026-10-27', name: 'Rice', meal: 'dinner', kcal: 400, protein: 8, carbs: 88, fat: 1 }];
  const totalsByDate = { '2026-10-27': { protein: 8, carbs: 88, fats: 1, cals: 300 + 0 } };
  const d = diary.summarize({ entries, totalsByDate, target, today: TODAY, days: 7 }).days[1];
  check('summary: recorded total wins and the extra shows as not-from-foods', d.intake.kcal === 693 && d.notFromFoodsKcal === 293, d);
}
check('onTarget: needs protein ≥ 90 %', diary.onTarget({ kcal: 2500, protein: 150 }, target) === false
  && diary.onTarget({ kcal: 2700, protein: 180 }, target) === true);

// ── Fake Firestore ──────────────────────────────────────────────────────────
const store = new Map();
function snapOf(path) {
  const data = store.get(path);
  return { id: path.split('/').pop(), exists: !!data, data: () => data && JSON.parse(JSON.stringify(data)), get: f => data && data[f] };
}
function docRef(path) {
  return {
    id: path.split('/').pop(),
    get: async () => snapOf(path),
    set: async d => { store.set(path, { ...d }); },
    delete: async () => { store.delete(path); },
  };
}
function query(coll, filters = [], orders = [], lim = Infinity, after = null) {
  return {
    where: (f, _op, v) => query(coll, [...filters, [f, v]], orders, lim, after),
    orderBy: f => query(coll, filters, [...orders, f], lim, after),
    limit: n => query(coll, filters, orders, n, after),
    startAfter: (...vals) => query(coll, filters, orders, lim, vals),
    doc: id => docRef(`${coll}/${id}`),
    get: async () => {
      const val = (d, f) => (f === '__name__' ? d.id : d.get(f));
      const cmp = (a, b) => { for (const f of orders) { const x = val(a, f); const y = val(b, f); if (x < y) return -1; if (x > y) return 1; } return 0; };
      let docs = [...store.keys()]
        .filter(k => k.startsWith(coll + '/') && !k.slice(coll.length + 1).includes('/'))
        .map(snapOf)
        .filter(d => filters.every(([f, v]) => d.get(f) === v))
        .sort(cmp);
      if (after) { const pivot = { id: after[orders.indexOf('__name__')], get: f => after[orders.indexOf(f)] }; docs = docs.filter(d => cmp(d, pivot) > 0); }
      docs = docs.slice(0, lim);
      return { docs, size: docs.length };
    },
  };
}
const db = {
  collection: p => query(p),
  runTransaction: async fn => {
    const writes = [];
    const r = await fn({ get: ref => ref.get(), set: (ref, d) => writes.push(() => ref.set(d)) });
    for (const w of writes) await w();
    return r;
  },
};

// ── App ─────────────────────────────────────────────────────────────────────
const people = { ana: 'uid_ana', bob: 'uid_bob', arman: 'uid_arman', other: 'uid_other' };
const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.user = { username: req.headers['x-user'] }; next(); });
const sendError = (res, s, code, message) => res.status(s).json({ success: false, error: { code, message } });
const sendSuccess = (res, s, d = {}) => res.status(s).json({ success: true, ...d });
let clock = Date.parse(TODAY + 'T12:00:00Z');
app.use('/api/sync', createSyncRouter({ db, firebaseEnabled: true, sendError, sendSuccess, resolveUid: async u => people[u] || null, now: () => clock }));
app.use('/api/coach/nutrition', createCoachNutritionRouter({
  db, sendError, sendSuccess, syncDocId,
  resolveCallerUid: async u => people[u && u.username] || null,
  now: () => new Date(clock),
}));

function link(coach, client, status) {
  store.set(`coaches/${people[coach]}/clients/${people[client]}`, { status });
  store.set(`users/${people[client]}/coachInvites/${people[coach]}`, { status });
}
function setSharing(client, sharing) {
  store.set(`users/${people[client]}`, { username: client, ...(sharing ? { coachSharing: sharing } : {}) });
}

const server = app.listen(0, async () => {
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (user, method, p, body) => {
    const r = await fetch(base + p, { method, headers: { 'x-user': user, 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  const read = (coach, client) => call(coach, 'GET', `/api/coach/nutrition/${people[client]}?days=28`);

  try {
    // Ana logs two foods (one later deleted), her targets and yesterday's total.
    const food = (id, date, name, kcal, extra = {}) => ({ store: 'foodLog', id: `id:${id}`, updatedAt: clock - 1000, data: { id, date, meal: 'lunch', name, kcal, protein: 30, carbs: 40, fat: 10, source: 'off', ...extra } });
    let r = await call('ana', 'POST', '/api/sync/push', { items: [
      food('2026-10-28-a', '2026-10-28', 'Magere kwark', 265, { meal: 'breakfast' }),
      food('2026-10-27-b', '2026-10-27', 'Kipfilet', 420),
      food('2026-10-27-c', '2026-10-27', 'Deleted thing', 999),
      { store: 'macroTargets', id: 'value', updatedAt: clock - 1000, data: JSON.stringify({ calories: 2500, protein: 180, carbs: 280, fat: 70 }) },
      { store: 'macroHistory', id: 'date:2026-10-27', updatedAt: clock - 1000, data: { date: '2026-10-27', totals: { protein: 60, carbs: 80, fats: 20, cals: 0 } } },
    ] });
    check('client push applied', r.status === 200 && r.body.applied === 5, r.body);
    r = await call('ana', 'POST', '/api/sync/push', { items: [{ store: 'foodLog', id: 'id:2026-10-27-c', deleted: true, updatedAt: clock }] });
    check('client deletes one entry', r.body.applied === 1);
    // Bob's food must never show up for Ana.
    await call('bob', 'POST', '/api/sync/push', { items: [food('2026-10-28-z', '2026-10-28', 'Bob food', 100)] });

    setSharing('ana', null);
    r = await read('arman', 'ana');
    check('no link → 404', r.status === 404 && r.body.error.code === 'coach.not_linked', r.body);

    link('arman', 'ana', 'pending');
    r = await read('arman', 'ana');
    check('pending link → 404', r.status === 404, r.body);

    link('arman', 'ana', 'active');
    r = await read('arman', 'ana');
    check('active link, sharing never set → 403 (opt-in)', r.status === 403 && r.body.error.code === 'coach.nutrition_not_shared', r.body);
    check('403 carries no data', r.body.nutrition === undefined);

    setSharing('ana', { checkIns: true, bodyweight: true, workouts: true, nutrition: false });
    r = await read('arman', 'ana');
    check('sharing off → 403', r.status === 403);

    setSharing('ana', { checkIns: true, bodyweight: true, workouts: true, nutrition: true });
    r = await read('arman', 'ana');
    check('sharing on → 200', r.status === 200, r.body);
    const n = r.body.nutrition || { days: [] };
    const names = n.days.flatMap(d => d.entries.map(e => e.name));
    check('coach sees the client’s entries', names.includes('Magere kwark') && names.includes('Kipfilet'), names);
    check('deleted entry not shown', !names.includes('Deleted thing'));
    check('other client’s entries not shown', !names.includes('Bob food'));
    check('target from the client’s synced macroTargets', n.target && n.target.kcal === 2500, n.target);
    check('yesterday uses the app’s archived total', n.days[1] && n.days[1].intake && n.days[1].intake.kcal === 740, n.days[1]);
    check('28-day stats present', n.last28 && n.last28.daysLogged === 1 && n.last28.adherence === 'red', n.last28);

    r = await read('other', 'ana');
    check('a coach not linked to this client → 404', r.status === 404);

    store.delete(`users/${people.ana}/coachInvites/${people.arman}`);
    r = await read('arman', 'ana');
    check('client side of the link gone → 404', r.status === 404);
    link('arman', 'ana', 'active');

    setSharing('ana', { checkIns: true, bodyweight: true, workouts: true, nutrition: false });
    r = await read('arman', 'ana');
    check('revoked → 403 on the very next request, no data', r.status === 403 && r.body.nutrition === undefined);

    setSharing('ana', { nutrition: true });
    store.delete(`coaches/${people.arman}/clients/${people.ana}`);
    r = await read('arman', 'ana');
    check('unlinked by coach → 404 even with sharing on', r.status === 404);

    r = await call('arman', 'GET', '/api/coach/nutrition/..%2Fusers');
    check('odd client id rejected', r.status === 422 || r.status === 404);
  } catch (err) {
    failures++;
    console.error(err);
  } finally {
    server.close();
    console.log(`\n${total - failures}/${total} passed`);
    process.exitCode = failures ? 1 : 0;
  }
});
