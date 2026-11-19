// Weekly training volume for the master plan, calculated from Butters
// University (BU, README "Training intensity, volume & frequency" plus the
// energy-balance module and the training case studies).
//
// BU is the calculation. Menno Henselmans' volume formula
// (trainingsvolumeMenno in src/intakeCalculations.js) is NOT used to pick
// the number: the generator only reports it next to BU's number, as a
// comparison for the coach.
//
// All numbers come from the rule `train.volume.bu` (rules/training.json),
// so changing the rule changes the plan without touching this code.
'use strict';

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

// params = registry.params('train.volume.bu').
// input  = { status: 1|2|3, age, sessionsPerWeek, phaseType: 'cut'|'maintain'|'build'|... }
// Returns { sets, band: { min, max }, reasons: [string] } with sets in
// direct sets per muscle per week (indirect sets count params.setCounting.indirect).
function buWeeklySets(params, { status, age, sessionsPerWeek, phaseType }) {
  const s = String(clamp(Math.round(Number(status) || 2), 1, 3));
  const band = { ...params.bands[s] };
  let sets = params.startByStatus[s];
  const reasons = [`${params.statusLabels[s]}: start at ${sets} direct sets in BU's ${band.min}–${band.max} band`];

  // BU: older clients (60+) do better closer to 10 sets per muscle.
  const older = params.olderAdults;
  if (Number(age) >= older.fromAge) {
    band.max = Math.min(band.max, older.max);
    band.min = Math.min(band.min, band.max);
    if (sets > older.start) {
      sets = older.start;
      reasons.push(`age ${age} (${older.fromAge}+): ${older.start} sets, at most ${older.max}`);
    }
  }

  // BU case study "Tom": 2 sessions a week → ~8–10 direct sets per muscle.
  const crunched = params.timeCrunched;
  if (Number(sessionsPerWeek) <= crunched.maxSessionsPerWeek) {
    band.min = Math.min(band.min, crunched.min);
    band.max = Math.min(band.max, crunched.max);
    if (sets > crunched.max) {
      sets = crunched.max;
      reasons.push(`${sessionsPerWeek} sessions a week: ${crunched.min}–${crunched.max} sets (time-crunched)`);
    }
  }

  // BU: don't cut volume in a cut; keep at least ~10 sets per muscle.
  // Unlike Menno's formula, a deficit never lowers the number.
  if (phaseType === 'cut' && Number(sessionsPerWeek) > crunched.maxSessionsPerWeek && sets < params.cut.minSets) {
    sets = params.cut.minSets;
    reasons.push(`cut: kept at ${params.cut.minSets}+ sets (BU: volume is held, not lowered, in a deficit)`);
  }

  sets = clamp(sets, band.min, band.max);
  return { sets, band, reasons };
}

module.exports = { buWeeklySets };
