const test = require('node:test');
const assert = require('node:assert/strict');
const { readGuide, applyUpdate, STEP_IDS } = require('../src/coachGuide');

const T1 = '2026-11-18T10:00:00.000Z';
const T2 = '2026-11-19T10:00:00.000Z';

test('readGuide returns an empty guide for nothing stored', () => {
  assert.deepEqual(readGuide(undefined), { welcomeSeen: null, dismissed: null, steps: {}, tours: {} });
});

test('readGuide drops unknown ids and bad timestamps', () => {
  const g = readGuide({ welcomeSeen: 'nope', steps: { code: T1, hack: T1, client: 5 }, tours: { phone: T1, tv: T1 } });
  assert.equal(g.welcomeSeen, null);
  assert.deepEqual(g.steps, { code: T1 });
  assert.deepEqual(g.tours, { phone: T1 });
});

test('applyUpdate adds steps once and keeps the first time', () => {
  let r = applyUpdate(null, { steps: ['code', 'client', 'bogus'] }, T1);
  assert.equal(r.changed, true);
  assert.deepEqual(r.guide.steps, { code: T1, client: T1 });
  r = applyUpdate(r.guide, { steps: ['code'] }, T2);
  assert.equal(r.changed, false);
  assert.equal(r.guide.steps.code, T1);
});

test('applyUpdate marks welcome and tours, and replay clears a tour', () => {
  let r = applyUpdate(null, { welcomeSeen: true, tour: 'desktop' }, T1);
  assert.equal(r.guide.welcomeSeen, T1);
  assert.equal(r.guide.tours.desktop, T1);
  r = applyUpdate(r.guide, { replay: 'desktop' }, T2);
  assert.equal(r.changed, true);
  assert.equal(r.guide.tours.desktop, undefined);
  assert.equal(r.guide.welcomeSeen, T1);
});

test('applyUpdate can dismiss and bring back the checklist', () => {
  let r = applyUpdate(null, { dismissed: true }, T1);
  assert.equal(r.guide.dismissed, T1);
  r = applyUpdate(r.guide, { dismissed: false }, T2);
  assert.equal(r.guide.dismissed, null);
});

test('applyUpdate ignores junk bodies', () => {
  for (const body of [null, 'x', 5, { steps: 'code' }, { tour: 'tv' }]) {
    assert.equal(applyUpdate(null, body, T1).changed, false);
  }
  assert.equal(STEP_IDS.length, 6);
});
