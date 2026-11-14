// Tests for the roadmap validator (src/coachShare.js) and the coach's calendar
// events (src/routes/coachLibrary.js), against an in-memory stand-in for
// Firestore. All users are made up. Run: node scripts/test-coach-calendar.js
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
  const rm = cs.sanitizeRoadmap({
    phases: [{ name: 'Cut', start: '2027-01-05', end: '2027-03-01', goal: '-6 kg' }, { name: 'Build', start: '2026-11-01', end: '2027-01-04' },
      { name: 'Backwards', start: '2027-05-01', end: '2027-04-01' }, { name: '', start: '2027-01-01', end: '2027-01-02' }],
    milestones: [{ date: '2027-03-02', title: 'Photo shoot' }, { date: 'nope', title: 'x' }],
  });
  check('a roadmap keeps valid phases in date order', rm.phases.map(p => p.name).join() === 'Build,Cut' && rm.phases[1].goal === '-6 kg');
  check('a roadmap keeps dated milestones only', rm.milestones.length === 1 && rm.milestones[0].title === 'Photo shoot');
  check('an empty roadmap is null', cs.sanitizeRoadmap({ phases: [], milestones: [] }) === null && cs.sanitizeRoadmap(null) === null);
  check('roadmaps cap at 12 phases and 20 milestones', cs.sanitizeRoadmap({
    phases: Array.from({ length: 15 }, (_, i) => ({ name: `P${i}`, start: `2027-01-${String(i + 1).padStart(2, '0')}`, end: `2027-01-${String(i + 1).padStart(2, '0')}` })),
    milestones: Array.from({ length: 25 }, (_, i) => ({ date: `2027-02-${String(i + 1).padStart(2, '0')}`, title: `M${i}` })),
  }).phases.length === 12);

  check('an event needs a title and a real date', !!lib.sanitizeEvent({ date: '2026-11-20' }).error && !!lib.sanitizeEvent({ title: 'x', date: '2026-02-30' }).error);
  check('an event keeps a valid time and kind', lib.sanitizeEvent({ title: 'Call', date: '2026-11-20', time: '14:30', kind: 'call' }).event.time === '14:30'
    && lib.sanitizeEvent({ title: 'Call', date: '2026-11-20', time: '25:00', kind: 'weird' }).event.time === '' && lib.sanitizeEvent({ title: 'x', date: '2026-11-20', kind: 'weird' }).event.kind === 'other');

  const db = fakeDb();
  const users = { coach: { uid: 'c1', username: 'coach_a' }, other: { uid: 'c2', username: 'coach_b' } };
  db.docs.set('coaches/c1/clients/u1', { athleteDisplayName: 'client_a', status: 'active' });
  let clock = Date.UTC(2026, 10, 14, 9, 0, 0);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = users[req.get('x-user')]; next(); });
  app.use('/api/coach/events', lib.createCoachEventsRouter({ db, sendError, sendSuccess, resolveCallerUid: async u => u?.uid || null, now: () => new Date(clock += 1000) }));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, user, body) => {
    const r = await fetch(base + url, { method, headers: { 'content-type': 'application/json', 'x-user': user }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json() };
  };

  try {
    let r = await call('PUT', '/api/coach/events/ev_1', 'coach', { title: 'Call with Sam', date: '2026-11-20', time: '14:30', kind: 'call', clientUid: 'u1', note: 'Review week 3' });
    check('coach saves an event about a client', r.status === 200 && r.body.event.id === 'ev_1' && r.body.event.clientUid === 'u1' && r.body.event.kind === 'call');
    r = await call('PUT', '/api/coach/events/ev_2', 'coach', { title: 'Invoice day', date: '2026-11-01' });
    check('coach saves an event without a client', r.status === 200 && r.body.event.clientUid === '');
    r = await call('PUT', '/api/coach/events/ev_3', 'coach', { title: 'Call', date: '2026-11-21', clientUid: 'stranger' });
    check('an event about someone off the roster is refused', r.status === 422 && r.body.error.code === 'events.invalid');
    r = await call('PUT', '/api/coach/events/ev_1', 'coach', { title: 'Call with Sam', date: '2026-11-22', time: '10:00', clientUid: 'u1' });
    check('saving again moves it', r.status === 200 && r.body.event.date === '2026-11-22');
    r = await call('GET', '/api/coach/events', 'coach');
    check('coach lists events in date order', r.body.events.map(e => e.id).join() === 'ev_2,ev_1');
    r = await call('GET', '/api/coach/events', 'other');
    check('another coach sees none of them', r.body.events.length === 0);
    r = await call('DELETE', '/api/coach/events/ev_2', 'coach');
    check('coach deletes an event', r.status === 200 && (await call('GET', '/api/coach/events', 'coach')).body.events.length === 1);
  } finally {
    server.close();
  }

  const failed = results.filter(r => !r.pass);
  for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'} - ${r.label}`);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})();
