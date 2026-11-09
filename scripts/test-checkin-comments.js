// Tests for the check-in comment thread (src/checkInComments.js) against an
// in-memory stand-in for the parts of Firestore it uses. All users are made
// up. Run: node scripts/test-checkin-comments.js
'use strict';

const path = require('path');
const express = require('express');
const cc = require(path.join(__dirname, '..', 'src', 'checkInComments'));

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
  check('cleanComment trims, strips control chars, keeps paragraphs', cc.cleanComment('  Nice\u0007 work \r\n\n\n\n keep going  ') === 'Nice work\n\nkeep going');
  check('cleanComment caps at 1000 and ignores non-strings', cc.cleanComment('x'.repeat(1200)).length === 1000 && cc.cleanComment(42) === '');
  check('isoDate rejects impossible dates', cc.isoDate('2026-02-30') === null && cc.isoDate('2026-02-28') === '2026-02-28');
  check('withDate dedupes, newest first', cc.withDate(['2026-10-01', '2026-10-08'], '2026-10-08').join() === '2026-10-08,2026-10-01');

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
  // u1 has two photos on 2026-10-14 and one on 2026-10-07, photos allowed.
  const photo = { allowed: true, index: { '2026-10-14': 2, '2026-10-07': 1 } };

  let t = 0;
  const routers = cc.createRouters({
    db, sendError, sendSuccess,
    resolveCallerUid: async u => u?.uid || null,
    usernameForUid: async () => '',
    photosFor: async uid => (uid === 'u1' ? photo : { allowed: false, index: {} }),
    photoPose: async (_uid, date, i) => (date === '2026-10-14' && i === 0 ? 'Front' : 'Side'),
    notifyComment: async x => { notified.push({ kind: 'comment', ...x }); },
    notifyReply: async x => { notified.push({ kind: 'reply', ...x }); },
    now: () => new Date(Date.UTC(2026, 10, 3, 9, 0, t++)),
  });
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = users[req.get('x-user')]; next(); });
  app.use('/api/client/checkins', routers.client);
  app.use('/api/coach/clients/:clientUid', routers.coach);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, user, body) => {
    const r = await fetch(base + url, { method, headers: { 'content-type': 'application/json', 'x-user': user }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json() };
  };
  const roster = () => db.docs.get('coaches/c1/clients/u1');
  const thread = '/api/coach/clients/u1/checkins/2026-10-14/comments';

  try {
    let r = await call('POST', thread, 'coach', { text: '  Great progress on the waist. ' });
    check('coach comments on a check-in', r.status === 201 && r.body.comment.author === 'coach' && r.body.comment.text === 'Great progress on the waist.');
    check('client is notified (no comment text in it)', notified.length === 1 && notified[0].clientUsername === 'client_a' && notified[0].date === '2026-10-14' && !('text' in notified[0]) && notified[0].onPhoto === false);
    check('roster marks the date as commented', roster().coachCommentDates.join() === '2026-10-14');

    r = await call('POST', thread, 'coach', { text: 'Shoulders look fuller', photoIndex: 0 });
    check('coach pins a comment to a photo', r.status === 201 && r.body.comment.photoIndex === 0 && r.body.comment.photoLabel === 'Front' && notified.at(-1).onPhoto === true);
    r = await call('POST', thread, 'coach', { text: 'x', photoIndex: 2 });
    check('a photo index past the check-in\'s photos is refused', r.status === 422 && r.body.error.code === 'comments.invalid_photo');
    r = await call('POST', thread, 'coach', { text: 'x', photoIndex: 'front' });
    check('a non-number photo index is refused', r.status === 422);
    r = await call('POST', '/api/coach/clients/u1/checkins/2026-10-21/comments', 'coach', { text: 'x', photoIndex: 0 });
    check('pinning on a check-in without photos is refused', r.status === 422);
    photo.allowed = false;
    r = await call('POST', thread, 'coach', { text: 'x', photoIndex: 0 });
    check('pinning is refused once photo sharing is off', r.status === 422);
    photo.allowed = true;
    r = await call('POST', thread, 'coach', { text: '   ' });
    check('empty comment refused', r.status === 422 && r.body.error.code === 'comments.empty');
    r = await call('POST', thread, 'coach', { text: 'y'.repeat(1500) });
    check('long comment is cut to 1000 characters', r.status === 201 && r.body.comment.text.length === 1000);
    r = await call('POST', '/api/coach/clients/u1/checkins/2026-13-01/comments', 'coach', { text: 'x' });
    check('bad date refused', r.status === 422);
    r = await call('POST', thread, 'other', { text: 'hi' });
    check('a coach not linked to the client gets 404', r.status === 404);
    r = await call('GET', thread, 'pend');
    check('a pending coach cannot read the thread', r.status === 404);

    r = await call('GET', '/api/client/checkins/2026-10-14/comments', 'ana');
    check('client reads the thread in order', r.status === 200 && r.body.comments.length === 3 && r.body.comments[0].text === 'Great progress on the waist.');
    r = await call('POST', '/api/client/checkins/2026-10-14/comments', 'ana', { text: 'Thanks! Felt flat this week though.' });
    check('client replies', r.status === 201 && r.body.comment.author === 'client' && r.body.comment.coachUid === 'c1');
    check('coach is notified of the reply', notified.at(-1).kind === 'reply' && notified.at(-1).coachUsername === 'coach_a' && notified.at(-1).clientUid === 'u1');
    check('roster marks the reply as waiting for the coach', roster().awaitingReplyDates.join() === '2026-10-14');
    r = await call('POST', '/api/client/checkins/2026-10-14/comments', 'ana', { text: 'hi', coachUid: 'c3' });
    check('client cannot write to a coach who is not active', r.status === 422 && r.body.error.code === 'comments.pick_coach');
    r = await call('POST', '/api/client/checkins/2026-10-14/comments', 'bob', { text: 'hi' });
    check('client without a coach cannot post', r.status === 409);

    r = await call('GET', thread, 'coach');
    check('coach sees the reply', r.body.comments.length === 4 && r.body.comments[3].author === 'client');
    await call('POST', thread, 'coach', { text: 'Normal, carbs are up next week.' });
    check('coach answering clears the waiting flag', roster().awaitingReplyDates.length === 0);

    await call('POST', '/api/coach/clients/u1/checkins/2026-10-07/comments', 'coach', { text: 'Good start.' });
    r = await call('GET', '/api/client/checkins/comments', 'ana');
    check('client gets every thread in one call, with photo dates', r.status === 200 && r.body.comments.length === 6 && r.body.photoDates.join() === '2026-10-14,2026-10-07' && r.body.coaches[0].uid === 'c1');
    photo.allowed = false;
    r = await call('GET', '/api/client/checkins/comments', 'ana');
    check('photo dates are hidden while photo sharing is off', r.body.photoDates.length === 0);
    photo.allowed = true;
    r = await call('GET', '/api/client/checkins/comments', 'bob');
    check("another client gets none of them", r.status === 200 && r.body.comments.length === 0);

    // Link ends → the pair's comments go; account deletion helpers.
    db.docs.set('checkInComments/zzz_other', { coachUid: 'c2', clientUid: 'u2', checkInDate: '2026-10-14', author: 'coach', text: 'keep', createdAt: '2026-11-01T00:00:00Z' });
    await cc.deleteComments(db, { coachUid: 'c1', clientUid: 'u1' });
    const left = [...db.docs.keys()].filter(k => k.startsWith('checkInComments/'));
    check('unlink deletes only that pair\'s comments', left.length === 1 && left[0] === 'checkInComments/zzz_other');
    await cc.deleteComments(db, { coachUid: 'c2' });
    check('deleting a coach account clears their comments', ![...db.docs.keys()].some(k => k.startsWith('checkInComments/')));
  } finally {
    server.close();
  }

  const failed = results.filter(r => !r.pass);
  for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'} - ${r.label}`);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})().catch(err => { console.error(err); process.exit(1); });
