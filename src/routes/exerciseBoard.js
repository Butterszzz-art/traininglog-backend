// Exercise leaderboard: best estimated 1RM per user for the main barbell
// lifts, over this week, the last 30 days, or all time.
//
// The app's Exercise Leaderboard showed hardcoded sample data (Alice, Bob,
// Cara). Now every saved workout (POST /workouts) updates the lifter's best
// for each tracked lift, and GET /api/leaderboard/exercises ranks them.
//
// Storage (server-only):
//   exerciseBests/{lift}__{user} { lift, user, userName, bestE1rm,
//     best: { e1rm, kg, reps, date }, sessions: { [workoutId]: { date, e1rm, kg, reps } } }
// Ranking needs the composite index (lift asc, bestE1rm desc).
const express = require('express');
const { profileKey, blockedBy } = require('./profiles');

// Canonical lifts and the exercise names that count for them (lowercase,
// hyphens → spaces, single spaces).
const LIFTS = {
  squat: { label: 'Squat', names: ['squat', 'back squat', 'barbell squat', 'barbell back squat', 'high bar squat', 'low bar squat'] },
  bench: { label: 'Bench Press', names: ['bench press', 'bench', 'barbell bench press', 'barbell bench', 'flat bench press', 'flat barbell bench press'] },
  deadlift: { label: 'Deadlift', names: ['deadlift', 'conventional deadlift', 'barbell deadlift', 'sumo deadlift'] },
  ohp: { label: 'Overhead Press', names: ['overhead press', 'ohp', 'military press', 'barbell overhead press', 'standing overhead press', 'strict press'] },
  row: { label: 'Barbell Row', names: ['barbell row', 'bent over row', 'barbell bent over row', 'pendlay row'] },
};
const NAME_TO_LIFT = new Map();
Object.entries(LIFTS).forEach(([lift, { names }]) => names.forEach(n => NAME_TO_LIFT.set(n, lift)));

const MAX_REPS = 12;       // Epley gets unreliable above this
const MAX_KG = 700;        // sanity cap
const SESSIONS_KEPT = 40;
const RANGE_DAYS = { weekly: 7, monthly: 30 };
const TOP_N = 50;
const SCAN = 200;

function liftFor(name) {
  const key = String(name || '').toLowerCase().replace(/[-_]/g, ' ').replace(/\s+/g, ' ').trim();
  return NAME_TO_LIFT.get(key) || null;
}

function e1rm(kg, reps) {
  return reps === 1 ? kg : kg * (1 + reps / 30);
}

// Every (exercise name, kg, reps) set in any workout shape the app sends.
function setsOf(workout) {
  if (!workout || typeof workout !== 'object') return [];
  const lbs = /^lbs?$/i.test(String(workout.units || workout.unit || ''));
  const toKg = w => (lbs ? Number(w) * 0.45359237 : Number(w));
  const out = [];
  if (Array.isArray(workout.log)) {
    workout.log.forEach(e => {
      const reps = Array.isArray(e?.repsArray) ? e.repsArray : [];
      const weights = Array.isArray(e?.weightsArray) ? e.weightsArray : [];
      reps.forEach((r, i) => out.push({ name: e.name || e.exercise, kg: toKg(weights[i]), reps: Number(r) }));
    });
  } else if (Array.isArray(workout.exercises)) {
    workout.exercises.forEach(ex => (Array.isArray(ex?.sets) ? ex.sets : [])
      .forEach(s => out.push({ name: ex.name || ex.exercise, kg: toKg(s?.weight), reps: Number(s?.reps) })));
  } else if (Array.isArray(workout.sets)) {
    workout.sets.forEach(s => out.push({ name: s?.exercise || s?.name, kg: toKg(s?.weight), reps: Number(s?.reps) }));
  }
  return out;
}

// { lift: { e1rm, kg, reps } } — the best set per tracked lift in a workout.
function bestSetsByLift(workout) {
  const best = {};
  setsOf(workout).forEach(({ name, kg, reps }) => {
    const lift = liftFor(name);
    if (!lift || !(kg > 0) || kg > MAX_KG || !(reps >= 1) || reps > MAX_REPS || !Number.isInteger(reps)) return;
    const est = Math.round(e1rm(kg, reps) * 10) / 10;
    if (!best[lift] || est > best[lift].e1rm) best[lift] = { e1rm: est, kg: Math.round(kg * 10) / 10, reps };
  });
  return best;
}

