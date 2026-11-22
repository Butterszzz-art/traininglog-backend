// AI coach + BU Time-efficient training: session timing in the training
// summary tool, the Home brief's session-length signal, and the time budget
// in the athlete context.
const test = require('node:test');
const assert = require('node:assert/strict');
const { runTool } = require('../src/coach/tools');
const { buildBriefDigest } = require('../src/coach/digest');
const { athleteContext } = require('../src/coach/prompt');

const NOW = Date.parse('2026-11-22T09:00:00Z');
const daysAgo = n => new Date(NOW - n * 86400000).toISOString().slice(0, 10);
const session = (n, timing) => ({
  date: daysAgo(n), title: 'Full A',
  exercises: [{ name: 'Bench Press', sets: [{ w: 80, r: 8 }, { w: 80, r: 8 }] }],
  ...(timing ? { timing } : {}),
});

const pack = {
  generatedAt: new Date(NOW).toISOString(),
  timeBudgetMin: 45,
  workouts: [
    session(9, { min: 58, sets: 16, perSet: 3.6, otherMin: 14, target: 45, budget: true }),
    session(6, { min: 61, sets: 17, perSet: 3.6, otherMin: 16, target: 45, budget: true }),
    session(3, { min: 57, sets: 16, perSet: 3.6, otherMin: 12, target: 45, budget: true }),
    session(1),
  ],
};

test('get_training_summary adds per-session minutes and a session-length summary', () => {
  const { result } = runTool('get_training_summary', { weeks: 4 }, pack);
  assert.deepEqual(result.recentSessions[1], {
    date: daysAgo(3), title: 'Full A', exercises: ['Bench Press (2 sets)'],
    minutes: 57, minutesPerSet: 3.6, minutesNotSetsOrRest: 12, targetMinutes: 45, targetFrom: 'time budget',
  });
  assert.equal(result.recentSessions[0].minutes, undefined, 'untimed session stays as before');
  assert.deepEqual(result.sessionLength, {
    timedSessions: 3, avgMinutes: 59, avgMinutesPerSet: 3.6, avgMinutesNotSetsOrRest: 14,
    avgTargetMinutes: 45, sessionsOverTargetBy5Plus: 3,
  });
  assert.equal(result.timeBudgetMin, 45);
});

test('get_training_summary without timing is unchanged', () => {
  const { result } = runTool('get_training_summary', { weeks: 4 }, { generatedAt: pack.generatedAt, workouts: [session(2)] });
  assert.equal(result.sessionLength, undefined);
  assert.equal(result.timeBudgetMin, undefined);
});

test('brief: a "time" signal when 3+ recent sessions run 10+ min over target', () => {
  const d = buildBriefDigest(pack, { now: NOW });
  const sig = d.signals.find(s => /^Sessions averaging/.test(s.text));
  assert.ok(sig, 'time signal present');
  assert.equal(sig.text, 'Sessions averaging 59 min, about 14 over your 45-min target');
  assert.equal(sig.tone, 'watch');

  const close = { ...pack, workouts: pack.workouts.map(w => (w.timing ? { ...w, timing: { ...w.timing, min: 50 } } : w)) };
  assert.ok(!buildBriefDigest(close, { now: NOW }).signals.some(s => /^Sessions averaging/.test(s.text)), '5 min over is fine');
  const two = { ...pack, workouts: pack.workouts.slice(1) };
  assert.ok(!buildBriefDigest(two, { now: NOW }).signals.some(s => /^Sessions averaging/.test(s.text)), 'needs 3 timed sessions');
});

test('athleteContext states the time budget only for an offered budget', () => {
  assert.match(athleteContext({ today: '2026-11-22', timeBudgetMin: 30 }), /Time budget: about 30 min per session/);
  assert.doesNotMatch(athleteContext({ today: '2026-11-22', timeBudgetMin: 37 }), /Time budget/);
  assert.doesNotMatch(athleteContext({ today: '2026-11-22' }), /Time budget/);
});
