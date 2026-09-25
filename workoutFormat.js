// Compact storage format for workout objects (users/{uid}/workouts/*.workout).
//
// The app's log entries carry ~10 parallel per-set arrays, most of them all
// defaults ([false,false,…], ['standard',…], and an 11-field empty
// `advancedArray` object per set), plus fields derivable from others. That
// padding was ~80% of every stored workout.
//
// compactWorkout() removes ONLY values it can rebuild exactly, and records
// what it removed in a bitmask (`_m`) on the object it removed them from.
// expandWorkout() rebuilds them. Lossless by construction:
//   - it never touches a value that isn't exactly the default / derivable one;
//   - unknown fields are left as they are;
//   - every compaction is verified: compact → expand must deep-equal the
//     original, otherwise the original is stored unchanged.
//
// A doc stores the compacted form only when it also has
// `workoutFormat: WORKOUT_FORMAT` next to `workout` — the marker lives
// outside the workout object so client data can never be mistaken for it.
//
// The defaults below are part of the stored format: never change what an
// existing bit means. To support a new default, add a new bit.
'use strict';

const { isDeepStrictEqual } = require('util');

const WORKOUT_FORMAT = 2;

const defaultAdvancedSet = () => ({
  method: null,
  drops: [],
  restPauseExtras: [],
  myo: { activationReps: null, clusters: [] },
  backoff: { weight: null, reps: null },
  tempo: null,
  partials: null,
  assisted: null,
  amrap: false,
  tags: {},
  state: null
});

// Per-set arrays on a log entry that are dropped when every element equals
// the default and the array is as long as repsArray. Bit = index.
const ENTRY_ARRAY_DEFAULTS = [
  ['rpeArray', () => null],
  ['dropsetArray', () => false],
  ['restPauseArray', () => false],
  ['unilateralArray', () => false],
  ['skippedArray', () => false],
  ['completedArray', () => false],
  ['completedArray', () => true],
  ['setTypeArray', () => 'standard'],
  ['advancedArray', defaultAdvancedSet]
];
const ENTRY_BIT_DATE = 1 << ENTRY_ARRAY_DEFAULTS.length;       // entry.date === workout.date
const ENTRY_BIT_SETS = 1 << (ENTRY_ARRAY_DEFAULTS.length + 1); // entry.sets === repsArray.length

const WORKOUT_BIT_METRICS = 1 << 0;   // metrics mirrors sessionVolume/averageIntensity/estimated1RM
const WORKOUT_BIT_EXERCISES = 1 << 1; // exercises derived from flat `sets` (history.js shape)

const MASK_KEY = '_m';

const isPlainObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const clone = v => JSON.parse(JSON.stringify(v));

const metricsFor = w => ({ volume: w.sessionVolume, intensity: w.averageIntensity, oneRM: w.estimated1RM });
const exercisesFor = w => w.sets.map(set => ({ name: set.exercise, sets: [{ weight: set.weight, reps: set.reps }] }));

function compactEntry(entry, workoutDate) {
  if (!isPlainObject(entry) || MASK_KEY in entry || !Array.isArray(entry.repsArray)) return entry;
  const n = entry.repsArray.length;
  const out = { ...entry };
  let mask = 0;
  ENTRY_ARRAY_DEFAULTS.forEach(([key, makeDefault], bit) => {
    // completedArray has two candidate defaults; once one bit has removed
    // it, `out[key]` is gone and the other check skips.
    const arr = out[key];
    if (Array.isArray(arr) && arr.length === n && arr.every(v => isDeepStrictEqual(v, makeDefault()))) {
      delete out[key];
      mask |= 1 << bit;
    }
  });
  if (typeof out.date === 'string' && out.date === workoutDate) {
    delete out.date;
    mask |= ENTRY_BIT_DATE;
  }
  if (typeof out.sets === 'number' && out.sets === n) {
    delete out.sets;
    mask |= ENTRY_BIT_SETS;
  }
  if (!mask) return entry;
  out[MASK_KEY] = mask;
  return out;
}

function expandEntry(entry, workoutDate) {
  if (!isPlainObject(entry) || typeof entry[MASK_KEY] !== 'number') return entry;
  const mask = entry[MASK_KEY];
  const out = { ...entry };
  delete out[MASK_KEY];
  const n = Array.isArray(out.repsArray) ? out.repsArray.length : 0;
  ENTRY_ARRAY_DEFAULTS.forEach(([key, makeDefault], bit) => {
    if (mask & (1 << bit)) out[key] = Array.from({ length: n }, makeDefault);
  });
  if (mask & ENTRY_BIT_DATE) out.date = workoutDate;
  if (mask & ENTRY_BIT_SETS) out.sets = n;
  return out;
}

function compactUnverified(workout) {
  if (!isPlainObject(workout) || MASK_KEY in workout) return null;
  const out = { ...workout };
  let mask = 0;

  if (isPlainObject(out.metrics) && isDeepStrictEqual(out.metrics, metricsFor(out))) {
    delete out.metrics;
    mask |= WORKOUT_BIT_METRICS;
  }
  if (Array.isArray(out.sets) && Array.isArray(out.exercises) &&
      out.sets.every(isPlainObject) && isDeepStrictEqual(out.exercises, exercisesFor(out))) {
    delete out.exercises;
    mask |= WORKOUT_BIT_EXERCISES;
  }
  let entriesChanged = false;
  if (Array.isArray(out.log)) {
    const log = out.log.map(e => compactEntry(e, out.date));
    entriesChanged = log.some((e, i) => e !== out.log[i]);
    out.log = log;
  }
  if (!mask && !entriesChanged) return null;
  if (mask) out[MASK_KEY] = mask;
  return out;
}

/** Stored form → the workout object exactly as the app originally sent it. */
function expandWorkout(stored) {
  if (!isPlainObject(stored)) return stored;
  const out = { ...stored };
  const mask = typeof out[MASK_KEY] === 'number' ? out[MASK_KEY] : 0;
  delete out[MASK_KEY];
  if (Array.isArray(out.log)) out.log = out.log.map(e => expandEntry(e, out.date));
  if (mask & WORKOUT_BIT_METRICS) out.metrics = metricsFor(out);
  if (mask & WORKOUT_BIT_EXERCISES) out.exercises = exercisesFor(out);
  return out;
}

/**
 * Returns { workout, format } to store. `format` is WORKOUT_FORMAT when the
 * compact form is used (store it as the doc's `workoutFormat`), or null when
 * the original is stored unchanged (nothing to compact, or verification
 * failed).
 */
function compactWorkout(workout) {
  try {
    const original = clone(workout); // exactly what JSON storage would hold
    const compacted = compactUnverified(original);
    if (!compacted) return { workout, format: null };
    if (!isDeepStrictEqual(expandWorkout(clone(compacted)), original)) {
      console.warn('[workoutFormat] compaction did not round-trip; storing original');
      return { workout, format: null };
    }
    return { workout: compacted, format: WORKOUT_FORMAT };
  } catch (err) {
    console.warn('[workoutFormat] compaction failed; storing original:', err.message);
    return { workout, format: null };
  }
}

/** Read side: the doc's `workout` field as the app should receive it. */
function readStoredWorkout(stored, format) {
  return format === WORKOUT_FORMAT ? expandWorkout(stored) : stored;
}

module.exports = { WORKOUT_FORMAT, compactWorkout, expandWorkout, readStoredWorkout };
