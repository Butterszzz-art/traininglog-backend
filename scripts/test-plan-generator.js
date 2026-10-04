// Tests for the rule registry, the plan generator and the plan lifecycle.
// Run: node scripts/test-plan-generator.js
'use strict';

const path = require('path');
const root = path.join(__dirname, '..');
const calc = require(path.join(root, 'src', 'intakeCalculations'));
const { createRegistry, validateRule } = require(path.join(root, 'src', 'rules', 'registry'));
const { generatePlan } = require(path.join(root, 'src', 'plan', 'generator'));
const lifecycle = require(path.join(root, 'src', 'plan', 'lifecycle'));

const results = [];
const check = (label, cond) => results.push({ label, pass: !!cond });
const throws = (fn, code) => { try { fn(); return false; } catch (e) { return code ? e.code === code : true; } };

const registry = createRegistry();

// ── Registry ────────────────────────────────────────────────────────────────
check('registry loads and has a version', /^\d+\.\d+\.\d+$/.test(registry.version));
check('a rule without a statement is rejected', validateRule({ id: 'nutr.x', version: 1, domain: 'nutrition', params: {}, evidenceGrade: 'A', sources: [], verified: false }).length > 0);
check('min <= default <= max is enforced', validateRule({ id: 'nutr.x', version: 1, domain: 'nutrition', statement: 's', params: { min: 2, default: 1, max: 3 }, evidenceGrade: 'A', sources: [], verified: false }).length > 0);
check('conditions resolve per context', registry.resolve('nutr.energy.factor', { goal: 'vetverlies' }).value === 0.8);
check('resolve stamps provenance', registry.resolve('nutr.protein.g_per_kg').ruleId === 'nutr.protein.g_per_kg');

// Registry defaults must equal ClientIntake's constants until a reviewed rule
// change says otherwise (then this test is updated with the rule).
check('PAL table = ClientIntake STANDAARD_PAL', JSON.stringify(registry.params('nutr.pal.table').values) === JSON.stringify(calc.STANDAARD_PAL));
check('TEF = ClientIntake STANDAARD_TEF', registry.resolve('nutr.tef.factor').value === calc.STANDAARD_TEF);
check('energy factors = ClientIntake STANDAARD_ENERGIEBALANS_FACTOR',
  Object.entries(calc.STANDAARD_ENERGIEBALANS_FACTOR).every(([goal, f]) => registry.resolve('nutr.energy.factor', { goal }).value === f));
check('energy ranges = ClientIntake ENERGIEBALANS_BEREIK',
  Object.entries(calc.ENERGIEBALANS_BEREIK).every(([goal, r]) => JSON.stringify(registry.params('nutr.energy.factor', { goal }).range) === JSON.stringify(r)));
check('protein range = ClientIntake EIWIT_BEREIK_G_PER_KG', (() => {
  const p = registry.params('nutr.protein.g_per_kg');
  return p.min === calc.EIWIT_BEREIK_G_PER_KG.min && p.default === calc.EIWIT_BEREIK_G_PER_KG.praktisch && p.max === calc.EIWIT_BEREIK_G_PER_KG.maxSlank;
})());
check('fat range = ClientIntake VET_BEREIK_PERCENTAGE_REE', (() => {
  const p = registry.params('nutr.fat.pct_ree');
  return p.min === calc.VET_BEREIK_PERCENTAGE_REE.min && p.max === calc.VET_BEREIK_PERCENTAGE_REE.max;
})());
check('post-training boost = ClientIntake POST_TRAINING_BOOST_STANDAARD', registry.resolve('nutr.meals.post_training_protein').value === calc.POST_TRAINING_BOOST_STANDAARD);

