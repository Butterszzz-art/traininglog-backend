// Tests for src/routes/appleIap.js with an in-memory Firestore stand-in and
// fake Apple verifiers (real JWS only come from Apple). No network.
//
// Run: node scripts/test-apple-iap.js
const assert = require('assert');
const http = require('http');
const express = require('express');
const crypto = require('crypto');
const { createAppleIapRouter, verifyWithAny, entitlementFromNotification } = require('../src/routes/appleIap');

// ── Fake Firestore (users collection, doc + where/limit/get) ─────────────────
const store = { users: {} };
function docRef(id) {
  return {
    id,
    async get() {
      const data = store.users[id];
      return { id, exists: !!data, get: f => data?.[f], data: () => data && { ...data } };
    },
    async set(data, opts) {
      store.users[id] = opts?.merge ? { ...(store.users[id] || {}), ...data } : { ...data };
    },
  };
}
const db = {
  collection: () => ({
    doc: docRef,
    where: (field, _op, value) => ({
      limit: () => ({
        async get() {
          const docs = Object.entries(store.users).filter(([, d]) => d[field] === value).map(([id]) => ({ id }));
          return { empty: !docs.length, docs };
        },
      }),
    }),
  }),
};

// ── Fake verifiers: a "JWS" is JSON prefixed with the environment it's from ──
function fakeVerifier(env) {
  const decode = jws => {
    const cut = jws.indexOf('|');
    const [prefix, json] = [jws.slice(0, cut), jws.slice(cut + 1)];
    if (prefix === 'bad') throw new Error('signature invalid');
    if (prefix !== env) throw new Error('INVALID_ENVIRONMENT');
    return JSON.parse(json);
  };
  return { verifyAndDecodeTransaction: async j => decode(j), verifyAndDecodeNotification: async j => decode(j) };
}
const jws = (env, obj) => `${env}|${JSON.stringify(obj)}`;
const NOW = Date.parse('2026-10-01T00:00:00Z');
const DAY = 86400000;

const entitlements = [];
const app = express();
app.use(express.json());
const authenticate = (req, _res, next) => { req.user = { username: req.headers['x-user'] }; next(); };
app.use('/api/iap/apple', createAppleIapRouter({
  db, enabled: true,
  verifiers: [fakeVerifier('prod'), fakeVerifier('sandbox')],
  applyEntitlement: async e => { entitlements.push(e); store.users[e.uid] = { ...store.users[e.uid], userPlan: e.plan, appleOriginalTransactionId: e.sourceCustomerId }; return true; },
  resolveUid: async u => ({ alice: 'uid_alice', bob: 'uid_bob' })[String(u).toLowerCase()] || null,
  authenticate,
  sendError: (res, status, code, message) => res.status(status).json({ success: false, error: { code, message } }),
  sendSuccess: (res, status, data) => res.status(status).json({ success: true, ...data }),
  now: () => NOW,
  randomUUID: () => crypto.randomUUID(),
}));

