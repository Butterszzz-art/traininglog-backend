// Tests for cloud sync (src/routes/sync.js) and the exercise-board cleanup
// run when a workout is deleted, against an in-memory Firestore stand-in.
// No network, no Firebase project.
//
// Run: node scripts/test-sync.js
const express = require('express');
const { createSyncRouter, syncDocId } = require('../src/routes/sync');
const { recordExerciseBests, forgetExerciseSession } = require('../src/routes/exerciseBoard');

// ── Fake Firestore ───────────────────────────────────────────────────────────
const store = new Map(); // "path/id" -> data
function snapOf(coll, id) {
  const data = store.get(`${coll}/${id}`);
  return { id, exists: !!data, data: () => data && { ...data }, get: f => data && data[f] };
}
function docRef(coll, id) {
  return {
    id,
    get: async () => snapOf(coll, id),
    set: async d => { store.set(`${coll}/${id}`, { ...d }); },
    delete: async () => { store.delete(`${coll}/${id}`); },
  };
}
const DOC_ID = '__name__';
function query(coll, orders = [], lim = Infinity, after = null) {
  return {
    orderBy: f => query(coll, [...orders, f], lim, after),
    limit: n => query(coll, orders, n, after),
    startAfter: (...vals) => query(coll, orders, lim, vals),
    doc: id => docRef(coll, id),
    get: async () => {
      const val = (d, f) => (f === DOC_ID ? d.id : d.get(f));
      const cmp = (a, b) => {
        for (const f of orders) {
          const x = val(a, f); const y = val(b, f);
          if (x < y) return -1;
          if (x > y) return 1;
        }
        return 0;
      };
      let docs = [...store.keys()]
        .filter(k => k.startsWith(coll + '/') && !k.slice(coll.length + 1).includes('/'))
        .map(k => snapOf(coll, k.slice(coll.length + 1)))
        .sort(cmp);
      if (after) {
        // startAfter values line up with the orderBy fields.
        const pivot = { id: after[orders.indexOf(DOC_ID)], get: f => after[orders.indexOf(f)] };
        docs = docs.filter(d => cmp(d, pivot) > 0);
      }
      docs = docs.slice(0, lim);
      return { docs, size: docs.length };
    },
  };
}
const db = {
  collection: path => query(path),
  runTransaction: async fn => {
    const writes = [];
    const result = await fn({ get: r => r.get(), set: (r, d) => writes.push(() => r.set(d)) });
    for (const w of writes) await w();
    return result;
  },
};

// ── App ─────────────────────────────────────────────────────────────────────
let clock = 1_000_000;
let switchOn = true;
const uids = { alice: 'uid_alice', bob: 'uid_bob' }; // "legacy" has none
const app = express();
app.use(express.json({ limit: '256kb' }));
app.use((req, _res, next) => { req.user = { username: req.headers['x-user'] }; next(); });
const sendError = (res, s, code, message) => res.status(s).json({ success: false, error: { code, message } });
const sendSuccess = (res, s, d = {}) => res.status(s).json({ success: true, ...d });
app.use('/api/sync', createSyncRouter({
  db, firebaseEnabled: true, sendError, sendSuccess,
  resolveUid: async u => uids[u] || null,
  enabled: () => switchOn,
  now: () => clock,
}));

