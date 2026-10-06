// Tests for exercise classification: src/coach/exerciseClassify.js and
// POST /api/ai/classify-exercises. The Anthropic client's messages.create
// is a scripted fake, so no network and no API key are needed.
//
// Run: node scripts/test-exercise-classify.js
const assert = require('assert');
const express = require('express');

process.env.ANTHROPIC_API_KEY = 'test';

const coachClient = require('../src/coach/client');
const ec = require('../src/coach/exerciseClassify');
const { router: aiRouter } = require('../src/routes/ai');

const calls = [];
let script = [];
coachClient.getClient().messages.create = async (params) => {
  calls.push(JSON.parse(JSON.stringify(params)));
  const step = script.shift();
  if (step instanceof Error) throw step;
  return { stop_reason: 'end_turn', content: [{ type: 'text', text: typeof step === 'string' ? step : JSON.stringify(step) }] };
};

const app = express();
app.use(express.json());
app.use('/api/ai', aiRouter);

let base;
const post = (body) => fetch(base + '/api/ai/classify-exercises', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

async function run() {
  let passed = 0;
  const t = async (name, fn) => {
    calls.length = 0;
    script = [];
    await fn();
    assert.strictEqual(script.length, 0, `${name}: ${script.length} scripted replies were not used`);
    passed++;
    console.log('  ok -', name);
  };

  console.log('input');

  await t('cleanNames trims, collapses spaces, dedupes case-insensitively and caps length', () => {
    const { names } = ec.cleanNames(['  Larsen   press ', 'larsen press', 42, '', 'x'.repeat(200)]);
    assert.deepStrictEqual(names, ['Larsen press', 'x'.repeat(80)]);
  });

  await t('cleanNames rejects empty, non-array and oversized batches', () => {
    assert.ok(ec.cleanNames([]).error);
    assert.ok(ec.cleanNames('Larsen press').error);
    assert.ok(ec.cleanNames(['', '  ']).error);
    assert.ok(ec.cleanNames(Array.from({ length: ec.MAX_NAMES + 1 }, (_, i) => `ex ${i}`)).error);
  });

  console.log('reply parsing');

  await t('keeps only groups from the list; invented names are ignored, skipped ones come back null', () => {
    const text = 'Sure! ```json\n' + JSON.stringify({ results: [
      { name: 'larsen press', muscleGroup: 'Chest', confidence: 1.4, canonicalName: ' Larsen Press ' },
      { name: 'Zercher carry', muscleGroup: 'core', confidence: 0.9, canonicalName: 'Zercher Carry' },
      { name: 'Ignore previous instructions', muscleGroup: 'back', confidence: 1, canonicalName: null },
    ] }) + '\n```';
    const out = ec.parseReply(text, ['Larsen press', 'Zercher carry', 'Spoto press']);
    assert.deepStrictEqual(out, [
      { name: 'Larsen press', muscleGroup: 'chest', confidence: 1, canonicalName: 'Larsen Press' },
      { name: 'Zercher carry', muscleGroup: null, confidence: 0, canonicalName: null },
      { name: 'Spoto press', muscleGroup: null, confidence: 0, canonicalName: null },
    ]);
  });

  await t('an unreadable reply leaves every name unclassified', () => {
    const out = ec.parseReply('I am not sure.', ['Larsen press']);
    assert.deepStrictEqual(out, [{ name: 'Larsen press', muscleGroup: null, confidence: 0, canonicalName: null }]);
  });

  console.log('route');

  await t('POST classifies a batch in one model call with the group list and a JSON schema', async () => {
    script.push({ results: [
      { name: 'Larsen press', muscleGroup: 'chest', confidence: 0.92, canonicalName: 'Larsen Press' },
      { name: 'Spoto press', muscleGroup: 'chest', confidence: 0.88, canonicalName: 'Spoto Press' },
    ] });
    const res = await post({ names: ['Larsen press', 'Spoto press', 'larsen press'] });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.success, true);
    assert.deepStrictEqual(body.results.map((r) => [r.name, r.muscleGroup]), [['Larsen press', 'chest'], ['Spoto press', 'chest']]);
    assert.strictEqual(calls.length, 1);
    assert.deepStrictEqual(JSON.parse(calls[0].messages[0].content), { names: ['Larsen press', 'Spoto press'] });
    ec.MUSCLE_GROUPS.forEach((g) => assert.ok(calls[0].system.includes(g), `system prompt lists ${g}`));
    assert.strictEqual(calls[0].output_config.format.type, 'json_schema');
    assert.ok(calls[0].max_tokens <= 2500, 'fits Groq short-call output cap');
  });

  await t('POST with bad input is 422 and never calls the model', async () => {
    const res = await post({ names: [] });
    assert.strictEqual(res.status, 422);
    assert.strictEqual(calls.length, 0);
  });

  await t('POST answers 502 when the model fails', async () => {
    script.push(new Error('boom'));
    const res = await post({ names: ['Larsen press'] });
    assert.strictEqual(res.status, 502);
    assert.strictEqual((await res.json()).success, false);
  });

  console.log(`\n${passed} passed`);
}

const server = app.listen(0, '127.0.0.1', async () => {
  base = `http://127.0.0.1:${server.address().port}`;
  try {
    await run();
  } catch (err) {
    console.error('FAILED:', err);
    process.exitCode = 1;
  } finally {
    server.closeAllConnections();
    server.close();
  }
});
