// Tests for iPhone push (src/push.js) and its hook in notify()
// (src/routes/notifications.js), with a fake APNs and an in-memory Firestore.
//
// Run: node scripts/test-push.js
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const express = require('express');
const push = require('../src/push');
const { notify, createNotificationsRouter, deleteNotifications } = require('../src/routes/notifications');

// ── Fake Firestore (just what push + notify use) ─────────────────────────────
const store = new Map();
let autoId = 0;
function snapOf(coll, id) {
  const data = store.get(`${coll}/${id}`);
  return { id, exists: !!data, ref: docRef(coll, id), data: () => data && { ...data }, get: f => data && data[f] };
}
function docRef(coll, id) {
  const key = `${coll}/${id}`;
  return {
    id,
    get: async () => snapOf(coll, id),
    set: async (d, o) => { store.set(key, o?.merge ? { ...(store.get(key) || {}), ...d } : { ...d }); },
    update: async d => { store.set(key, { ...store.get(key), ...d }); },
    delete: async () => { store.delete(key); },
  };
}
function query(coll, filters = []) {
  const run = () => [...store.keys()]
    .filter(k => k.startsWith(coll + '/'))
    .map(k => snapOf(coll, k.slice(coll.length + 1)))
    .filter(d => filters.every(([f, , v]) => d.get(f) === v));
  return {
    where: (f, op, v) => query(coll, [...filters, [f, op, v]]),
    orderBy: () => query(coll, filters),
    limit: () => query(coll, filters),
    get: async () => { const docs = run(); return { docs, size: docs.length, empty: !docs.length }; },
    doc: id => docRef(coll, id || `a${++autoId}`),
  };
}
const db = {
  collection: name => query(name),
  getAll: (...refs) => Promise.all(refs.map(r => r.get())),
  batch: () => {
    const ops = [];
    return {
      set: (r, d, o) => ops.push(() => r.set(d, o)),
      update: (r, d) => ops.push(() => r.update(d)),
      commit: async () => { for (const op of ops) await op(); },
    };
  },
};

// ── Fake APNs ───────────────────────────────────────────────────────────────
// tokens: token -> { env, gone }. Every request is recorded.
const devices = {};
const sent = [];
let expireNext = false;
function fakeTransport(host, token, payload, headers) {
  const env = host === push.HOSTS.sandbox ? 'sandbox' : 'production';
  sent.push({ env, token, payload, headers });
  if (expireNext) { expireNext = false; return { status: 403, reason: 'ExpiredProviderToken' }; }
  const d = devices[token];
  if (!d || d.gone) return { status: 410, reason: 'Unregistered' };
  if (d.env !== env) return { status: 400, reason: 'BadDeviceToken' };
  return { status: 200, reason: '' };
}

const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
const config = {
  enabled: true,
  key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  keyId: 'ABC123DEFG',
  teamId: 'WD37WHSYG7',
  bundleId: 'com.pocketcoach.app',
};
push.setSender(push.createPushSender({ config, transport: fakeTransport }));

