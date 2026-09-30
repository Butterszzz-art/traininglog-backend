// Tests for progress photos (src/routes/photos.js) against an in-memory
// Firestore stand-in. No network, no Firebase project.
//
// Run: node scripts/test-photos.js
const express = require('express');
const { createPhotosRouter, DATA_MAX_BYTES } = require('../src/routes/photos');

const store = new Map();
const db = {
  collection: coll => ({
    doc: id => ({
      get: async () => {
        const d = store.get(`${coll}/${id}`);
        return { exists: !!d, get: f => d && d[f] };
      },
      set: async d => { store.set(`${coll}/${id}`, { ...d }); },
      delete: async () => { store.delete(`${coll}/${id}`); },
    }),
  }),
};
const FieldValue = { serverTimestamp: () => new Date() };
const uids = { alice: 'uid_alice', bob: 'uid_bob' };

const app = express();
app.use(express.json({ limit: '256kb' }));
app.use((req, _res, next) => { req.user = { username: req.headers['x-user'] }; next(); });
const sendError = (res, s, code, message) => res.status(s).json({ success: false, error: { code, message } });
const sendSuccess = (res, s, d = {}) => res.status(s).json({ success: true, ...d });
app.use('/api/photos', createPhotosRouter({ db, FieldValue, firebaseEnabled: true, sendError, sendSuccess, resolveUid: async u => uids[u] || null }));

let failures = 0;
const check = (label, cond, extra) => {
  if (!cond) failures++;
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${label}${!cond && extra ? ' → ' + JSON.stringify(extra) : ''}`);
};

const JPEG = 'data:image/jpeg;base64,' + 'A'.repeat(1000);

const server = app.listen(0, async () => {
  const base = `http://127.0.0.1:${server.address().port}/api/photos`;
  const call = async (user, method, p, body) => {
    const r = await fetch(base + p, { method, headers: { 'x-user': user, 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => null), cache: r.headers.get('cache-control') };
  };
  try {
    let r = await call('legacy', 'GET', '/ph_abcd1');
    check('legacy account refused', r.status === 409, r);

    r = await call('alice', 'PUT', '/ph_abcd1', { slot: 'front', date: '2026-09-30', data: JPEG });
    check('upload', r.status === 200 && r.body.id === 'ph_abcd1', r);
    r = await call('alice', 'GET', '/ph_abcd1');
    check('download', r.status === 200 && r.body.photo.data === JPEG && r.body.photo.slot === 'front', r.body);
    check('not cacheable', /no-store/.test(r.cache || ''), r.cache);

    r = await call('bob', 'GET', '/ph_abcd1');
    check('other account cannot read it', r.status === 404, r);

    r = await call('alice', 'PUT', '/bad id', { slot: 'front', date: '2026-09-30', data: JPEG });
    check('bad id refused', r.status === 422 || r.status === 404, r.status);
    r = await call('alice', 'PUT', '/ph_abcd2', { slot: 'top', date: '2026-09-30', data: JPEG });
    check('bad slot refused', r.status === 422 && r.body.error.code === 'photos.invalid_slot', r);
    r = await call('alice', 'PUT', '/ph_abcd2', { slot: 'side', date: 'yesterday', data: JPEG });
    check('bad date refused', r.status === 422 && r.body.error.code === 'photos.invalid_date', r);
    r = await call('alice', 'PUT', '/ph_abcd2', { slot: 'side', date: '2026-09-30', data: 'data:text/html;base64,PHNjcmlwdD4=' });
    check('non-image refused', r.status === 422 && r.body.error.code === 'photos.invalid_data', r);
    r = await call('alice', 'PUT', '/ph_abcd2', { slot: 'side', date: '2026-09-30', data: 'data:image/jpeg;base64,' + 'A'.repeat(DATA_MAX_BYTES) });
    check('oversized refused', r.status === 413, r.status);

    r = await call('alice', 'DELETE', '/ph_abcd1');
    check('delete', r.status === 200, r);
    r = await call('alice', 'GET', '/ph_abcd1');
    check('gone after delete', r.status === 404, r);
    r = await call('alice', 'DELETE', '/ph_abcd1');
    check('deleting again is fine', r.status === 200, r);
  } catch (err) {
    failures++;
    console.error(err);
  } finally {
    server.close();
    console.log(failures ? `\n${failures} FAILED` : '\nall passed');
    process.exit(failures ? 1 : 0);
  }
});
