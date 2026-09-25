// One-off: convert existing users/{uid}/workouts docs to the compact format
// (workoutFormat.js) and fix their stored sessionVolume.
//
// Safety:
// - Every doc is compacted with compactWorkout(), which verifies the result
//   expands back to exactly the original and otherwise leaves it unchanged.
// - Before any write, the doc's original `workout` / `workoutFormat` /
//   `sessionVolume` are appended to a local JSONL backup file
//   (--backup=<path>, default ./workouts-backup-<timestamp>.jsonl).
//   scripts/restore-workouts.js puts them back.
// - Writes carry a lastUpdateTime precondition: a doc the app changed while
//   this ran is skipped (and reported), never overwritten.
// - --dry-run reports what would change and writes nothing.
//
// sessionVolume: workouts saved from the app's log screen (the `log` shape)
// were stored with sessionVolume 0 because the backend didn't understand
// that shape. This recomputes it; run backfill-leaderboard-totals.js
// afterwards so the leaderboard counters pick the corrected values up.
//
// Run (needs FIREBASE_SERVICE_ACCOUNT or gcloud ADC):
//   node scripts/compact-workouts.js --dry-run
//   node scripts/compact-workouts.js [--backup=path.jsonl]
'use strict';

const fs = require('fs');
const path = require('path');
const { db, firebaseEnabled, initError } = require(path.join(__dirname, '..', 'firebase'));
const { compactWorkout, readStoredWorkout, WORKOUT_FORMAT } = require(path.join(__dirname, '..', 'workoutFormat'));
const { computeSessionVolume } = require(path.join(__dirname, '..', 'workoutStore'));

const DRY_RUN = process.argv.includes('--dry-run');
const backupArg = process.argv.find(a => a.startsWith('--backup='));
const BACKUP_PATH = backupArg ? backupArg.slice('--backup='.length) : `workouts-backup-${Date.now()}.jsonl`;
const PAGE = 200;

const bytes = v => Buffer.byteLength(JSON.stringify(v ?? null));

(async () => {
  if (!firebaseEnabled) {
    console.error('Firebase is not configured:', initError || 'unknown error');
    process.exit(1);
  }

  const stats = { scanned: 0, compacted: 0, volumeFixed: 0, skippedConcurrent: 0, bytesBefore: 0, bytesAfter: 0 };
  const backup = DRY_RUN ? null : fs.openSync(BACKUP_PATH, 'a');
  let last = null;

  for (;;) {
    let q = db.collectionGroup('workouts').orderBy('__name__').limit(PAGE);
    if (last) q = q.startAfter(last);
    const page = await q.get();
    if (page.empty) break;
    last = page.docs[page.docs.length - 1];

    const writer = DRY_RUN ? null : db.bulkWriter();
    if (writer) {
      writer.onWriteError(err => {
        if (err.code === 9 /* FAILED_PRECONDITION */) {
          stats.skippedConcurrent++;
          console.warn(`skipped (changed during run): ${err.documentRef.path}`);
          return false;
        }
        return err.failedAttempts < 3;
      });
    }

    for (const doc of page.docs) {
      if (doc.ref.parent.parent?.parent?.id !== 'users') continue; // only users/{uid}/workouts
      stats.scanned++;
      const stored = doc.get('workout');
      const format = doc.get('workoutFormat') ?? null;
      if (stored == null) continue;

      const original = readStoredWorkout(stored, format);
      const update = {};

      if (format !== WORKOUT_FORMAT) {
        const result = compactWorkout(original);
        if (result.format === WORKOUT_FORMAT) {
          update.workout = result.workout;
          update.workoutFormat = WORKOUT_FORMAT;
          stats.compacted++;
          stats.bytesBefore += bytes(stored);
          stats.bytesAfter += bytes(result.workout);
        }
      }

      const volume = computeSessionVolume(original);
      const storedVolume = Number(doc.get('sessionVolume')) || 0;
      if (volume !== storedVolume) {
        update.sessionVolume = volume;
        stats.volumeFixed++;
      }

      if (!Object.keys(update).length) continue;
      if (DRY_RUN) continue;

      fs.writeSync(backup, JSON.stringify({
        path: doc.ref.path,
        updateTime: doc.updateTime.toDate().toISOString(),
        workout: stored,
        workoutFormat: format,
        sessionVolume: doc.get('sessionVolume') ?? null
      }) + '\n');
      writer.update(doc.ref, update, { lastUpdateTime: doc.updateTime });
    }
    if (writer) await writer.close();
  }

  if (backup !== null) fs.closeSync(backup);
  const saved = stats.bytesBefore ? Math.round((1 - stats.bytesAfter / stats.bytesBefore) * 100) : 0;
  console.log(`${DRY_RUN ? '[dry-run] ' : ''}scanned ${stats.scanned} workouts; ` +
    `compacted ${stats.compacted} (${stats.bytesBefore} B -> ${stats.bytesAfter} B, ${saved}% smaller); ` +
    `sessionVolume corrected on ${stats.volumeFixed}; skipped ${stats.skippedConcurrent} changed during run.`);
  if (!DRY_RUN) console.log(`Backup of every changed doc: ${path.resolve(BACKUP_PATH)}`);
  process.exit(0);
})().catch(err => {
  console.error('compact-workouts failed:', err);
  process.exit(1);
});
