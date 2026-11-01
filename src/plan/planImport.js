// Master plan import: a coach's own plan document (PDF, Word, Excel, photo)
// → the phases and nutrition of a pocketcoach.plan/2 draft.
//
// 1. readImportFile() (src/coach/programImport.js) turns the file into
//    Messages API content, same as the program import.
// 2. Claude fills PLAN_IMPORT_SCHEMA with only what the document states.
// 3. normalizeImportedPlan() cleans that up and fills the gaps the coach
//    chose to have suggested (same kcal on both day types when only one is
//    given, protein/fat carried over from the other day type or the phase
//    before, carbs from the kcal left). Every filled value is listed in
//    `suggested` so the dashboard can mark it until the coach confirms it.
//
// Nothing here saves anything: the coach reviews the result, then the plans
// route creates the draft (schema.planFromImport).
'use strict';

const PHASE_TYPES = ['cut', 'maintain', 'build', 'deload'];
const DAY_KEYS = ['kcal', 'proteinG', 'carbG', 'fatG'];
const LIMITS = { kcal: [800, 6000], proteinG: [0, 400], carbG: [0, 1000], fatG: [0, 300] };

const nullable = type => ({ type: [type, 'null'] });
const dayTargets = {
  type: 'object',
  properties: { kcal: nullable('number'), proteinG: nullable('number'), carbG: nullable('number'), fatG: nullable('number') },
  required: ['kcal', 'proteinG', 'carbG', 'fatG'],
  additionalProperties: false,
};

const PLAN_IMPORT_SCHEMA = {
  type: 'object',
  properties: {
    isPlan: { type: 'boolean' },
    name: { type: 'string' },
    startDate: nullable('string'),
    phases: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: PHASE_TYPES },
          weeks: { type: 'integer' },
          goal: { type: 'string' },
          averageKcal: nullable('number'),
          trainingDay: dayTargets,
          restDay: dayTargets,
        },
        required: ['type', 'weeks', 'goal', 'averageKcal', 'trainingDay', 'restDay'],
        additionalProperties: false,
      },
    },
    notes: { type: 'string' },
    warnings: { type: 'array', items: { type: 'string' } },
  },
  required: ['isPlan', 'name', 'startDate', 'phases', 'notes', 'warnings'],
  additionalProperties: false,
};

const PLAN_IMPORT_INSTRUCTIONS = `You read a fitness coach's master plan for one client (a PDF, Word or Excel document, or a photo) and copy its phases and nutrition targets into Pocket Coach's plan format. The document may be in English or Dutch.

Copy only what the document states. Never calculate, estimate or invent a number: if a value is not in the document, use null. The app fills gaps itself and shows them to the coach as suggestions.

- phases: in order. type is cut (fat loss, "afvallen", deficit), maintain (maintenance, "onderhoud"), build (muscle gain, "opbouw", surplus) or deload. weeks is the phase length; "weeks 13–15" is 3 weeks, "week 16" is 1 week.
- goal: the phase's goal in one short sentence, as the document puts it (e.g. "Lose ~0.4–0.6 kg per week while keeping strength").
- trainingDay / restDay: kcal, protein, carbs and fat in grams for that day type. "~2350" is 2350. When the document gives one value for every day (e.g. "~2700 kcal/day"), put it in averageKcal and leave the day types null unless they are stated separately. When a phase says "same as phase 2", copy that phase's values.
- averageKcal: a daily or weekly-average kcal figure for the phase, if given.
- startDate: only if the document states the start date (YYYY-MM-DD).
- name: the plan's title without the client's name (e.g. "16-week X-frame plan").
- notes: the coach's key guidance in a few sentences (protein rule, meal timing, recovery check, when to reassess). No client name, no personal details.
- warnings: anything ambiguous you had to choose about, in plain English.
- isPlan: false if this is not a fitness plan with phases; then leave phases empty.`;

function num(value, [min, max]) {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= min && n <= max ? Math.round(n * 10) / 10 : null;
}

function text(value, max) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function cleanDay(d) {
  const src = d && typeof d === 'object' ? d : {};
  return Object.fromEntries(DAY_KEYS.map(k => [k, num(src[k], LIMITS[k])]));
}

/**
 * The AI's object → { name, startDate, phases, notes, warnings, suggested } or
 * null when no plan was found. phases: [{ type, weeks, goalText,
 * trainingDay, restDay, suggested: ['restDay.carbG', …] }].
 */
