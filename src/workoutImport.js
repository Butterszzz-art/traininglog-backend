// Workout history import (POST /workouts/import).
//
// The app's "Bring your history" screen parses a CSV export from another
// training app (Strong, Hevy, Fitbod) on the phone and sends the sessions
// here in chunks. They're stored next to the user's own workouts in
// users/{uid}/workouts, in the same shape, so history, progress charts and
// overload suggestions read them like any other session.
//
// Imported sessions are marked `imported: true` and are kept OUT of the
// leaderboard: they don't add to users/{uid}.totalVolume / workoutCount,
// don't record exercise-board bests and don't send "you were passed"
// notifications. Otherwise a year of history pasted in at once would put a
// brand-new account at the top of the all-time board and notify everyone
// it passed. POST /workouts, DELETE /workouts/:id and
// scripts/backfill-leaderboard-totals.js all skip imported docs too
// (isImportedWorkout).
//
// Doc ids come from the app (`imp_` + a hash of date, title and sets), so
// importing the same file twice overwrites instead of duplicating.
'use strict';

const { computeSessionVolume, safeDocId, batchSetAll } = require('../workoutStore');
const { compactWorkout } = require('../workoutFormat');

const MAX_PER_REQUEST = 200;
const MAX_LOG_ENTRIES = 80;
const MAX_WORKOUT_BYTES = 64 * 1024;
const MIN_DATE = '1990-01-01';
const SOURCES = new Set(['strong', 'hevy', 'fitbod', 'generic']);
const DATE_RE = /^(\d{4}-\d{2}-\d{2})(T[\d:.]+Z?)?$/;

function isImportedWorkout(docOrData) {
  if (!docOrData) return false;
  const get = typeof docOrData.get === 'function' ? k => docOrData.get(k) : k => docOrData[k];
  if (get('imported') === true) return true;
  const w = get('workout');
  return !!(w && typeof w === 'object' && w.imported === true);
}

/**
 * Validate one request body and turn it into Firestore writes.
 * body: { source, workouts: [{ date, title, workout }] }
 * → { docs: [{ id, data }], skipped } or { error } (a 422 message).
 */
function prepareImport(body, { now = Date.now() } = {}) {
  const list = body && Array.isArray(body.workouts) ? body.workouts : null;
  if (!list || !list.length) return { error: 'workouts must be a non-empty array.' };
  if (list.length > MAX_PER_REQUEST) return { error: `Send at most ${MAX_PER_REQUEST} workouts per request.` };
  const source = SOURCES.has(body.source) ? body.source : 'generic';
  const latest = new Date(now + 36 * 3600 * 1000).toISOString().slice(0, 10); // allow timezones ahead of UTC

  const docs = [];
  let skipped = 0;
  for (const item of list) {
    const workout = item && item.workout;
    const date = String((item && item.date) || '');
    const m = DATE_RE.exec(date);
    const id = safeDocId(workout && workout.id);
    const ok = m && m[1] >= MIN_DATE && m[1] <= latest
      && workout && typeof workout === 'object' && !Array.isArray(workout)
      && Array.isArray(workout.log) && workout.log.length > 0 && workout.log.length <= MAX_LOG_ENTRIES
      && id && id.startsWith('imp_')
      && JSON.stringify(workout).length <= MAX_WORKOUT_BYTES;
    if (!ok) { skipped++; continue; }

    const stored = { ...workout, imported: true, importSource: source };
    const { workout: compact, format } = compactWorkout(stored);
    docs.push({
      id,
      data: {
        date,
        title: String((item && item.title) || workout.title || 'Workout').slice(0, 120),
        sessionVolume: computeSessionVolume(stored),
        imported: true,
        importSource: source,
        workout: compact,
        workoutFormat: format,
      },
    });
  }
  return { docs, skipped };
}

/** Write prepared docs for one user. Returns how many were saved. */
async function saveImport(db, uid, docs) {
  const col = db.collection(`users/${uid}/workouts`);
  await batchSetAll(db, docs.map(d => ({ ref: col.doc(d.id), data: d.data })));
  return docs.length;
}

module.exports = { prepareImport, saveImport, isImportedWorkout, MAX_PER_REQUEST };