let failures = 0;
const check = (label, cond, extra) => {
  if (!cond) failures++;
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${label}${!cond && extra ? ' → ' + JSON.stringify(extra) : ''}`);
};

const server = app.listen(0, async () => {
  const base = `http://127.0.0.1:${server.address().port}/api/sync`;
  const call = async (user, method, p, body) => {
    const r = await fetch(base + p, { method, headers: { 'x-user': user, 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  const push = (user, items) => call(user, 'POST', '/push', { items });
  const pull = (user, cursor) => call(user, 'GET', `/pull${cursor ? `?cursor=${cursor}` : ''}`);

  try {
    console.log('— access');
    let r = await call('legacy', 'GET', '/status');
    check('legacy account refused', r.status === 409 && r.body.error.code === 'sync.not_migrated', r);
    r = await call('alice', 'GET', '/status');
    check('status ok', r.status === 200 && r.body.enabled === true, r);
    switchOn = false;
    r = await push('alice', []);
    check('kill switch → 503', r.status === 503 && r.body.error.code === 'sync.disabled', r);
    switchOn = true;

    console.log('— push / pull');
    r = await push('alice', [
      { store: 'bodyMeasurements', id: '2026-09-01', data: { date: '2026-09-01', waist: 80 }, updatedAt: clock },
      { store: 'macroTargets', id: 'value', data: { protein: 180 }, updatedAt: clock },
      { store: 'bad store!', id: 'x', data: 1, updatedAt: clock },
      { store: 'sleepLog', id: 'x', updatedAt: clock },
      { store: 'sleepLog', id: 'y', data: 1, updatedAt: clock + 60 * 60 * 1000 },
    ]);
    check('valid items applied', r.status === 200 && r.body.applied === 2, r.body);
    check('invalid items reported', r.body.rejected.map(x => x.reason).join() === 'invalid_store,missing_data,invalid_updated_at', r.body.rejected);

    r = await pull('alice');
    check('pull returns both', r.body.items.length === 2 && !r.body.hasMore, r.body);
    check('data round-trips', r.body.items.find(i => i.store === 'bodyMeasurements').data.waist === 80, r.body.items);
    const c1 = r.body.cursor;

    r = await pull('bob');
    check('other users see nothing', r.body.items.length === 0 && r.body.cursor === null, r.body);

    r = await pull('alice', c1);
    check('nothing new after cursor', r.body.items.length === 0 && r.body.cursor === c1, r.body);

    console.log('— conflicts');
    clock += 1000;
    r = await push('alice', [{ store: 'macroTargets', id: 'value', data: { protein: 150 }, updatedAt: clock - 5000 }]);
    check('older write not applied', r.body.applied === 0 && r.body.newer.length === 1 && r.body.newer[0].data.protein === 180, r.body);
    r = await push('alice', [{ store: 'macroTargets', id: 'value', data: { protein: 200 }, updatedAt: clock }]);
    check('newer write applied', r.body.applied === 1, r.body);
    r = await pull('alice', c1);
    check('pull after cursor sees only the change', r.body.items.length === 1 && r.body.items[0].data.protein === 200, r.body);
    const c2 = r.body.cursor;

    console.log('— deletes');
    clock += 1000;
    r = await push('alice', [{ store: 'bodyMeasurements', id: '2026-09-01', deleted: true, updatedAt: clock }]);
    check('delete applied', r.body.applied === 1, r.body);
    r = await pull('alice', c2);
    check('tombstone pulled', r.body.items.length === 1 && r.body.items[0].deleted && r.body.items[0].data === null, r.body);
    check('tombstone stored without data', store.get(`users/uid_alice/syncItems/${syncDocId('bodyMeasurements', '2026-09-01')}`).data === null);

    console.log('— paging');
    clock += 1000;
    const many = Array.from({ length: 100 }, (_, i) => ({ store: 'sleepLog', id: `d${i}`, data: { h: i }, updatedAt: clock }));
    r = await push('alice', many);
    check('100 items in one push', r.body.applied === 100, r.body);
    r = await push('alice', [...many, many[0]]);
    check('101 items refused', r.status === 413, r);
    let cursor = c2; let seen = 0; let pages = 0;
    do {
      r = await call('alice', 'GET', `/pull?limit=30&cursor=${cursor}`);
      seen += r.body.items.length; cursor = r.body.cursor; pages++;
    } while (r.body.hasMore && pages < 20);
    check('paging returns every item once (same seq)', seen === 101 && pages === 4, { seen, pages });
    r = await call('alice', 'GET', '/pull?cursor=garbage');
    check('bad cursor refused', r.status === 422, r);

    console.log('— size');
    r = await push('alice', [{ store: 'notes', id: 'big', data: 'x'.repeat(210 * 1024), updatedAt: clock }]);
    check('oversized item rejected', r.status === 413 || (r.body.rejected && r.body.rejected[0]?.reason === 'too_large'), r.status);

    console.log('— exercise board');
    await recordExerciseBests(db, { username: 'alice', workoutId: 'w1', date: '2026-09-01', workout: { log: [{ exercise: 'Bench Press', repsArray: [1], weightsArray: [120] }] } });
    await recordExerciseBests(db, { username: 'alice', workoutId: 'w2', date: '2026-09-02', workout: { log: [{ exercise: 'Bench Press', repsArray: [1], weightsArray: [100] }] } });
    check('best recorded', store.get('exerciseBests/bench__alice').bestE1rm === 120);
    await forgetExerciseSession(db, { username: 'alice', workoutId: 'w1' });
    const after = store.get('exerciseBests/bench__alice');
    check('best falls back after delete', after.bestE1rm === 100 && !after.sessions.w1, after);
    await forgetExerciseSession(db, { username: 'alice', workoutId: 'w2' });
    check('doc removed with last session', !store.has('exerciseBests/bench__alice'));
  } catch (err) {
    failures++;
    console.error(err);
  } finally {
    server.close();
    console.log(failures ? `\n${failures} FAILED` : '\nall passed');
    process.exit(failures ? 1 : 0);
  }
});
