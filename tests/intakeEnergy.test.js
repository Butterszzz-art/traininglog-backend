// Regression: training-session energy (EE) used to be counted twice in the
// day targets. onderhoudPerDag already averages the training-day energy into
// maintenance, yet the targets were rest = onderhoudPerDag × factor and
// training = rest + EE, so the weekly average landed ~+15% instead of the
// intended factor. Numbers are Gael's intake (first coaching client).
const test = require('node:test');
const assert = require('node:assert/strict');
const calc = require('../src/intakeCalculations');
const { createRegistry } = require('../src/rules/registry');
const { generatePlan } = require('../src/plan/generator');

const GAEL = { ree: 2358, totaalTrainingsdag: 2904, ee: 497, onderhoudPerDag: 2670, factor: 1.045, dagen: 4 };
const weekly = (rest, training, days) => (training * days + rest * (7 - days)) / 7;

test('the input numbers are consistent with each other', () => {
  assert.equal(Math.round(calc.onderhoudsinnamePerDag(GAEL.totaalTrainingsdag, GAEL.ree, GAEL.dagen)), GAEL.onderhoudPerDag);
});

test('the old formula overshoots by ~15% (the bug, kept as a guard)', () => {
  const rest = GAEL.onderhoudPerDag * GAEL.factor;
  const training = rest + GAEL.ee;
  const ratio = weekly(rest, training, GAEL.dagen) / GAEL.onderhoudPerDag;
  assert.ok(ratio > 1.14 && ratio < 1.16, `old ratio ${ratio}`);
});

test('day targets = each day type’s maintenance × factor', () => {
  const rest = calc.beoogdeInnameRustdag(GAEL.ree, GAEL.factor);
  const training = calc.beoogdeInnameTrainingsdag(GAEL.totaalTrainingsdag, GAEL.factor);
  assert.equal(Math.round(rest), 2464);
  assert.equal(Math.round(training), 3035);
  const avg = calc.beoogdeInnameGemiddeld(rest, training, GAEL.dagen);
  assert.equal(Math.round(avg), 2790);
  assert.ok(Math.abs(avg / GAEL.onderhoudPerDag - GAEL.factor) < 0.001, 'weekly average = maintenance × factor (+4.5%)');
});

test('berekenClient: weekly average of the targets equals onderhoudPerDag × factor', () => {
  const intake = {
    persoonsgegevens: { gewicht: 84, vetpercentage: 18, geslacht: 'man', trainingservaring: 3 },
    doel: { categorie: 'onderhoud' },
    trainingsfrequentie: { huidig: 4 },
    lifestyle: { activityLevel: 'actief' },
  };
  for (const factor of [0.8, 1, 1.045, 1.1]) {
    const r = calc.berekenClient(intake, { energiebalansFactor: factor });
    const avg = weekly(r.beoogdeInnameRustdag, r.beoogdeInnameTrainingsdag, 4);
    assert.ok(Math.abs(avg - r.onderhoudPerDag * factor) <= 1.5, `factor ${factor}: ${avg} vs ${r.onderhoudPerDag * factor}`);
    assert.ok(Math.abs(r.beoogdeInnameGemiddeld - r.onderhoudPerDag * factor) <= 1, 'beoogdeInnameGemiddeld');
    assert.ok(r.beoogdeInnameTrainingsdag > r.beoogdeInnameRustdag);
  }
});

test('no false deficit flag at maintenance', () => {
  const intake = { persoonsgegevens: { gewicht: 84, vetpercentage: 18, geslacht: 'man' }, trainingsfrequentie: { huidig: 4 } };
  const r = calc.berekenClient(intake, { energiebalansFactor: 1 });
  assert.ok(!r.rodeVlaggen.some(f => /Tekort van/.test(f.bericht)), JSON.stringify(r.rodeVlaggen));
});

test('generator: every phase’s weekly average equals maintenance × its factor', () => {
  const registry = createRegistry();
  const plan = generatePlan({
    intake: {
      persoonsgegevens: { gewicht: 84, vetpercentage: 18, geslacht: 'man', trainingservaring: 3 },
      doel: { categorie: 'vetverlies' },
      trainingsfrequentie: { huidig: 4 },
      lifestyle: { activityLevel: 'actief', slaap: { uren: 7 } },
    },
    packageId: 'cut_cycle_32', startDate: '2026-11-02', tier: 'medium', registry, now: new Date('2026-11-01T00:00:00Z'),
  });
  for (const p of plan.phases) {
    const n = p.nutrition;
    const factor = n.provenance.kcal.value;
    const avg = weekly(n.restDay.kcal, n.trainingDay.kcal, 4);
    assert.ok(Math.abs(avg - n.maintenanceKcal * factor) <= 2, `${p.type}: ${avg} vs ${n.maintenanceKcal * factor}`);
  }
});
