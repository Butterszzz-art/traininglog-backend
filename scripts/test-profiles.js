// Tests for src/routes/profiles.js against an in-memory Firestore stand-in.
// No network, no Firebase project needed.
//
// Run: node scripts/test-profiles.js
const assert = require('assert');
const http = require('http');
const express = require('express');
const {
  createProfilesRouter, deleteProfile, parseAvatar, cleanText, profileKey, containsObjectionable, parseTerms,
} = require('../src/routes/profiles');

// ── Fake Firestore ───────────────────────────────────────────────────────────
const store = {}; // collectionPath -> { docId -> data }
const SERVER_TS = { __serverTimestamp: true };
function docRef(col, id) {
  store[col] = store[col] || {};
  return {
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
}
const db = {
  collection: col => ({ doc: id => docRef(col, id) }),
  batch() {
    const ops = [];
    return {
      set: (ref, data, opts) => ops.push(() => ref.set(data, opts)),
      delete: ref => ops.push(() => ref.delete()),
      commit: async () => { for (const op of ops) await op(); },
    };
  },
};
const FieldValue = { serverTimestamp: () => SERVER_TS };

const alerts = []; // messages sent to notifyModerators
const uids = { alice: 'uid_alice', bob: 'uid_bob', coachcarl: 'uid_carl', mod: 'uid_mod' };

// ── App ──────────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json({ limit: '256kb' }));
app.use((req, _res, next) => { // stand-in for authenticateToken
  const u = req.headers['x-user'];
  req.user = { username: u, uid: uids[String(u).toLowerCase()] };
  next();
});
app.use('/api/profiles', createProfilesRouter({
  db, FieldValue, firebaseEnabled: true,
  resolveUid: async u => uids[String(u).toLowerCase()] || null,
  sendError: (res, status, code, message) => res.status(status).json({ success: false, error: { code, message } }),
  sendSuccess: (res, status, data) => res.status(status).json({ success: true, ...data }),
  adminUsernames: ['Mod'],
  objectionableTerms: ['badword', 'two words'],
  notifyModerators: async msg => { alerts.push(msg); },
}));

let port;
function call(method, path, user, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port, method, path: '/api/profiles' + path,
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

// 1x1 JPEG / PNG
const JPEG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAAA//EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AN//Z';
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

async function run() {
  let passed = 0;
  const t = async (name, fn) => { await fn(); passed++; console.log('  ok -', name); };

  // helpers
  await t('profileKey rejects dot-only and bad usernames', () => {
    assert.strictEqual(profileKey('Alice'), 'alice');
    assert.strictEqual(profileKey('..'), null);
    assert.strictEqual(profileKey('a/b'), null);
    assert.strictEqual(profileKey(''), null);
  });
  await t('cleanText strips control chars, trims, caps length', () => {
    assert.strictEqual(cleanText('  hi\u0007  there ', 40), 'hi there');
    assert.strictEqual(cleanText('a'.repeat(50), 40).length, 40);
    assert.strictEqual(cleanText('l1\n\n l2 \nl3\nl4', 160, { multiline: true }), 'l1\nl2\nl3');
    assert.strictEqual(cleanText(42, 10), '');
  });
  await t('parseAvatar checks magic bytes, not the declared type', () => {
    assert.strictEqual(parseAvatar(JPEG).mime, 'image/jpeg');
    assert.strictEqual(parseAvatar(PNG).mime, 'image/png');
    assert.strictEqual(parseAvatar(PNG.replace('image/png', 'image/jpeg')).mime, 'image/png');
    assert.strictEqual(parseAvatar('data:image/jpeg;base64,' + Buffer.from('<svg/>').toString('base64')), null);
    assert.strictEqual(parseAvatar('data:image/svg+xml;base64,PHN2Zy8+'), null);
    assert.ok(parseAvatar('data:image/jpeg;base64,' + Buffer.alloc(200 * 1024, 0xff).toString('base64')).tooLarge);
  });

  // routes
  await t('GET /me with no profile returns defaults', async () => {
    const r = await call('GET', '/me', 'Alice');
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.body.profile, { username: 'Alice', displayName: '', bio: '', avatarVersion: null, visibility: 'everyone', avatar: null });
  });
  await t('PUT /me saves cleaned fields and rejects bad visibility', async () => {
    let r = await call('PUT', '/me', 'Alice', { displayName: '  Alice  W ', bio: 'Powerlifter\n\nCoach in training', visibility: 'everyone' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.profile.displayName, 'Alice W');
    assert.strictEqual(r.body.profile.bio, 'Powerlifter\nCoach in training');
    assert.strictEqual(store.profiles.alice.uid, 'uid_alice');
    r = await call('PUT', '/me', 'Alice', { visibility: 'friends' });
    assert.strictEqual(r.status, 422);
    r = await call('PUT', '/me', 'Alice', { bio: 'Updated' });
    assert.strictEqual(r.body.profile.displayName, 'Alice W', 'omitted fields are kept');
  });
  await t('PUT /me/avatar stores photo, rejects non-images', async () => {
    let r = await call('PUT', '/me/avatar', 'Alice', { image: 'data:text/html;base64,PGI+' });
    assert.strictEqual(r.status, 422);
    r = await call('PUT', '/me/avatar', 'Alice', { image: JPEG });
    assert.strictEqual(r.status, 200);
    assert.ok(r.body.avatarVersion);
    assert.strictEqual(store.profiles.alice.avatarVersion, r.body.avatarVersion);
    r = await call('GET', '/me', 'Alice');
    assert.ok(r.body.profile.avatar.startsWith('data:image/jpeg;base64,'));
  });
  await t('lookup returns avatar only when the cached version is stale', async () => {
    const v = store.profiles.alice.avatarVersion;
    let r = await call('POST', '/lookup', 'Bob', { usernames: ['alice', 'nobody', '..'] });
    assert.strictEqual(r.status, 200);
    assert.ok(r.body.profiles.alice.avatar);
    assert.strictEqual(r.body.profiles.alice.displayName, 'Alice W');
    assert.deepStrictEqual(r.body.profiles.nobody, { username: 'nobody', hidden: true });
    assert.strictEqual(Object.keys(r.body.profiles).length, 2);
    r = await call('POST', '/lookup', 'Bob', { usernames: ['Alice'], have: { alice: v } });
    assert.strictEqual(r.body.profiles.alice.avatar, undefined);
    assert.strictEqual(r.body.profiles.alice.avatarVersion, v);
  });
  await t('coach visibility: only an active coach/client link can see it', async () => {
    await call('PUT', '/me', 'Alice', { visibility: 'coach' });
    let r = await call('POST', '/lookup', 'Bob', { usernames: ['alice'] });
    assert.strictEqual(r.body.profiles.alice.hidden, true);
    assert.strictEqual(r.body.profiles.alice.avatar, undefined);

    store['coaches/uid_carl/clients'] = { uid_alice: { status: 'pending' } };
    r = await call('POST', '/lookup', 'CoachCarl', { usernames: ['alice'] });
    assert.strictEqual(r.body.profiles.alice.hidden, true, 'pending invite is not enough');

    store['coaches/uid_carl/clients'].uid_alice.status = 'active';
    r = await call('POST', '/lookup', 'CoachCarl', { usernames: ['alice'] });
    assert.ok(r.body.profiles.alice.avatar);

    r = await call('POST', '/lookup', 'Alice', { usernames: ['alice'] });
    assert.ok(r.body.profiles.alice.avatar, 'owner always sees their own');
  });
  await t('private visibility hides from everyone else', async () => {
    await call('PUT', '/me', 'Alice', { visibility: 'private' });
    const r = await call('POST', '/lookup', 'CoachCarl', { usernames: ['alice'] });
    assert.deepStrictEqual(r.body.profiles.alice, { username: 'Alice', hidden: true });
    await call('PUT', '/me', 'Alice', { visibility: 'everyone' });
  });
  await t('report: validates, dedupes per reporter, blocks self-report', async () => {
    let r = await call('POST', '/alice/report', 'Bob', { reason: 'nope' });
    assert.strictEqual(r.status, 422);
    r = await call('POST', '/alice/report', 'Alice', { reason: 'spam' });
    assert.strictEqual(r.status, 422);
    r = await call('POST', '/ghost/report', 'Bob', { reason: 'spam' });
    assert.strictEqual(r.status, 404);
    r = await call('POST', '/alice/report', 'Bob', { reason: 'inappropriate', note: 'bad photo' });
    assert.strictEqual(r.status, 201);
    await call('POST', '/alice/report', 'Bob', { reason: 'spam' });
    assert.strictEqual(Object.keys(store.profileReports).length, 1);
    assert.strictEqual(store.profileReports.alice__bob.reason, 'spam');
  });
  await t('moderator removal: forbidden for regular users, works for PROFILE_ADMINS', async () => {
    let r = await call('DELETE', '/alice/avatar', 'Bob');
    assert.strictEqual(r.status, 403);
    assert.ok(store.profileAvatars.alice);
    r = await call('DELETE', '/alice/avatar', 'mod');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(store.profileAvatars.alice, undefined);
    assert.strictEqual(store.profiles.alice.avatarVersion, null);
    assert.strictEqual(store.profiles.alice.bio, '');
  });
  await t('DELETE /me/avatar removes own photo', async () => {
    await call('PUT', '/me/avatar', 'Bob', { image: PNG });
    assert.ok(store.profileAvatars.bob);
    const r = await call('DELETE', '/me/avatar', 'Bob');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(store.profileAvatars.bob, undefined);
    assert.strictEqual(store.profiles.bob.avatarVersion, null);
  });
  await t('containsObjectionable matches whole words only', () => {
    const terms = parseTerms(' Badword, two words ,');
    assert.deepStrictEqual(terms, ['badword', 'two words']);
    assert.ok(containsObjectionable('what a BADWORD!', terms));
    assert.ok(containsObjectionable('say two words now', terms));
    assert.ok(!containsObjectionable('notbadwordy', terms));
    assert.ok(!containsObjectionable('anything', []));
  });
  await t('PUT /me rejects objectionable names and bios', async () => {
    let r = await call('PUT', '/me', 'Bob', { bio: 'I am a badword' });
    assert.strictEqual(r.status, 422);
    assert.strictEqual(r.body.error.code, 'profile.objectionable');
    r = await call('PUT', '/me', 'Bob', { displayName: 'Two  Words' });
    assert.strictEqual(r.status, 422);
    r = await call('PUT', '/me', 'Bob', { bio: 'Clean bio' });
    assert.strictEqual(r.status, 200);
  });
  await t('reports alert the moderators', async () => {
    alerts.length = 0;
    const r = await call('POST', '/bob/report', 'Alice', { reason: 'spam' });
    assert.strictEqual(r.status, 201);
    await new Promise(res => setImmediate(res));
    assert.ok(alerts.some(a => a.includes('@bob') && a.includes('spam')));
  });
  await t('block: hides the user in lookups, ends friendship, alerts moderators', async () => {
    alerts.length = 0;
    await db.collection('friendships').doc('alice__bob').set({ users: ['alice', 'bob'], status: 'accepted' });
    let r = await call('POST', '/Bob/block', 'Alice');
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(store.profileBlocks.alice.blocked, ['bob']);
    assert.strictEqual(store.friendships.alice__bob, undefined);
    await new Promise(res => setImmediate(res));
    assert.strictEqual(alerts.filter(a => a.includes('blocked @bob')).length, 1);

    r = await call('POST', '/bob/block', 'Alice'); // idempotent, no second alert
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(store.profileBlocks.alice.blocked, ['bob']);
    await new Promise(res => setImmediate(res));
    assert.strictEqual(alerts.filter(a => a.includes('blocked @bob')).length, 1);

    r = await call('POST', '/lookup', 'Alice', { usernames: ['bob'] });
    assert.deepStrictEqual(r.body.profiles.bob, { username: 'Bob', hidden: true, blocked: true });
    r = await call('POST', '/lookup', 'coachcarl', { usernames: ['bob'] }); // others still see Bob
    assert.ok(!r.body.profiles.bob.hidden);

    r = await call('GET', '/blocks', 'Alice');
    assert.deepStrictEqual(r.body.blocked, ['bob']);
  });
  await t('block: cannot block yourself or an invalid name', async () => {
    assert.strictEqual((await call('POST', '/alice/block', 'Alice')).status, 422);
    assert.strictEqual((await call('POST', '/%2E%2E/block', 'Alice')).status, 422);
  });
  await t('unblock restores the profile', async () => {
    const r = await call('DELETE', '/bob/block', 'Alice');
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(store.profileBlocks.alice.blocked, []);
    const l = await call('POST', '/lookup', 'Alice', { usernames: ['bob'] });
    assert.ok(!l.body.profiles.bob.hidden);
  });
  await t('deleteProfile also removes the block list (account deletion)', async () => {
    await call('POST', '/bob/block', 'Alice');
    assert.ok(store.profileBlocks.alice);
    await deleteProfile(db, 'Alice');
    assert.strictEqual(store.profileBlocks.alice, undefined);
  });
  await t('deleteProfile removes profile + avatar (account deletion)', async () => {
    await call('PUT', '/me/avatar', 'Bob', { image: PNG });
    await deleteProfile(db, 'Bob');
    assert.strictEqual(store.profiles.bob, undefined);
    assert.strictEqual(store.profileAvatars.bob, undefined);
  });

  console.log(`\n${passed} passed`);
}

const server = app.listen(0, '127.0.0.1', async () => {
  port = server.address().port;
  try {
    await run();
  } catch (err) {
    console.error('FAILED:', err);
    process.exitCode = 1;
  } finally {
    server.close();
  }
});
