// Coach ↔ client data helpers. Pure functions only (no Firestore, no Express)
// so they can be unit-tested with plain node: scripts/test-coach-share.js.
//
// What a client shares with a linked coach is controlled by the client's own
// switches (users/{uid}.coachSharing). The phone builds a snapshot, the server
// strips whatever the client switched off, and the result is copied onto each
// active coach's roster doc (coaches/{coachUid}/clients/{clientUid}).

// nutrition (the food-level diary) is opt-in: food logs are health data, so
// a coach only sees them after the client switches it on. The others keep
// their original default (on).
const SHARING_KEYS = ['checkIns', 'bodyweight', 'workouts', 'nutrition'];
const DEFAULT_SHARING = Object.freeze({ checkIns: true, bodyweight: true, workouts: true, nutrition: false });

// Fields on the coach's roster doc that come from the client's share, grouped
// by the sharing switch that controls them. Turning a switch off deletes these.
const SHARE_FIELDS = {
  checkIns: ['checkIns', 'lastCheckInAt', 'latestCheckInJson'],
  bodyweight: ['bodyweight', 'currentBodyweight', 'weeklyWeightChangePercent'],
  workouts: ['weeklyWorkouts', 'workoutsLoggedThisWeek', 'workoutsWeekStart', 'compliancePercent', 'activeProgramName'],
  // Nothing is copied onto the roster: the coach reads the client's own
  // synced food log at request time (src/routes/coachNutrition.js), so
  // switching it off cuts access straight away.
  nutrition: [],
};

const MAX_CHECKINS = 12;
const MAX_BODYWEIGHT = 120;
const MAX_WEEKS = 12;
const SCORE_KEYS = ['sleep', 'energy', 'stress', 'hunger', 'digestion', 'trainingPerformance', 'cardioAdherence', 'mood', 'motivation', 'soreness'];

function normalizeSharing(value) {
  const src = value && typeof value === 'object' ? value : {};
  const out = {};
  for (const key of SHARING_KEYS) out[key] = typeof src[key] === 'boolean' ? src[key] : DEFAULT_SHARING[key];
  return out;
}

// Which switches the client has actually set (vs. still on their default).
// The app asks once about nutrition while it is undecided.
function decidedSharing(value) {
  const src = value && typeof value === 'object' ? value : {};
  const out = {};
  for (const key of SHARING_KEYS) out[key] = typeof src[key] === 'boolean';
  return out;
}

// The stored switches after a change: what was stored, plus the boolean
// keys in `changes`. Keys never set stay unset, so "not asked yet" survives.
function mergeSharing(stored, changes) {
  const base = stored && typeof stored === 'object' ? stored : {};
  const body = changes && typeof changes === 'object' ? changes : {};
  const out = {};
  for (const key of SHARING_KEYS) {
    if (typeof body[key] === 'boolean') out[key] = body[key];
    else if (typeof base[key] === 'boolean') out[key] = base[key];
  }
  return out;
}

function isoDate(value) {
  if (typeof value !== 'string') return null;
  const m = value.match(/^(\d{4}-\d{2}-\d{2})/);
  if (!m) return null;
  return Number.isNaN(Date.parse(m[1] + 'T00:00:00Z')) ? null : m[1];
}

function num(value, min, max) {
  // Number(null) and Number('') are 0: treat them as "not provided" so a
  // missing value never turns into a real-looking 0.
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  if (min !== undefined && n < min) return null;
  if (max !== undefined && n > max) return null;
  return Math.round(n * 100) / 100;
}

function text(value, max) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function sanitizeCheckIn(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const date = isoDate(entry.date);
  if (!date) return null;
  const out = { date };
  for (const key of SCORE_KEYS) {
    const v = num(entry[key], 0, 10);
    if (v !== null) out[key] = v;
  }
  const bw = num(entry.bodyweight, 20, 400);
  if (bw !== null) out.bodyweight = bw;
  const notes = text(entry.notes, 1000);
  if (notes) out.notes = notes;
  const summary = text(entry.summary, 400);
  if (summary) out.summary = summary;
  return out;
}

