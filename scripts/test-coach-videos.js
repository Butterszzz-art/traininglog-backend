// Route tests for src/routes/coachVideos.js against an in-memory stand-in for
// the parts of Firestore it uses. Run: node scripts/test-coach-videos.js
'use strict';

const path = require('path');
const express = require('express');
const { createCoachVideosRouter, createClientCoachVideosRouter, sanitizeVideo } = require(path.join(__dirname, '..', 'src', 'routes', 'coachVideos'));

const results = [];
const check = (label, cond) => results.push({ label, pass: !!cond });

function fakeDb() {
  const docs = new Map(); // "a/b/c/d" -> data
  const snap = (p, data) => ({
    id: p.split('/').pop(), exists: data !== undefined,
    data: () => (data === undefined ? undefined : JSON.parse(JSON.stringify(data))),
    get: f => (data == null ? undefined : data[f]),
  });
  const docRef = p => ({
    get: async () => snap(p, docs.get(p)),
    set: async data => { docs.set(p, data); },
    delete: async () => { docs.delete(p); },
  });
  const coll = (p, filters = []) => ({
    doc: id => docRef(`${p}/${id}`),
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
  // Pure validation
  check('sanitize: missing title rejected', sanitizeVideo({ videoUrl: 'https://loom.com/share/x' }).error);
  check('sanitize: javascript: url rejected', sanitizeVideo({ title: 'x', videoUrl: 'javascript:alert(1)' }).error);
  check('sanitize: bad category rejected', sanitizeVideo({ title: 'x', videoUrl: 'https://a.b', category: 'nope' }).error);
  check('sanitize: selected needs clients', sanitizeVideo({ title: 'x', videoUrl: 'https://a.b', audience: 'selected' }).error);
  check('sanitize: defaults to all/general', (() => {
    const f = sanitizeVideo({ title: ' Welcome ', videoUrl: 'https://www.loom.com/share/abc' }).fields;
    return f.title === 'Welcome' && f.category === 'general' && f.audience === 'all' && f.clientUids.length === 0;
  })());
  check('sanitize: partial allows a lone message', (() => {
    const r = sanitizeVideo({ message: 'hi' }, { partial: true });
    return !r.error && Object.keys(r.fields).join() === 'message';
  })());

  const db = fakeDb();
  const notified = [];
  const users = {
    coach: { uid: 'c1', username: 'arman' }, other: { uid: 'c2', username: 'other' },
    ana: { uid: 'u1', username: 'ana' }, bob: { uid: 'u2', username: 'bob' }, cleo: { uid: 'u3', username: 'cleo' },
  };
  // c1 coaches ana and bob (active) and has cleo pending.
  db.docs.set('coaches/c1/clients/u1', { athleteDisplayName: 'ana', status: 'active' });
  db.docs.set('coaches/c1/clients/u2', { athleteDisplayName: 'bob', status: 'active' });
  db.docs.set('coaches/c1/clients/u3', { athleteDisplayName: 'cleo', status: 'pending' });
  db.docs.set('users/u1/coachInvites/c1', { status: 'active', coachUsername: 'arman' });
  db.docs.set('users/u2/coachInvites/c1', { status: 'active', coachUsername: 'arman' });
  db.docs.set('users/u3/coachInvites/c1', { status: 'pending', coachUsername: 'arman' });

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = users[req.get('x-user')]; next(); });
  let t = 0;
  const deps = { db, sendError, sendSuccess, resolveCallerUid: async u => u?.uid || null, now: () => new Date(Date.UTC(2026, 9, 7, 9, 0, t++)) };
  app.use('/api/coach/videos', createCoachVideosRouter({ ...deps, notifyVideo: async x => { notified.push(x); } }));
  app.use('/api/client/coach-videos', createClientCoachVideosRouter(deps));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, user, body) => {
    const r = await fetch(base + url, { method, headers: { 'content-type': 'application/json', 'x-user': user }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json() };
  };

  try {
    let r = await call('POST', '/api/coach/videos', 'coach', { title: 'How your program works', category: 'program', videoUrl: 'https://www.loom.com/share/abc123', message: 'Watch before Monday' });
    check('POST all → 201', r.status === 201);
    const allId = r.body.video?.id;
    check('POST all → id shape', /^vid_[0-9a-f]{20}$/.test(allId || ''));
    check('POST all → notifies active clients only', r.body.notified === 2 && notified[0]?.clients.map(c => c.name).sort().join() === 'ana,bob');
    check('POST all → notify carries title + coach', notified[0]?.title === 'How your program works' && notified[0]?.coachUsername === 'arman');

    r = await call('POST', '/api/coach/videos', 'coach', { title: 'Your diet', category: 'diet', videoUrl: 'https://youtu.be/dQw4w9WgXcQ', audience: 'selected', clientUids: ['u1'] });
    check('POST selected → 201, notifies ana only', r.status === 201 && r.body.notified === 1 && notified[1]?.clients[0]?.uid === 'u1');
    const dietId = r.body.video?.id;

    r = await call('POST', '/api/coach/videos', 'coach', { title: 'x', videoUrl: 'https://a.b/x', audience: 'selected', clientUids: ['stranger'] });
    check('POST unknown client → 422', r.status === 422 && r.body.error.code === 'videos.unknown_client');

    r = await call('POST', '/api/coach/videos', 'coach', { title: 'x', videoUrl: 'ftp://a.b/x' });
    check('POST bad url → 422', r.status === 422);

    r = await call('GET', '/api/coach/videos', 'coach');
    check('GET coach → both, newest first', r.status === 200 && r.body.videos.map(v => v.id).join() === `${dietId},${allId}`);

    r = await call('GET', '/api/coach/videos', 'other');
    check('GET other coach → empty', r.status === 200 && r.body.videos.length === 0);

    r = await call('GET', '/api/client/coach-videos', 'ana');
    check('client ana sees both', r.status === 200 && r.body.videos.length === 2 && r.body.videos[0].coachUsername === 'arman');
    check('client view hides audience list', r.body.videos.every(v => v.clientUids === undefined));
    r = await call('GET', '/api/client/coach-videos', 'bob');
    check('client bob sees only the all-clients video', r.body.videos.length === 1 && r.body.videos[0].id === allId);
    r = await call('GET', '/api/client/coach-videos', 'cleo');
    check('pending client sees nothing', r.body.videos.length === 0);

    notified.length = 0;
    r = await call('PATCH', `/api/coach/videos/${dietId}`, 'coach', { audience: 'selected', clientUids: ['u1', 'u2'] });
    check('PATCH add bob → 200, notifies bob only', r.status === 200 && r.body.notified === 1 && notified[0]?.clients[0]?.uid === 'u2');
    r = await call('PATCH', `/api/coach/videos/${dietId}`, 'coach', { message: 'Updated note' });
    check('PATCH message → no new notifications', r.status === 200 && r.body.notified === 0 && r.body.video.message === 'Updated note' && r.body.video.title === 'Your diet');
    r = await call('PATCH', `/api/coach/videos/${dietId}`, 'other', { message: 'hijack' });
    check('PATCH by another coach → 404', r.status === 404);
    r = await call('PATCH', `/api/coach/videos/${dietId}`, 'coach', {});
    check('PATCH empty → 422', r.status === 422);

    r = await call('DELETE', `/api/coach/videos/${dietId}`, 'other');
    check('DELETE by another coach → 404', r.status === 404);
    r = await call('DELETE', `/api/coach/videos/${dietId}`, 'coach');
    check('DELETE → 200', r.status === 200 && !db.docs.has(`coaches/c1/videos/${dietId}`));
    r = await call('DELETE', '/api/coach/videos/..%2Fclients%2Fu1', 'coach');
    check('DELETE odd id → 404, roster untouched', r.status === 404 && db.docs.has('coaches/c1/clients/u1'));
  } finally {
    server.close();
  }

  const failed = results.filter(x => !x.pass);
  results.forEach(x => console.log(`${x.pass ? 'PASS' : 'FAIL'}  ${x.label}`));
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})();