// ── Generator ───────────────────────────────────────────────────────────────
const intake = {
  persoonsgegevens: { naam: 'Ana', gewicht: 84, vetpercentage: 18, geslacht: 'man', trainingservaring: 3 },
  doel: { categorie: 'vetverlies' },
  trainingsfrequentie: { huidig: 4 },
  blessures: { tekst: 'knie', vermijdenOefeningen: [] },
  lifestyle: { activityLevel: 'erg actief', stressLevel: 'gemiddeld', slaap: { uren: 7 } },
  vetpercentageMeting: { huidplooimeter: true },
  materiaal: { apparatuur: ['squat_rack'] },
  genen: { enkelomtrek: 22 },
};
const now = new Date('2026-10-04T08:00:00Z');
const cut = generatePlan({ intake, packageId: 'cut_cycle_32', startDate: '2026-10-12', tier: 'medium', registry, now, client: { uid: 'u1', coachUid: 'c1' } });

check('cut cycle: 4 phases cut/maintain/cut/maintain', cut.phases.map(p => p.type).join() === 'cut,maintain,cut,maintain');
check('cut cycle: 32 weeks in 8 billing blocks', cut.package.totalWeeks === 32 && cut.package.billing.blocks === 8);
check('phases are back to back', cut.phases.every((p, i) => i === 0 || p.plannedStart > cut.phases[i - 1].plannedEnd));
check('first phase starts on the start date, 12 weeks long', cut.phases[0].plannedStart === '2026-10-12' && cut.phases[0].plannedEnd === '2027-01-03');
check('last phase ends after 32 weeks', cut.phases[3].plannedEnd === '2027-05-23');
check('status is draft', cut.status === 'draft');

const direct = calc.berekenClient({ ...intake, doel: { categorie: 'vetverlies' } }, {
  pal: 1.725, tef: 1.1, MET: 5.7, trainingsduurMinuten: 60, eiwitFactor: 1.8, percentageVetVanREE: 0.4,
  aantalMaaltijden: 4, postTrainingBoost: 1.5, trainingsdagenPerWeek: 4, energiebalansFactor: 0.8,
});
check('cut kcal = ClientIntake berekenClient (vetverlies, erg actief)', cut.phases[0].nutrition.restDay.kcal === direct.beoogdeInnameRustdag);
check('protein = 1.8 g/kg', cut.phases[0].nutrition.restDay.proteinG === Math.round(84 * 1.8 * 10) / 10);
check('maintain phase eats more than cut', cut.phases[1].nutrition.restDay.kcal > cut.phases[0].nutrition.restDay.kcal);
check('kcal provenance cites the energy rule', cut.phases[0].nutrition.provenance.kcal.ruleId === 'nutr.energy.factor');
check('cut phase has a coach-set target slot and a time cap',
  cut.phases[0].endCriteria.any[0].kind === 'target' && cut.phases[0].endCriteria.any[0].value === null && cut.phases[0].endCriteria.any[1].weeks === 12);
check('maintain phase ends on its time cap only', cut.phases[1].endCriteria.any.length === 1);
check('volume is lower in a cut than in maintenance', cut.phases[0].training.weeklySetsPerMuscle.chest < cut.phases[1].training.weeklySetsPerMuscle.chest);
check('volume = Henselmans formula', cut.phases[1].training.provenance.weeklySetsPerMuscle.value === calc.trainingsvolumeAdvies(2, 0, 1, 1, 2));
check('injury conflicts carried from the intake', cut.injuryConflicts.some(c => c.oefening === 'squat'));
check('unverified rules are listed for review', cut.unverifiedRules.includes('nutr.protein.g_per_kg'));
check('deload policy is reactive (BU Module 7)', cut.phases[0].training.deloads.mode === 'reactive');

const phys = generatePlan({ intake, packageId: 'physique_28', startDate: '2026-10-12', tier: 'premium', registry, now });
check('physique: build 16 / maintain 4 / cut 8', phys.phases.map(p => `${p.type}${p.caps.maxWeeks}`).join() === 'build16,maintain4,cut8');
check('physique: 7 billing blocks', phys.package.billing.blocks === 7);
check('build > maintain > cut kcal', phys.phases[0].nutrition.restDay.kcal > phys.phases[1].nutrition.restDay.kcal && phys.phases[1].nutrition.restDay.kcal > phys.phases[2].nutrition.restDay.kcal);

