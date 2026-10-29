// Turns Google Health API `exercise` data points into the flat shape the app's
// cardio log uses. Field names follow Google's v4 reference (Exercise,
// MetricsSummary, SessionTimeInterval): int64 values arrive as strings and
// durations as "123s" strings.

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

// "3600s" / "3.5s" → seconds.
function durationSeconds(value) {
  if (typeof value !== 'string') return 0;
  return toNumber(value.replace(/s$/, ''));
}

function pad(n) {
  return String(n).padStart(2, '0');
}

// The local calendar date the workout started on. Google gives it directly as
// civilStartTime; otherwise shift startTime by its UTC offset.
function localStartDate(interval) {
  const d = interval?.civilStartTime?.date;
  if (d?.year && d?.month && d?.day) return `${d.year}-${pad(d.month)}-${pad(d.day)}`;
  const start = new Date(interval?.startTime || '');
  if (Number.isNaN(start.getTime())) return null;
  const shifted = new Date(start.getTime() + durationSeconds(interval?.startUtcOffset) * 1000);
  return shifted.toISOString().slice(0, 10);
}

function normalizeExercise(point) {
  const ex = point?.exercise;
  const interval = ex?.interval;
  if (!interval?.startTime) return null;
  const date = localStartDate(interval);
  if (!date) return null;

  const metrics = ex.metricsSummary || {};
  const activeSeconds = durationSeconds(ex.activeDuration);
  const wallSeconds = (new Date(interval.endTime) - new Date(interval.startTime)) / 1000;
  const seconds = activeSeconds > 0 ? activeSeconds : (Number.isFinite(wallSeconds) ? wallSeconds : 0);
  const avgHr = toNumber(metrics.averageHeartRateBeatsPerMinute);

  return {
    syncId: point.name || `exercise:${interval.startTime}`,
    date,
    startTime: interval.startTime,
    endTime: interval.endTime || null,
    exerciseType: ex.exerciseType || 'EXERCISE_TYPE_UNSPECIFIED',
    displayName: ex.displayName || '',
    durationMinutes: Math.round(seconds / 60),
    distanceKm: Math.round((toNumber(metrics.distanceMillimeters) / 1e6) * 100) / 100,
    calories: Math.round(toNumber(metrics.caloriesKcal)),
    avgHeartRate: avgHr > 0 ? Math.round(avgHr) : null,
    steps: toNumber(metrics.steps)
  };
}

// Adds `days` to a YYYY-MM-DD date string.
function addDays(dateStr, days) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Google filter for workouts starting on local dates start..end (inclusive).
function exerciseFilter(start, end) {
  return `exercise.interval.civil_start_time >= "${start}" AND exercise.interval.civil_start_time < "${addDays(end, 1)}"`;
}

module.exports = { normalizeExercise, exerciseFilter, addDays, durationSeconds };