function normalizeImportedPlan(obj) {
  if (!obj || typeof obj !== 'object' || obj.isPlan === false) return null;
  const warnings = (Array.isArray(obj.warnings) ? obj.warnings : []).map(w => text(w, 300)).filter(Boolean).slice(0, 10);
  const phases = (Array.isArray(obj.phases) ? obj.phases : []).slice(0, 12).map(p => ({
    type: PHASE_TYPES.includes(p && p.type) ? p.type : 'maintain',
    weeks: Math.min(52, Math.max(1, Math.round(Number(p && p.weeks) || 1))),
    goalText: text(p && p.goal, 300),
    averageKcal: num(p && p.averageKcal, LIMITS.kcal),
    trainingDay: cleanDay(p && p.trainingDay),
    restDay: cleanDay(p && p.restDay),
    suggested: [],
  }));
  if (!phases.length) return null;

  const empty = d => DAY_KEYS.every(k => d[k] == null);
  const fill = (p, dayType, key, value) => {
    if (p[dayType][key] != null || value == null) return;
    p[dayType][key] = Math.round(value);
    p.suggested.push(`${dayType}.${key}`);
  };
  const other = dt => (dt === 'trainingDay' ? 'restDay' : 'trainingDay');

  phases.forEach((p, i) => {
    const prev = phases[i - 1];
    // A phase the document gives nothing for (e.g. "deload: same as before") copies the phase before.
    if (prev && empty(p.trainingDay) && empty(p.restDay) && p.averageKcal == null) {
      ['trainingDay', 'restDay'].forEach(dt => DAY_KEYS.forEach(k => fill(p, dt, k, prev[dt][k])));
      return;
    }
    ['trainingDay', 'restDay'].forEach(dt => {
      const d = p[dt];
      // One kcal figure for the whole phase, or only one day type stated.
      if (d.kcal == null) fill(p, dt, 'kcal', p.averageKcal != null ? p.averageKcal : p[other(dt)].kcal);
      // Protein and fat: the other day type, else the same day type the phase before, else after.
      for (const key of ['proteinG', 'fatG']) {
        const next = phases[i + 1];
        const candidates = [p[other(dt)][key], prev && prev[dt][key], prev && prev[other(dt)][key], next && next[dt][key]];
        fill(p, dt, key, candidates.find(v => v != null));
      }
      // Carbs from what's left; kcal from grams when only grams are given.
      if (d.carbG == null && d.kcal != null && d.proteinG != null && d.fatG != null) {
        fill(p, dt, 'carbG', Math.max(0, (d.kcal - d.proteinG * 4 - d.fatG * 9) / 4));
      }
      if (d.kcal == null && d.proteinG != null && d.carbG != null && d.fatG != null) {
        fill(p, dt, 'kcal', d.proteinG * 4 + d.carbG * 4 + d.fatG * 9);
      }
    });
  });

  const startDate = typeof obj.startDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(obj.startDate) ? obj.startDate : null;
  return {
    name: text(obj.name, 80) || 'Coach plan',
    startDate,
    phases: phases.map(({ averageKcal, ...p }) => p),
    notes: text(obj.notes, 2000),
    warnings,
    suggested: phases.reduce((n, p) => n + p.suggested.length, 0),
  };
}

const SUGGESTED_RE = /^(trainingDay|restDay)\.(kcal|proteinG|carbG|fatG)$/;

/**
 * The reviewed import the dashboard sends back to create the draft: same
 * shape as normalizeImportedPlan's result, re-checked (no gap filling).
 */
function sanitizeImported(input) {
  const src = input && typeof input === 'object' ? input : {};
  const phases = (Array.isArray(src.phases) ? src.phases : []).slice(0, 12).map(p => ({
    type: PHASE_TYPES.includes(p && p.type) ? p.type : 'maintain',
    weeks: Math.min(52, Math.max(1, Math.round(Number(p && p.weeks) || 1))),
    goalText: text(p && p.goalText, 300),
    trainingDay: cleanDay(p && p.trainingDay),
    restDay: cleanDay(p && p.restDay),
    suggested: (Array.isArray(p && p.suggested) ? p.suggested : []).filter(s => typeof s === 'string' && SUGGESTED_RE.test(s)),
  }));
  if (!phases.length) return null;
  return { name: text(src.name, 80) || 'Coach plan', phases, notes: text(src.notes, 2000) };
}

module.exports = { PLAN_IMPORT_SCHEMA, PLAN_IMPORT_INSTRUCTIONS, normalizeImportedPlan, sanitizeImported, LIMITS };
