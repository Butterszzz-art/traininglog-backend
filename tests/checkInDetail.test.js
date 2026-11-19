// node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const { cleanDetail, detailFlags, detailToText } = require('../src/checkInDetail');
const { buildShareFields } = require('../src/coachShare');

const sample = {
  training: {
    programWeek: ' Week 4, Day 2 ',
    recovery: { chest: 'day', quads: 'stillSore', calves: 'none', biceps: 'bogus', neck: 'day' },
    workload: [{ day: 'Day 1', rating: 'limit' }, { day: 'Day 2', rating: 'tooMuch' }, { day: 'Day 3', rating: null }],
    jointPain: 'Left elbow on skull crushers',
    pump: 2,
    cardioAdherence: 9,
  },
  nutrition: { ratings: { hunger: 2, appetite: '', digestion: 4, adherence: 6 }, water: 'most' },
  lifestyle: { physicalFatigue: 8, caffeineMg: '300', peds: 'missed', unknown: 'x' },
};

test('cleanDetail keeps only valid answers', () => {
  const d = cleanDetail(sample);
  assert.equal(d.training.programWeek, 'Week 4, Day 2');
  assert.deepEqual(d.training.recovery, { chest: 'day', quads: 'stillSore', calves: 'none' });
  assert.deepEqual(d.training.workload, [{ day: 'Day 1', rating: 'limit' }, { day: 'Day 2', rating: 'tooMuch' }]);
  assert.equal(d.training.pump, 2);
  assert.equal(d.training.cardioAdherence, undefined); // out of 1-5
  assert.deepEqual(d.nutrition.ratings, { hunger: 2, digestion: 4 });
  assert.equal(d.lifestyle.caffeineMg, 300);
  assert.equal(d.lifestyle.unknown, undefined);
});

test('cleanDetail returns null when nothing was answered', () => {
  assert.equal(cleanDetail(null), null);
  assert.equal(cleanDetail({ training: { recovery: {} }, nutrition: { ratings: { hunger: '' } } }), null);
});

test('detailFlags points at what a coach should look at', () => {
  const texts = detailFlags(sample).map(f => f.text);
  assert.ok(texts.includes('Still sore next session: Quads'));
  assert.ok(texts.includes('Too much volume: Day 2'));
  assert.ok(texts.includes('Joint pain reported'));
  assert.ok(texts.includes('Weak pumps (2/5)'));
  assert.ok(texts.some(t => t.startsWith('Nutrition struggles: Hunger 2/5')));
  assert.ok(texts.includes('PEDs missed or mistimed'));
});

test('detailToText describes the answers for AI prompts', () => {
  const text = detailToText(sample);
  assert.match(text, /Quads still sore/);
  assert.match(text, /Day 2 too much/);
  assert.match(text, /Water target: most days/);
});

test('shared check-ins keep a cleaned detail', () => {
  const fields = buildShareFields({ checkIns: [{ date: '2026-11-18', sleep: 7, detail: sample }, { date: '2026-11-11', detail: { nope: 1 } }] }, {});
  assert.equal(fields.checkIns[0].detail.training.recovery.quads, 'stillSore');
  assert.equal(fields.checkIns[1].detail, undefined);
});

test('detail is dropped with check-in sharing off', () => {
  const fields = buildShareFields({ checkIns: [{ date: '2026-11-18', detail: sample }] }, { checkIns: false });
  assert.equal(fields.checkIns, undefined);
});
