// Tests for coach automations (src/coachAutomations.js) and client groups
// (src/routes/coachLibrary.js), against an in-memory stand-in for Firestore.
// All users are made up. Run: node scripts/test-coach-automations.js
'use strict';

const path = require('path');
const express = require('express');
const auto = require(path.join(__dirname, '..', 'src', 'coachAutomations'));
const lib = require(path.join(__dirname, '..', 'src', 'routes', 'coachLibrary'));

const results = [];
const check = (label, cond) => results.push({ label, pass: !!cond });

function fakeDb() {
  const docs = new Map(); // "a/b/c/d" -> data
  let autoId = 0;
  const clone = v => JSON.parse(JSON.stringify(v));
  function docRef(p) {
    return {
      id: p.split('/').pop(),
      get: async () => snap(p, docs.get(p)),
      set: async (data, opts) => { docs.set(p, opts && opts.merge ? { ...(docs.get(p) || {}), ...clone(data) } : clone(data)); },
      delete: async () => { docs.delete(p); },
      collection: name => coll(`${p}/${name}`),
    };
  }
  const snap = (p, data) => ({
    id: p.split('/').pop(), exists: data !== undefined, ref: docRef(p),
    data: () => (data === undefined ? undefined : clone(data)),
    get: f => (data == null ? undefined : data[f]),
  });
  const coll = (p, filters = []) => ({
    doc: id => docRef(`${p}/${id || `auto${String(++autoId).padStart(4, '0')}`}`),
    where: (f, _op, v) => coll(p, [...filters, [f, v]]),
    get: async () => ({
      docs: [...docs.entries()]
        .filter(([k]) => k.startsWith(`${p}/`) && !k.slice(p.length + 1).includes('/'))
        .filter(([, d]) => filters.every(([f, v]) => d[f] === v))
        .map(([k, d]) => snap(k, d)),
    }),
    // Every id directly under this collection, including ones that only
    // exist as a parent of subcollections.
    listDocuments: async () => [...new Set([...docs.keys()].filter(k => k.startsWith(`${p}/`)).map(k => k.slice(p.length + 1).split('/')[0]))].map(id => docRef(`${p}/${id}`)),
  });
  return { docs, collection: coll };
}

const sendError = (res, status, code, message) => res.status(status).json({ success: false, error: { code, message } });
const sendSuccess = (res, status, data = {}) => res.status(status).json({ success: true, ...data });