let port;
function call(method, path, user, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port, method, path: '/api/iap/apple' + path,
      headers: { 'x-user': user || '', 'content-type': 'application/json', ...(payload ? { 'content-length': Buffer.byteLength(payload) } : {}) },
    }, res => {
      let raw = '';
      res.on('data', c => { raw += c; });
      res.on('end', () => { let b = raw; try { b = JSON.parse(raw); } catch { /* text */ } resolve({ status: res.statusCode, body: b }); });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function run() {
  let passed = 0;
  const t = async (name, fn) => { await fn(); passed++; console.log('  ok -', name); };

  let aliceToken;
  await t('account-token creates a UUID once and returns the same one after', async () => {
    const r1 = await call('GET', '/account-token', 'Alice');
    assert.strictEqual(r1.status, 200);
    aliceToken = r1.body.appAccountToken;
    assert.match(aliceToken, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    const r2 = await call('GET', '/account-token', 'alice');
    assert.strictEqual(r2.body.appAccountToken, aliceToken);
    assert.strictEqual(store.users.uid_alice.appleAccountToken, aliceToken);
  });

  await t('verify: a sandbox purchase (App Review / TestFlight) is accepted', async () => {
    const tx = { productId: 'com.pocketcoach.app.pro.monthly', appAccountToken: aliceToken.toUpperCase(), originalTransactionId: '1000', expiresDate: NOW + 30 * DAY };
    const r = await call('POST', '/verify', 'Alice', { signedTransaction: jws('sandbox', tx) });
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.body, { success: true, active: true, plan: 'pro' });
    const e = entitlements.at(-1);
    assert.strictEqual(e.uid, 'uid_alice');
    assert.strictEqual(e.source, 'apple');
    assert.strictEqual(e.billingCycle, 'monthly');
    assert.strictEqual(e.sourceCustomerId, '1000');
  });

  await t('verify: someone else’s receipt is refused', async () => {
    await call('GET', '/account-token', 'Bob');
    const before = entitlements.length;
    const tx = { productId: 'com.pocketcoach.app.pro.monthly', appAccountToken: aliceToken, originalTransactionId: '1000', expiresDate: NOW + DAY };
    const r = await call('POST', '/verify', 'Bob', { signedTransaction: jws('prod', tx) });
    assert.strictEqual(r.status, 403);
    assert.strictEqual(r.body.error.code, 'iap.account_mismatch');
    assert.strictEqual(entitlements.length, before);
  });

  await t('verify: expired or refunded transactions grant nothing', async () => {
    const before = entitlements.length;
    let r = await call('POST', '/verify', 'Alice', { signedTransaction: jws('prod', { productId: 'com.pocketcoach.app.coach.annual', appAccountToken: aliceToken, expiresDate: NOW - DAY }) });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.active, false);
    r = await call('POST', '/verify', 'Alice', { signedTransaction: jws('prod', { productId: 'com.pocketcoach.app.coach.annual', appAccountToken: aliceToken, expiresDate: NOW + DAY, revocationDate: NOW - 1 }) });
    assert.strictEqual(r.body.active, false);
    assert.strictEqual(entitlements.length, before);
  });

  await t('verify: bad signatures, unknown products and missing input are rejected', async () => {
    let r = await call('POST', '/verify', 'Alice', { signedTransaction: 'bad|{}' });
    assert.strictEqual(r.status, 400);
    assert.strictEqual(r.body.error.code, 'iap.verification_failed');
    r = await call('POST', '/verify', 'Alice', { signedTransaction: jws('prod', { productId: 'x', appAccountToken: aliceToken }) });
    assert.strictEqual(r.body.error.code, 'iap.unknown_product');
    r = await call('POST', '/verify', 'Alice', {});
    assert.strictEqual(r.body.error.code, 'iap.missing_transaction');
  });

  await t('notifications: renewal found by account token, refund downgrades', async () => {
    const tx = { productId: 'com.pocketcoach.app.pro.annual', appAccountToken: aliceToken, originalTransactionId: '1000', expiresDate: NOW + 365 * DAY };
    let r = await call('POST', '/notifications', null, {
      signedPayload: jws('prod', { notificationType: 'DID_RENEW', data: { signedTransactionInfo: jws('prod', tx) } }),
    });
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(
      (({ uid, plan, status, billingCycle }) => ({ uid, plan, status, billingCycle }))(entitlements.at(-1)),
      { uid: 'uid_alice', plan: 'pro', status: 'active', billingCycle: 'annual' });

    r = await call('POST', '/notifications', null, {
      signedPayload: jws('sandbox', { notificationType: 'REFUND', data: { signedTransactionInfo: jws('sandbox', tx) } }),
    });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(entitlements.at(-1).plan, 'free');
    assert.strictEqual(entitlements.at(-1).status, 'canceled');
  });

  await t('notifications: falls back to the original transaction id', async () => {
    const tx = { productId: 'com.pocketcoach.app.pro.monthly', originalTransactionId: '1000', expiresDate: NOW + DAY };
    const r = await call('POST', '/notifications', null, {
      signedPayload: jws('prod', { notificationType: 'DID_RENEW', data: { signedTransactionInfo: jws('prod', tx) } }),
    });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(entitlements.at(-1).uid, 'uid_alice');
  });

  await t('notifications: unknown accounts are acknowledged, forgeries rejected', async () => {
    const before = entitlements.length;
    let r = await call('POST', '/notifications', null, {
      signedPayload: jws('prod', { notificationType: 'DID_RENEW', data: { signedTransactionInfo: jws('prod', { productId: 'com.pocketcoach.app.pro.monthly', originalTransactionId: '999' }) } }),
    });
    assert.strictEqual(r.status, 200);
    r = await call('POST', '/notifications', null, { signedPayload: 'bad|{}' });
    assert.strictEqual(r.status, 400);
    assert.strictEqual(entitlements.length, before);
  });

  await t('helpers: verifyWithAny tries each environment; notification mapping', async () => {
    assert.deepStrictEqual(await verifyWithAny([fakeVerifier('prod'), fakeVerifier('sandbox')], 'verifyAndDecodeTransaction', jws('sandbox', { a: 1 })), { a: 1 });
    await assert.rejects(() => verifyWithAny([], 'verifyAndDecodeTransaction', 'x'), /No Apple verifiers/);
    assert.deepStrictEqual(entitlementFromNotification('EXPIRED'), { plan: 'free', status: 'canceled' });
    assert.deepStrictEqual(entitlementFromNotification('DID_FAIL_TO_RENEW'), { status: 'past_due' });
    assert.deepStrictEqual(entitlementFromNotification('SUBSCRIBED'), { status: 'active' });
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
