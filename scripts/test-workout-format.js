// Round-trip tests for workoutFormat.js — the guarantee is "no data lost":
// for every input, readStoredWorkout(compactWorkout(w)) must deep-equal w as
// JSON storage would hold it. Run: node scripts/test-workout-format.js
'use strict';

const path = require('path');
const { isDeepStrictEqual } = require('util');
const { compactWorkout, readStoredWorkout, WORKOUT_FORMAT } = require(path.join(__dirname, '..', 'workoutFormat'));

const results = [];
const check = (label, cond) => results.push({ label, pass: !!cond });
const json = v => JSON.parse(JSON.stringify(v));
const size = v => Buffer.byteLength(JSON.stringify(v));

function roundTrips(w) {
  const { workout, format } = compactWorkout(w);
  // Also pass the stored form through JSON, as Firestore would.
  return isDeepStrictEqual(readStoredWorkout(json(workout), format), json(w));
}

const adv = () => ({ method: null, drops: [], restPauseExtras: [], myo: { activationReps: null, clusters: [] }, backoff: { weight: null, reps: null }, tempo: null, partials: null, assisted: null, amrap: false, tags: {}, state: null });
const entry = (name, n, over = {}) => ({
  exercise: name, sets: n,
  repsArray: Array(n).fill(8), weightsArray: Array(n).fill(80), rpeArray: Array(n).fill(null),
  dropsetArray: Array(n).fill(false), restPauseArray: Array(n).fill(false), unilateralArray: Array(n).fill(false),
  skippedArray: Array(n).fill(false), completedArray: Array(n).fill(false), setTypeArray: Array(n).fill('standard'),
  advancedArray: Array.from({ length: n }, adv), unit: 'kg', date: '2026-09-01', goal: 'hypertrophy', repGoal: 8,
  targetRPE: null, targetRIR: null, maxedOut: false, ...over
});
const logWorkout = (log, over = {}) => ({
  id: 'w1', title: 'Workout on 2026-09-01', date: '2026-09-01', log, restBreaks: [],
  sessionVolume: 12800, averageIntensity: 0.72, estimated1RM: 101.3,
  metrics: { volume: 12800, intensity: 0.72, oneRM: 101.3 }, ...over
});

// ── Typical log-screen workout: compacts a lot, round-trips exactly ──
const typical = logWorkout(['Bench', 'Incline DB', 'Fly', 'OHP', 'Lateral'].map(n => entry(n, 4)));
const typicalResult = compactWorkout(typical);
check('typical: compacted', typicalResult.format === WORKOUT_FORMAT);
check('typical: round-trips', roundTrips(typical));
check('typical: at least 70% smaller', size(typicalResult.workout) < size(typical) * 0.3);
console.log(`typical workout: ${size(typical)} B -> ${size(typicalResult.workout)} B`);

// ── Non-default per-set data is kept verbatim ──
const rich = logWorkout([
  entry('Bench', 3, {
    rpeArray: [7, 8, null], dropsetArray: [false, false, true], setTypeArray: ['top-set', 'backoff', 'dropset'],
    completedArray: [true, true, true], unilateralArray: [false, true, false],
    advancedArray: [adv(), { ...adv(), method: 'myo', myo: { activationReps: 12, clusters: [4, 4] } }, { ...adv(), drops: [{ weight: 60, reps: 8 }], tags: { pain: true } }],
    nextSessionRecommendation: { message: '+2.5kg', delta: 2.5 }, notes: 'felt strong'
  })
], { notes: 'great session', prEvents: [{ exercise: 'Bench', e1rm: 105 }], sessionRating: 9 });
check('rich: round-trips', roundTrips(rich));
const richStored = compactWorkout(rich).workout;
check('rich: non-default arrays kept', isDeepStrictEqual(richStored.log[0].rpeArray, [7, 8, null]) && richStored.log[0].advancedArray.length === 3);
check('rich: all-true completedArray still elided', !('completedArray' in richStored.log[0]));

