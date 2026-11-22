// Unit tests for src/coachShare.js (pure helpers, no server needed).
// Run: node scripts/test-coach-share.js
const assert = require('assert');
const cs = require('../src/coachShare');

const results = [];
function test(label, fn) {
  try { fn(); results.push({ label, pass: true }); }
  catch (err) { results.push({ label, pass: false, err }); }
}

const NOW = new Date('2026-09-24T12:00:00Z'); // a Thursday

test('normalizeSharing defaults everything on except the food log', () => {
  assert.deepStrictEqual(cs.normalizeSharing(null), { checkIns: true, bodyweight: true, workouts: true, nutrition: false, photos: false });
  assert.deepStrictEqual(cs.normalizeSharing({ bodyweight: false, junk: 1 }), { checkIns: true, bodyweight: false, workouts: true, nutrition: false, photos: false });
});

test('photos need their own yes on top of check-ins', () => {
  assert.strictEqual(cs.photosAllowed(null), false);
  assert.strictEqual(cs.photosAllowed({ checkIns: true }), false, 'undecided is off');
  assert.strictEqual(cs.photosAllowed({ photos: true }), true, 'check-ins default on');
  assert.strictEqual(cs.photosAllowed({ checkIns: false, photos: true }), false);
  assert.strictEqual(cs.decidedSharing({ checkIns: true }).photos, false);
  assert.deepStrictEqual(cs.mergeSharing({ photos: true }, { nutrition: true }), { nutrition: true, photos: true });
});

test('buildShareFields keeps valid check-ins, newest first, deduped by date', () => {
  const f = cs.buildShareFields({ checkIns: [
    { date: '2026-09-10', energy: 7 },
    { date: '2026-09-20', energy: 5, sleep: 11, notes: ' tired ' },
    { date: 'not-a-date', energy: 3 },
    { date: '2026-09-20T08:00:00Z', energy: 9 },
  ] }, null, NOW);
  assert.strictEqual(f.checkIns.length, 2);
  assert.strictEqual(f.lastCheckInAt, '2026-09-20');
  assert.strictEqual(f.latestCheckInJson.notes, 'tired');
  assert.strictEqual(f.latestCheckInJson.sleep, undefined, 'out-of-range score dropped');
});

test('buildShareFields drops what the client switched off', () => {
  const f = cs.buildShareFields({ checkIns: [{ date: '2026-09-20' }], bodyweight: [{ date: '2026-09-20', weight: 80 }], workouts: { thisWeek: 2 } },
    { checkIns: false, bodyweight: true, workouts: false }, NOW);
  assert.ok(!('checkIns' in f) && !('lastCheckInAt' in f));
  assert.ok(!('workoutsLoggedThisWeek' in f) && !('compliancePercent' in f));
  assert.strictEqual(f.currentBodyweight, 80);
});

test('buildShareFields keeps missing numbers as null, not 0', () => {
  const f = cs.buildShareFields({ workouts: { thisWeek: null, weekly: [] }, compliancePercent: null }, null, NOW);
  assert.strictEqual(f.compliancePercent, null);
  assert.strictEqual(f.workoutsLoggedThisWeek, null);
  const g = cs.buildShareFields({ checkIns: [{ date: '2026-09-20', energy: '', sleep: null, stress: 0 }] }, null, NOW);
  assert.deepStrictEqual(g.latestCheckInJson, { date: '2026-09-20', stress: 0 });
});

test('weeklyChangePercent compares the last two 7-day windows', () => {
  const series = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(Date.UTC(2026, 8, 20 - i));
    series.push({ date: d.toISOString().slice(0, 10), weight: i >= 7 ? 100 : 99 });
  }
  assert.strictEqual(cs.weeklyChangePercent(series), -1);
  assert.strictEqual(cs.weeklyChangePercent([{ date: '2026-09-20', weight: 80 }]), null);
});

test('computeClientAlerts: no data means no alerts (not 0% compliance)', () => {
  const r = cs.computeClientAlerts({ status: 'active' }, NOW);
  assert.strictEqual(r.alertStatus, 'ok');
  assert.strictEqual(r.alerts.length, 0);
});