// Validates and trims the phone's snapshot, then drops whatever the client's
// sharing switches exclude. Returns the fields to merge onto the coach doc.
function buildShareFields(snapshot, sharing, now = new Date()) {
  const s = snapshot && typeof snapshot === 'object' ? snapshot : {};
  const allow = normalizeSharing(sharing);
  const fields = {};

  if (allow.checkIns && Array.isArray(s.checkIns)) {
    const checkIns = s.checkIns.map(sanitizeCheckIn).filter(Boolean)
      .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
      .filter((c, i, arr) => i === 0 || c.date !== arr[i - 1].date)
      .slice(0, MAX_CHECKINS);
    fields.checkIns = checkIns;
    fields.lastCheckInAt = checkIns[0] ? checkIns[0].date : null;
    fields.latestCheckInJson = checkIns[0] || null;
  }

  if (allow.bodyweight && Array.isArray(s.bodyweight)) {
    const byDate = new Map();
    for (const e of s.bodyweight) {
      const date = isoDate(e && e.date);
      const weight = num(e && e.weight, 20, 400);
      if (date && weight !== null) byDate.set(date, weight);
    }
    const series = [...byDate.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .slice(-MAX_BODYWEIGHT).map(([date, weight]) => ({ date, weight }));
    fields.bodyweight = series;
    fields.currentBodyweight = series.length ? series[series.length - 1].weight : null;
    fields.weeklyWeightChangePercent = weeklyChangePercent(series);
  }

  if (allow.workouts && s.workouts && typeof s.workouts === 'object') {
    const w = s.workouts;
    const weeks = Array.isArray(w.weekly) ? w.weekly : [];
    fields.weeklyWorkouts = weeks
      .map(x => ({ weekStart: isoDate(x && x.weekStart), count: num(x && x.count, 0, 50) }))
      .filter(x => x.weekStart && x.count !== null)
      .sort((a, b) => (a.weekStart < b.weekStart ? -1 : 1))
      .slice(-MAX_WEEKS);
    fields.workoutsLoggedThisWeek = num(w.thisWeek, 0, 50);
    fields.workoutsWeekStart = isoDate(w.weekStart) || isoDate(now.toISOString());
    fields.compliancePercent = num(s.compliancePercent, 0, 100);
    fields.activeProgramName = text(s.activeProgramName, 120);
  }

  return fields;
}

// Percent change per week between the average of the latest 7 days and the
// 7 days before that. Null when there isn't enough data for both windows.
function weeklyChangePercent(series) {
  if (!Array.isArray(series) || series.length < 2) return null;
  const last = Date.parse(series[series.length - 1].date + 'T00:00:00Z');
  const day = 86400000;
  const avg = (from, to) => {
    const pts = series.filter(p => {
      const t = Date.parse(p.date + 'T00:00:00Z');
      return t > last - to * day && t <= last - from * day;
    });
    return pts.length ? pts.reduce((s, p) => s + p.weight, 0) / pts.length : null;
  };
  const recent = avg(0, 7);
  const prior = avg(7, 14);
  if (recent === null || prior === null || !prior) return null;
  return Math.round(((recent - prior) / prior) * 10000) / 100;
}

// Monday (UTC) of the week containing `date`, as YYYY-MM-DD.
function weekStartOf(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dow = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - dow);
  return d.toISOString().slice(0, 10);
}

function daysBetween(fromIso, now) {
  const t = Date.parse(String(fromIso).slice(0, 10) + 'T00:00:00Z');
  if (Number.isNaN(t)) return null;
  const today = Date.parse(now.toISOString().slice(0, 10) + 'T00:00:00Z');
  return Math.floor((today - t) / 86400000);
}

