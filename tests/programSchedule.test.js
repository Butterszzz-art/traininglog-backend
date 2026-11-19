// src/coachShare.js sanitizeProgramSchedule — a coach's repeat / pause weeks
// for one client (same rules as the app's src/js/program-timeline.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const cs = require('../src/coachShare');

test('keeps valid changes in week order with notes; repeats need a week before them', () => {
  const s = cs.sanitizeProgramSchedule({
    startDate: '2026-11-02T10:00:00Z',
    changes: [
      { kind: 'pause', afterWeek: 3, note: '  Holiday   week ' },
      { kind: 'repeat', afterWeek: 2, id: 'r1' },
      { kind: 'repeat', afterWeek: 0 },
      { kind: 'skip', afterWeek: 1 },
      { kind: 'pause', afterWeek: 53 },
      { kind: 'pause', afterWeek: 0 },
    ],
  }, 'p1');
  assert.equal(s.programId, 'p1');
  assert.equal(s.startDate, '2026-11-02');
  assert.deepEqual(s.changes.map(c => [c.kind, c.afterWeek]), [['pause', 0], ['repeat', 2], ['pause', 3]]);
  assert.equal(s.changes[1].id, 'r1');
  assert.equal(s.changes[2].note, 'Holiday week');
});

test('null without a date or a change; caps at 30 changes', () => {
  assert.equal(cs.sanitizeProgramSchedule({ startDate: 'nope', changes: [] }), null);
  assert.equal(cs.sanitizeProgramSchedule(null), null);
  const many = cs.sanitizeProgramSchedule({ changes: Array.from({ length: 40 }, () => ({ kind: 'pause', afterWeek: 1 })) });
  assert.equal(many.changes.length, 30);
  assert.equal(new Set(many.changes.map(c => c.id)).size, 30);
  assert.equal(many.startDate, '');
});

test('the client shares which program it follows and since when (workouts switch)', () => {
  const f = cs.buildShareFields({ workouts: { weekly: [] }, activeProgramName: 'Block', activeProgramId: 'coach-x-p1', activeProgramStartDate: '2026-11-02' }, { workouts: true });
  assert.equal(f.activeProgramId, 'coach-x-p1');
  assert.equal(f.activeProgramStartDate, '2026-11-02');
  assert.ok(cs.SHARE_FIELDS.workouts.includes('activeProgramStartDate'));
  const off = cs.buildShareFields({ activeProgramStartDate: '2026-11-02' }, { workouts: false });
  assert.equal(off.activeProgramStartDate, undefined);
});
