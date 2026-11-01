// pocketcoach.program/2 — src/programs/model.js (same file as the app's
// src/js/program-model.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../src/programs/model');
const cs = require('../src/coachShare');

const row = (name, extra = {}) => ({ name, sets: 2, repsMin: 6, repsMax: 10, rir: 3, lastSetRir: null, restSec: 120, restSecMax: 180, type: 'compound', ...extra });
const xframe = () => ({
  schema: M.SCHEMA,
  name: 'X-frame',
  weeks: [
    { week: 1, days: [
      { dayId: 'd4', weekday: 5, label: 'Upper B', exercises: [row('Machine lateral raise', { sets: 4, repsMin: 12, repsMax: 20, type: 'isolation' })] },
      { dayId: 'd1', weekday: 1, label: 'Lower A', focus: 'quads', exercises: [row('Hack squat'), row('Ab-wheel roll-out', { rir: null, type: 'core' })] },
      { dayId: 'd2', weekday: 2, label: 'Upper A', exercises: [row('Cable lateral raise', { sets: 4, type: 'isolation' })] },
      { dayId: 'd3', weekday: 4, label: 'Lower B', exercises: [row('Lying leg curl')] },
    ] },
  ],
});

test('parsers read the sheet notation', () => {
  assert.deepEqual(M.parseReps('6-10'), { repsMin: 6, repsMax: 10 });
  assert.deepEqual(M.parseReps('8'), { repsMin: 8, repsMax: null });
  assert.deepEqual(M.parseRir('3'), { rir: 3, lastSetRir: null });
  assert.deepEqual(M.parseRir('3 (last set 2)'), { rir: 3, lastSetRir: 2 });
  assert.deepEqual(M.parseRir('2/1'), { rir: 2, lastSetRir: 1 });
  assert.deepEqual(M.parseRir('-'), { rir: null, lastSetRir: null });
  assert.deepEqual(M.parseRest('2-3 min'), { restSec: 120, restSecMax: 180 });
  assert.deepEqual(M.parseRest('1 min'), { restSec: 60, restSecMax: null });
  assert.deepEqual(M.parseRest('90s'), { restSec: 90, restSecMax: null });
  assert.deepEqual(M.parseRest('1:30'), { restSec: 90, restSecMax: null });
  assert.deepEqual(M.parseDayLabel('Mon - Lower A (quads)'), { weekday: 1, label: 'Lower A', focus: 'quads' });
  assert.deepEqual(M.parseDayLabel('Thu - Lower B (hamstrings and hips)'), { weekday: 4, label: 'Lower B', focus: 'hamstrings and hips' });
  assert.deepEqual(M.parseDayLabel('Upper A'), { weekday: null, label: 'Upper A', focus: '' });
  assert.equal(M.parseWeek('Week 12'), 12);
});

test('quick entry fills the row fields', () => {
  assert.deepEqual(M.parseQuickEntry('Squat 4x6-8'), { name: 'Squat', sets: 4, repsMin: 6, repsMax: 8, rir: null, lastSetRir: null, restSec: null, restSecMax: null });
  const r = M.parseQuickEntry('Cable lateral raise 4x10-20 @2/1 1-2min');
  assert.equal(r.name, 'Cable lateral raise');
  assert.deepEqual([r.sets, r.repsMin, r.repsMax, r.rir, r.lastSetRir, r.restSec, r.restSecMax], [4, 10, 20, 2, 1, 60, 120]);
  assert.equal(M.parseQuickEntry('Leg press machine').name, 'Leg press machine');
  assert.equal(M.parseQuickEntry('Hip thrust or 45 deg back extension 1x8-15 RIR 3').rir, 3);
});

test('v1 programs read as one repeating week', () => {
  const p = M.readProgram({ name: 'PPL', days: { Mon: ['Bench Press', { name: 'Row', sets: 4, reps: 8, repsMax: 12 }], Thu: [{ name: 'Squat', sets: 3, reps: 5 }] } });
  assert.equal(p.schema, M.SCHEMA);
  assert.equal(p.weeks.length, 1);
  assert.deepEqual(p.weeks[0].days.map(d => [d.weekday, d.label]), [[1, 'Mon'], [4, 'Thu']]);
  assert.deepEqual(p.weeks[0].days[0].exercises.map(e => [e.name, e.sets, e.repsMin, e.repsMax]), [['Bench Press', 3, 10, null], ['Row', 4, 8, 12]]);
  assert.equal(M.readProgram({ days: {} }), null);
});