// Explainable roster alerts, computed at read time so "days since check-in"
// stays current. Only uses data the client actually shared: a missing field
// never raises an alert (the old app treated missing compliance as 0% and
// flagged every client).
function computeClientAlerts(doc, now = new Date()) {
  const d = doc && typeof doc === 'object' ? doc : {};
  const alerts = [];
  if (d.status && d.status !== 'active') return { alerts, alertStatus: 'ok' };

  if (d.lastCheckInAt) {
    const days = daysBetween(d.lastCheckInAt, now);
    if (days !== null && days >= 10) alerts.push({ id: 'missed_checkin', severity: 'action', label: 'Missed check-in', reason: `${days} days since last check-in` });
    else if (days !== null && days >= 7) alerts.push({ id: 'missed_checkin', severity: 'watch', label: 'Check-in due', reason: `${days} days since last check-in` });
  }

  const compliance = Number(d.compliancePercent);
  if (d.compliancePercent !== null && d.compliancePercent !== undefined && Number.isFinite(compliance)) {
    if (compliance < 65) alerts.push({ id: 'low_compliance', severity: 'action', label: 'Low compliance', reason: `${Math.round(compliance)}% adherence` });
    else if (compliance < 80) alerts.push({ id: 'low_compliance', severity: 'watch', label: 'Low compliance', reason: `${Math.round(compliance)}% adherence` });
  }

  const change = Number(d.weeklyWeightChangePercent);
  if (d.weeklyWeightChangePercent !== null && d.weeklyWeightChangePercent !== undefined && Number.isFinite(change)) {
    const abs = Math.abs(change);
    const reason = `${change > 0 ? '+' : ''}${change.toFixed(2)}% this week`;
    if (abs >= 1.25) alerts.push({ id: 'rapid_weight_change', severity: 'action', label: 'Rapid weight change', reason });
    else if (abs >= 0.8) alerts.push({ id: 'rapid_weight_change', severity: 'watch', label: 'Fast weight change', reason });
  }

  // Workouts only count if the snapshot is from this week; a stale snapshot
  // says nothing about this week, and the check-in rule already covers silence.
  const thisWeek = weekStartOf(now);
  const dow = (now.getUTCDay() + 6) % 7; // 0 = Monday
  if (d.workoutsWeekStart === thisWeek && Number(d.workoutsLoggedThisWeek) === 0 && dow >= 3) {
    alerts.push({ id: 'no_workout_logs', severity: 'watch', label: 'No workouts logged', reason: '0 sessions logged this week' });
  }

  if (d.sharedAt || d.lastSharedAt) {
    const days = daysBetween(d.lastSharedAt || d.sharedAt, now);
    if (days !== null && days >= 14 && !alerts.some(a => a.id === 'missed_checkin')) {
      alerts.push({ id: 'no_sync', severity: 'watch', label: 'No recent activity', reason: `App not opened for ${days} days` });
    }
  }

  const rank = { action: 0, watch: 1 };
  alerts.sort((a, b) => rank[a.severity] - rank[b.severity] || a.label.localeCompare(b.label));
  const alertStatus = alerts.some(a => a.severity === 'action') ? 'action' : alerts.length ? 'watch' : 'ok';
  return { alerts: alerts.slice(0, 4), alertStatus };
}

// ── Coach program library ────────────────────────────────────────────────────
// Coach programs are a simple weekly split: days.{Mon..Sun} = [{ name, sets,
// reps, repsMax? }]. Older mobile saves stored plain exercise-name strings.

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function sanitizeCoachExercise(ex) {
  const src = typeof ex === 'string' ? { name: ex } : (ex && typeof ex === 'object' ? ex : null);
  if (!src) return null;
  const name = text(src.name, 80);
  if (!name) return null;
  const sets = Math.round(num(src.sets, 1, 20) || 3);
  const reps = Math.round(num(src.reps, 1, 100) || 10);
  const repsMaxRaw = num(src.repsMax, 1, 100);
  const out = { name, sets, reps };
  if (repsMaxRaw !== null && repsMaxRaw > reps) out.repsMax = Math.round(repsMaxRaw);
  const notes = text(src.notes, 200);
  if (notes) out.notes = notes;
  return out;
}

function sanitizeCoachProgram(program) {
  const p = program && typeof program === 'object' ? program : {};
  const name = text(p.name, 80);
  if (!name) return null;
  const days = {};
  let total = 0;
  for (const day of WEEKDAYS) {
    const list = Array.isArray(p.days && p.days[day]) ? p.days[day] : [];
    days[day] = list.map(sanitizeCoachExercise).filter(Boolean).slice(0, 20);
    total += days[day].length;
  }
  return { name, notes: text(p.notes, 2000), days, exerciseCount: total };
}