(async () => {
  const s = auto.sanitizeAutomations({ checkInReminder: { enabled: true, graceDays: 3 }, welcome: { enabled: true, text: '  Welcome!\r\n\r\n\r\n\r\nRead the guide.  ' } });
  check('automations keep valid settings and tidy the text', s.checkInReminder.enabled && s.checkInReminder.graceDays === 3 && s.welcome.enabled && s.welcome.text === 'Welcome!\n\nRead the guide.');
  check('automations default to off', !auto.sanitizeAutomations(null).checkInReminder.enabled && !auto.sanitizeAutomations({}).welcome.enabled && auto.sanitizeAutomations({ checkInReminder: { graceDays: 99 } }).checkInReminder.graceDays === 1);
  check('a welcome with no text cannot be on', !auto.sanitizeAutomations({ welcome: { enabled: true, text: '   ' } }).welcome.enabled);

  const now = new Date('2026-11-14T08:00:00Z');
  check('a reminder is due after frequency plus grace', auto.reminderDue({ status: 'active', lastCheckInAt: '2026-11-05' }, 1, now) && !auto.reminderDue({ status: 'active', lastCheckInAt: '2026-11-07' }, 1, now));
  check('a longer frequency delays the reminder', !auto.reminderDue({ status: 'active', lastCheckInAt: '2026-11-05', checkInSettings: { everyDays: 14 } }, 1, now));
  check('no reminder for pending clients or ones who never checked in', !auto.reminderDue({ status: 'pending', lastCheckInAt: '2026-10-01' }, 0, now) && !auto.reminderDue({ status: 'active' }, 0, now));
  check('no second reminder for the same missed check-in', !auto.reminderDue({ status: 'active', lastCheckInAt: '2026-11-01', checkInRequestedAt: '2026-11-10T09:00:00Z' }, 1, now)
    && auto.reminderDue({ status: 'active', lastCheckInAt: '2026-11-01', checkInRequestedAt: '2026-10-20T09:00:00Z' }, 1, now));

  // ── The daily run ──
  const db = fakeDb();
  db.docs.set('coaches/c1/settings/automations', { checkInReminder: { enabled: true, graceDays: 1 }, welcome: { enabled: true, text: 'Welcome aboard!' } });
  db.docs.set('coaches/c2/settings/automations', { checkInReminder: { enabled: false, graceDays: 1 } });
  db.docs.set('coaches/c1/clients/late', { athleteDisplayName: 'client_late', status: 'active', lastCheckInAt: '2026-11-01' });
  db.docs.set('coaches/c1/clients/fine', { athleteDisplayName: 'client_fine', status: 'active', lastCheckInAt: '2026-11-12' });
  db.docs.set('coaches/c1/clients/asked', { athleteDisplayName: 'client_asked', status: 'active', lastCheckInAt: '2026-11-01', checkInRequestedAt: '2026-11-10T09:00:00Z' });
  db.docs.set('coaches/c2/clients/other', { athleteDisplayName: 'client_other', status: 'active', lastCheckInAt: '2026-10-01' });
  db.docs.set('users/late/coachInvites/c1', { status: 'active', coachUsername: 'coach_a' });
  const sent = [];
  let run = await auto.runCheckInReminders(db, { now, notify: async x => { sent.push(x); } });
  check('the run reminds only the late client of a coach who switched it on', run.coaches === 1 && run.reminded === 1 && sent.length === 1 && sent[0].clientUsername === 'client_late' && sent[0].coachUsername === 'coach_a');
  check('the reminder is recorded on the roster', db.docs.get('coaches/c1/clients/late').checkInRequestedAt === now.toISOString() && db.docs.get('coaches/c1/clients/late').checkInRequestedBy === 'automation');
  run = await auto.runCheckInReminders(db, { now: new Date('2026-11-15T08:00:00Z'), notify: async x => { sent.push(x); } });
  check('the next day sends nothing more', run.reminded === 0 && sent.length === 1);

  // ── Welcome ──
  db.docs.set('coaches/c1/clients/newbie', { athleteDisplayName: 'client_new', status: 'active' });
  const welcomed = [];
  let ok = await auto.sendWelcome(db, { coachUid: 'c1', coachUsername: 'coach_a', clientUid: 'newbie', clientUsername: 'client_new', now, onSent: async x => { welcomed.push(x); } });
  const coachNotes = [...db.docs.keys()].filter(k => k.startsWith('coaches/c1/clients/newbie/notes/'));
  const clientNotes = [...db.docs.keys()].filter(k => k.startsWith('users/newbie/coachNotes/'));
  check('a new client gets the welcome as a coach note on both sides', ok && coachNotes.length === 1 && clientNotes.length === 1 && db.docs.get(clientNotes[0]).text === 'Welcome aboard!' && coachNotes[0].split('/').pop() === clientNotes[0].split('/').pop());
  check('the caller is told so it can notify', welcomed.length === 1 && welcomed[0].clientUsername === 'client_new' && welcomed[0].text === 'Welcome aboard!');
  ok = await auto.sendWelcome(db, { coachUid: 'c1', coachUsername: 'coach_a', clientUid: 'newbie', clientUsername: 'client_new', now });
  check('the welcome is sent once per client', ok === false && [...db.docs.keys()].filter(k => k.startsWith('users/newbie/coachNotes/')).length === 1);
  ok = await auto.sendWelcome(db, { coachUid: 'c2', coachUsername: 'coach_b', clientUid: 'other', clientUsername: 'client_other', now });
  check('no welcome when the coach has it off', ok === false);

  // ── Routes: automations and groups ──
  const users = { coach: { uid: 'c1', username: 'coach_a' }, other: { uid: 'c3', username: 'coach_c' } };
  const deps = { db, sendError, sendSuccess, resolveCallerUid: async u => u?.uid || null, now: () => now };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = users[req.get('x-user')]; next(); });
  app.use('/api/coach/automations', auto.createRouter(deps));
  app.use('/api/coach/groups', lib.createCoachGroupsRouter(deps));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, user, body) => {
    const r = await fetch(base + url, { method, headers: { 'content-type': 'application/json', 'x-user': user }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json() };
  };
  try {
    let r = await call('GET', '/api/coach/automations', 'other');
    check('a coach with nothing saved reads the defaults', r.status === 200 && r.body.automations.checkInReminder.enabled === false && r.body.automations.checkInReminder.graceDays === 1);
    r = await call('PUT', '/api/coach/automations', 'other', { checkInReminder: { enabled: true, graceDays: 2 }, welcome: { enabled: false, text: 'Hi' } });
    check('coach saves automations', r.status === 200 && r.body.automations.checkInReminder.graceDays === 2 && db.docs.get('coaches/c3/settings/automations').checkInReminder.enabled === true);
    r = await call('PUT', '/api/coach/automations', 'other', { welcome: { enabled: true, text: '  ' } });
    check('switching the welcome on without a message is refused', r.status === 422 && r.body.error.code === 'automations.invalid');

    r = await call('PUT', '/api/coach/groups/grp_prep', 'coach', { name: '  Prep   team ', clientUids: ['late', 'fine', 'stranger', 'late'] });
    check('coach saves a group with roster members only', r.status === 200 && r.body.group.name === 'Prep team' && r.body.group.clientUids.join() === 'late,fine');
    r = await call('PUT', '/api/coach/groups/grp_x', 'coach', { name: '', clientUids: [] });
    check('a group needs a name', r.status === 422);
    await call('PUT', '/api/coach/groups/grp_a', 'coach', { name: 'Athletes', clientUids: [] });
    r = await call('GET', '/api/coach/groups', 'coach');
    check('coach lists groups by name', r.body.groups.map(g => g.name).join() === 'Athletes,Prep team');
    r = await call('GET', '/api/coach/groups', 'other');
    check('another coach sees none of them', r.body.groups.length === 0);
    r = await call('DELETE', '/api/coach/groups/grp_a', 'coach');
    check('coach deletes a group', r.status === 200 && (await call('GET', '/api/coach/groups', 'coach')).body.groups.length === 1);
  } finally {
    server.close();
  }

  const failed = results.filter(r => !r.pass);
  for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'} - ${r.label}`);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})();
