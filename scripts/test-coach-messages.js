// Tests for coach <-> client messages and check-in requests
// (src/coachMessages.js) against an in-memory stand-in for the parts of
// Firestore it uses. All users are made up. Run: node scripts/test-coach-messages.js
'use strict';

const path = require('path');
const express = require('express');
const cm = require(path.join(__dirname, '..', 'src', 'coachMessages'));

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
  check('preview flattens and cuts long text', cm.preview('a\n b') === 'a b' && cm.preview('x'.repeat(300)).length === 140);
  check('rosterSummary defaults', cm.rosterSummary({}).unreadMessages === 0 && cm.rosterSummary({ unreadMessages: -2 }).unreadMessages === 0 && cm.rosterSummary({}).lastMessageAt === null);

  const db = fakeDb();
  const notified = [];
  const users = {
    coach: { uid: 'c1', username: 'coach_a' }, other: { uid: 'c2', username: 'coach_b' }, pend: { uid: 'c3', username: 'coach_c' },
    ana: { uid: 'u1', username: 'client_a' }, bob: { uid: 'u2', username: 'client_b' },
  };
  // c1 coaches u1 (active); c3 has u1 pending; c2 coaches nobody. u2 has no coach.
  db.docs.set('coaches/c1/clients/u1', { athleteDisplayName: 'client_a', status: 'active' });
  db.docs.set('coaches/c3/clients/u1', { athleteDisplayName: 'client_a', status: 'pending' });
  db.docs.set('users/u1/coachInvites/c1', { status: 'active', coachUsername: 'coach_a' });
  db.docs.set('users/u1/coachInvites/c3', { status: 'pending', coachUsername: 'coach_c' });
  // The coach already sent one note (server.js writes these).
  db.docs.set('coaches/c1/clients/u1/notes/n1', { text: 'Welcome aboard', coachUsername: 'coach_a', createdAt: '2026-11-01T08:00:00.000Z' });

  let clock = Date.UTC(2026, 10, 3, 9, 0, 0);
  const routers = cm.createRouters({
    db, sendError, sendSuccess,
    resolveCallerUid: async u => u?.uid || null,
    usernameForUid: async () => '',
    notifyMessage: async x => { notified.push({ kind: 'message', ...x }); },
    notifyCheckInRequest: async x => { notified.push({ kind: 'request', ...x }); },
    now: () => new Date(clock += 1000),
  });
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = users[req.get('x-user')]; next(); });
  app.use('/api/client/messages', routers.client);
  app.use('/api/coach/clients/:clientUid', routers.coach);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, user, body) => {
    const r = await fetch(base + url, { method, headers: { 'content-type': 'application/json', 'x-user': user }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json() };
  };
  const roster = () => db.docs.get('coaches/c1/clients/u1');

  try {
    let r = await call('GET', '/api/coach/clients/u1/messages', 'coach');
    check("thread starts with the coach's note", r.status === 200 && r.body.messages.length === 1 && r.body.messages[0].author === 'coach' && r.body.messages[0].text === 'Welcome aboard');

    r = await call('POST', '/api/client/messages', 'ana', { text: '  Thanks! When do I start?  ' });
    check('client replies', r.status === 201 && r.body.message.author === 'client' && r.body.message.text === 'Thanks! When do I start?' && r.body.message.coachUid === 'c1');
    check('coach is notified (no message text in it)', notified.length === 1 && notified[0].kind === 'message' && notified[0].coachUsername === 'coach_a' && notified[0].clientUid === 'u1' && !('text' in notified[0]));
    check('roster shows the reply as unread', roster().unreadMessages === 1 && roster().lastMessageAuthor === 'client' && roster().lastMessageText === 'Thanks! When do I start?');
    await call('POST', '/api/client/messages', 'ana', { text: 'Also, which gym days?' });
    check('unread count grows', roster().unreadMessages === 2);

    r = await call('POST', '/api/client/messages', 'ana', { text: '   ' });
    check('empty message refused', r.status === 422 && r.body.error.code === 'messages.empty');
    r = await call('POST', '/api/client/messages', 'ana', { text: 'z'.repeat(1500) });
    check('long message is cut to 1000 characters', r.status === 201 && r.body.message.text.length === 1000 && roster().lastMessageText.length === 140);
    r = await call('POST', '/api/client/messages', 'ana', { text: 'hi', coachUid: 'c3' });
    check('client cannot write to a coach who is not active', r.status === 422 && r.body.error.code === 'messages.pick_coach');
    r = await call('POST', '/api/client/messages', 'bob', { text: 'hi' });
    check('client without a coach cannot write', r.status === 409);

    r = await call('GET', '/api/client/messages', 'ana');
    check('client reads their own replies and coaches', r.status === 200 && r.body.messages.length === 3 && r.body.messages.every(m => m.author === 'client') && r.body.coaches[0].uid === 'c1');
    r = await call('GET', '/api/client/messages', 'bob');
    check('another client gets none of them', r.status === 200 && r.body.messages.length === 0);

    r = await call('GET', '/api/coach/clients/u1/messages', 'coach');
    check('coach reads notes and replies in time order', r.body.messages.length === 4 && r.body.messages[0].author === 'coach' && r.body.messages[1].text === 'Thanks! When do I start?');
    check('reading the thread clears unread', roster().unreadMessages === 0);
    r = await call('GET', '/api/coach/clients/u1/messages', 'other');
    check('a coach not linked to the client gets 404', r.status === 404);
    r = await call('GET', '/api/coach/clients/u1/messages', 'pend');
    check('a pending coach cannot read the thread', r.status === 404);

    await cm.recordCoachNote(db, { coachUid: 'c1', clientUid: 'u1', text: 'Monday. Lower day first.', now: new Date(clock += 1000) });
    check('a coach note becomes the latest message', roster().lastMessageAuthor === 'coach' && roster().lastMessageText === 'Monday. Lower day first.');

    r = await call('POST', '/api/coach/clients/u1/checkin-request', 'coach');
    check('coach asks for a check-in', r.status === 201 && roster().checkInRequestedAt === r.body.checkInRequestedAt && notified.at(-1).kind === 'request' && notified.at(-1).clientUsername === 'client_a');
    r = await call('POST', '/api/coach/clients/u1/checkin-request', 'coach');
    check('asking again within 12 hours is refused', r.status === 409 && r.body.error.code === 'messages.already_requested');
    clock += cm.REQUEST_GAP_MS;
    r = await call('POST', '/api/coach/clients/u1/checkin-request', 'coach');
    check('asking again later works', r.status === 201);
    r = await call('POST', '/api/coach/clients/u1/checkin-request', 'other');
    check('a coach not linked cannot ask', r.status === 404);

    // Link ends -> the pair's replies go; account deletion helpers.
    db.docs.set('coachMessages/zzz_other', { coachUid: 'c2', clientUid: 'u2', author: 'client', text: 'keep', createdAt: '2026-11-01T00:00:00Z' });
    await cm.deleteMessages(db, { coachUid: 'c1', clientUid: 'u1' });
    const left = [...db.docs.keys()].filter(k => k.startsWith('coachMessages/'));
    check("unlink deletes only that pair's replies", left.length === 1 && left[0] === 'coachMessages/zzz_other');
    await cm.deleteMessages(db, { coachUid: 'c2' });
    check('deleting a coach account clears their replies', ![...db.docs.keys()].some(k => k.startsWith('coachMessages/')));
  } finally {
    server.close();
  }

  const failed = results.filter(r => !r.pass);
  for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'} - ${r.label}`);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})();
