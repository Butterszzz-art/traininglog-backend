// Tests for src/routes/friends.js against an in-memory Firestore stand-in.
// No network, no Firebase project needed.
//
// Run: node scripts/test-friends.js
const assert = require('assert');
const http = require('http');
const express = require('express');
const { createFriendsRouter, deleteFriendships, pairId } = require('../src/routes/friends');

// ── Fake Firestore ───────────────────────────────────────────────────────────
const store = {}; // collectionPath -> { docId -> data }
const SERVER_TS = { __serverTimestamp: true };
function docRef(col, id) {
  store[col] = store[col] || {};
  const ref = {
    id,
    async get() {
      const data = store[col][id];
      return { id, exists: !!data, get: f => data?.[f], data: () => data && { ...data } };
    },
    async set(data, opts) {
      store[col][id] = opts?.merge ? { ...(store[col][id] || {}), ...data } : { ...data };
    },
    async delete() { delete store[col][id]; },
  };
  return ref;
}
const db = {
  getAll: (...refs) => Promise.all(refs.map(r => r.get())),
  batch: () => { const ops = []; return { set: (r, d, o) => ops.push(() => r.set(d, o)), commit: async () => { for (const op of ops) await op(); } }; },
  collection: col => ({
    doc: id => docRef(col, id),
    where: (field, op, value) => ({
      async get() {
        assert.strictEqual(op, 'array-contains');
        const docs = Object.entries(store[col] || {})
          .filter(([, d]) => Array.isArray(d[field]) && d[field].includes(value))
          .map(([id, d]) => ({ id, ref: docRef(col, id), data: () => ({ ...d }) }));
        return { docs, empty: !docs.length };
      },
    }),
  }),
};
const FieldValue = { serverTimestamp: () => SERVER_TS };

// Accounts that exist (usernames index + users docs).
for (const [name, uid] of [['Alice', 'uid_alice'], ['Bob', 'uid_bob'], ['carl', 'uid_carl']]) {
  store.usernames = store.usernames || {};
  store.users = store.users || {};
  store.usernames[name.toLowerCase()] = { uid };
  store.users[uid] = { uid, username: name };
}

// ── App ──────────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use((req, _res, next) => { // stand-in for authenticateToken
  req.user = { username: req.headers['x-user'] };
  next();
});
app.use('/api/friends', createFriendsRouter({
  db, FieldValue, firebaseEnabled: true,
  sendError: (res, status, code, message) => res.status(status).json({ success: false, error: { code, message } }),
  sendSuccess: (res, status, data) => res.status(status).json({ success: true, ...data }),
}));

let port;
function call(method, path, user, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port, method, path: '/api/friends' + path,
      headers: { 'x-user': user, 'content-type': 'application/json', ...(payload ? { 'content-length': Buffer.byteLength(payload) } : {}) },
    }, res => {
      let raw = '';
      res.on('data', c => { raw += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(raw) }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function run() {
  let passed = 0;
  const t = async (name, fn) => { await fn(); passed++; console.log('  ok -', name); };

  await t('pairId is order-independent', () => {
    assert.strictEqual(pairId('bob', 'alice'), 'alice__bob');
    assert.strictEqual(pairId('alice', 'bob'), 'alice__bob');
  });

  await t('rejects self, invalid and unknown usernames', async () => {
    assert.strictEqual((await call('POST', '/requests', 'Alice', { username: 'alice' })).status, 422);
    assert.strictEqual((await call('POST', '/requests', 'Alice', { username: 'a/b' })).status, 422);
    assert.strictEqual((await call('POST', '/requests', 'Alice', { username: 'ghost' })).status, 404);
  });

  await t('sending a request makes it pending, not a friend', async () => {
    const r = await call('POST', '/requests', 'Alice', { username: 'BOB' });
    assert.strictEqual(r.status, 201);
    assert.deepStrictEqual([r.body.status, r.body.username], ['pending', 'Bob']);
    const a = (await call('GET', '/', 'Alice')).body;
    assert.deepStrictEqual(a.friends, []);
    assert.deepStrictEqual(a.outgoing.map(x => x.username), ['Bob']);
    const b = (await call('GET', '/', 'Bob')).body;
    assert.deepStrictEqual(b.friends, []);
    assert.deepStrictEqual(b.incoming.map(x => x.username), ['Alice']);
  });

  await t('re-sending is idempotent', async () => {
    const r = await call('POST', '/requests', 'Alice', { username: 'bob' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.status, 'pending');
  });

  await t('only the recipient can accept', async () => {
    assert.strictEqual((await call('POST', '/requests/bob/accept', 'Alice')).status, 404);
    assert.strictEqual((await call('POST', '/requests/alice/accept', 'carl')).status, 404);
    const r = await call('POST', '/requests/alice/accept', 'Bob');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.username, 'Alice');
    assert.deepStrictEqual((await call('GET', '/', 'Alice')).body.friends.map(f => f.username), ['Bob']);
    assert.deepStrictEqual((await call('GET', '/', 'Bob')).body.friends.map(f => f.username), ['Alice']);
    assert.strictEqual((await call('POST', '/requests', 'Bob', { username: 'alice' })).status, 409);
  });

  await t('a request back to someone who asked you accepts it', async () => {
    await call('POST', '/requests', 'carl', { username: 'alice' });
    const r = await call('POST', '/requests', 'Alice', { username: 'carl' });
    assert.strictEqual(r.body.status, 'accepted');
    assert.deepStrictEqual((await call('GET', '/', 'Alice')).body.friends.map(f => f.username), ['Bob', 'carl']);
  });

  await t('decline removes the request; accepted friendships cannot be declined', async () => {
    await call('DELETE', '/carl', 'Alice');
    await call('POST', '/requests', 'carl', { username: 'alice' });
    assert.strictEqual((await call('POST', '/requests/carl/decline', 'Alice')).status, 200);
    assert.deepStrictEqual((await call('GET', '/', 'carl')).body.outgoing, []);
    assert.strictEqual((await call('POST', '/requests/bob/decline', 'Alice')).status, 404);
  });

  await t('unfriend removes it for both sides', async () => {
    assert.strictEqual((await call('DELETE', '/alice', 'Bob')).status, 200);
    assert.deepStrictEqual((await call('GET', '/', 'Alice')).body.friends, []);
  });

  await t('a block either way stops friend requests (looks like an unknown user)', async () => {
    store.profileBlocks = { carl: { blocked: ['bob'] } };
    let r = await call('POST', '/requests', 'Bob', { username: 'carl' }); // carl blocked bob
    assert.strictEqual(r.status, 404);
    assert.strictEqual(r.body.error.code, 'friends.not_found');
    r = await call('POST', '/requests', 'carl', { username: 'bob' });     // blocker can't either
    assert.strictEqual(r.status, 404);
    assert.strictEqual(store.friendships?.[pairId('bob', 'carl')], undefined);
    delete store.profileBlocks;
  });

  await t('deleteFriendships clears every row for that user', async () => {
    await call('POST', '/requests', 'Alice', { username: 'bob' });
    await call('POST', '/requests', 'carl', { username: 'alice' });
    await deleteFriendships(db, 'Alice');
    assert.deepStrictEqual(Object.keys(store.friendships), []);
  });

  console.log(`\n${passed} passed`);
}

const server = app.listen(0, async () => {
  port = server.address().port;
  try { await run(); } catch (err) { console.error(err); process.exitCode = 1; } finally { server.close(); }
});