// Called after a workout is saved. `workoutId` keeps re-posts of the same
// workout from counting twice; `date` is the workout's YYYY-MM-DD / ISO date.
async function recordExerciseBests(db, { username, workoutId, date, workout }) {
  const user = profileKey(username);
  if (!user || !workoutId) return;
  const best = bestSetsByLift(workout);
  const day = String(date || '').slice(0, 10);
  await Promise.all(Object.entries(best).map(async ([lift, set]) => {
    const ref = db.collection('exerciseBests').doc(`${lift}__${user}`);
    const snap = await ref.get();
    const prev = snap.exists ? snap.data() : {};
    const sessions = { ...(prev.sessions || {}), [workoutId]: { date: day, ...set } };
    const kept = Object.entries(sessions)
      .sort(([, a], [, b]) => String(b.date).localeCompare(String(a.date)))
      .slice(0, SESSIONS_KEPT);
    const prevBest = prev.best && prev.best.e1rm > 0 ? prev.best : null;
    const newBest = !prevBest || set.e1rm > prevBest.e1rm ? { date: day, ...set } : prevBest;
    await ref.set({
      lift,
      user,
      userName: username,
      bestE1rm: newBest.e1rm,
      best: newBest,
      sessions: Object.fromEntries(kept),
    });
  }));
}

function bestInRange(data, range, now = new Date()) {
  if (range === 'all' || !RANGE_DAYS[range]) return data.best || null;
  const since = new Date(now.getTime() - RANGE_DAYS[range] * 86400000).toISOString().slice(0, 10);
  let top = null;
  Object.values(data.sessions || {}).forEach(s => {
    if (String(s.date) >= since && (!top || s.e1rm > top.e1rm)) top = s;
  });
  return top;
}

function createExerciseBoardRouter({ db, firebaseEnabled, sendError, sendSuccess }) {
  const router = express.Router();

  // GET /?lift=squat&range=weekly|monthly|all
  router.get('/', async (req, res) => {
    if (!firebaseEnabled) return sendError(res, 503, 'exercise_board.firebase_disabled', 'The leaderboard is not available right now.');
    const lift = LIFTS[req.query.lift] ? req.query.lift : 'squat';
    const range = ['weekly', 'monthly', 'all'].includes(req.query.range) ? req.query.range : 'weekly';
    try {
      const [snap, blocked] = await Promise.all([
        db.collection('exerciseBests').where('lift', '==', lift).orderBy('bestE1rm', 'desc').limit(SCAN).get(),
        blockedBy(db, req.user?.username),
      ]);
      const items = snap.docs
        .map(d => d.data())
        .filter(d => !blocked.includes(d.user))
        .map(d => ({ d, top: bestInRange(d, range) }))
        .filter(x => x.top)
        .sort((a, b) => b.top.e1rm - a.top.e1rm)
        .slice(0, TOP_N)
        .map(({ d, top }) => ({ username: d.userName || d.user, e1rm: top.e1rm, kg: top.kg, reps: top.reps, date: top.date }));
      return sendSuccess(res, 200, {
        lift,
        range,
        lifts: Object.entries(LIFTS).map(([id, { label }]) => ({ id, label })),
        items,
      });
    } catch (err) {
      console.error('GET /api/leaderboard/exercises failed:', err);
      return sendError(res, 500, 'exercise_board.server_error', 'Could not load the exercise leaderboard.');
    }
  });

  return router;
}

// Called after a workout is deleted: drops its session and, if it held the
// all-time best, falls back to the best remaining session.
async function forgetExerciseSession(db, { username, workoutId }) {
  const user = profileKey(username);
  if (!user || !workoutId) return;
  await Promise.all(Object.keys(LIFTS).map(async lift => {
    const ref = db.collection('exerciseBests').doc(`${lift}__${user}`);
    const snap = await ref.get();
    if (!snap.exists) return;
    const prev = snap.data();
    const gone = prev.sessions && prev.sessions[workoutId];
    if (!gone) return;
    const sessions = { ...prev.sessions };
    delete sessions[workoutId];
    const remaining = Object.values(sessions);
    if (!remaining.length) { await ref.delete(); return; }
    const wasBest = prev.best && prev.best.e1rm === gone.e1rm && prev.best.date === gone.date;
    const best = wasBest
      ? remaining.reduce((top, s) => (s.e1rm > top.e1rm ? s : top))
      : prev.best;
    await ref.set({ ...prev, sessions, best, bestE1rm: best.e1rm });
  }));
}

async function deleteExerciseBests(db, username) {
  const user = profileKey(username);
  if (!user) return;
  await Promise.all(Object.keys(LIFTS).map(lift => db.collection('exerciseBests').doc(`${lift}__${user}`).delete()));
}

module.exports = { createExerciseBoardRouter, recordExerciseBests, forgetExerciseSession, deleteExerciseBests, bestSetsByLift, bestInRange, liftFor, LIFTS };
