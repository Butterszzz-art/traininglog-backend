// Tests for the coach libraries (src/routes/coachLibrary.js): workouts and the
// vault, against an in-memory stand-in for Firestore. All users are made up.
// Run: node scripts/test-coach-library.js
'use strict';

const path = require('path');
const express = require('express');
const lib = require(path.join(__dirname, '..', 'src', 'routes', 'coachLibrary'));
const cs = require(path.join(__dirname, '..', 'src', 'coachShare'));

const results = [];
const check = (label, cond) => results.push({ label, pass: !!cond });

function fakeDb() {
  const docs = new Map(); // "a/b/c/d" -> data
  let auto = 0;
  const clone = v => JSON.parse(JSON.stringify(v));
  function docRef(p) {
    return {
      id: p.split('/').pop(),
      get: async () => snap(p, docs.get(p)),
      set: async (data, opts) => { docs.set(p, opts && opts.merge ? { ...(docs.get(p) || {}), ...clone(data) } : clone(data)); },
      delete: async () => { docs.delete(p); },
    };
  }
  const snap = (p, data) => ({
    id: p.split('/').pop(), exists: data !== undefined, ref: docRef(p),
    data: () => (data === undefined ? undefined : clone(data)),
    get: f => (data == null ? undefined : data[f]),
  });
  const coll = (p, filters = []) => ({
    doc: id => docRef(`${p}/${id || `auto${String(++auto).padStart(4, '0')}`}`),
    where: (f, _op, v) => coll(p, [...filters, [f, v]]),
    get: async () => ({
      docs: [...docs.entries()]
        .filter(([k]) => k.startsWith(`${p}/`) && !k.slice(p.length + 1).includes('/'))
        .filter(([, d]) => filters.every(([f, v]) => d[f] === v))
        .map(([k, d]) => snap(k, d)),
    }),
  });
  return { docs, collection: coll };
}

const sendError = (res, status, code, message) => res.status(status).json({ success: false, error: { code, message } });
const sendSuccess = (res, status, data = {}) => res.status(status).json({ success: true, ...data });

