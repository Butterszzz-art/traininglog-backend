// Program import without AI: a sheet laid out as a table with one row per
// exercise, e.g. (the coach's own format)
//
//   Week   | Day                    | Exercise   | Sets | Reps | RIR            | Rest    | Notes
//   Week 1 | Mon - Lower A (quads)  | Hack squat | 2    | 6-10 | 3              | 2-3 min | Full depth
//   Week 2 | Tue - Upper A          | Curl       | 2    | 10-15| 3 (last set 2) | 1-2 min |
//
// plus an optional key/value "Notes" sheet (Block, Progression, RIR rules…).
// Optional columns: Block (mesocycle name, per row; "Week 5 (deload)" or a
// block named "Deload" marks a deload week) and Load ("75%" of 1RM or "100kg").
// The coach dashboard's Export CSV writes exactly this layout.
// Header names are matched loosely; Week/Day cells left blank repeat the row
// above (merged cells). Everything maps onto pocketcoach.program/2 exactly,
// with a warning pinned to each row that needed a guess.
//
// parseTables(sheets) returns null when no sheet looks like this, so the
// caller falls back to the AI conversion.
'use strict';

const M = require('../programs/model');

const COLUMNS = [
  ['block', /^(block|meso(cycle)?|phase|blok|fase)\b/i],
  ['load', /^(load|weight|intensity|gewicht|%\s*(of\s*)?1\s*rm|kg)\b/i],
  ['week', /^(week|wk|wo?ek)\b/i],
  ['day', /^(day|dag|session|workout|training)\b/i],
  ['exercise', /^(exercise|exercises|movement|oefening|lift)\b/i],
  ['sets', /^(sets?|series)\b/i],
  ['rir', /^(rir|reps? in reserve)\b/i],
  ['reps', /^(reps?|repetitions|herhalingen|rep range)\b/i],
  ['rest', /^(rest|pause|rust)\b/i],
  ['notes', /^(notes?|comments?|cues?|opmerkingen?|toelichting)\b/i],
];
const REQUIRED = ['week', 'day', 'exercise', 'sets', 'reps'];
const NOTE_SHEET = /^(notes?|info|read ?me|toelichting|about)$/i;

function cell(grid, r, c) {
  const row = grid[r];
  return row && row[c] != null ? String(row[c]).trim() : '';
}

function findHeader(grid) {
  for (let r = 0; r < Math.min(grid.length, 15); r++) {
    const row = grid[r];
    if (!row) continue;
    const cols = {};
    row.forEach((value, c) => {
      const text = String(value || '').trim();
      if (!text) return;
      const hit = COLUMNS.find(([key, re]) => cols[key] === undefined && re.test(text));
      if (hit) cols[hit[0]] = c;
    });
    if (REQUIRED.every(k => cols[k] !== undefined)) return { row: r, cols };
  }
  return null;
}

// Key/value rows → program notes. The client's name is left out on purpose:
// library programs get reused for other clients.
function readNotes(sheet) {
  const out = { name: '', notes: [], progressionNotes: [], rules: [] };
  (sheet.grid || []).forEach(row => {
    const cells = (row || []).map(v => String(v || '').trim()).filter(Boolean);
    if (cells.length < 2) { if (cells[0]) out.rules.push(cells[0]); return; }
    const key = cells[0].replace(/:$/, '');
    const value = cells.slice(1).join(' ');
    if (/^(client|name|naam|athlete)$/i.test(key)) return;
    if (/^(program|programme|title)$/i.test(key)) out.name = value;
    else if (/^(block|about|description|overview)$/i.test(key)) out.notes.push(value);
    else if (/^progression/i.test(key)) out.progressionNotes.push(value);
    else out.rules.push(`${key}: ${value}`);
  });
  return out;
}

