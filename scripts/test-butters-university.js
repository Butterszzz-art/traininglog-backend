// Tests for the Butters University connector (src/rules/butters.js) and the
// BU references in the rule registry.
// Run: node scripts/test-butters-university.js
// With BU_README=<path to butters-university/README.md> it also checks every
// rule's quotes against the real README.
'use strict';

const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const bu = require(path.join(root, 'src', 'rules', 'butters'));
const { createRegistry, loadRegistry, validateRule } = require(path.join(root, 'src', 'rules', 'registry'));
const { generatePlan } = require(path.join(root, 'src', 'plan', 'generator'));
const { clientView, summarize } = require(path.join(root, 'src', 'routes', 'plans'));

const results = [];
const check = (label, cond) => results.push({ label, pass: !!cond });

// ── Parsing and matching on a small README ──────────────────────────────────
const readme = [
  '# Hub',
  '',
  '# Module: Energy balance',
  '',
  '### Estimating energy expenditure',
  'TEF is typically 10% as a population average, costed at \\~0.1 kcal/kg/min of',
  'active training time.',
  '',
  '```',
  '# not a heading',
  '```',
  '# Module: Protein',
  '**Practical synthesis**: eat 1.6–2.2 g/kg.',
].join('\n');
const parsed = bu.sections(readme);

check('headings are found with their level and line', parsed.heads.some(h => h.title === 'Module: Energy balance' && h.level === 1 && h.line === 3));
check('a heading inside a code fence is ignored', !parsed.heads.some(h => h.title === 'not a heading'));
check('a section ends before the next heading of the same level', bu.findSection(parsed, 'Module: Energy balance').end === 11);
check('a nested heading stays inside its parent section', bu.findSection(parsed, 'Estimating energy expenditure').end === 11);
check('section titles match regardless of case and spacing', !!bu.findSection(parsed, '  module:  ENERGY balance '));
check('normalize drops markdown escapes and emphasis', bu.normalize('**Bold** \\~0.1') === 'bold ~0.1');
check('normalize treats en dashes as hyphens', bu.normalize('1.6–2.2') === bu.normalize('1.6-2.2'));

const energy = bu.findSection(parsed, 'Module: Energy balance');
check('a quote is found on its line', bu.findQuote(parsed, energy, 'typically 10% as a population average') === 6);
check('a quote spanning two lines is found where it starts', bu.findQuote(parsed, energy, '0.1 kcal/kg/min of active training time') === 6);
check('an escaped tilde in the README still matches', bu.findQuote(parsed, energy, '~0.1 kcal/kg/min') === 6);
check('a quote from another section is not found', bu.findQuote(parsed, energy, 'eat 1.6-2.2 g/kg') === null);

const rule = (id, b) => ({ id, bu: b });
const report = bu.checkRegistry([
  rule('nutr.tef.factor', { section: 'Module: Energy balance', status: 'match', quotes: ['typically 10% as a population average'] }),
  rule('nutr.protein.g_per_kg', { section: 'Module: Protein', status: 'match', quotes: ['eat 1.6-2.2 g/kg', 'no benefit above 1.6'] }),
  rule('nutr.gone', { section: 'Module: Carbohydrates', status: 'partial', quotes: ['x'] }),
  { id: 'pkg.cut_cycle_32' },
], readme);
check('a rule whose quotes are all present has no problem', report[0].problem === null && report[0].line === 3);
check('a reworded quote is reported as missing', report[1].missing.length === 1 && report[1].missing[0] === 'no benefit above 1.6');
check('a removed section is reported', report[2].problem === 'section not found');
check('a rule without a BU reference is not a problem', report[3].problem === null && report[3].status === null);