test('days are ordered by weekday; validate flags real problems only', () => {
  const p = M.readProgram(xframe());
  assert.deepEqual(p.weeks[0].days.map(d => d.label), ['Lower A', 'Upper A', 'Lower B', 'Upper B']);
  assert.deepEqual(M.validate(p), []);
  const bad = M.readProgram({ ...xframe(), weeks: [{ days: [{ weekday: 1, label: 'A', exercises: [row('X', { rir: null, type: 'isolation' })] }, { weekday: 1, label: 'B', exercises: [] }] }] });
  const msgs = M.validate(bad).map(w => w.message);
  assert.ok(msgs.some(m => /no target RIR/.test(m)));
  assert.ok(msgs.some(m => /two days on Mon/.test(m)));
  assert.ok(msgs.some(m => /has no exercises/.test(m)));
});

test('copy week → next, then a different RIR per week', () => {
  let p = M.readProgram(xframe());
  p = M.copyWeek(p, 1);
  assert.equal(p.weeks.length, 2);
  p.weeks[1].days[1].exercises[0].lastSetRir = 2;
  const again = M.readProgram(p);
  assert.equal(M.weekDays(again, 1)[1].exercises[0].lastSetRir, null, 'week 1 untouched');
  assert.equal(M.weekDays(again, 2)[1].exercises[0].lastSetRir, 2);
  assert.equal(M.stats(again).weekCount, 2);
});

test('toLibrary: per-set RIR with the last set, weekday on each day, weeks when > 1', () => {
  let p = M.copyWeek(M.readProgram(xframe()), 1);
  p.weeks[1].days[1].exercises[0].lastSetRir = 2;
  const lib = M.toLibrary(M.readProgram(p), { id: 'coach-a-x', coachUsername: 'a' });
  assert.deepEqual(lib.frequency, ['Mon', 'Tue', 'Thu', 'Fri']);
  assert.deepEqual(lib.schedule.weekdays, [1, 2, 4, 5]);
  assert.equal(lib.days[0].name, 'Lower A');
  assert.equal(lib.days[0].weekday, 1);
  const w2 = lib.weeks[1].days[1].exercises[0];
  assert.deepEqual(w2.sets.map(s => s.rir), [3, 3, 3, 2]);
  assert.deepEqual(w2.sets[0], { reps: 6, repsMax: 10, rir: 3, restSec: 120, restSecMax: 180 });
  assert.equal(w2.type, 'isolation');
  assert.equal(lib.durationWeeks, 2);
  const single = M.toLibrary(M.readProgram(xframe()));
  assert.equal(single.weeks, undefined, 'one-week programs keep the plain days shape');
});

test('library shape (AI import) reads back to the same rows', () => {
  const p = M.readProgram(M.copyWeek(M.readProgram(xframe()), 1));
  const back = M.readProgram(M.toLibrary(p));
  assert.deepEqual(back.weeks[1].days.map(d => d.exercises.map(e => [e.name, e.sets, e.repsMin, e.repsMax, e.rir, e.restSec, e.restSecMax])),
    p.weeks[1].days.map(d => d.exercises.map(e => [e.name, e.sets, e.repsMin, e.repsMax, e.rir, e.restSec, e.restSecMax])));
  assert.deepEqual(back.weeks[0].days.map(d => d.weekday), [1, 2, 4, 5]);
});

test('formatRow', () => {
  assert.equal(M.formatRow(row('Cable lateral raise', { sets: 4, repsMin: 10, repsMax: 20, rir: 2, lastSetRir: 1, restSec: 60, restSecMax: 120 })), 'Cable lateral raise 4×10–20 · RIR 2 (last set 1) · rest 1–2 min');
});

test('coachShare: v2 stored with counts and the legacy days view; client gets library shape', () => {
  const saved = cs.sanitizeCoachProgram(M.copyWeek(M.readProgram(xframe()), 1));
  assert.equal(saved.weekCount, 2);
  assert.equal(saved.dayCount, 4);
  assert.equal(saved.exerciseCount, 10);
  assert.deepEqual(saved.days.Fri.map(e => e.name), ['Machine lateral raise']);
  assert.equal(cs.isV1ProgramBody({ name: 'x', days: {} }), true);
  assert.equal(cs.isV1ProgramBody(saved), false);
  const client = cs.toClientProgram(saved, { coachUsername: 'Coach A', programId: 'p1' });
  assert.equal(client.id, 'coach-coach-a-p1');
  assert.equal(client.weeks.length, 2);
});
