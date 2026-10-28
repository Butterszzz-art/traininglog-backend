// Food log summaries for the coach. Pure functions only (no Firestore, no
// Express) so they can be tested with plain node:
// scripts/test-coach-nutrition.js.
//
// The app keeps the food log in localStorage (`foodLog_<user>`, one entry
// per food logged) and cloud sync copies each entry to
// users/{uid}/syncItems (store 'foodLog'). An entry:
//   { id, date: 'YYYY-MM-DD', meal: 'breakfast'|'lunch'|'dinner'|'snacks',
//     name, brand?, amount, unit, grams, source: 'usda'|'off'|'custom'|...,
//     kcal, protein, carbs, fat, fiber?, sugar?, satFat?, sodiumMg?, ... }
// Day totals the app archived (macroHistory, which also holds quick-added
// macros that aren't tied to a food) are used as the day's intake when
// present, so the coach sees the same number the client sees.
'use strict';

const MEALS = ['breakfast', 'lunch', 'dinner', 'snacks'];
const NUTRIENTS = [
  'kcal', 'protein', 'carbs', 'fat', 'fiber', 'sugar', 'satFat', 'sodiumMg',
  'ironMg', 'calciumMg', 'potassiumMg', 'magnesiumMg', 'vitDUg', 'b12Ug',
];
const DAY_MS = 86400000;
const MAX_DAYS = 90;

const isoDate = v => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v.slice(0, 10)) && !Number.isNaN(Date.parse(v.slice(0, 10) + 'T00:00:00Z')) ? v.slice(0, 10) : null);
const text = (v, max) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');
const round1 = n => Math.round(n * 10) / 10;

function num(v, max = 100000) {
  if (v === null || v === undefined || v === '' || typeof v === 'boolean') return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 && n <= max ? n : null;
}

// Calories vs. what the macros add up to (4P + 4C + 9F). Labels can
// legitimately differ by fibre (2 kcal/g on EU labels), polyols, alcohol and
// rounding, so a food is only flagged when it is more than 15 % off both
// with and without fibre, and small amounts get a 10 kcal margin.
// Same rule as the app's food-core.js kcalCheck.
function kcalMismatch({ kcal, protein, carbs, fat, fiber }) {
  const k = Number(kcal) || 0;
  const base = (Number(protein) || 0) * 4 + (Number(carbs) || 0) * 4 + (Number(fat) || 0) * 9;
  const withFiber = base + (Number(fiber) || 0) * 2;
  const off = expected => {
    const diff = Math.abs(k - expected);
    return diff > 10 && diff > Math.max(k, expected) * 0.15;
  };
  return off(base) && off(withFiber);
}

// One synced entry → what the coach may see, or null when unusable.
function sanitizeEntry(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const date = isoDate(raw.date);
  const name = text(raw.name, 160);
  if (!date || !name) return null;
  const out = {
    id: text(String(raw.id ?? ''), 80),
    date,
    meal: MEALS.includes(raw.meal) ? raw.meal : 'snacks',
    name,
    source: text(raw.source, 12) || 'unknown',
  };
  const brand = text(raw.brand, 80);
  if (brand) out.brand = brand;
  const amount = num(raw.amount, 100000);
  if (amount !== null) out.amount = round1(amount);
  const unit = text(raw.unit, 60);
  if (unit) out.unit = unit;
  const grams = num(raw.grams, 100000);
  if (grams !== null) out.grams = round1(grams);
  for (const k of NUTRIENTS) {
    const v = num(raw[k]);
    if (v !== null) out[k] = k === 'kcal' ? Math.round(v) : round1(v);
  }
  for (const k of ['kcal', 'protein', 'carbs', 'fat']) if (out[k] === undefined) out[k] = 0;
  // Worked out here too, so the flag doesn't depend on the app version.
  if (raw.flag === 'kcal_mismatch' || kcalMismatch(out)) out.flag = 'kcal_mismatch';
  const t = num(raw.t, 1e14);
  if (t !== null) out.t = Math.round(t);
  return out;
}

// macroHistory / dailyMacroProgress totals → { kcal, protein, carbs, fat }.
function sanitizeTotals(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const protein = num(raw.protein) || 0;
  const carbs = num(raw.carbs) || 0;
  const fat = num(raw.fats ?? raw.fat) || 0;
  const direct = Number(raw.cals) || 0; // can be negative (see app's logMacroAmounts)
  const kcal = num(raw.calories) ?? Math.max(0, protein * 4 + carbs * 4 + fat * 9 + direct);
  if (!kcal && !protein && !carbs && !fat) return null;
  return { kcal: Math.round(kcal), protein: round1(protein), carbs: round1(carbs), fat: round1(fat) };
}

function sanitizeTarget(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const kcal = num(raw.calories ?? raw.Calories ?? raw.kcal, 20000);
  if (!kcal) return null;
  return {
    kcal: Math.round(kcal),
    protein: Math.round(num(raw.protein ?? raw.Protein, 2000) || 0),
    carbs: Math.round(num(raw.carbs ?? raw.Carbs, 4000) || 0),
    fat: Math.round(num(raw.fat ?? raw.Fat ?? raw.fats, 2000) || 0),
  };
}

