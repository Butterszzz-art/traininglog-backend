// Restores workout docs from a backup written by compact-workouts.js: puts
// back the original `workout`, `workoutFormat` and `sessionVolume` fields.
// Run backfill-leaderboard-totals.js afterwards so counters match.
//
//   node scripts/restore-workouts.js <backup.jsonl> [--dry-run]
'use strict';

const fs = require('fs');
const path = require('path');
const { db, firebaseEnabled, initError } = require(path.join(__dirname, '..', 'firebaseAdmin'));

const file = process.argv[2];
const DRY_RUN = process.argv.includes('--dry-run');

(async () => {
  if (!file || !fs.existsSync(file)) {
    console.error('Usage: node scripts/restore-workouts.js <backup.jsonl> [--dry-run]');
    process.exit(1);
  }
  if (!firebaseEnabled) {
    console.error('Firebase is not configured:', initError || 'unknown error');
    process.exit(1);
  }
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  // Several runs can append to one file; the first backup of a path is the
  // true original.
  const originals = new Map();
  for (const line of lines) {
    const rec = JSON.parse(line);
    if (!originals.has(rec.path)) originals.set(rec.path, rec);
  }
  if (DRY_RUN) {
    console.log(`[dry-run] would restore ${originals.size} docs`);
    process.exit(0);
  }
  const writer = db.bulkWriter();
  for (const rec of originals.values()) {
    writer.update(db.doc(rec.path), {
      workout: rec.workout,
      workoutFormat: rec.workoutFormat ?? null,
      sessionVolume: rec.sessionVolume ?? null
    });
  }
  await writer.close();
  console.log(`Restored ${originals.size} docs from ${file}`);
  process.exit(0);
})().catch(err => {
  console.error('restore-workouts failed:', err);
  process.exit(1);
});