test('computeClientAlerts: pending invites never alert', () => {
  assert.strictEqual(cs.computeClientAlerts({ status: 'pending', compliancePercent: 10 }, NOW).alertStatus, 'ok');
});

test('computeClientAlerts: overdue check-in, low compliance, fast weight change', () => {
  const r = cs.computeClientAlerts({ status: 'active', lastCheckInAt: '2026-09-12', compliancePercent: 70, weeklyWeightChangePercent: -1.4 }, NOW);
  assert.strictEqual(r.alertStatus, 'action');
  const ids = r.alerts.map(a => a.id);
  assert.ok(ids.includes('missed_checkin') && ids.includes('low_compliance') && ids.includes('rapid_weight_change'));
  assert.strictEqual(r.alerts[0].severity, 'action');
});

test('computeClientAlerts: 0 workouts only counts for the current week', () => {
  const thisWeek = cs.weekStartOf(NOW);
  assert.strictEqual(thisWeek, '2026-09-21');
  assert.strictEqual(cs.computeClientAlerts({ status: 'active', workoutsWeekStart: thisWeek, workoutsLoggedThisWeek: 0 }, NOW).alertStatus, 'watch');
  assert.strictEqual(cs.computeClientAlerts({ status: 'active', workoutsWeekStart: '2026-09-14', workoutsLoggedThisWeek: 0 }, NOW).alertStatus, 'ok');
});

test('sanitizeCoachProgram accepts old string days and new exercise objects', () => {
  const p = cs.sanitizeCoachProgram({ name: 'PPL', days: { Mon: ['Bench Press', { name: 'Row', sets: 4, reps: 8, repsMax: 12 }], Tue: [], Xyz: ['ignored'] } });
  assert.strictEqual(p.exerciseCount, 2);
  assert.deepStrictEqual(p.days.Mon[0], { name: 'Bench Press', sets: 3, reps: 10 });
  assert.deepStrictEqual(p.days.Mon[1], { name: 'Row', sets: 4, reps: 8, repsMax: 12 });
  assert.strictEqual(cs.sanitizeCoachProgram({ days: {} }), null);
});

test('toClientProgram produces the app program format', () => {
  const prog = cs.toClientProgram({ name: 'Upper/Lower', days: { Mon: [{ name: 'Squat', sets: 3, reps: 5 }], Thu: ['Bench'] } }, { coachUsername: 'Coach A', programId: 'p1' });
  assert.deepStrictEqual(prog.frequency, ['Mon', 'Thu']);
  assert.deepStrictEqual(prog.schedule.weekdays, [1, 4]);
  assert.strictEqual(prog.days.length, 2);
  assert.strictEqual(prog.days[0].exercises[0].sets.length, 3);
  assert.strictEqual(prog.days[0].exercises[0].sets[0].reps, 5);
  assert.strictEqual(prog.id, 'coach-coach-a-p1');
});

test('sanitizeMacroTargets needs all four numbers', () => {
  assert.deepStrictEqual(cs.sanitizeMacroTargets({ calories: '2400', protein: 180, carbs: 250.4, fat: 70 }), { calories: 2400, protein: 180, carbs: 250, fat: 70 });
  assert.strictEqual(cs.sanitizeMacroTargets({ calories: 2400 }), null);
});

test('sanitizeMacroPlan derives calories and keeps the weekly pattern', () => {
  const p = cs.sanitizeMacroPlan({
    days: { training: { protein: 180, carbs: '250', fat: 70 }, rest: { protein: 180, carbs: 150, fat: 75 }, high: null },
    schedule: { mon: 'training', tue: 'rest', wed: 'high', thu: 'nonsense' },
    note: '  refeed on Saturdays  ',
  });
  assert.deepStrictEqual(p.days.training, { protein: 180, carbs: 250, fat: 70, calories: 2350 });
  assert.strictEqual(p.days.rest.calories, 180 * 4 + 150 * 4 + 75 * 9);
  assert.strictEqual(p.days.high, undefined);
  // A weekday pointing at a day type with no targets is left for the client to pick.
  assert.deepStrictEqual(p.schedule, { mon: 'training', tue: 'rest', wed: null, thu: null, fri: null, sat: null, sun: null });
  assert.strictEqual(p.note, 'refeed on Saturdays');
});

