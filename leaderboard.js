const express = require('express');
const Airtable = require('airtable');
const jwt = require('jsonwebtoken');
const { db, firebaseEnabled } = require('./firebase');

const router = express.Router();

const LEADERBOARD_SIZE = 100;

const airtableApiKey = process.env.AIRTABLE_API_TOKEN || process.env.AIRTABLE_TOKEN || process.env.AIRTABLE_API_KEY;
const airtableBaseId = process.env.AIRTABLE_BASE_ID;
const airtableEnabled = Boolean(airtableApiKey && airtableBaseId);
const airtable = new Airtable({ apiKey: airtableApiKey });
const base = airtable.base(airtableBaseId || '');

function authenticateToken(req, res, next) {
  const token = (req.headers['authorization'] || '').split(' ')[1];
  if (!token) return res.status(401).json({ success: false, error: { code: 'auth.missing_token', message: 'Authorization token is required.' } });
  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ success: false, error: { code: 'auth.invalid_token', message: 'Token invalid or expired.' } });
    req.user = user;
    next();
  });
}

function parseMaybeJson(input) {
  if (typeof input !== 'string') return null;
  try { return JSON.parse(input); } catch { return null; }
}

function computeVolumeFromWorkout(workout) {
  if (!workout || typeof workout !== 'object') return 0;
  const sets = Array.isArray(workout.sets)
    ? workout.sets
    : Array.isArray(workout.exercises)
      ? workout.exercises.flatMap(ex => Array.isArray(ex.sets) ? ex.sets : [])
      : [];
  return sets.reduce((total, set) => {
    const weight = Number(set?.weight || 0);
    const reps   = Number(set?.reps   || 0);
    if (!Number.isFinite(weight) || !Number.isFinite(reps)) return total;
    return total + weight * reps;
  }, 0);
}

// Firestore is authoritative for any username that has migrated (same rule
// every other route in server.js follows) — Airtable's Workouts table only
// still holds real data for usernames that haven't reclaimed their account
// yet. Reading Airtable alone here silently dropped every migrated user's
// volume once their workouts moved to Firestore.
router.get('/leaderboard', authenticateToken, async (_req, res) => {
  try {
    const leaderboardMap = new Map();

    if (firebaseEnabled) {
      // users/{uid}.totalVolume / workoutCount are maintained at write time by
      // workoutStore.saveWorkoutWithTotals(), so this is a single top-N query
      // (LEADERBOARD_SIZE reads) instead of scanning every user's every
      // workout. Existing data needs a one-off
      // `node scripts/backfill-leaderboard-totals.js` to populate them.
      const topSnap = await db.collection('users')
        .orderBy('totalVolume', 'desc')
        .limit(LEADERBOARD_SIZE)
        .get();
      topSnap.docs.forEach(doc => {
        const username = doc.get('username');
        if (!username) return;
        leaderboardMap.set(username, {
          username,
          totalVolume: Number(doc.get('totalVolume')) || 0,
          workoutCount: Number(doc.get('workoutCount')) || 0
        });
      });
    }

    if (airtableEnabled) {
      try {
        const records = await base('Workouts')
          .select({ fields: ['Username', 'SessionVolume', 'WorkoutJSON'], pageSize: 100 })
          .all();

        const legacyTotals = new Map();
        records.forEach(record => {
          const fields   = record.fields || {};
          const username = String(fields.Username || '').trim();
          if (!username) return;

          let sessionVolume = Number(fields.SessionVolume);
          if (!Number.isFinite(sessionVolume)) {
            sessionVolume = computeVolumeFromWorkout(parseMaybeJson(fields.WorkoutJSON));
          }

          const current = legacyTotals.get(username) || { username, totalVolume: 0, workoutCount: 0 };
          current.totalVolume  += sessionVolume;
          current.workoutCount += 1;
          legacyTotals.set(username, current);
        });

        // Skip usernames that have migrated — Firestore is authoritative for
        // them. One read per distinct legacy username (a shrinking set)
        // rather than scanning the whole users collection.
        const migrated = new Set();
        if (firebaseEnabled && legacyTotals.size) {
          const names = Array.from(legacyTotals.keys());
          const snaps = await db.getAll(...names.map(n => db.collection('usernames').doc(n.toLowerCase())));
          snaps.forEach((snap, i) => { if (snap.exists) migrated.add(names[i]); });
        }
        legacyTotals.forEach((entry, username) => {
          if (!migrated.has(username) && !leaderboardMap.has(username)) leaderboardMap.set(username, entry);
        });
      } catch (err) {
        // Non-fatal — still-migrating users' data above is real and shouldn't
        // be thrown away because the legacy fallback source hiccuped.
        console.error('[leaderboard] Airtable fallback failed:', err.message);
      }
    }

    const items = Array.from(leaderboardMap.values())
      .sort((a, b) => b.totalVolume - a.totalVolume)
      .slice(0, LEADERBOARD_SIZE);
    return res.json({ success: true, items });
  } catch (error) {
    console.error('GET /leaderboard failed:', error);
    return res.status(500).json({ success: false, error: 'Failed to load leaderboard' });
  }
});

module.exports = router;
