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

test('normalizeSharing defaults everything on', () => {
  assert.deepStrictEqual(cs.normalizeSharing(null), { checkIns: true, bodyweight: true, workouts: true });
  assert.deepStrictEqual(cs.normalizeSharing({ bodyweight: false, junk: 1 }), { checkIns: true, bodyweight: false, workouts: true });
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

for (const r of results) console.log((r.pass ? 'PASS' : 'FAIL') + ' - ' + r.label + (r.err ? '\n   ' + r.err.message : ''));
const failed = results.filter(r => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
