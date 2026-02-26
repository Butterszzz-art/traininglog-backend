const express = require('express');
const Airtable = require('airtable');

const router = express.Router();

const airtable = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY });
const base = airtable.base(process.env.AIRTABLE_BASE_ID || '');

function parseMaybeJson(input) {
  if (typeof input !== 'string') return null;
  try {
    return JSON.parse(input);
  } catch {
    return null;
  }
}

function computeVolumeFromWorkout(workout) {
  if (!workout || typeof workout !== 'object') return 0;

  const sets = Array.isArray(workout.sets)
    ? workout.sets
    : Array.isArray(workout.exercises)
      ? workout.exercises.flatMap(ex => (Array.isArray(ex.sets) ? ex.sets : []))
      : [];

  return sets.reduce((total, set) => {
    const weight = Number(set?.weight || 0);
    const reps = Number(set?.reps || 0);
    if (!Number.isFinite(weight) || !Number.isFinite(reps)) return total;
    return total + weight * reps;
  }, 0);
}

router.get('/leaderboard', async (_req, res) => {
  try {
    const records = await base('Workouts').select().all();
    const leaderboardMap = new Map();

    records.forEach((record) => {
      const fields = record.fields || {};
      const username = String(fields.Username || '').trim();
      if (!username) return;

      let sessionVolume = Number(fields.SessionVolume);
      if (!Number.isFinite(sessionVolume)) {
        const parsedWorkout = parseMaybeJson(fields.WorkoutJSON);
        sessionVolume = computeVolumeFromWorkout(parsedWorkout);
      }

      const current = leaderboardMap.get(username) || {
        username,
        totalVolume: 0,
        workoutCount: 0
      };

      current.totalVolume += sessionVolume;
      current.workoutCount += 1;
      leaderboardMap.set(username, current);
    });

    const items = Array.from(leaderboardMap.values()).sort(
      (a, b) => b.totalVolume - a.totalVolume
    );

    return res.json({ success: true, items });
  } catch (error) {
    console.error('GET /leaderboard failed:', error);
    return res.status(500).json({ success: false, error: 'Failed to load leaderboard' });
  }
});

module.exports = router;