const tok = c => c.repeat(64);
let failures = 0;
const check = (label, cond, extra) => {
  if (!cond) failures++;
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${label}${!cond && extra !== undefined ? ' → ' + JSON.stringify(extra) : ''}`);
};

// ── Router ──────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.user = { username: req.headers['x-user'] }; next(); });
const sendError = (res, s, code, message) => res.status(s).json({ success: false, error: { code, message } });
const sendSuccess = (res, s, d = {}) => res.status(s).json({ success: true, ...d });
app.use('/api/notifications', createNotificationsRouter({ db, firebaseEnabled: true, sendError, sendSuccess }));

const server = app.listen(0, async () => {
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (user, method, p, body) => {
    const r = await fetch(base + p, { method, headers: { 'x-user': user, 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  try {
    console.log('— config');
    check('off without a key', push.readConfig({}).enabled === false);
    check('on with key, key id and team id', push.readConfig({ APNS_KEY: 'k', APNS_KEY_ID: 'i', APNS_TEAM_ID: 't' }).enabled === true);
    check('escaped newlines in the key are restored', push.readConfig({ APNS_KEY: 'a\\nb' }).key === 'a\nb');
    check('token format is checked', push.isValidToken(tok('a')) && !push.isValidToken('nope') && !push.isValidToken(tok('z')));

    console.log('— token routes');
    let r = await call('Bob', 'POST', '/api/notifications/push-token', { token: 'bad', platform: 'ios' });
    check('bad token rejected', r.status === 400, r);
    r = await call('Bob', 'POST', '/api/notifications/push-token', { token: tok('a'), platform: 'android' });
    check('android rejected for now', r.status === 400, r);
    r = await call('Bob', 'POST', '/api/notifications/push-token', { token: tok('a'), platform: 'ios' });
    check('bob saves his iPhone token', r.status === 200 && store.get(`pushTokens/${tok('a')}`)?.user === 'bob', r);
    await call('Bob', 'POST', '/api/notifications/push-token', { token: tok('b'), platform: 'ios' });
    devices[tok('a')] = { env: 'production' };
    devices[tok('b')] = { env: 'sandbox' };

    console.log('— notify pushes');
    sent.length = 0;
    await notify(db, { to: 'bob', type: 'friend_request', actor: 'alice', actorName: 'Alice', text: 'sent you a friend request' });
    const okSends = sent.filter(s => devices[s.token] && devices[s.token].env === s.env);
    check('both of bob\'s devices get it', okSends.length === 2, sent.map(s => [s.env, s.token[0]]));
    const first = sent[0];
    check('reads as a sentence', first.payload.aps.alert.body === 'Alice sent you a friend request', first.payload);
    check('carries type for the tap', first.payload.type === 'friend_request' && first.payload.category === 'friends');
    check('topic is the bundle id', first.headers['apns-topic'] === 'com.pocketcoach.app');
    const decoded = jwt.verify(first.headers.authorization.replace('bearer ', ''), publicKey, { algorithms: ['ES256'], complete: true });
    check('signed ES256 with the key id and team', decoded.header.kid === 'ABC123DEFG' && decoded.payload.iss === 'WD37WHSYG7');
    check('sandbox token remembered after the first send', store.get(`pushTokens/${tok('b')}`)?.env === 'sandbox');

    sent.length = 0;
    await notify(db, { to: 'bob', type: 'friend_request', actor: 'alice', actorName: 'Alice', text: 'again' });
    check('known env is tried first (no wasted request)', sent.length === 2, sent.map(s => s.env));

    console.log('— collapse, mute, block');
    sent.length = 0;
    await notify(db, { to: 'bob', type: 'group_post', actor: 'carl', actorName: 'carl', text: 'posted in Lifters', collapseKey: 'group_post__g1' });
    check('collapsible kinds set apns-collapse-id', sent[0]?.headers['apns-collapse-id'] === 'group_post__g1', sent[0]?.headers);
    store.set('notificationPrefs/bob', { groups: false });
    sent.length = 0;
    await notify(db, { to: 'bob', type: 'group_post', actor: 'carl', actorName: 'carl', text: 'posted', collapseKey: 'group_post__g1' });
    check('muted category is not pushed', sent.length === 0);
    store.set('profileBlocks/bob', { blocked: ['dave'] });
    await notify(db, { to: 'bob', type: 'friend_request', actor: 'dave', actorName: 'dave', text: 'hi' });
    check('blocked sender is not pushed', sent.length === 0);

    console.log('— dead tokens and errors');
    devices[tok('a')].gone = true;
    sent.length = 0;
    await notify(db, { to: 'bob', type: 'friend_accepted', actor: 'alice', actorName: 'Alice', text: 'accepted' });
    check('unregistered token is deleted', !store.has(`pushTokens/${tok('a')}`));
    check('the other device still works', store.has(`pushTokens/${tok('b')}`));
    expireNext = true;
    sent.length = 0;
    const n = await push.getSender().sendToUsers(db, ['bob'], { body: 'x' });
    check('expired provider token is renewed and retried', n === 1 && sent.length === 2, sent.map(s => s.env));
    const failing = push.createPushSender({ config, transport: () => { throw new Error('boom'); } });
    check('a crashing transport never throws', (await failing.sendToUsers(db, ['bob'], { body: 'x' })) === 0);

    console.log('— moving and removing');
    await call('Carl', 'POST', '/api/notifications/push-token', { token: tok('b'), platform: 'ios' });
    check('signing in as someone else moves the token', store.get(`pushTokens/${tok('b')}`)?.user === 'carl');
    r = await call('Bob', 'DELETE', '/api/notifications/push-token', { token: tok('b') });
    check('others cannot remove it', store.has(`pushTokens/${tok('b')}`), r);
    await call('Carl', 'DELETE', '/api/notifications/push-token', { token: tok('b') });
    check('owner removes it on sign-out', !store.has(`pushTokens/${tok('b')}`));
    await call('Carl', 'POST', '/api/notifications/push-token', { token: tok('c'), platform: 'ios' });
    await deleteNotifications(db, 'carl');
    check('account deletion removes tokens', !store.has(`pushTokens/${tok('c')}`));

    const off = push.createPushSender({ config: { enabled: false }, transport: fakeTransport });
    sent.length = 0;
    check('nothing sent while push is off', (await off.sendToUsers(db, ['bob'], { body: 'x' })) === 0 && sent.length === 0);
  } catch (err) {
    failures++;
    console.error(err);
  } finally {
    server.close();
    console.log(failures ? `\n${failures} failure(s)` : '\nAll push tests passed');
    process.exit(failures ? 1 : 0);
  }
});
