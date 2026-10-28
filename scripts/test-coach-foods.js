// Tests for coach-approved foods (src/routes/coachFoods.js) and the calorie
// check (src/nutrition/diary.js kcalMismatch), against an in-memory
// Firestore stand-in. Run: node scripts/test-coach-foods.js
'use strict';

const express = require('express');
const { createCoachFoodsRouter, createClientCoachFoodsRouter, sanitizeCoachFood } = require('../src/routes/coachFoods');
const { kcalMismatch, sanitizeEntry } = require('../src/nutrition/diary');

let total = 0;
let failures = 0;
const check = (label, cond, extra) => {
  total++;
  if (!cond) failures++;
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${label}${!cond && extra !== undefined ? ' → ' + JSON.stringify(extra) : ''}`);
};

// ── Calorie check ───────────────────────────────────────────────────────────
check('kcal: matching macros not flagged', !kcalMismatch({ kcal: 435, protein: 5, carbs: 67, fat: 15 }));
check('kcal: EU fibre allowance', !kcalMismatch({ kcal: 370, protein: 13, carbs: 59, fat: 7, fiber: 10 }) );
check('kcal: way off flagged', kcalMismatch({ kcal: 467, protein: 3, carbs: 20, fat: 2 }));
check('kcal: tiny amounts get a margin', !kcalMismatch({ kcal: 12, protein: 0, carbs: 1, fat: 0 }));
check('kcal: entry flagged by the server too', sanitizeEntry({ date: '2026-10-28', name: 'x', kcal: 900, protein: 10, carbs: 10, fat: 10 }).flag === 'kcal_mismatch');
check('kcal: good entry not flagged', sanitizeEntry({ date: '2026-10-28', name: 'x', kcal: 170, protein: 10, carbs: 10, fat: 10 }).flag === undefined);

// ── Validation ──────────────────────────────────────────────────────────────
check('sanitize: name required', sanitizeCoachFood({ per100: { protein: 1, carbs: 1, fat: 1 } }).error);
check('sanitize: macros required', sanitizeCoachFood({ name: 'x', per100: { kcal: 10 } }).error);
check('sanitize: out of range', sanitizeCoachFood({ name: 'x', per100: { protein: 120, carbs: 0, fat: 0 } }).error);
check('sanitize: selected needs clients', sanitizeCoachFood({ name: 'x', per100: { protein: 1, carbs: 1, fat: 1 }, audience: 'selected' }).error);
{
  const f = sanitizeCoachFood({ name: ' Skyr ', per100: { protein: 11, carbs: 4, fat: 0.2, junk: 5 }, servings: [{ label: '1 beker', grams: 150 }, { label: '' }] }).fields;
  check('sanitize: defaults and kcal filled in', f.name === 'Skyr' && f.per100.kcal === 62 && f.per100.junk === undefined && f.audience === 'all' && f.servings.length === 1);
}

// ── Fake Firestore ──────────────────────────────────────────────────────────
const store = new Map();
const snapOf = p => { const d = store.get(p); return { id: p.split('/').pop(), exists: !!d, data: () => d && JSON.parse(JSON.stringify(d)), get: f => d && d[f] }; };
const docRef = p => ({ id: p.split('/').pop(), get: async () => snapOf(p), set: async d => { store.set(p, JSON.parse(JSON.stringify(d))); }, delete: async () => { store.delete(p); } });
const coll = (p, filters = []) => ({
  doc: id => docRef(`${p}/${id}`),
  where: (f, _op, v) => coll(p, [...filters, [f, v]]),
  get: async () => ({ docs: [...store.keys()].filter(k => k.startsWith(p + '/') && !k.slice(p.length + 1).includes('/')).map(snapOf).filter(s => filters.every(([f, v]) => s.get(f) === v)) }),
});
const db = { collection: coll };

const people = { arman: 'c1', other: 'c2', ana: 'u1', bob: 'u2', cleo: 'u3' };
const link = (coach, client, status) => {
  store.set(`coaches/${people[coach]}/clients/${people[client]}`, { status });
  store.set(`users/${people[client]}/coachInvites/${people[coach]}`, { status, coachUsername: coach });
};
link('arman', 'ana', 'active');
link('arman', 'bob', 'active');
link('arman', 'cleo', 'pending');

const sendError = (res, s, code, message) => res.status(s).json({ success: false, error: { code, message } });
const sendSuccess = (res, s, d = {}) => res.status(s).json({ success: true, ...d });
const resolveCallerUid = async u => people[u && u.username] || null;
const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.user = { username: req.headers['x-user'] }; next(); });
app.use('/api/coach/foods', createCoachFoodsRouter({ db, sendError, sendSuccess, resolveCallerUid }));
app.use('/api/client/coach-foods', createClientCoachFoodsRouter({ db, sendError, sendSuccess, resolveCallerUid }));

const server = app.listen(0, async () => {
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (user, method, p, body) => {
    const r = await fetch(base + p, { method, headers: { 'x-user': user, 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  try {
    const skyr = { name: 'Skyr naturel', brand: 'Arla', per100: { kcal: 63, protein: 11, carbs: 4, fat: 0.2 }, servings: [{ label: '1 beker', grams: 150 }] };
    let r = await call('arman', 'PUT', '/api/coach/foods/skyr', skyr);
    check('coach: create food for all clients', r.status === 201 && r.body.food.audience === 'all', r.body);
    r = await call('arman', 'PUT', '/api/coach/foods/kip', { name: 'Kipfilet', per100: { protein: 23, carbs: 0, fat: 1.5 }, audience: 'selected', clientUids: ['u2', 'u-not-mine'] });
    check('coach: selected audience keeps only own clients', r.status === 201 && JSON.stringify(r.body.food.clientUids) === '["u2"]', r.body);
    r = await call('arman', 'PUT', '/api/coach/foods/bad', { name: 'x', per100: { protein: 1, carbs: 1, fat: 1 }, audience: 'selected', clientUids: ['zzz'] });
    check('coach: audience of strangers only → 422', r.status === 422);
    r = await call('arman', 'PUT', '/api/coach/foods/..%2Fx', skyr);
    check('coach: bad id rejected', r.status === 422 || r.status === 404);
    r = await call('arman', 'GET', '/api/coach/foods');
    check('coach: lists own foods', r.body.foods.length === 2);
    r = await call('other', 'GET', '/api/coach/foods');
    check('another coach sees none of them', r.body.foods.length === 0);

    r = await call('ana', 'GET', '/api/client/coach-foods');
    check('client: gets the all-clients food only', r.status === 200 && r.body.foods.map(f => f.name).join() === 'Skyr naturel', r.body);
    check('client: food in app shape, marked coach', r.body.foods[0].source === 'coach' && r.body.foods[0].id === 'coach:c1:skyr' && r.body.foods[0].coachUsername === 'arman' && r.body.foods[0].audience === undefined);
    r = await call('bob', 'GET', '/api/client/coach-foods');
    check('client: selected food reaches the chosen client', r.body.foods.map(f => f.name).sort().join() === 'Kipfilet,Skyr naturel');
    r = await call('cleo', 'GET', '/api/client/coach-foods');
    check('client: pending link gets nothing', r.body.foods.length === 0);

    store.set(`coaches/c1/clients/u1`, { status: 'removed' });
    r = await call('ana', 'GET', '/api/client/coach-foods');
    check('client: coach side unlinked → nothing', r.body.foods.length === 0);

    r = await call('arman', 'DELETE', '/api/coach/foods/skyr');
    r = await call('bob', 'GET', '/api/client/coach-foods');
    check('coach: delete removes it for clients', r.body.foods.map(f => f.name).join() === 'Kipfilet');
  } catch (err) {
    failures++;
    console.error(err);
  } finally {
    server.close();
    console.log(`\n${total - failures}/${total} passed`);
    process.exitCode = failures ? 1 : 0;
  }
});
