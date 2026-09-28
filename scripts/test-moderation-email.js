// Tests for src/moderationEmail.js with a fake fetch — no mail is sent.
//
// Run: node scripts/test-moderation-email.js
const assert = require('assert');
const { createModerationNotifier } = require('../src/moderationEmail');

const quiet = { warn() {} };

function fakeFetch(response = { ok: true, status: 200, json: async () => ({ id: 'e1' }) }) {
  const calls = [];
  const fn = async (url, opts) => { calls.push({ url, opts, body: JSON.parse(opts.body) }); return response; };
  fn.calls = calls;
  return fn;
}

async function run() {
  let passed = 0;
  const t = async (name, fn) => { await fn(); passed++; console.log('  ok -', name); };

  await t('sends one email through Resend with subject, recipients and key', async () => {
    const fetchImpl = fakeFetch();
    const notify = createModerationNotifier({ apiKey: 're_test', to: 'mod@example.com, two@example.com', fetchImpl, log: quiet });
    await notify('Profile report (spam): @bob reported by @alice. Review within 24 hours.');
    assert.strictEqual(fetchImpl.calls.length, 1);
    const { url, opts, body } = fetchImpl.calls[0];
    assert.strictEqual(url, 'https://api.resend.com/emails');
    assert.strictEqual(opts.headers.Authorization, 'Bearer re_test');
    assert.deepStrictEqual(body.to, ['mod@example.com', 'two@example.com']);
    assert.strictEqual(body.subject, '[Pocket Coach] Profile report (spam): @bob reported by @alice');
    assert.ok(body.text.startsWith('Profile report (spam): @bob reported by @alice.'));
    assert.ok(body.from.includes('@pocketcoachcoms.org'));
  });

  await t('only logs when the API key or recipient is missing', async () => {
    const fetchImpl = fakeFetch();
    const logged = [];
    await createModerationNotifier({ to: 'mod@example.com', fetchImpl, log: { warn: (...a) => logged.push(a) } })('x');
    await createModerationNotifier({ apiKey: 're_test', fetchImpl, log: quiet })('x');
    assert.strictEqual(fetchImpl.calls.length, 0);
    assert.strictEqual(logged.length, 1);
  });

  await t('a Resend error is thrown with its message', async () => {
    const fetchImpl = fakeFetch({ ok: false, status: 403, json: async () => ({ message: 'domain not verified' }) });
    const notify = createModerationNotifier({ apiKey: 're_test', to: 'mod@example.com', fetchImpl, log: quiet });
    await assert.rejects(() => notify('x'), /Resend HTTP 403: domain not verified/);
  });

  console.log(`\n${passed} passed`);
}

run().catch(err => { console.error('FAILED:', err); process.exitCode = 1; });