test('sanitizeMacroPlan rejects a plan without training or with a half-filled day', () => {
  assert.strictEqual(cs.sanitizeMacroPlan({ days: { rest: { protein: 1, carbs: 1, fat: 1 } } }), null);
  assert.strictEqual(cs.sanitizeMacroPlan({ days: { training: { protein: 180, carbs: 250, fat: 70 }, low: { protein: 180 } } }), null);
  assert.strictEqual(cs.sanitizeMacroPlan({ days: { training: { protein: 0, carbs: 0, fat: 0 } } }), null);
  assert.strictEqual(cs.sanitizeMacroPlan('nope'), null);
});

test('buildShareFields keeps session times and weekly muscle sets under the workouts switch', () => {
  const snapshot = { workouts: { weekly: [], thisWeek: 2, weekStart: '2026-09-21',
    sessions: [
      { date: '2026-09-23', durationMin: 52.4, sets: 16, minPerSet: 3.27, otherMin: 12, targetMin: 45 },
      { date: '2026-09-21', durationMin: 40, sets: 14 },
      { date: 'bad', durationMin: 40, sets: 14 },
      { date: '2026-09-20', durationMin: 0, sets: 10 },
    ],
    muscleSets: { chest: 9.25, quads: 0, glutes: 'x', made_up: 5 } } };
  const f = cs.buildShareFields(snapshot, {}, NOW);
  assert.deepStrictEqual(f.sessionTimes, [
    { date: '2026-09-23', durationMin: 52, sets: 16, minPerSet: 3.3, otherMin: 12, targetMin: 45 },
    { date: '2026-09-21', durationMin: 40, sets: 14 },
  ]);
  assert.deepStrictEqual(f.weeklyMuscleSets, { chest: 9.3 });
  assert.ok(cs.SHARE_FIELDS.workouts.includes('sessionTimes') && cs.SHARE_FIELDS.workouts.includes('weeklyMuscleSets'));
  const off = cs.buildShareFields(snapshot, { workouts: false }, NOW);
  assert.strictEqual(off.sessionTimes, undefined);
});

test('computeClientAlerts flags sessions running long (3+ with a target, 15+ min and 25% over)', () => {
  const long = n => Array.from({ length: n }, (_, i) => ({ date: `2026-09-${String(20 - i).padStart(2, '0')}`, durationMin: 65, sets: 18, targetMin: 45 }));
  const { alerts } = cs.computeClientAlerts({ sessionTimes: long(3) }, NOW);
  assert.deepStrictEqual(alerts.find(a => a.id === 'long_sessions'), { id: 'long_sessions', severity: 'watch', label: 'Sessions running long', reason: 'Averaging 65 min, target 45 min' });
  assert.ok(!cs.computeClientAlerts({ sessionTimes: long(2) }, NOW).alerts.some(a => a.id === 'long_sessions'), 'needs 3 sessions');
  const close = long(3).map(x => ({ ...x, durationMin: 55 }));
  assert.ok(!cs.computeClientAlerts({ sessionTimes: close }, NOW).alerts.some(a => a.id === 'long_sessions'), '10 min over is fine');
  const old = long(3).map(x => ({ ...x, date: '2026-07-01' }));
  assert.ok(!cs.computeClientAlerts({ sessionTimes: old }, NOW).alerts.some(a => a.id === 'long_sessions'), 'only the last 28 days');
});

test('sanitizeProgramSchedule keeps busy weeks (after week 1+)', () => {
  const s = cs.sanitizeProgramSchedule({ startDate: '2026-09-21', changes: [{ kind: 'busy', afterWeek: 2, note: 'Exams' }, { kind: 'busy', afterWeek: 0 }] });
  assert.deepStrictEqual(s.changes.map(c => [c.kind, c.afterWeek, c.note]), [['busy', 2, 'Exams']]);
});

for (const r of results) console.log((r.pass ? 'PASS' : 'FAIL') + ' - ' + r.label + (r.err ? '\n   ' + r.err.message : ''));
const failed = results.filter(r => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
