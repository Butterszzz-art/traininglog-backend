// src/coach/tableImport.js — the coach's Week | Day | Exercise | Sets | Reps |
// RIR | Rest | Notes sheet read without AI. The fixture is Gael's X-frame
// block, weeks 1–4 (this repo is private; the app repo gets an anonymised copy).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const imp = require('../src/coach/programImport');
const { parseTables } = require('../src/coach/tableImport');
const M = require('../src/programs/model');

function load() {
  const data = fs.readFileSync(path.join(__dirname, 'fixtures', 'gael-xframe-weeks-1-4.xlsx')).toString('base64');
  const file = imp.readImportFile({ fileName: 'gael-xframe-weeks-1-4.xlsx', data });
  return parseTables(file.sheets, { fileName: file.fileName });
}

test('X-frame weeks 1–4 import exactly, with no warnings', () => {
  const { program, warnings, rowWarnings } = load();
  assert.deepEqual(warnings, []);
  assert.deepEqual(rowWarnings, []);
  assert.equal(program.name, 'X-frame');
  assert.deepEqual(M.stats(program), { weekCount: 4, dayCount: 4, exerciseCount: 104, weekdays: [1, 2, 4, 5] });
  assert.deepEqual(M.weekDays(program, 1).map(d => [d.weekday, d.label, d.focus, d.exercises.length]), [
    [1, 'Lower A', 'quads', 6], [2, 'Upper A', 'lats and delts', 7], [4, 'Lower B', 'hamstrings and hips', 4], [5, 'Upper B', 'width and delts', 9],
  ]);
});

test('rows carry sets, rep range, RIR per week, last-set RIR, rest range, type, notes', () => {
  const { program } = load();
  const hack = M.weekDays(program, 1)[0].exercises[0];
  assert.deepEqual(
    { name: hack.name, type: hack.type, sets: hack.sets, repsMin: hack.repsMin, repsMax: hack.repsMax, rir: hack.rir, restSec: hack.restSec, restSecMax: hack.restSecMax, notes: hack.notes },
    { name: 'Hack squat (or Smith squat), deep', type: 'compound', sets: 2, repsMin: 6, repsMax: 10, rir: 3, restSec: 120, restSecMax: 180, notes: 'Full depth, controlled 2-3 s lowering' }
  );
  const raise = w => M.weekDays(program, w)[1].exercises.find(e => /^Cable lateral/.test(e.name));
  assert.deepEqual([1, 2, 3, 4].map(w => [raise(w).rir, raise(w).lastSetRir]), [[3, null], [3, 2], [2, 1], [2, 1]]);
  assert.equal(raise(1).type, 'isolation');
  const ab = M.weekDays(program, 1)[0].exercises[5];
  assert.deepEqual([ab.name, ab.type, ab.rir, ab.restSec], ['Ab-wheel roll-out', 'core', null, 60]);
  assert.equal(M.weekDays(program, 3)[0].exercises[0].rir, 2, 'leg compounds drop to RIR 2 in week 3');
});

test('the Notes sheet becomes program notes and rules, without the client name', () => {
  const { program } = load();
  assert.match(program.notes, /^X-frame, phase 1, weeks 1-4 of 16/);
  assert.match(program.progressionNotes, /^Double progression/);
  assert.ok(program.rules.some(r => /^Recovery gate:/.test(r)));
  assert.ok(program.rules.some(r => /^RIR: Leg compounds never below 2 RIR/.test(r)));
  assert.ok(!JSON.stringify(program).includes('Gael'));
});

test('to the phone: per-set RIR with the last set, weekdays, weeks', () => {
  const lib = M.toLibrary(load().program);
  assert.deepEqual(lib.frequency, ['Mon', 'Tue', 'Thu', 'Fri']);
  assert.equal(lib.weeks.length, 4);
  const curl = lib.weeks[3].days[1].exercises.find(e => e.name === 'Incline dumbbell curl');
  assert.deepEqual(curl.sets, [{ reps: 10, repsMax: 15, rir: 2, restSec: 60, restSecMax: 120 }, { reps: 10, repsMax: 15, rir: 1, restSec: 60, restSecMax: 120 }]);
});

test('messy tables: header found below a title, blanks repeat, warnings pinned to rows', () => {
  const grid = [
    ['Program for client'],
    [],
    ['WEEK', 'Day', 'Exercise', 'Sets', 'Reps', 'RIR (reps in reserve)', 'Rest', 'Notes'],
    ['Week 1', 'Monday: Push', 'Bench press', '4', '6-8', '2', '3 min', ''],
    ['', '', 'Lateral raise', 'x', 'AMRAP', 'hard', 'long', ''],
    ['', 'Push', 'Fly', '2', '12', '1', '', ''],
    ['Week 3', 'Monday: Push', 'Bench press', '4', '6-8', '1', '3 min', ''],
  ];
  const r = parseTables([{ name: 'Sheet1', grid }], { fileName: 'my-push_plan.csv' });
  const p = r.program;
  assert.equal(p.name, 'My push plan');
  assert.equal(M.weekDays(p, 1)[0].exercises.length, 2);
  const msgs = r.rowWarnings.map(w => `${w.row}: ${w.message}`);
  assert.ok(msgs.some(m => m.startsWith('5: "Lateral raise": sets "x"')));
  assert.ok(msgs.some(m => m.startsWith('5: "Lateral raise": reps "AMRAP"')));
  assert.ok(msgs.some(m => m.startsWith('5: "Lateral raise": RIR "hard"')));
  assert.ok(msgs.some(m => m.startsWith('5: "Lateral raise": rest "long"')));
  assert.ok(msgs.some(m => /Day "Push" has no weekday/.test(m)));
  assert.deepEqual(r.warnings, ['Week 2 is missing from the sheet; it repeats week 1.']);
  assert.equal(p.weeks[1].sameAs, 1);
});

test('a sheet that is not a table → null (the AI path takes it)', () => {
  assert.equal(parseTables([{ name: 'A', grid: [['Exercise', 'Week 1', 'Week 2'], ['Bench', '3x8', '3x6']] }]), null);
  assert.equal(parseTables(null), null);
});
