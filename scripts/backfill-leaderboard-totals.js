// One-off backfill for the storage-efficiency change (see workoutStore.js).
//
// 1. Recomputes users/{uid}.totalVolume and .workoutCount from each user's
//    existing workouts, so GET /leaderboard (which now reads only those
//    counters) includes history written before the change. Each user is
//    recomputed inside a transaction, so a workout saved concurrently can't be
//    lost or double-counted. Safe to re-run: it sets absolute values.
// 2. With --delete-sets, also deletes the legacy per-set docs
//    (users/{uid}/workouts/{id}/sets/*) that POST /workouts used to write and
//    nothing ever read.
//
// Run against the real project (needs FIREBASE_SERVICE_ACCOUNT or gcloud ADC):
//   node scripts/backfill-leaderboard-totals.js [--delete-sets] [--dry-run]
'use strict';

const path = require('path');
const { db, firebaseEnabled, initError } = require(path.join(__dirname, '..', 'firebaseAdmin'));

const DRY_RUN = process.argv.includes('--dry-run');
const DELETE_SETS = process.argv.includes('--delete-sets');
const PAGE = 300;

async function backfillTotals() {
  let last = null;
  let users = 0;
  for (;;) {
    let q = db.collection('users').orderBy('__name__').limit(PAGE);
    if (last) q = q.startAfter(last);
    const page = await q.get();
    if (page.empty) break;

    for (const userDoc of page.docs) {
      const workoutsQuery = userDoc.ref.collection('workouts').select('sessionVolume');
      if (DRY_RUN) {
        const snap = await workoutsQuery.get();
        const totalVolume = snap.docs.reduce((t, d) => t + (Number(d.get('sessionVolume')) || 0), 0);
        console.log(`[dry-run] ${userDoc.id}: workoutCount=${snap.size} totalVolume=${totalVolume}`);
      } else {
        await db.runTransaction(async tx => {
          const snap = await tx.get(workoutsQuery);
          const totalVolume = snap.docs.reduce((t, d) => t + (Number(d.get('sessionVolume')) || 0), 0);
          tx.set(userDoc.ref, { totalVolume, workoutCount: snap.size }, { merge: true });
        });
      }
      users++;
    }
    last = page.docs[page.docs.length - 1];
  }
  console.log(`${DRY_RUN ? '[dry-run] ' : ''}Recomputed leaderboard totals for ${users} users.`);
}

async function deleteLegacySets() {
  let deleted = 0;
  for (;;) {
    const page = await db.collectionGroup('sets').limit(PAGE).get();
    // Only the legacy users/{uid}/workouts/{id}/sets/* docs.
    const legacy = page.docs.filter(d => d.ref.parent.parent?.parent?.id === 'workouts');
    if (!legacy.length) break;
    if (DRY_RUN) {
      console.log(`[dry-run] would delete at least ${legacy.length} legacy set docs`);
      return;
    }
    const writer = db.bulkWriter();
    legacy.forEach(d => writer.delete(d.ref));
    await writer.close();
    deleted += legacy.length;
    if (legacy.length < page.docs.length) break; // remaining 'sets' docs aren't ours
  }
  console.log(`Deleted ${deleted} legacy set docs.`);
}

(async () => {
  if (!firebaseEnabled) {
    console.error('Firebase is not configured:', initError || 'unknown error');
    process.exit(1);
  }
  await backfillTotals();
  if (DELETE_SETS) await deleteLegacySets();
  process.exit(0);
})().catch(err => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