const withSettings = generatePlan({ intake, instellingen: { eiwitFactor: 2.0, energiebalansFactor: 0.6 }, packageId: 'cut_cycle_32', startDate: '2026-10-12', tier: 'basis', registry, now });
check('coach intake settings apply and are logged as overrides', withSettings.phases[0].nutrition.restDay.proteinG === 168 && withSettings.overrides.some(o => o.path === 'settings.eiwitFactor'));
check('a global energiebalansFactor setting does not flatten the phases', withSettings.phases[0].nutrition.settingsUsed.energiebalansFactor === 0.8);

check('unknown package is rejected', throws(() => generatePlan({ intake, packageId: 'nope', startDate: '2026-10-12', tier: 'medium', registry })));
check('unknown tier is rejected', throws(() => generatePlan({ intake, packageId: 'cut_cycle_32', startDate: '2026-10-12', tier: 'gold', registry })));
check('bad start date is rejected', throws(() => generatePlan({ intake, packageId: 'cut_cycle_32', startDate: '12-10-2026', tier: 'medium', registry })));

// ── Lifecycle ───────────────────────────────────────────────────────────────
const edited = lifecycle.applyOverride(cut, { path: 'phases[0].nutrition.restDay.kcal', value: 2400, by: 'coach', reason: 'adherence', at: now });
check('override changes the value', edited.phases[0].nutrition.restDay.kcal === 2400);
check('override is logged with from/to', edited.overrides.at(-1).from === cut.phases[0].nutrition.restDay.kcal && edited.overrides.at(-1).to === 2400);
check('original plan is untouched', cut.phases[0].nutrition.restDay.kcal !== 2400);
check('cut target can be set', lifecycle.applyOverride(cut, { path: 'phases[0].endCriteria.any[0].value', value: 78, by: 'coach' }).phases[0].endCriteria.any[0].value === 78);
check('provenance cannot be edited', throws(() => lifecycle.applyOverride(cut, { path: 'phases[0].nutrition.provenance.kcal.value', value: 1, by: 'coach' }), 'plan.field_not_editable'));
check('dates cannot be edited', throws(() => lifecycle.applyOverride(cut, { path: 'phases[0].plannedStart', value: '2026-01-01', by: 'coach' }), 'plan.field_not_editable'));
check('wrong type is rejected', throws(() => lifecycle.applyOverride(cut, { path: 'phases[0].nutrition.restDay.kcal', value: 'lots', by: 'coach' }), 'plan.field_type'));

const approved = lifecycle.approve(edited, { by: 'coach', at: now });
check('approve: draft → approved', approved.status === 'approved' && approved.approval.approvedBy === 'coach');
check('editing an approved plan sends it back to draft', lifecycle.applyOverride(approved, { path: 'phases[1].nutrition.restDay.kcal', value: 2700, by: 'coach' }).status === 'draft');
check('publish needs approval', throws(() => lifecycle.publish(edited, {}), 'plan.not_approved'));
const published = lifecycle.publish(approved, { at: now });
check('publish: approved → published', published.status === 'published' && published.approval.publishedAt);
check('a published plan cannot be edited', throws(() => lifecycle.applyOverride(published, { path: 'phases[0].nutrition.restDay.kcal', value: 1, by: 'coach' }), 'plan.not_editable'));

let p = published;
const inMonth1 = new Date('2026-10-20T10:00:00Z');
p = lifecycle.recordAdjustment(p, { type: 'phase_transition', at: inMonth1 });
p = lifecycle.recordAdjustment(p, { type: 'phase_transition', at: inMonth1 });
p = lifecycle.recordAdjustment(p, { type: 'adhoc_client', at: inMonth1 });
const q = lifecycle.adjustmentQuota(p, registry, inMonth1);
check('phase transitions never count toward the quota', q.used === 1);
check('medium tier: cap 2, 1 left', q.cap === 2 && q.remaining === 1);
check('quota resets in the next 4-week block', lifecycle.adjustmentQuota(p, registry, new Date('2026-11-10T10:00:00Z')).used === 0);
check('basis tier has no ad-hoc adjustments', lifecycle.adjustmentQuota(withSettings, registry, inMonth1).remaining === 0);
check('premium tier is unlimited', lifecycle.adjustmentQuota(phys, registry, inMonth1).remaining === null);

for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.label}`);
const failed = results.filter(r => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
