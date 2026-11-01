// Parity test: src/intakeCalculations.js (generated) must produce exactly
// what ClientIntake's calculations.js produced for the fixtures in
// scripts/fixtures/intake-calculations.json.
//   node scripts/test-intake-calculations.js
// To refresh the expected values after a reviewed ClientIntake change:
//   node scripts/test-intake-calculations.js --update <path to ClientIntake/calculations.js>
'use strict';

const fs = require('fs');
const path = require('path');
const { isDeepStrictEqual } = require('util');
const calc = require(path.join(__dirname, '..', 'src', 'intakeCalculations'));

const FIXTURES = path.join(__dirname, 'fixtures', 'intake-calculations.json');

// Inputs cover each goal, every PAL level (incl. 'erg actief'), both stress
// scales, PEDs, injuries, coach overrides, and the volume/1RM helpers.
function baseIntake(overrides = {}) {
  return {
    persoonsgegevens: { naam: 'Test', email: '', leeftijd: 30, lengte: 180, gewicht: 84, vetpercentage: 18, geslacht: 'man', trainingservaring: 3 },
    huidigeKracht: [{ oefening: 'Bench press', kg: 90, herhalingen: 5, sets: 3 }, { oefening: 'Squat', kg: 0, herhalingen: 0, sets: 0 }],
    doel: { tekst: '', categorie: 'onderhoud' },
    trainingsfrequentie: { huidig: 4, trainingsmomenten: [] },
    blessures: { tekst: '', vermijdenOefeningen: [] },
    peds: { gebruikt: false },
    lifestyle: { activityLevel: 'sedentair', stressLevel: 'gemiddeld', slaap: { uren: 7, kwaliteit: 'goed' } },
    vetpercentageMeting: { huidplooimeter: true },
    genen: { enkelomtrek: 22.5 },
    ...overrides,
  };
}

const CASES = {
  berekenClient: [
    [baseIntake({ doel: { categorie: 'vetverlies' } })],
    [baseIntake({ doel: { categorie: 'spieropbouw' }, lifestyle: { activityLevel: 'licht actief', stressLevel: 'hoog', slaap: { uren: 5 } } })],
    [baseIntake({ doel: { categorie: 'krachttoename' }, lifestyle: { activityLevel: 'actief', stressLevel: 'veel_stress' } })],
    [baseIntake({ lifestyle: { activityLevel: 'erg actief', stressLevel: 'stressvrij' }, peds: { gebruikt: true } })],
    [baseIntake({ blessures: { tekst: 'Last van mijn knie en schouder', vermijdenOefeningen: ['Deadlift'] }, vetpercentageMeting: { huidplooimeter: false } })],
    [baseIntake({ doel: { categorie: 'vetverlies' } }), { energiebalansFactor: 0.7, eiwitFactor: 2.2, aantalMaaltijden: 3, trainingsdagenPerWeek: 5 }],
  ],
  trainingsvolumeAdvies: [[1, 0, 1, 1, 2], [2, 1, 0.9, 0.8, 3], [3, 0, 1.2, 1.1, 4], [0, 0, 2, 1, 1]],
  rm1VrijGewicht: [[100, 5], [60, 12]],
  rm1Bodyweight: [[80, 10, 6]],
  rm1PushUp: [[80, 0, 20]],
  bepaalSplitsdagen: [[1], [3], [4], [5], [6], [8]],
};

function run(fns) {
  const out = {};
  for (const [name, argsList] of Object.entries(CASES)) {
    out[name] = argsList.map(args => ({ args, result: fns[name](...args) }));
  }
  return JSON.parse(JSON.stringify(out));
}

(async () => {
  if (process.argv[2] === '--update') {
    const src = process.argv[3];
    if (!src) { console.error('--update needs the path to ClientIntake/calculations.js'); process.exit(1); }
    const ci = await import(require('url').pathToFileURL(path.resolve(src)).href);
    fs.writeFileSync(FIXTURES, JSON.stringify(run(ci), null, 2) + '\n');
    console.log('Wrote', path.relative(process.cwd(), FIXTURES));
    return;
  }

  const expected = JSON.parse(fs.readFileSync(FIXTURES, 'utf8'));
  const actual = run(calc);
  let failed = 0;
  for (const name of Object.keys(CASES)) {
    expected[name].forEach((exp, i) => {
      const ok = isDeepStrictEqual(actual[name][i], exp);
      if (!ok) failed++;
      console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} #${i + 1}`);
    });
  }
  console.log(`\n${failed ? `${failed} failed` : 'all passed'}`);
  process.exit(failed ? 1 : 0);
})();