function addDays(iso, n) {
  return new Date(Date.parse(iso + 'T00:00:00Z') + n * DAY_MS).toISOString().slice(0, 10);
}

function sumEntries(entries) {
  const t = {};
  for (const e of entries) {
    for (const k of NUTRIENTS) if (typeof e[k] === 'number') t[k] = (t[k] || 0) + e[k];
  }
  for (const k of Object.keys(t)) t[k] = k === 'kcal' ? Math.round(t[k]) : round1(t[k]);
  for (const k of ['kcal', 'protein', 'carbs', 'fat']) if (t[k] === undefined) t[k] = 0;
  return t;
}

// A day counts as "on target" when calories are within ±10 % of the target
// and protein reaches at least 90 % of it.
function onTarget(intake, target) {
  if (!intake || !target || !target.kcal) return null;
  const kcalOk = Math.abs(intake.kcal - target.kcal) <= target.kcal * 0.1;
  const proteinOk = !target.protein || intake.protein >= target.protein * 0.9;
  return kcalOk && proteinOk;
}

// One row per date, newest first, from `today` back `days` days.
// totalsByDate: { 'YYYY-MM-DD': raw macroHistory totals }.
function buildDays({ entries, totalsByDate = {}, target = null, today, days }) {
  const n = Math.min(Math.max(Math.round(days) || 28, 1), MAX_DAYS);
  const byDate = new Map();
  for (const e of entries || []) {
    if (!byDate.has(e.date)) byDate.set(e.date, []);
    byDate.get(e.date).push(e);
  }
  const out = [];
  for (let i = 0; i < n; i++) {
    const date = addDays(today, -i);
    const list = (byDate.get(date) || []).slice()
      .sort((a, b) => MEALS.indexOf(a.meal) - MEALS.indexOf(b.meal) || (a.t || 0) - (b.t || 0));
    const foodTotals = sumEntries(list);
    const recorded = sanitizeTotals(totalsByDate[date]);
    // The app's own day total wins: it includes quick-added macros.
    const intake = recorded && recorded.kcal >= foodTotals.kcal ? recorded : (list.length ? foodTotals : recorded);
    const logged = !!intake && intake.kcal > 0;
    out.push({
      date,
      today: i === 0,
      logged,
      entries: list,
      foodTotals,
      intake: logged ? intake : null,
      notFromFoodsKcal: logged && list.length ? Math.max(0, intake.kcal - foodTotals.kcal) : (logged ? intake.kcal : 0),
      onTarget: logged ? onTarget(intake, target) : null,
      flagged: list.filter(e => e.flag).length,
    });
  }
  return out;
}

// Averages over the last `n` full days (today is left out: it isn't over).
function windowStats(days, n, target) {
  const window = days.filter(d => !d.today).slice(0, n);
  const logged = window.filter(d => d.logged);
  const avg = {};
  for (const k of ['kcal', 'protein', 'carbs', 'fat']) {
    avg[k] = logged.length ? Math.round(logged.reduce((s, d) => s + d.intake[k], 0) / logged.length) : null;
  }
  const vsTarget = {};
  if (target && logged.length) {
    for (const k of ['kcal', 'protein', 'carbs', 'fat']) {
      vsTarget[k] = target[k] ? Math.round(((avg[k] - target[k]) / target[k]) * 100) : null;
    }
  }
  const onTargetDays = logged.filter(d => d.onTarget === true).length;
  return {
    days: window.length,
    daysLogged: logged.length,
    onTargetDays: target ? onTargetDays : null,
    average: avg,
    vsTargetPercent: target && logged.length ? vsTarget : null,
    adherence: adherenceLevel(window.length, logged.length, target ? onTargetDays : null),
  };
}

// green: logs most days and most of those are on target; amber: partly;
// red: rarely logs or rarely on target. 'unknown' without a target.
function adherenceLevel(totalDays, loggedDays, onTargetDays) {
  if (!totalDays) return 'unknown';
  const logRate = loggedDays / totalDays;
  if (onTargetDays === null) return logRate >= 0.8 ? 'logging' : logRate >= 0.5 ? 'partial' : 'low';
  const hitRate = loggedDays ? onTargetDays / loggedDays : 0;
  if (logRate >= 0.8 && hitRate >= 0.7) return 'green';
  if (logRate >= 0.5 && hitRate >= 0.4) return 'amber';
  return 'red';
}

function summarize({ entries, totalsByDate, target, today, days = 28 }) {
  const list = buildDays({ entries, totalsByDate, target, today, days: Math.max(days, 29) });
  return {
    today,
    target,
    days: list.slice(0, Math.min(Math.max(days, 1), MAX_DAYS)),
    last7: windowStats(list, 7, target),
    last28: windowStats(list, 28, target),
  };
}

module.exports = {
  MEALS, NUTRIENTS, MAX_DAYS,
  sanitizeEntry, sanitizeTotals, sanitizeTarget, kcalMismatch,
  buildDays, windowStats, adherenceLevel, onTarget, summarize, addDays,
};
