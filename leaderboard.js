const express = require('express');
const Airtable = require('airtable');
const jwt = require('jsonwebtoken');

const router = express.Router();

const airtable = new Airtable({ apiKey: process.env.AIRTABLE_API_TOKEN || process.env.AIRTABLE_TOKEN || process.env.AIRTABLE_API_KEY });
const base = airtable.base(process.env.AIRTABLE_BASE_ID || '');

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

router.get('/leaderboard', authenticateToken, async (_req, res) => {
  try {
    const records = await base('Workouts')
      .select({ fields: ['Username', 'SessionVolume', 'WorkoutJSON'], pageSize: 100 })
      .all();

    const leaderboardMap = new Map();
    records.forEach(record => {
      const fields    = record.fields || {};
      const username  = String(fields.Username || '').trim();
      if (!username) return;

      let sessionVolume = Number(fields.SessionVolume);
      if (!Number.isFinite(sessionVolume)) {
        sessionVolume = computeVolumeFromWorkout(parseMaybeJson(fields.WorkoutJSON));
      }

      const current = leaderboardMap.get(username) || { username, totalVolume: 0, workoutCount: 0 };
      current.totalVolume  += sessionVolume;
      current.workoutCount += 1;
      leaderboardMap.set(username, current);
    });

    const items = Array.from(leaderboardMap.values()).sort((a, b) => b.totalVolume - a.totalVolume);
    return res.json({ success: true, items });
  } catch (error) {
    console.error('GET /leaderboard failed:', error);
    return res.status(500).json({ success: false, error: 'Failed to load leaderboard' });
  }
});

module.exports = router;