(async () => {
  const w = lib.sanitizeWorkout({ name: '  Lower   A ', focus: 'Quads', exercises: [{ name: 'Hack squat', sets: 3, repsMin: 6, repsMax: 10, rir: 2 }] }, cs.sanitizeCoachProgram);
  check('a workout is one validated program day', w.workout && w.workout.name === 'Lower A' && w.workout.focus === 'Quads' && w.workout.exercises.length === 1 && w.workout.exercises[0].name === 'Hack squat');
  check('a workout needs a name and an exercise', !!lib.sanitizeWorkout({ exercises: [{ name: 'x' }] }, cs.sanitizeCoachProgram).error && !!lib.sanitizeWorkout({ name: 'Empty', exercises: [] }, cs.sanitizeCoachProgram).error);
  check('vault items need a title and an http(s) link', !!lib.sanitizeVaultItem({ title: '', url: 'https://x.test' }).error && !!lib.sanitizeVaultItem({ title: 'Guide', url: 'javascript:alert(1)' }).error
    && lib.sanitizeVaultItem({ title: 'Guide', url: 'https://x.test/a.pdf', folder: ' Nutrition ' }).item.folder === 'Nutrition');
  check('a selected audience needs clients', !!lib.sanitizeVaultItem({ title: 'Guide', url: 'https://x.test', audience: 'selected', clientUids: [] }).error);

  const db = fakeDb();
  const notified = [];
  const users = {
    coach: { uid: 'c1', username: 'coach_a' }, other: { uid: 'c2', username: 'coach_b' },
    ana: { uid: 'u1', username: 'client_a' }, bob: { uid: 'u2', username: 'client_b' },
  };
  db.docs.set('coaches/c1/clients/u1', { athleteDisplayName: 'client_a', status: 'active' });
  db.docs.set('coaches/c1/clients/u2', { athleteDisplayName: 'client_b', status: 'active' });
  db.docs.set('coaches/c1/clients/u3', { athleteDisplayName: 'client_c', status: 'pending' });
  db.docs.set('users/u1/coachInvites/c1', { status: 'active', coachUsername: 'coach_a' });
  db.docs.set('users/u2/coachInvites/c1', { status: 'active', coachUsername: 'coach_a' });

  let clock = Date.UTC(2026, 10, 14, 9, 0, 0);
  const deps = { db, sendError, sendSuccess, resolveCallerUid: async u => u?.uid || null, now: () => new Date(clock += 1000) };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = users[req.get('x-user')]; next(); });
  app.use('/api/coach/workouts', lib.createCoachWorkoutsRouter({ ...deps, sanitizeProgram: cs.sanitizeCoachProgram }));
  app.use('/api/coach/vault', lib.createCoachVaultRouter({ ...deps, notifyResource: async x => { notified.push(x); } }));
  app.use('/api/client/coach-vault', lib.createClientCoachVaultRouter(deps));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, user, body) => {
    const r = await fetch(base + url, { method, headers: { 'content-type': 'application/json', 'x-user': user }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json() };
  };

  try {
    // ── Workouts ──
    let r = await call('PUT', '/api/coach/workouts/wk_lower', 'coach', { name: 'Lower A', exercises: [{ name: 'Hack squat', sets: 3, repsMin: 6, repsMax: 10 }, { name: 'Leg curl', sets: 3, repsMin: 10 }] });
    check('coach saves a workout', r.status === 200 && r.body.workout.id === 'wk_lower' && r.body.workout.exercises.length === 2);
    r = await call('PUT', '/api/coach/workouts/wk_lower', 'coach', { name: 'Lower A', exercises: [{ name: 'Hack squat', sets: 4, repsMin: 6 }] });
    check('saving again replaces it', r.status === 200 && r.body.workout.exercises.length === 1 && r.body.workout.exercises[0].sets === 4);
    r = await call('PUT', '/api/coach/workouts/bad id', 'coach', { name: 'x', exercises: [{ name: 'x' }] });
    check('a bad id is refused', r.status === 422);
    r = await call('PUT', '/api/coach/workouts/wk_empty', 'coach', { name: 'Empty', exercises: [] });
    check('an empty workout is refused', r.status === 422 && r.body.error.code === 'workouts.invalid');
    await call('PUT', '/api/coach/workouts/wk_upper', 'coach', { name: 'Upper A', exercises: [{ name: 'Bench press', sets: 3, repsMin: 6 }] });
    r = await call('GET', '/api/coach/workouts', 'coach');
    check('coach lists workouts by name', r.body.workouts.map(x => x.name).join() === 'Lower A,Upper A');
    r = await call('GET', '/api/coach/workouts', 'other');
    check("another coach has none of them", r.body.workouts.length === 0);
    r = await call('DELETE', '/api/coach/workouts/wk_upper', 'coach');
    check('coach deletes a workout', r.status === 200 && (await call('GET', '/api/coach/workouts', 'coach')).body.workouts.length === 1);

    // ── Vault ──
    r = await call('POST', '/api/coach/vault', 'coach', { title: 'Meal prep guide', url: 'https://x.test/prep.pdf', folder: 'Nutrition', description: 'Read before week 1.' });
    const allId = r.body.item && r.body.item.id;
    check('coach adds a vault item for everyone', r.status === 201 && r.body.item.audience === 'all' && r.body.item.folder === 'Nutrition');
    check('active clients are notified, pending ones are not', notified.length === 1 && notified[0].clients.map(c => c.uid).sort().join() === 'u1,u2' && notified[0].title === 'Meal prep guide');
    r = await call('POST', '/api/coach/vault', 'coach', { title: 'Knee rehab', url: 'https://x.test/knee', audience: 'selected', clientUids: ['u1', 'u3', 'ghost'] });
    check('a selected item keeps only active clients', r.status === 201 && r.body.item.clientUids.join() === 'u1' && notified.at(-1).clients.length === 1);
    r = await call('POST', '/api/coach/vault', 'coach', { title: 'x', url: 'https://x.test', audience: 'selected', clientUids: ['u3'] });
    check('selecting only a pending client is refused', r.status === 422);
    r = await call('POST', '/api/coach/vault', 'coach', { title: 'Bad', url: 'ftp://x' });
    check('a non-http link is refused', r.status === 422 && r.body.error.code === 'vault.invalid');

    r = await call('GET', '/api/client/coach-vault', 'ana');
    check('a chosen client sees both items', r.status === 200 && r.body.items.length === 2 && r.body.items[0].title === 'Knee rehab' && r.body.items[0].coachUsername === 'coach_a' && !('clientUids' in r.body.items[0]));
    r = await call('GET', '/api/client/coach-vault', 'bob');
    check('another client sees only the item for everyone', r.body.items.length === 1 && r.body.items[0].title === 'Meal prep guide');
    r = await call('GET', '/api/coach/vault', 'coach');
    check('coach lists the vault, newest first', r.body.items.length === 2 && r.body.items[0].title === 'Knee rehab');
    r = await call('DELETE', `/api/coach/vault/${allId}`, 'coach');
    check('coach removes an item and clients stop seeing it', r.status === 200 && (await call('GET', '/api/client/coach-vault', 'bob')).body.items.length === 0);
  } finally {
    server.close();
  }

  const failed = results.filter(r => !r.pass);
  for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'} - ${r.label}`);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})();