function guessName(notes, fileName) {
  if (notes.name) return notes.name;
  const block = notes.notes[0] || '';
  const first = block.split(/[,.;(]/)[0].trim();
  if (first && first.length <= 40) return first;
  const base = String(fileName || '').replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ').trim();
  return base ? base.charAt(0).toUpperCase() + base.slice(1) : 'Imported program';
}

/**
 * sheets: [{ name, grid }]. Returns null, or
 * { program (v2), warnings: [string], rowWarnings: [{ sheet, row, week, dayId, exerciseId, message }] }.
 */
function parseTables(sheets, { fileName } = {}) {
  const list = Array.isArray(sheets) ? sheets : [];
  let table = null;
  for (const sheet of list) {
    const header = findHeader(sheet.grid || []);
    if (header) { table = { sheet, header }; break; }
  }
  if (!table) return null;

  const { sheet, header } = table;
  const { cols } = header;
  const rowWarnings = [];
  const warnings = [];
  const weeks = new Map(); // week number → Map(dayKey → day)
  const dayIds = new Map(); // "weekday|label" → dayId, the same across weeks
  const weekBlock = new Map(); // week number → block name
  const deloads = new Set();
  let week = null;
  let dayText = '';
  let blockText = '';

  for (let r = header.row + 1; r < sheet.grid.length; r++) {
    const name = cell(sheet.grid, r, cols.exercise);
    const weekCell = cell(sheet.grid, r, cols.week);
    const dayCell = cell(sheet.grid, r, cols.day);
    if (weekCell) week = M.parseWeek(weekCell) || week;
    if (dayCell) dayText = dayCell;
    if (cols.block !== undefined && (weekCell || cell(sheet.grid, r, cols.block))) blockText = cell(sheet.grid, r, cols.block);
    if (week && /deload/i.test(weekCell)) deloads.add(week);
    if (week && blockText && !weekBlock.has(week)) weekBlock.set(week, blockText);
    if (!name) continue;
    const at = { sheet: sheet.name, row: r + 1 };
    const warn = message => rowWarnings.push({ ...at, message });
    if (!week) { warn(`"${name}": no week number; skipped.`); continue; }
    if (!dayText) { warn(`"${name}": no day; skipped.`); continue; }

    const day = M.parseDayLabel(dayText);
    const key = `${day.weekday || ''}|${day.label.toLowerCase()}`;
    if (!dayIds.has(key)) dayIds.set(key, `d${dayIds.size + 1}`);
    const dayId = dayIds.get(key);
    if (!weeks.has(week)) weeks.set(week, new Map());
    const days = weeks.get(week);
    if (!days.has(dayId)) {
      days.set(dayId, { dayId, weekday: day.weekday, label: day.label || dayText, focus: day.focus, exercises: [] });
      if (!day.weekday) warn(`Day "${dayText}" has no weekday; pick one before saving.`);
    }
    const target = days.get(dayId);

    const setsText = cell(sheet.grid, r, cols.sets);
    let sets = Number.parseInt(setsText, 10);
    if (!(sets >= 1 && sets <= 20)) { warn(`"${name}": sets "${setsText}" not understood; used 3.`); sets = 3; }
    const repsText = cell(sheet.grid, r, cols.reps);
    const reps = M.parseReps(repsText);
    if (reps.repsMin === null) warn(`"${name}": reps "${repsText}" not understood.`);
    const rirText = cols.rir !== undefined ? cell(sheet.grid, r, cols.rir) : '';
    const rir = M.parseRir(rirText);
    if (rirText && rir.rir === null && !/^[-–—x]+$/i.test(rirText)) warn(`"${name}": RIR "${rirText}" not understood.`);
    const restText = cols.rest !== undefined ? cell(sheet.grid, r, cols.rest) : '';
    const rest = M.parseRest(restText);
    if (restText && rest.restSec === null && !/^[-–—]+$/.test(restText)) warn(`"${name}": rest "${restText}" not understood.`);

    const loadText = cols.load !== undefined ? cell(sheet.grid, r, cols.load) : '';
    const load = M.parseLoad(loadText);
    if (loadText && load.loadPct === null && load.loadKg === null && !/^[-–—]+$/.test(loadText)) warn(`"${name}": load "${loadText}" not understood (use 75% or 100kg).`);

    let type = M.guessType(name);
    if (rir.rir === null && /^[-–—]+$/.test(rirText) && type !== 'core') type = 'core';
    const exerciseId = `w${week}-${dayId}-e${target.exercises.length + 1}`;
    target.exercises.push({
      id: exerciseId, name, type, sets, ...reps, ...rir, ...rest, ...load,
      notes: cols.notes !== undefined ? cell(sheet.grid, r, cols.notes) : '',
    });
    rowWarnings.forEach(w => { if (w.row === at.row && !w.exerciseId) Object.assign(w, { week, dayId, exerciseId }); });
  }
  if (!weeks.size) return null;

  const max = Math.max(...weeks.keys());
  if (max > M.LIMITS.weeks) warnings.push(`Only the first ${M.LIMITS.weeks} weeks were imported.`);
  // Block names → blocks; a block called just "Deload" marks its weeks as deloads.
  const blocks = [];
  const blockId = name => {
    const key = name.trim().replace(/\s*\(?deload\)?\s*$/i, '').trim();
    if (!key) return null;
    let b = blocks.find(x => x.name.toLowerCase() === key.toLowerCase());
    if (!b) { b = { id: `b${blocks.length + 1}`, name: key.slice(0, M.LIMITS.label), goal: '' }; blocks.push(b); }
    return b.id;
  };
  const weekExtras = n => {
    const name = weekBlock.get(n) || '';
    const out = {};
    const id = blockId(name);
    if (id) out.block = id;
    if (deloads.has(n) || /deload/i.test(name)) out.deload = true;
    return out;
  };
  const weekList = [];
  for (let n = 1; n <= Math.min(max, M.LIMITS.weeks); n++) {
    if (weeks.has(n)) weekList.push({ week: n, ...weekExtras(n), days: [...weeks.get(n).values()] });
    else {
      warnings.push(`Week ${n} is missing from the sheet; it repeats week ${n - 1}.`);
      weekList.push(n > 1 ? { week: n, sameAs: n - 1 } : { week: n, days: [] });
    }
  }

  const noteSheet = list.find(s => s !== sheet && NOTE_SHEET.test(String(s.name || '').trim()));
  const notes = noteSheet ? readNotes(noteSheet) : { name: '', notes: [], progressionNotes: [], rules: [] };
  const program = M.readProgram({
    schema: M.SCHEMA,
    name: guessName(notes, fileName),
    notes: notes.notes.join('\n'),
    progressionNotes: notes.progressionNotes.join('\n'),
    rules: notes.rules,
    blocks,
    weeks: weekList,
  });
  if (!program) return null;
  M.validate(program).forEach(w => {
    // Day/RIR gaps already reported per row stay single.
    if (!rowWarnings.some(r => r.exerciseId && r.exerciseId === w.exerciseId)) rowWarnings.push(w);
  });
  return { program, warnings, rowWarnings };
}

module.exports = { parseTables, findHeader, readNotes };