// ── Shapes and edge cases that must be left alone or round-trip ──
const cases = {
  'history.js shape (sets + exercises)': {
    id: 'h1', userId: 'u', name: 'Resistance Workout', title: 'Resistance Workout', notes: '', units: 'kg',
    date: '2026-09-01T10:00:00.000Z', createdAt: '2026-09-01T10:00:00.000Z',
    sets: [{ exercise: 'Row', weight: 60, reps: 10 }, { exercise: 'Row', weight: 60, reps: 9 }],
    exercises: [{ name: 'Row', sets: [{ weight: 60, reps: 10 }] }, { name: 'Row', sets: [{ weight: 60, reps: 9 }] }]
  },
  'exercises NOT derivable from sets': {
    sets: [{ exercise: 'Row', weight: 60, reps: 10 }],
    exercises: [{ name: 'Row', sets: [{ weight: 60, reps: 10 }, { weight: 50, reps: 12 }] }]
  },
  'archived history entry shape': {
    id: 'a1', createdAt: '2026-08-01T00:00:00.000Z', date: '2026-08-01T00:00:00.000Z', title: 'X', name: 'X', userId: 'u', username: 'u', sessionRating: null,
    workout: { id: 'a1', exercises: [{ name: 'Squat', sets: [{ reps: 5, weight: 100 }] }], sets: [{ exercise: 'Squat', reps: 5, weight: 100 }] }
  },
  'metrics that do NOT mirror the top-level fields': logWorkout([entry('A', 2)], { metrics: { volume: 1, intensity: 2, oneRM: 3 } }),
  'metrics with an extra field': logWorkout([entry('A', 2)], { metrics: { volume: 12800, intensity: 0.72, oneRM: 101.3, extra: 1 } }),
  'arrays shorter/longer than repsArray': logWorkout([entry('A', 3, { dropsetArray: [false, false], skippedArray: [false, false, false, false] })]),
  'entry without repsArray': logWorkout([{ exercise: 'Plank', seconds: [60, 60], dropsetArray: [false, false] }]),
  'entry.date differs from workout.date': logWorkout([entry('A', 2, { date: '2026-08-31' })]),
  'entry.sets differs from set count': logWorkout([entry('A', 2, { sets: 3 })]),
  'workout without date': logWorkout([entry('A', 2)], { date: undefined }),
  'client data already using the _m key (top level)': logWorkout([entry('A', 2)], { _m: 5 }),
  'client data already using the _m key (entry)': logWorkout([entry('A', 2, { _m: 'mine' })]),
  'advanced with extra key': logWorkout([entry('A', 1, { advancedArray: [{ ...adv(), extra: null }] })]),
  'advanced missing a key': logWorkout([entry('A', 1, { advancedArray: [(({ state, ...rest }) => rest)(adv())] })]),
  'string weights / nulls / empty log': logWorkout([entry('A', 2, { weightsArray: ['80', null], repsArray: ['8', ''] })], { log: [] }),
  'non-object log entries': logWorkout([null, 'x', 5, entry('A', 1)]),
  'zero sets': logWorkout([entry('A', 0)]),
  'not an object': 'hello',
  'array': [1, 2, 3],
  'null': null,
  'empty object': {}
};
for (const [label, w] of Object.entries(cases)) check(`${label}: round-trips`, roundTrips(w));
check('_m collision (top level) stored unchanged', compactWorkout(cases['client data already using the _m key (top level)']).format === null);
check('non-derivable exercises kept', 'exercises' in compactWorkout(cases['exercises NOT derivable from sets']).workout);
check('history.js exercises elided', !('exercises' in compactWorkout(cases['history.js shape (sets + exercises)']).workout));

// ── Randomized: thousands of mixed default / non-default workouts ──
let seed = 42;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const pick = arr => arr[Math.floor(rnd() * arr.length)];
const maybe = (p, a, b) => (rnd() < p ? a() : b());
let fuzzFailures = 0;
for (let i = 0; i < 3000; i++) {
  const date = maybe(0.8, () => '2026-09-0' + (1 + Math.floor(rnd() * 9)), () => pick([undefined, '', null, 20260901]));
  const log = Array.from({ length: Math.floor(rnd() * 6) }, () => {
    const n = Math.floor(rnd() * 6);
    const arr = (dflt, alts) => maybe(0.15, () => undefined, () => Array.from({ length: maybe(0.9, () => n, () => n + 1) }, () => maybe(0.85, () => dflt(), () => pick(alts))));
    const e = {
      exercise: pick(['Bench', 'Squat', '', null]),
      repsArray: maybe(0.95, () => Array.from({ length: n }, () => Math.floor(rnd() * 12)), () => undefined),
      weightsArray: Array.from({ length: n }, () => Math.floor(rnd() * 200)),
      rpeArray: arr(() => null, [7, 8.5, 10, 0]),
      dropsetArray: arr(() => false, [true, null]),
      restPauseArray: arr(() => false, [true]),
      unilateralArray: arr(() => false, [true]),
      skippedArray: arr(() => false, [true]),
      completedArray: arr(() => pick([true, false]), [null, true, false]),
      setTypeArray: arr(() => 'standard', ['top-set', 'backoff', 'dropset', 'rest-pause']),
      advancedArray: arr(adv, [{ ...adv(), amrap: true }, { ...adv(), tempo: '3-1-1' }, {}, null]),
      date: maybe(0.7, () => date, () => '2026-01-01'),
      sets: maybe(0.8, () => n, () => n + 1),
    };
    if (rnd() < 0.2) e.extra = { nested: [1, { a: null }] };
    for (const k of Object.keys(e)) if (e[k] === undefined) delete e[k];
    return e;
  });
  const w = { id: 'f' + i, date, log };
  if (rnd() < 0.5) Object.assign(w, { sessionVolume: 1000, averageIntensity: 0.5, estimated1RM: 90, metrics: maybe(0.7, () => ({ volume: 1000, intensity: 0.5, oneRM: 90 }), () => ({ volume: 999 })) });
  if (w.date === undefined) delete w.date;
  if (!roundTrips(w)) fuzzFailures++;
}
check('randomized: 3000 workouts all round-trip', fuzzFailures === 0);

// ── Stored doc without the marker is returned untouched ──
check('legacy doc (no workoutFormat) returned as-is', readStoredWorkout(typical, undefined) === typical);

for (const { label, pass } of results) console.log((pass ? 'PASS' : 'FAIL') + ' - ' + label);
const failed = results.filter(r => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