// ── Validation ──────────────────────────────────────────────────────────────
const base = { id: 'nutr.x', version: 1, domain: 'nutrition', statement: 's', params: {}, evidenceGrade: 'unrated', sources: [], verified: false };
check('a valid bu block passes', validateRule({ ...base, bu: { section: 'S', status: 'match', quotes: ['q'] } }).length === 0);
check('an unknown bu status is rejected', validateRule({ ...base, bu: { section: 'S', status: 'maybe', quotes: ['q'] } }).length > 0);
check('a conflict without a quote is rejected', validateRule({ ...base, bu: { section: 'S', status: 'conflict', quotes: [] } }).length > 0);
check('not_covered needs no quote', validateRule({ ...base, bu: { section: 'S', status: 'not_covered', quotes: [] } }).length === 0);
check('bu.section is required', validateRule({ ...base, bu: { status: 'match', quotes: ['q'] } }).length > 0);

// ── The registry ────────────────────────────────────────────────────────────
const registry = createRegistry();
const evidenceRules = registry.all().filter(r => r.domain !== 'package');
check('every non-package rule points at Butters University', evidenceRules.every(r => r.bu && r.moduleRef && r.moduleRef.startsWith('BU: ')));
check('the BU commit is pinned', /^[0-9a-f]{40}$/.test(registry.butters?.commit || '') && registry.butters.repo === 'Butterszzz-art/butters-university');
check('no rule marks itself verified on the strength of the connector', evidenceRules.every(r => r.verified === false));
const summary = registry.buttersSummary();
check('the summary groups rules by BU status', summary.match.includes('nutr.bmr.method') && summary.not_covered.includes('train.status.from_experience'));
check('no rule conflicts with or only partly matches Butters University', summary.conflict.length === 0 && summary.partial.length === 0);

// ── Plans carry the review; clients never see it ────────────────────────────
const intake = {
  persoonsgegevens: { naam: 'Ana', gewicht: 84, vetpercentage: 18, geslacht: 'man', trainingservaring: 3 },
  doel: { categorie: 'vetverlies' },
  trainingsfrequentie: { huidig: 4 },
  blessures: { tekst: '', vermijdenOefeningen: [] },
  lifestyle: { activityLevel: 'actief', stressLevel: 'gemiddeld', slaap: { uren: 7 } },
};
const plan = generatePlan({ intake, packageId: 'cut_cycle_32', startDate: '2026-10-12', tier: 'medium', registry, now: new Date('2026-10-04T08:00:00Z') });
check('a plan built on matching rules lists no conflicts or partial matches', plan.butters.partial.length === 0 && plan.butters.conflicts.length === 0);
// A registry where one rule conflicts with BU: the plan must surface it.
const loaded = loadRegistry();
const rules = new Map(loaded.rules);
const pal = rules.get('nutr.pal.table');
rules.set(pal.id, { ...pal, bu: { ...pal.bu, status: 'conflict', note: 'test conflict' } });
const conflicted = generatePlan({ intake, packageId: 'cut_cycle_32', startDate: '2026-10-12', tier: 'medium', registry: createRegistry({ ...loaded, rules }), now: new Date('2026-10-04T08:00:00Z') });
check('a plan lists the BU conflicts among the rules it used', conflicted.butters.conflicts.some(c => c.ruleId === 'nutr.pal.table' && c.note === 'test conflict'));
check('a plan records the BU commit it was checked against', plan.butters.source.commit === registry.butters.commit);
check('the coach summary counts BU conflicts', summarize(conflicted).buConflicts === 1 && summarize(plan).buConflicts === 0);
check('the client view leaves the BU review out', !('butters' in clientView(plan)));

// ── The real README, when available ─────────────────────────────────────────
const real = process.env.BU_README;
if (real) {
  const live = bu.checkRegistry(registry.all(), fs.readFileSync(real, 'utf8'));
  const broken = live.filter(r => r.problem);
  check(`every cited section and quote is in ${real}`, broken.length === 0);
  for (const r of broken) console.log(`  ${r.id}: ${r.problem}${r.missing.length ? ` — ${r.missing.join(' | ')}` : ''}`);
}

let failed = 0;
for (const r of results) {
  console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.label}`);
  if (!r.pass) failed++;
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
