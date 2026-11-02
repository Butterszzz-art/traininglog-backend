// Tests for the AI coach: src/coach/{client,tools,prompt,digest}.js and
// POST /api/ai/coach(/brief|/review|/body) in src/routes/coach.js, mounted
// through the real src/routes/ai.js router. The Anthropic client's
// messages.create / beta.messages.stream are swapped for scripted fakes, so
// no network and no API key are needed.
//
// Run: node scripts/test-coach.js
const assert = require('assert');
const express = require('express');

process.env.ANTHROPIC_API_KEY = 'test';
delete process.env.COACH_MODEL;

const { Anthropic, ...coachClient } = require('../src/coach/client');
const { TOOL_DEFS, runTool, e1rm } = require('../src/coach/tools');
const { athleteContext } = require('../src/coach/prompt');
const { buildBriefDigest, buildBodyFacts } = require('../src/coach/digest');
const { router: aiRouter } = require('../src/routes/ai');

// ── helpers ─────────────────────────────────────────────────────────────────

/** assert that `actual` contains every field of `expected` (recursively). */
function assertMatch(actual, expected, path = '') {
  if (expected && typeof expected === 'object' && !Array.isArray(expected)) {
    assert.ok(actual && typeof actual === 'object', `${path || 'value'} should be an object, got ${JSON.stringify(actual)}`);
    Object.entries(expected).forEach(([k, v]) => assertMatch(actual[k], v, `${path}.${k}`));
  } else {
    assert.deepStrictEqual(actual, expected, `${path}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

const apiError = (Cls, status, msg) => new Cls(status, { error: {} }, msg, new Headers());

// ── scripted Anthropic client ───────────────────────────────────────────────
// Each script step is { message } (a final Message), { throw } (an error),
// and optionally { text: [deltas] } streamed before the message.

const calls = [];
let script = [];

// `via` tags each recorded call with the provider whose client got it.
function installFakes(client, via) {
const record = params => calls.push({ ...JSON.parse(JSON.stringify(params)), ...(via ? { via } : {}) });
client.messages.create = async params => {
  record(params);
  const step = script.shift();
  if (step.throw) throw step.throw;
  return step.message;
};
if (client.beta) client.beta.messages.stream = params => {
  record(params);
  const step = script.shift();
  const handlers = {};
  return {
    on(evt, fn) { handlers[evt] = fn; return this; },
    abort() {},
    async finalMessage() {
      if (step.throw) throw step.throw;
      (step.text || []).forEach(t => handlers.text && handlers.text(t));
      return step.message;
    },
  };
};
}
const client = coachClient.getClient();
installFakes(client);

// Switch to open-model providers for one test; each has its own client.
async function withOpenModels(names, fn) {
  delete process.env.ANTHROPIC_API_KEY;
  names.forEach(n => { process.env[`${n.toUpperCase()}_API_KEY`] = 'test'; });
  coachClient.markGood(null);
  names.forEach(n => installFakes(coachClient.getClient(n), n));
  try {
    await fn();
  } finally {
    ['OPENROUTER_API_KEY', 'OLLAMA_API_KEY', 'GROQ_API_KEY', 'OPENROUTER_MODELS', 'OLLAMA_MODELS', 'GROQ_MODELS'].forEach(k => delete process.env[k]);
    process.env.ANTHROPIC_API_KEY = 'test';
    coachClient.markGood(null);
  }
}
const withOpenRouter = fn => withOpenModels(['openrouter'], fn);
const withBoth = fn => withOpenModels(['ollama', 'openrouter'], fn);

// ── app: the real /api/ai router behind a fake auth middleware ──────────────

const app = express();
app.use('/api/ai/coach', express.json({ limit: '1mb' }));
app.use(express.json());
app.use('/api/ai', (req, _res, next) => {
  if (req.headers['x-user']) req.user = { uid: 'u1', username: req.headers['x-user'] };
  next();
}, aiRouter);

let base;
const post = (path, body, { user = 'pat', raw } = {}) => fetch(base + path, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(user ? { 'x-user': user } : {}) },
  body: raw !== undefined ? raw : JSON.stringify(body),
});

function parseSSE(body) {
  return body.split('\n\n').filter(Boolean).map(frame => ({
    type: /event: (.*)/.exec(frame)[1],
    data: JSON.parse(/data: (.*)/.exec(frame)[1]),
  }));
}

// ── fixtures ────────────────────────────────────────────────────────────────

const toolPack = {
  generatedAt: '2026-09-23T07:00:00.000Z',
  workouts: [
    { date: '2026-09-02', title: 'Legs A', exercises: [{ name: 'Back Squat', sets: [{ w: 120, r: 5 }, { w: 105, r: 5 }] }] },
    { date: '2026-09-09', title: 'Legs A', exercises: [{ name: 'Back Squat', sets: [{ w: 120, r: 5, rpe: 9 }] }] },
    { date: '2026-09-16', title: 'Push B', exercises: [{ name: 'Bench Press', sets: [{ w: 85, r: 5 }] }] },
  ],
  bodyweight: [
    { date: '2026-09-01', kg: 82 }, { date: '2026-09-08', kg: 81.6 },
    { date: '2026-09-15', kg: 81.1 }, { date: '2026-09-22', kg: 80.6 },
  ],
  macros: { targets: { calories: 2400, protein: 180, carbs: 250, fat: 75 } },
  program: {
    id: 'p1', name: 'PPL',
    days: [{ name: 'Legs A', exercises: [{ name: 'Back Squat', sets: [{ reps: 5, weight: 120 }] }] }],
  },
};

const routePack = {
  generatedAt: '2026-09-23T07:00:00.000Z',
  workouts: [
    { date: '2026-09-09', title: 'Legs A', exercises: [{ name: 'Back Squat', sets: [{ w: 120, r: 5 }] }] },
    { date: '2026-09-16', title: 'Legs A', exercises: [{ name: 'Back Squat', sets: [{ w: 120, r: 5 }] }] },
  ],
  program: { id: 'p1', name: 'PPL', days: [{ name: 'Legs A', exercises: [{ name: 'Back Squat', sets: [{ reps: 5, weight: 120 }] }] }] },
};

const endTurn = text => ({ message: { stop_reason: 'end_turn', content: [{ type: 'text', text }] } });

// ── tests ───────────────────────────────────────────────────────────────────

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

  console.log('coach tools');

  await t('every tool definition has a closed object schema', () => {
    TOOL_DEFS.forEach(d => {
      assert.strictEqual(d.input_schema.type, 'object');
      assert.strictEqual(d.input_schema.additionalProperties, false);
    });
  });

  await t('e1rm uses Epley and ignores high-rep sets', () => {
    assert.strictEqual(e1rm(100, 1), 100);
    assert.ok(Math.abs(e1rm(120, 5) - 140) < 1e-9);
    assert.strictEqual(e1rm(60, 20), null);
  });

  await t('exercise history fuzzy-matches and reports e1RM per session', () => {
    const out = runTool('get_exercise_history', { exercise: 'squat' }, toolPack);
    assert.deepStrictEqual(out.result.matched, ['Back Squat']);
    assert.strictEqual(out.result.sessions.length, 2);
    assertMatch(out.result.sessions[1], { date: '2026-09-09', topSet: '120×5', e1rmKg: 140 });
    assert.strictEqual(out.trace, 'Back Squat · 2 sessions');
    assert.strictEqual(out.chart.points.length, 2);
  });

  await t('exercise history lists logged names when nothing matches', () => {
    const out = runTool('get_exercise_history', { exercise: 'deadlift' }, toolPack);
    assert.deepStrictEqual(out.result.exercisesLogged, ['Back Squat', 'Bench Press']);
  });

  await t('body metrics computes a weekly rate from the 7-day trend', () => {
    const out = runTool('get_body_metrics', { days: 60 }, toolPack);
    assert.ok(out.result.ratePerWeekKg < 0);
    assert.strictEqual(out.result.bodyweight.length, 4);
  });

  await t('missing sections come back as unavailable, not as empty data', () => {
    const out = runTool('get_recovery', {}, { generatedAt: toolPack.generatedAt });
    assert.match(out.result.sleep, /turned off/);
  });

  await t('program change is validated against the real program', () => {
    const bad = runTool('propose_program_change', {
      title: 'x', day: 'Legs B', rationale: 'r', changes: [{ op: 'remove_exercise', exercise: 'Back Squat' }],
    }, toolPack);
    assert.strictEqual(bad.isError, true);
    assert.match(bad.result.error, /Legs A/);

    const good = runTool('propose_program_change', {
      title: 'Restart squat', day: 'legs a', rationale: 'Stalled 3 weeks.',
      changes: [{ op: 'set_sets', exercise: 'Back Squat', sets: [{ reps: 3, weight: 125 }, { reps: 5, weight: 110 }] }],
    }, toolPack);
    assert.strictEqual(good.isError, undefined);
    assertMatch(good.card, { type: 'program_change', day: 'Legs A', programId: 'p1' });
    assert.deepStrictEqual(good.card.changes[0].sets, [{ reps: 3, weight: 125 }, { reps: 5, weight: 110 }]);
  });

  await t('macro proposal must add up', () => {
    const bad = runTool('propose_macro_targets', { calories: 3000, protein: 180, carbs: 250, fat: 75, rationale: '' }, toolPack);
    assert.strictEqual(bad.isError, true);
    const good = runTool('propose_macro_targets', { calories: 2500, protein: 180, carbs: 275, fat: 75, rationale: 'hungry' }, toolPack);
    assert.deepStrictEqual(good.card.from, toolPack.macros.targets);
    assert.strictEqual(good.card.to.carbs, 275);
  });

  await t('a macro proposal that matches the current targets is rejected', () => {
    const same = runTool('propose_macro_targets', { calories: 2400, protein: 180, carbs: 251, fat: 75, rationale: 'x' }, toolPack);
    assert.strictEqual(same.isError, true);
    assert.strictEqual(same.card, undefined);
  });

  await t('remember trims and returns a memory event', () => {
    assert.strictEqual(runTool('remember', { fact: '  Left shoulder:\n no BTN press ' }, toolPack).memory, 'Left shoulder: no BTN press');
  });

  await t('unknown tools and bad input do not throw', () => {
    assert.strictEqual(runTool('nope', {}, toolPack).isError, true);
    assert.strictEqual(runTool('get_program', null, toolPack).isError, true);
  });

  console.log('coach prompt');

  await t('athlete context fences memory and notes turned-off data', () => {
    const text = athleteContext({
      profile: { name: 'Sam', unit: 'lbs' },
      memory: [{ text: 'Hates lunges' }],
      access: { recovery: false, workouts: true },
      style: 'hype',
      today: '2026-09-23',
    });
    assert.ok(text.includes('<memory>\n- Hates lunges\n</memory>'));
    assert.ok(text.includes('turned off coach access to: recovery'));
    assert.ok(text.includes('logged in lbs'));
    assert.match(text, /energetic/);
  });

  console.log('coach digest');

  const now = '2026-09-23T07:00:00.000Z';
  const squat = (date, w) => ({ date, title: 'Legs A', exercises: [{ name: 'Back Squat', sets: [{ w, r: 5 }] }] });

  await t('brief: flags a flat lift, scores short sleep down, and names the session', () => {
    const d = buildBriefDigest({
      generatedAt: now,
      profile: { unit: 'kg', phase: 'Cut' },
      workouts: [squat('2026-08-19', 115), squat('2026-08-26', 120), squat('2026-09-02', 120), squat('2026-09-09', 120), squat('2026-09-16', 120), squat('2026-09-21', 120)],
      sleep: [
        { date: '2026-09-15', hours: 7.5 }, { date: '2026-09-17', hours: 7.4 }, { date: '2026-09-19', hours: 7.3 },
        { date: '2026-09-22', hours: 5.8 },
      ],
      bodyweight: [
        { date: '2026-09-01', kg: 82 }, { date: '2026-09-06', kg: 81.8 }, { date: '2026-09-12', kg: 81.2 }, { date: '2026-09-20', kg: 80.9 },
      ],
    }, { session: 'Push B' });
    assertMatch(d.flag, { text: 'Back Squat stuck at 120 kg for 3 weeks', question: 'Why has my back squat stalled?' });
    assert.ok(d.readiness.score < 70);
    assert.strictEqual(d.bullets[0].tone, 'watch');
    assert.match(d.bullets[0].text, /^Sleep 5.8 h, under your 7.4 h average/);
    assert.strictEqual(d.signals.find(s => s.text.startsWith('Weight trend')).tone, 'good');
    assert.ok(d.headline.includes('Push B'));
    assert.strictEqual(d.hasData, true);
  });

  await t('brief: a lift that is still climbing is not a stall', () => {
    const pack = { generatedAt: now, workouts: [squat('2026-09-02', 110), squat('2026-09-09', 115), squat('2026-09-16', 120)] };
    assert.strictEqual(buildBriefDigest(pack, {}).flag, null);
  });

  await t('brief: no data → no readiness, a prompt to log, rest day wording', () => {
    const d = buildBriefDigest({ generatedAt: now }, {});
    assert.strictEqual(d.readiness, null);
    assert.strictEqual(d.hasData, false);
    assert.match(d.headline, /Log a session/);
    assert.match(buildBriefDigest({ generatedAt: now }, { restDay: true }).headline, /^Rest day/);
  });

  await t("brief: last night's sleep counts all day, whatever the hour", () => {
    const sleep = [{ date: '2026-09-18', hours: 7.5 }, { date: '2026-09-19', hours: 7.5 }, { date: '2026-09-20', hours: 7.5 }, { date: '2026-09-22', hours: 5.9 }];
    const lateEvening = new Date(2026, 8, 23, 23, 30).toISOString();
    assert.match(buildBriefDigest({ generatedAt: lateEvening, sleep }, {}).signals[0].text, /^Sleep 5.9 h/);
  });

  const at = '2026-09-23T08:00:00.000Z';
  const weighIns = perWeek => Array.from({ length: 10 }, (_, i) => {
    const d = new Date(Date.parse('2026-08-27T00:00:00Z') + i * 3 * 86400000);
    return { date: d.toISOString().slice(0, 10), kg: +(80 + (perWeek * i * 3) / 7).toFixed(2) };
  });
  const days = n => Array.from({ length: n }, (_, i) => new Date(Date.parse('2026-09-23T00:00:00Z') - i * 86400000).toISOString().slice(0, 10));

  await t('body: flat weight on a cut is the top takeaway', () => {
    const out = buildBodyFacts({ generatedAt: at, profile: { phase: 'Cut', unit: 'kg' }, bodyweight: weighIns(0) });
    assert.strictEqual(out.facts.weight.ratePerWeek, 0);
    assertMatch(out.takeaways[0], { key: 'weight', tone: 'watch' });
    assert.match(out.takeaways[0].text, /flat/);
    assert.strictEqual(out.hasData, true);
  });

  await t('body: a sustainable cut rate is a keep-going takeaway', () => {
    const out = buildBodyFacts({ generatedAt: at, profile: { phase: 'cut' }, bodyweight: weighIns(-0.5) });
    assert.ok(Math.abs(out.facts.weight.ratePerWeek + 0.5) < 0.05);
    assertMatch(out.takeaways[0], { key: 'weight', tone: 'good' });
  });

  await t('body: low protein and short sleep are ranked above good news', () => {
    const out = buildBodyFacts({
      generatedAt: at, profile: {},
      sleep: days(7).map(date => ({ date, hours: 6.2 })),
      cardio: days(5).map(date => ({ date, durationMin: 35 })),
      macros: { targets: { calories: 2400, protein: 180 }, intake: days(5).map(date => ({ date, kcal: 2300, protein: 120 })) },
    });
    assert.deepStrictEqual(out.takeaways.map(x => x.key), ['protein', 'sleep', 'cardio']);
    assert.match(out.takeaways[0].text, /120g vs your 180g/);
    assert.match(out.headline, /2 things/);
  });

  await t('body: placeholder targets are ignored and sparse logging is flagged', () => {
    const out = buildBodyFacts({
      generatedAt: at, profile: {},
      macros: { targets: { calories: 343, protein: 17 }, intake: [{ date: '2026-09-23', kcal: 1700, protein: 120 }] },
    });
    assertMatch(out.facts.nutrition, { calorieTarget: null, proteinTarget: null, daysLogged7d: 1 });
    assert.strictEqual(out.takeaways[0].key, 'logging');
  });

  await t('body: no data at all', () => {
    assertMatch(buildBodyFacts({ generatedAt: at, profile: {} }), { hasData: false, takeaways: [] });
  });

  console.log('coach client');

  await t('configured only with ANTHROPIC_API_KEY; refusal fallbacks on by default', () => {
    assert.strictEqual(coachClient.isConfigured(), true);
    assert.deepStrictEqual(coachClient.fallbackParams(), { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' });
  });

  await t('createMessage passes the model through and rejects a reply without content', async () => {
    script = [endTurn('hi'), { message: { error: 'upstream' } }];
    assert.strictEqual((await coachClient.createMessage('m1', { max_tokens: 5 })).content[0].text, 'hi');
    assert.strictEqual(calls[0].model, 'm1');
    await assert.rejects(coachClient.createMessage('m1', {}), coachClient.MalformedReply);
  });

  await t('createMessage aborts after timeoutMs', async () => {
    const saved = client.messages.create;
    client.messages.create = (_params, opts) => new Promise((_resolve, reject) => {
      opts.signal.addEventListener('abort', () => reject(new Error('aborted')));
    });
    try {
      await assert.rejects(coachClient.createMessage('m1', {}, { timeoutMs: 20 }), /aborted/);
    } finally {
      client.messages.create = saved;
    }
  });

  console.log('POST /api/ai/coach');

  await t('runs a tool round then streams the answer', async () => {
    script = [
      {
        text: ['Let me check.'],
        message: {
          stop_reason: 'tool_use',
          content: [
            { type: 'text', text: 'Let me check.' },
            { type: 'tool_use', id: 't1', name: 'get_exercise_history', input: { exercise: 'squat' } },
            { type: 'tool_use', id: 't2', name: 'propose_program_change', input: {
              title: 'Restart squat', day: 'Legs A', rationale: 'Flat for 2 weeks.',
              changes: [{ op: 'set_sets', exercise: 'Back Squat', sets: [{ reps: 3, weight: 125 }] }],
            } },
            { type: 'tool_use', id: 't3', name: 'remember', input: { fact: 'Trains at 6am' } },
          ],
        },
      },
      { text: ['Your squat is ', '**flat**.'], ...endTurn('Your squat is **flat**.') },
    ];

    const res = await post('/api/ai/coach', {
      message: 'Why has my squat stalled?',
      history: [{ role: 'assistant', content: 'orphan' }, { role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }],
      data: routePack,
      memory: [{ text: 'Hates lunges' }],
      access: { recovery: false },
      style: 'balanced',
    });
    assert.match(res.headers.get('content-type'), /text\/event-stream/);
    const events = parseSSE(await res.text());

    assert.strictEqual(events[events.length - 1].type, 'done');
    assert.deepStrictEqual(events.filter(e => e.type === 'trace').map(e => e.data.label), ['Back Squat · 2 sessions']);
    assertMatch(events.find(e => e.type === 'card').data, { type: 'program_change', day: 'Legs A' });
    assert.strictEqual(events.find(e => e.type === 'memory').data.text, 'Trains at 6am');
    assert.strictEqual(events.find(e => e.type === 'chart').data.kind, 'e1rm');
    assert.strictEqual(events.filter(e => e.type === 'text').map(e => e.data.delta).join(''), 'Let me check.\n\nYour squat is **flat**.');

    // First request: Anthropic model + fallbacks, cleaned history (leading
    // assistant dropped), then the question.
    assertMatch(calls[0], { model: 'claude-opus-5-5', fallbacks: 'default', output_config: { effort: 'medium' }, cache_control: { type: 'ephemeral' } });
    assert.deepStrictEqual(calls[0].betas, ['server-side-fallback-2026-07-01']);
    assert.deepStrictEqual(calls[0].messages.map(m => m.role), ['user', 'assistant', 'user']);
    assert.ok(calls[0].system[1].text.includes('Hates lunges'));
    assert.ok(calls[0].system[1].text.includes('recovery'));
    assert.ok(calls[0].tools.every(x => x.eager_input_streaming));
    // Second request carries all three tool results in one user message.
    const last = calls[1].messages[calls[1].messages.length - 1];
    assert.strictEqual(last.role, 'user');
    assert.deepStrictEqual(last.content.map(c => c.tool_use_id), ['t1', 't2', 't3']);
    assert.strictEqual(JSON.parse(last.content[0].content).sessionsLogged, 2);
  });

  await t('an unparseable streamed tool input is re-issued; API errors are not', async () => {
    script = [{ throw: new SyntaxError('Unexpected end of JSON input') }, { text: ['Fine.'], ...endTurn('Fine.') }];
    let events = parseSSE(await (await post('/api/ai/coach', { message: 'x', data: routePack })).text());
    assert.deepStrictEqual(events.map(e => e.type), ['text', 'done']);
    assert.strictEqual(calls.length, 2);

    calls.length = 0;
    script = [{ throw: apiError(Anthropic.RateLimitError, 429, 'busy') }];
    events = parseSSE(await (await post('/api/ai/coach', { message: 'x', data: routePack })).text());
    assert.deepStrictEqual(events.map(e => e.type), ['error']);
    assert.match(events[0].data.message, /busy/);
    assert.strictEqual(calls.length, 1);
  });

  await t('refusal ends with an error event', async () => {
    script = [{ message: { stop_reason: 'refusal', content: [] } }];
    const events = parseSSE(await (await post('/api/ai/coach', { message: 'x', data: routePack })).text());
    assert.deepStrictEqual(events.map(e => e.type), ['error']);
  });

  await t('rejects an empty message before streaming', async () => {
    assert.strictEqual((await post('/api/ai/coach', null, { raw: '{}' })).status, 400);
  });

  await t('refuses requests without req.user, even if mounted without auth', async () => {
    for (const path of ['/api/ai/coach', '/api/ai/coach/brief', '/api/ai/coach/review', '/api/ai/coach/body', '/api/ai/coach/nutrition-review']) {
      const res = await post(path, { message: 'x', data: routePack }, { user: null });
      assert.strictEqual(res.status, 401, path);
    }
  });

  await t('no ANTHROPIC_API_KEY → 404 AI_NOT_CONFIGURED', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const res = await post('/api/ai/coach/body', { data: {} });
      assert.strictEqual(res.status, 404);
      assert.strictEqual((await res.json()).error, 'AI_NOT_CONFIGURED');
    } finally {
      process.env.ANTHROPIC_API_KEY = 'test';
    }
  });

  await t('accepts a data pack larger than the global 256kb body limit', async () => {
    const workouts = Array.from({ length: 1000 }, (_, i) => ({
      date: '2026-09-16', title: `Session ${i}`, exercises: [{ name: 'Back Squat', sets: Array.from({ length: 20 }, () => ({ w: 120, r: 5 })) }],
    }));
    const raw = JSON.stringify({ data: { generatedAt: now, workouts } });
    assert.ok(raw.length > 256 * 1024);
    script = [endTurn('{"headline":"Train.","bullets":[]}')];
    assert.strictEqual((await post('/api/ai/coach/brief', null, { raw })).status, 200);
  });

  console.log('POST /api/ai/coach/brief');

  const briefPack = { generatedAt: now, sleep: [{ date: '2026-09-22', hours: 5.5 }] };

  await t('AI wording comes back when the reply parses', async () => {
    script = [endTurn('{"headline":"Push B today, keep it at RPE 8.","bullets":[{"text":"Sleep 5.5 h last night","tone":"watch"}]}')];
    const body = await (await post('/api/ai/coach/brief', { data: briefPack, today: { session: 'Push B' } })).json();
    assert.strictEqual(body.source, 'ai');
    assert.strictEqual(body.headline, 'Push B today, keep it at RPE 8.');
    assert.ok(body.digest.readiness.score < 70);
    assertMatch(JSON.parse(calls[0].messages[0].content), { plannedSession: 'Push B' });
    assert.strictEqual(calls[0].output_config.format.type, 'json_schema');
  });

  await t('malformed or failed AI falls back to the rules brief', async () => {
    script = [endTurn('Sure! Here you go.')];
    let body = await (await post('/api/ai/coach/brief', { data: briefPack })).json();
    assert.strictEqual(body.source, 'rules');
    assert.strictEqual(body.headline, body.digest.headline);

    script = [{ throw: new Error('network down') }];
    body = await (await post('/api/ai/coach/brief', { data: briefPack })).json();
    assertMatch(body, { source: 'rules', aiError: 'failed' });

    script = [{ throw: apiError(Anthropic.InternalServerError, 500, 'oops') }];
    body = await (await post('/api/ai/coach/brief', { data: briefPack })).json();
    assertMatch(body, { source: 'rules', aiError: 500 });
  });

  console.log('POST /api/ai/coach/body');

  const bodyPack = {
    generatedAt: now,
    profile: { unit: 'kg', phase: 'cut' },
    sleep: [{ date: '2026-09-22', hours: 6 }, { date: '2026-09-21', hours: 6.4 }],
  };

  await t('AI takeaways come back and only facts are sent', async () => {
    script = [endTurn('{"headline":"Sleep is the lever this week.","bullets":[{"text":"Get to bed 30 min earlier","tone":"watch"}]}')];
    const body = await (await post('/api/ai/coach/body', { data: bodyPack })).json();
    assertMatch(body, { source: 'ai', headline: 'Sleep is the lever this week.' });
    assert.deepStrictEqual(body.bullets, [{ text: 'Get to bed 30 min earlier', tone: 'watch' }]);
    const sent = JSON.parse(calls[0].messages[0].content);
    assertMatch(sent.facts.sleep, { nights7d: 2, avgHours: 6.2 });
    assert.strictEqual(sent.draft.bullets[0].tone, 'watch');
    assert.deepStrictEqual(body.recovery, []);
  });

  await t('tracker vitals reach the AI and come back as recovery lines', async () => {
    const line = { text: 'HRV 34 ms is under your usual 45–55. Cap top sets at RPE 7 today.', tone: 'watch' };
    script = [endTurn(JSON.stringify({ headline: 'Recovery is the lever today.', bullets: [{ text: 'Get to bed 30 min earlier', tone: 'watch' }], recovery: [line] }))];
    const vitals = { status: { level: 'watch', title: 'Worth watching' }, metrics: [
      { key: 'hrvMs', label: 'HRV', unit: 'ms', value: 34, date: '2026-09-23', fresh: true, usualLow: 45, usualHigh: 55, baselineDays: 12, flag: 'low', change30: null },
    ] };
    const body = await (await post('/api/ai/coach/body', { data: { ...bodyPack, vitals } })).json();
    assert.deepStrictEqual(body.recovery, [line]);
    const sent = JSON.parse(calls[0].messages[0].content);
    assertMatch(sent.facts.vitals.metrics[0], { name: 'HRV', value: 34, usualRange: '45–55', flag: 'low' });
    assert.match(sent.draft.recovery[0].text, /^HRV 34 ms, below your usual 45–55/);
  });

  await t('an AI reply without recovery lines falls back to the rules ones', async () => {
    script = [endTurn('{"headline":"Sleep is the lever this week.","bullets":[{"text":"Get to bed 30 min earlier","tone":"watch"}]}')];
    const vitals = { status: null, metrics: [{ key: 'hrvMs', label: 'HRV', unit: 'ms', value: 34, fresh: true, usualLow: 45, usualHigh: 55, flag: 'low' }] };
    const body = await (await post('/api/ai/coach/body', { data: { ...bodyPack, vitals } })).json();
    assert.strictEqual(body.source, 'ai');
    assert.match(body.recovery[0].text, /^HRV 34 ms, below your usual/);
  });

  await t('no data or a failed AI call returns the rules takeaways', async () => {
    let body = await (await post('/api/ai/coach/body', { data: {} })).json();
    assert.strictEqual(body.source, 'rules');
    assert.strictEqual(calls.length, 0);

    script = [{ throw: new Error('network down') }];
    body = await (await post('/api/ai/coach/body', { data: bodyPack })).json();
    assertMatch(body, { source: 'rules', aiError: 'failed' });
    assert.match(body.bullets[0].text, /Sleep averages 6.2h/);
  });

  console.log('POST /api/ai/coach/review');

  const reviewBody = {
    facts: { week: { start: '2026-09-14', end: '2026-09-20' }, training: { sessions: 3 } },
    rules: { summary: 'Rules summary.', wins: ['w1'], watch: ['x1'] },
    data: {
      generatedAt: now,
      macros: { targets: { calories: 2400, protein: 180, carbs: 250, fat: 75 } },
      program: { id: 'p1', name: 'PPL', days: [{ name: 'Legs A', exercises: [{ name: 'Back Squat', sets: [{ reps: 5, weight: 120 }] }] }] },
    },
  };

  await t('AI review with invalid proposals dropped, valid ones as cards', async () => {
    const ai = {
      summary: 'Solid week.', wins: ['Squat PR'], watch: ['Protein low'],
      proposals: [
        { kind: 'program', title: 'Heavier triple', rationale: 'PR at 125.', day: 'Legs A', changes: [{ op: 'set_sets', exercise: 'Back Squat', sets: [{ reps: 3, weight: 127.5 }] }] },
        { kind: 'program', title: 'Bogus day', rationale: 'x', day: 'Arms', changes: [{ op: 'remove_exercise', exercise: 'Curl' }] },
        { kind: 'macros', title: 'More protein', rationale: 'Low protein.', calories: 2450, protein: 200, carbs: 230, fat: 75 },
      ],
    };
    // A code-fenced reply must still parse.
    script = [endTurn('```json\n' + JSON.stringify(ai) + '\n```')];
    const body = await (await post('/api/ai/coach/review', reviewBody)).json();
    assert.strictEqual(body.source, 'ai');
    assert.strictEqual(body.summary, 'Solid week.');
    assert.deepStrictEqual(body.cards.map(c => c.title), ['Heavier triple', 'More protein']);
    assertMatch(body.cards[1], { type: 'macro_targets', from: { protein: 180 }, to: { protein: 200 } });
    assert.deepStrictEqual(JSON.parse(calls[0].messages[0].content).draft.wins, ['w1']);
    assert.strictEqual(calls[0].output_config.format.type, 'json_schema');
  });

  await t('unusable AI reply falls back to the rules review', async () => {
    script = [endTurn('no json here')];
    const body = await (await post('/api/ai/coach/review', reviewBody)).json();
    assert.deepStrictEqual(body, { summary: 'Rules summary.', wins: ['w1'], watch: ['x1'], cards: [], source: 'rules' });
  });

  await t('facts are required', async () => {
    assert.strictEqual((await post('/api/ai/coach/review', null, { raw: '{}' })).status, 400);
  });

  console.log('POST /api/ai/coach/nutrition-review');

  const nutritionBody = {
    facts: {
      week: { start: '2026-10-19', end: '2026-10-25', daysLogged: 7, avgKcal: 2400, avgProtein: 160 },
      target: { calories: 2500, protein: 180 },
      maintenance: { kcal: 2950, confidence: 'good' },
      supplementCandidates: [{ id: 'vitamin_d', why: 'Oct-Mar' }, { id: 'creatine', why: 'trains' }],
    },
    rules: {
      headline: 'Protein 160 g vs 180 g.',
      items: [{ kind: 'work_on', text: 'Protein averaged 160 g against your 180 g target.' }, { kind: 'nonsense', text: 'x' }],
      supplements: [{ id: 'vitamin_d', why: 'Oct-Mar' }, { id: 'ashwagandha', why: 'nope' }],
    },
  };

  await t('AI nutrition review: cleaned, only listed supplements, no unknown kinds', async () => {
    const ai = {
      headline: 'Real maintenance is ~2,950 kcal, so 2,500 keeps the cut going.',
      items: [
        { kind: 'work_on', text: 'Add 20 g protein at breakfast.' },
        { kind: 'work_on', text: 'Two.' },
        { kind: 'work_on', text: 'A third work-on is dropped.' },
        { kind: 'keeps_working', text: 'Fibre 32 g.' },
        { kind: 'think_about', text: 'Weight -0.5 kg.' },
      ],
      supplements: [
        { id: 'vitamin_d', why: 'Little sun until March.' },
        { id: 'iron', why: 'Not a candidate for this athlete.' },
        { id: 'vitamin_d', why: 'duplicate' },
      ],
    };
    script = [endTurn(JSON.stringify(ai))];
    const body = await (await post('/api/ai/coach/nutrition-review', nutritionBody)).json();
    assert.strictEqual(body.source, 'ai');
    assert.deepStrictEqual(body.items.map(i => i.text), ['Add 20 g protein at breakfast.', 'Two.', 'Fibre 32 g.', 'Weight -0.5 kg.']);
    assert.deepStrictEqual(body.supplements, [{ id: 'vitamin_d', name: 'Vitamin D', why: 'Little sun until March.' }]);
    assert.deepStrictEqual(JSON.parse(calls[0].messages[0].content).facts.maintenance, { kcal: 2950, confidence: 'good' });
    assert.strictEqual(calls[0].output_config.format.type, 'json_schema');
  });

  await t('unusable AI reply → the app’s rules review, cleaned', async () => {
    script = [endTurn('no json here')];
    const body = await (await post('/api/ai/coach/nutrition-review', nutritionBody)).json();
    assert.deepStrictEqual(body, {
      headline: 'Protein 160 g vs 180 g.',
      items: [{ kind: 'work_on', text: 'Protein averaged 160 g against your 180 g target.' }],
      supplements: [{ id: 'vitamin_d', name: 'Vitamin D', why: 'Oct-Mar' }],
      source: 'rules',
    });
  });

  await t('AI failure → rules review with aiError', async () => {
    script = [{ throw: new Error('network down') }];
    const body = await (await post('/api/ai/coach/nutrition-review', nutritionBody)).json();
    assertMatch(body, { source: 'rules', aiError: 'failed' });
  });

  await t('nutrition review: facts required, size-capped', async () => {
    assert.strictEqual((await post('/api/ai/coach/nutrition-review', null, { raw: '{}' })).status, 400);
    assert.strictEqual((await post('/api/ai/coach/nutrition-review', { facts: { blob: 'x'.repeat(25000) } })).status, 400);
  });

  console.log('open models (Ollama / OpenRouter)');

  const free = coachClient.OPENROUTER_FREE_MODELS;
  const orRefs = free.map(m => `openrouter::${m}`);
  const olRefs = coachClient.OLLAMA_FREE_MODELS.map(m => `ollama::${m}`);

  await t('OpenRouter key alone → free model chain, no Anthropic-only params', () => withOpenRouter(() => {
    assert.strictEqual(coachClient.provider(), 'openrouter');
    assert.strictEqual(coachClient.openModels(), true);
    assert.deepStrictEqual(coachClient.modelChain('claude-opus-5-5'), orRefs);
    assert.deepStrictEqual(coachClient.fallbackParams(), {});
    assert.deepStrictEqual(coachClient.jsonOutput({ type: 'object' }, 'low'), { effort: 'low' });
    process.env.OPENROUTER_MODELS = 'claude-haiku-4-5-20251001, openai/gpt-x';
    assert.deepStrictEqual(coachClient.modelChain('m'), ['openrouter::anthropic/claude-haiku-4.5', 'openrouter::openai/gpt-x']);
  }));

  await t('both open keys → Ollama first, then OpenRouter', () => withBoth(() => {
    assert.deepStrictEqual(coachClient.providers(), ['ollama', 'openrouter']);
    assert.deepStrictEqual(coachClient.modelChain('m'), [...olRefs, ...orRefs]);
    process.env.OLLAMA_MODELS = 'gpt-oss:120b,gemma4:31b';
    assert.deepStrictEqual(coachClient.modelChain('m').slice(0, 2), ['ollama::gpt-oss:120b', 'ollama::gemma4:31b']);
    // an OpenRouter model answering doesn't move OpenRouter ahead of Ollama
    coachClient.markGood(orRefs[2]);
    assert.deepStrictEqual(coachClient.modelChain('m').slice(2, 4), [orRefs[2], orRefs[3]]);
  }));

  await t('Anthropic key wins over every open-model key', () => withBoth(() => {
    process.env.ANTHROPIC_API_KEY = 'test';
    assert.strictEqual(coachClient.provider(), 'anthropic');
    assert.strictEqual(coachClient.openModels(), false);
    assert.deepStrictEqual(coachClient.modelChain('claude-opus-5-5'), ['anthropic::claude-opus-5-5']);
  }));

  await t('prepare trims each request to what its provider accepts', () => withBoth(() => {
    const params = {
      max_tokens: 10, betas: ['b'], fallbacks: 'default', cache_control: { type: 'ephemeral' },
      output_config: { effort: 'low', format: { type: 'json_schema' } },
      plugins: [{ id: 'file-parser' }],
      tools: [{ name: 'x', input_schema: {}, eager_input_streaming: true }],
      messages: [{ role: 'user', content: 'hi' }],
    };
    const ol = coachClient.prepare(olRefs[0], params).body;
    assert.deepStrictEqual(ol, {
      max_tokens: 10, model: 'gemma4:31b', output_config: { effort: 'low' },
      tools: [{ name: 'x', input_schema: {} }], messages: params.messages,
    });
    const or = coachClient.prepare(orRefs[0], params).body;
    assert.strictEqual(or.model, free[0]);
    assert.deepStrictEqual(or.plugins, params.plugins);
    assert.deepStrictEqual(or.cache_control, params.cache_control);
    assert.strictEqual(or.betas, undefined);
    const pdf = { ...params, messages: [{ role: 'user', content: [{ type: 'document', source: {} }] }] };
    assert.strictEqual(coachClient.prepare(olRefs[0], pdf), null, 'Ollama has no PDF input');
    assert.ok(coachClient.prepare(orRefs[0], pdf));
  }));

  await t('chat: a rate-limited free model is skipped for the next one', () => withOpenRouter(async () => {
    script = [{ throw: apiError(Anthropic.RateLimitError, 429, 'busy') }, { text: ['Squat looks fine.'], ...endTurn('Squat looks fine.') }];
    const body = await (await post('/api/ai/coach', { message: 'How is my squat?', data: routePack })).text();
    assert.deepStrictEqual(parseSSE(body).map(e => e.type), ['text', 'done']);
    assert.deepStrictEqual(calls.map(c => c.model), [free[0], free[1]]);
    assert.strictEqual(calls[1].betas, undefined);
    assert.strictEqual(calls[1].fallbacks, undefined);
    // the model that answered goes first next time
    assert.strictEqual(coachClient.modelChain('x')[0], orRefs[1]);
  }));

  await t('chat: Ollama out of free allowance (402) → OpenRouter answers', () => withBoth(async () => {
    script = [{ throw: apiError(Anthropic.APIError, 402, 'usage limit reached') }, { text: ['Fine.'], ...endTurn('Fine.') }];
    const body = await (await post('/api/ai/coach', { message: 'Hi', data: routePack })).text();
    assert.deepStrictEqual(parseSSE(body).map(e => e.type), ['text', 'done']);
    assert.deepStrictEqual(calls.map(c => [c.via, c.model]), [['ollama', 'gemma4:31b'], ['openrouter', free[0]]]);
    assert.strictEqual(calls[0].cache_control, undefined);
    assert.ok(calls[0].tools.every(tool => tool.eager_input_streaming === undefined));
  }));

  await t('brief: JSON shape comes from the instructions, not output_config.format', () => withOpenRouter(async () => {
    script = [endTurn('Sure! {"headline":"Rest today.","bullets":[]}')];
    const body = await (await post('/api/ai/coach/brief', { data: briefPack })).json();
    assert.strictEqual(body.source, 'ai');
    assert.strictEqual(body.headline, 'Rest today.');
    assert.deepStrictEqual(calls[0].output_config, { effort: 'low' });
    assert.strictEqual(calls[0].model, free[0]);
  }));

  await t('ai.js routes use the chain, a token floor and the first text block', () => withBoth(async () => {
    script = [
      { throw: apiError(Anthropic.InternalServerError, 503, 'overloaded') },
      { message: { stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: 'Solid week.' }] } },
    ];
    const res = await post('/api/ai/checkin-summary', {
      sleep: 7, energy: 6, stress: 4, bodyweightThisWeek: 80, compliancePercent: 90, goal: 'cut', archetype: 'lifter',
    });
    assert.deepStrictEqual(await res.json(), { summary: 'Solid week.' });
    assert.deepStrictEqual(calls.map(c => c.via), ['ollama', 'openrouter']);
    assert.strictEqual(calls[1].max_tokens, 4096);
  }));

  console.log('Groq');

  const groq = require('../src/coach/groq');
  const withAll = fn => withOpenModels(['ollama', 'groq', 'openrouter'], fn);

  await t('groq: Anthropic request ↔ Chat Completions', () => {
    const req = groq.toChatRequest({
      model: 'openai/gpt-oss-120b', max_tokens: 16000,
      system: [{ type: 'text', text: 'Be brief.' }, { type: 'text', text: 'Athlete: Pat.' }],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }, { role: 'assistant', content: 'Hello' }],
    });
    assert.deepStrictEqual(req, {
      model: 'openai/gpt-oss-120b',
      messages: [
        { role: 'system', content: 'Be brief.\n\nAthlete: Pat.' },
        { role: 'user', content: 'Hi' },
        { role: 'assistant', content: 'Hello' },
      ],
      max_completion_tokens: 2500,
      reasoning_effort: 'low',
    });
    const msg = groq.toMessage({ id: 'c1', choices: [{ message: { content: 'Done' }, finish_reason: 'length' }], usage: { prompt_tokens: 5, completion_tokens: 7 } }, 'm');
    assertMatch(msg, { content: [{ type: 'text', text: 'Done' }], stop_reason: 'max_tokens', usage: { input_tokens: 5, output_tokens: 7 } });
    assert.strictEqual(groq.toMessage({ choices: [] }, 'm').content, null);
  });

  await t('groq: only short, text-only requests fit the free tier', () => {
    const small = { max_tokens: 2000, system: 'Short.', messages: [{ role: 'user', content: 'Hi' }] };
    assert.strictEqual(groq.fitsGroq(small), true);
    assert.strictEqual(groq.fitsGroq({ ...small, system: 'x'.repeat(29000) }), false, 'ai.js methodology prompt is too big');
    assert.strictEqual(groq.fitsGroq({ ...small, tools: [{ name: 't' }] }), false);
    assert.strictEqual(groq.fitsGroq({ ...small, messages: [{ role: 'user', content: [{ type: 'image', source: {} }] }] }), false);
  });

  await t('groq: HTTP errors become SDK errors the chain understands', async () => {
    const seen = [];
    const answers = [
      { ok: false, status: 429, json: { error: { message: 'Rate limit reached' } } },
      { ok: true, status: 200, json: { choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] } },
    ];
    const fakeFetch = async (url, init) => {
      seen.push({ url, auth: init.headers.Authorization, body: JSON.parse(init.body) });
      const a = answers.shift();
      return { ok: a.ok, status: a.status, headers: new Headers(), json: async () => a.json };
    };
    const c = groq.createGroqClient('k', fakeFetch);
    const body = { model: 'openai/gpt-oss-20b', max_tokens: 100, messages: [{ role: 'user', content: 'Hi' }] };
    await assert.rejects(c.messages.create(body), err => err instanceof Anthropic.RateLimitError && err.status === 429);
    assert.strictEqual((await c.messages.create(body)).content[0].text, 'ok');
    assert.strictEqual(seen[0].url, 'https://api.groq.com/openai/v1/chat/completions');
    assert.strictEqual(seen[0].auth, 'Bearer k');
    const down = groq.createGroqClient('k', async () => { throw new Error('ECONNRESET'); });
    await assert.rejects(down.messages.create(body), Anthropic.APIConnectionError);
  });

  await t('all three keys → Ollama, Groq, OpenRouter', () => withAll(() => {
    assert.deepStrictEqual(coachClient.providers(), ['ollama', 'groq', 'openrouter']);
    const chain = coachClient.modelChain('m');
    assert.deepStrictEqual(chain.slice(0, 3), [...olRefs, ...coachClient.GROQ_FREE_MODELS.map(m => `groq::${m}`)]);
    assert.deepStrictEqual(chain.slice(3), orRefs);
    const groqRef = `groq::${coachClient.GROQ_FREE_MODELS[0]}`;
    assert.strictEqual(coachClient.prepare(groqRef, { max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] }, { stream: true }), null);
  }));

  await t('brief: Ollama busy → Groq answers the short call', () => withAll(async () => {
    script = [{ throw: apiError(Anthropic.RateLimitError, 429, 'busy') }, endTurn('{"headline":"Easy day.","bullets":[]}')];
    const body = await (await post('/api/ai/coach/brief', { data: briefPack })).json();
    assert.strictEqual(body.headline, 'Easy day.');
    assert.deepStrictEqual(calls.map(c => c.via), ['ollama', 'groq']);
    assert.strictEqual(calls[1].model, coachClient.GROQ_FREE_MODELS[0]);
    assert.strictEqual(calls[1].cache_control, undefined);
  }));

  await t('chat (streamed) and the big ai.js prompt skip Groq', () => withAll(async () => {
    script = [{ throw: apiError(Anthropic.RateLimitError, 429, 'busy') }, { text: ['Fine.'], ...endTurn('Fine.') }];
    await (await post('/api/ai/coach', { message: 'Hi', data: routePack })).text();
    assert.deepStrictEqual(calls.map(c => c.via), ['ollama', 'openrouter']);
    calls.length = 0;
    script = [{ throw: apiError(Anthropic.RateLimitError, 429, 'busy') }, endTurn('Solid week.')];
    await post('/api/ai/checkin-summary', { sleep: 7, energy: 6, stress: 4, bodyweightThisWeek: 80, compliancePercent: 90, goal: 'cut', archetype: 'lifter' });
    assert.deepStrictEqual(calls.map(c => c.via), ['ollama', 'openrouter']);
  }));

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
