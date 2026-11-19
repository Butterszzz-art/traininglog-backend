// The AI coach's nutrition knowledge (src/knowledge/nutrition-methodology.js)
// follows Butters University and must state the same numbers the master
// plan calculates with (src/intakeCalculations.js).
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { NUTRITION_KNOWLEDGE: K } = require('../src/knowledge/nutrition-methodology');
const calc = require('../src/intakeCalculations');

const pct = (f) => Math.round(f * 1000) / 10;

test('Butters University comes first and wins over the PTC', () => {
  const bu = K.indexOf('PART 1 — BUTTERS UNIVERSITY');
  const ptc = K.indexOf('PART 2 — SECONDARY: HENSELMANS PTC');
  assert.ok(bu !== -1 && ptc > bu);
  assert.match(K, /Where BU and the PTC disagree|If anything in Part 2 seems to conflict with Part 1, follow Part 1/);
});

test('protein matches the plan (min, default, max g/kg)', () => {
  const p = calc.EIWIT_BEREIK_G_PER_KG;
  assert.ok(K.includes(`Protein ${p.min}–${p.maxSlank} g/kg; default ${p.praktisch} g/kg`));
});

test('fat matches the plan (share of energy)', () => {
  const f = calc.VET_BEREIK_PERCENTAGE_REE;
  assert.ok(K.includes(`Fat ${pct(f.min)}–${pct(f.max)}% of energy`));
});

test('surplus by training status matches the plan', () => {
  const s = calc.SURPLUS_PER_TRAININGSSTATUS;
  const band = (b) => `${pct(b.min - 1)}–${pct(b.max - 1)}%`;
  assert.ok(K.includes(`beginner ${band(s[1])}, intermediate ${band(s[2])}, advanced ${band(s[3])}`));
});

test('deficit ends match the plan', () => {
  const low = calc.TEKORT_BIJ_WEDSTRIJDVORM;
  const high = calc.TEKORT_BIJ_HOOG_VETPERCENTAGE;
  assert.ok(K.includes(`~${pct(low.min)}–${pct(low.max)}% near contest leanness, up to ${pct(high.min)}–${pct(high.max)}% at high body fat`));
});

test('BMR formulas and TEF match the plan', () => {
  assert.strictEqual(calc.katchMcArdleBMR(10), 370 + 21.6 * 10);
  assert.ok(K.includes('370 + 21.6 × fat-free mass'));
  assert.ok(K.includes('24.8 × bodyweight (kg) + 10'));
  assert.ok(K.includes(`TEF ×${calc.STANDAARD_TEF}`));
});

test('the old Menno-only numbers are gone', () => {
  assert.doesNotMatch(K, /10-30% deficit|200-500 kcal|0\.9 g\/kg/);
});