function slug(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'ex';
}

// Converts a coach program into the app's program format (same shape the
// premium library uses) so the client can import it with one tap.
function toClientProgram(program, meta = {}) {
  const p = sanitizeCoachProgram(program);
  if (!p) return null;
  const trainingDays = WEEKDAYS.filter(d => p.days[d].length);
  const days = trainingDays.map((day, i) => ({
    dayId: `d${i + 1}`,
    name: day,
    exercises: p.days[day].map((ex, j) => ({
      exerciseId: `d${i + 1}-${j + 1}-${slug(ex.name)}`,
      name: ex.name,
      ...(ex.notes ? { notes: ex.notes } : {}),
      sets: Array.from({ length: ex.sets }, () => ({ reps: ex.reps, ...(ex.repsMax ? { repsMax: ex.repsMax } : {}), restSec: 120 })),
    })),
  }));
  return {
    id: `coach-${slug(meta.coachUsername)}-${slug(meta.programId || p.name)}`,
    title: p.name,
    summary: p.notes,
    frequency: trainingDays,
    schedule: { startDate: '', weekdays: trainingDays.map(d => WEEKDAYS.indexOf(d) + 1) },
    split: { type: 'custom', name: p.name, daysPerWeek: trainingDays.length },
    progressionType: 'double-progression',
    days,
    assignedBy: meta.coachUsername || '',
    rev: meta.rev || null,
  };
}

function sanitizeMacroTargets(value) {
  if (!value || typeof value !== 'object') return null;
  const out = {};
  for (const [key, max] of [['calories', 10000], ['protein', 1000], ['carbs', 2000], ['fat', 1000]]) {
    const v = num(value[key], 0, max);
    if (v === null) return null;
    out[key] = Math.round(v);
  }
  return out;
}

// A coach's macro plan by day type: grams per day type (calories derived from
// them) and which day type each weekday is, so the client's Macros tab can
// pick today's target on its own. Training is required; the others are
// optional (the client falls back to training). A weekday without a valid
// day type stays null, meaning the client picks that day by hand.
const MACRO_DAY_TYPES = ['training', 'rest', 'high', 'low'];
const MACRO_WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

function sanitizeMacroDay(value) {
  if (!value || typeof value !== 'object') return null;
  const out = {};
  for (const [key, max] of [['protein', 1000], ['carbs', 2000], ['fat', 1000]]) {
    const v = num(value[key], 0, max);
    if (v === null) return null;
    out[key] = Math.round(v);
  }
  out.calories = out.protein * 4 + out.carbs * 4 + out.fat * 9;
  return out.calories > 0 ? out : null;
}

function sanitizeMacroPlan(value) {
  if (!value || typeof value !== 'object') return null;
  const days = {};
  for (const type of MACRO_DAY_TYPES) {
    const raw = value.days && value.days[type];
    if (raw == null) continue;
    const day = sanitizeMacroDay(raw);
    if (!day) return null; // a half-filled day is a mistake, not "skip this day"
    days[type] = day;
  }
  if (!days.training) return null;
  const schedule = {};
  for (const wd of MACRO_WEEKDAYS) {
    const type = value.schedule && value.schedule[wd];
    schedule[wd] = days[type] ? type : null;
  }
  const note = typeof value.note === 'string' ? value.note.trim().slice(0, 300) : '';
  return { days, schedule, note };
}

module.exports = {
  SHARING_KEYS,
  SHARE_FIELDS,
  DEFAULT_SHARING,
  normalizeSharing,
  decidedSharing,
  mergeSharing,
  buildShareFields,
  computeClientAlerts,
  weeklyChangePercent,
  weekStartOf,
  sanitizeCoachProgram,
  toClientProgram,
  sanitizeMacroTargets,
  sanitizeMacroPlan,
  MACRO_DAY_TYPES,
  MACRO_WEEKDAYS,
};
