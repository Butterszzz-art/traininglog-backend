// One-off backfill for the exercise leaderboard (src/routes/exerciseBoard.js).
//
// POST /workouts records each lifter's best Squat / Bench / Deadlift / OHP /
// Row set as workouts are saved. This replays every user's existing workouts
// so history written before that change shows up too. Safe to re-run: each
// workout is keyed by its doc id, so replays overwrite rather than add.
//
// Run against the real project (needs FIREBASE_SERVICE_ACCOUNT or gcloud ADC):
//   node scripts/backfill-exercise-bests.js [--dry-run]
'use strict';

const path = require('path');
const { db, firebaseEnabled, initError } = require(path.join(__dirname, '..', 'firebaseAdmin'));
const { readStoredWorkout } = require(path.join(__dirname, '..', 'workoutFormat'));
const { recordExerciseBests, bestSetsByLift } = require(path.join(__dirname, '..', 'src', 'routes', 'exerciseBoard'));

const DRY_RUN = process.argv.includes('--dry-run');
const PAGE = 300;

(async () => {
  if (!firebaseEnabled) {
    console.error('Firebase is not configured:', initError || 'unknown error');
    process.exit(1);
  }
  let last = null;
  let users = 0;
  let workouts = 0;
  for (;;) {
    let q = db.collection('users').orderBy('__name__').limit(PAGE);
    if (last) q = q.startAfter(last);
    const page = await q.get();
    if (page.empty) break;
    for (const userDoc of page.docs) {
      const username = userDoc.get('username');
      if (!username) continue;
      const snap = await userDoc.ref.collection('workouts').get();
      for (const doc of snap.docs) {
        const stored = doc.data();
        const workout = readStoredWorkout(stored.workout, stored.workoutFormat);
        if (!workout) continue;
        if (!Object.keys(bestSetsByLift(workout)).length) continue;
        workouts++;
        if (DRY_RUN) continue;
        await recordExerciseBests(db, { username, workoutId: doc.id, date: stored.date || workout.date, workout });
      }
      users++;
    }
    last = page.docs[page.docs.length - 1];
  }
  console.log(`${DRY_RUN ? '[dry-run] ' : ''}Recorded exercise bests from ${workouts} workouts across ${users} users.`);
  process.exit(0);
})().catch(err => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
