// Tests for src/planAccess.js (AI features are Pro; admins bypass) and the
// premium router's admin bypass. No network, no Firebase.
//
// Run: node scripts/test-plan-access.js
const assert = require('assert');
const http = require('http');
const express = require('express');
const { createPlanAccess, parseUsernames } = require('../src/planAccess');
const { createPremiumRouter } = require('../src/routes/premium');

const plans = { freebie: 'free', pat: 'pro', cora: 'coach', '29796': 'free' };
let failLookup = false;
const getPlanInfo = async u => {
  if (failLookup) throw new Error('firestore down');
  return { plan: plans[String(u).toLowerCase()] || 'free', status: 'none' };
};
const sendError = (res, status, code, message) => res.status(status).json({ success: false, error: { code, message } });

const access = createPlanAccess({ getPlanInfo, adminUsernames: parseUsernames(' 29796 , '), sendError });

const app = express();
app.use((req, _res, next) => { req.user = { username: req.headers['x-user'] }; next(); });
app.post('/api/ai/chat', access.requirePaidPlan, (_req, res) => res.json({ success: true, reply: 'hi' }));
app.use('/api/premium', createPremiumRouter({ getPlanInfo, sendError, isAdmin: access.isAdmin }));

let port;
function call(method, path, user) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers: { 'x-user': user } }, res => {
      let raw = '';
      res.on('data', c => { raw += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(raw) }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function run() {
  let passed = 0;
  const t = async (name, fn) => { await fn(); passed++; console.log('  ok -', name); };

  await t('parseUsernames trims, lowercases and drops blanks', () => {
    assert.deepStrictEqual(parseUsernames(' Alice, ,BOB '), ['alice', 'bob']);
    assert.deepStrictEqual(parseUsernames(undefined), []);
  });

  await t('free accounts are refused AI with upgrade_required', async () => {
    const r = await call('POST', '/api/ai/chat', 'freebie');
    assert.strictEqual(r.status, 403);
    assert.strictEqual(r.body.error.code, 'plan.upgrade_required');
  });

  await t('Pro and Coach accounts get AI', async () => {
    assert.strictEqual((await call('POST', '/api/ai/chat', 'pat')).status, 200);
    assert.strictEqual((await call('POST', '/api/ai/chat', 'Cora')).status, 200);
  });

  await t('admin 29796 gets AI on a free plan', async () => {
    const r = await call('POST', '/api/ai/chat', '29796');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(access.isAdmin('29796'), true);
    assert.strictEqual(access.isAdmin('freebie'), false);
  });

  await t('admin bypass skips the plan lookup entirely', async () => {
    failLookup = true;
    try {
      assert.strictEqual((await call('POST', '/api/ai/chat', '29796')).status, 200);
      const r = await call('POST', '/api/ai/chat', 'pat');
      assert.strictEqual(r.status, 503);
      assert.strictEqual(r.body.error.code, 'plan.lookup_failed');
    } finally {
      failLookup = false;
    }
  });

  await t('premium library: free = preview, admin = full', async () => {
    assert.strictEqual((await call('GET', '/api/premium/library', 'freebie')).body.access, 'preview');
    assert.strictEqual((await call('GET', '/api/premium/library', '29796')).body.access, 'full');
    assert.strictEqual((await call('GET', '/api/premium/library', 'pat')).body.access, 'full');
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
