// Plan schema "pocketcoach.plan/2" and the reader for /1.
//
// /2 adds, per phase:
//   type        cut | maintain | build | deload
//   startWeek   1-based plan week the phase starts (derived: phases are contiguous)
//   weeks       length; source of truth for plannedStart/plannedEnd and caps.maxWeeks
//   goalText    the coach's goal in words
//   nutrition.source   'generated' (from the intake) | 'coach' (entered or edited)
//   training.programRef { programId, name, rev, weekOffset } — program week =
//               phase week + weekOffset
// and at plan level startDate (a Monday) and, once published, programs:
// { [programId]: Library-shape snapshot } so library edits never change what
// a client follows until a new version is published.
//
// upgradePlan() reads /1 (stored /1 plans are never rewritten; a /1 draft
// becomes /2 on its first edit). derive() recomputes every date and count
// from startDate + phase order + weeks, and runs after every change.
'use strict';

const PLAN_SCHEMA_V1 = 'pocketcoach.plan/1';
const PLAN_SCHEMA = 'pocketcoach.plan/2';
const PHASE_TYPES = ['cut', 'maintain', 'build', 'deload'];
const GOAL_BY_TYPE = { cut: 'vetverlies', maintain: 'onderhoud', build: 'spieropbouw', deload: 'onderhoud' };
const MAX_WEEKS_PER_PHASE = 52;
const MAX_PHASES = 12;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function addDays(isoDate, days) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function weeksBetween(a, b) {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / (7 * 86400000));
}

function isIsoDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

function emptyDay() {
  return { kcal: null, proteinG: null, carbG: null, fatG: null };
}

/** /1 → /2 (a copy); /2 comes back as a copy. */
function upgradePlan(input) {
  if (!input || typeof input !== 'object') return input;
  const plan = clone(input);
  if (plan.schema === PLAN_SCHEMA) return derive(plan);
  plan.schema = PLAN_SCHEMA;
  plan.startDate = plan.startDate || plan.package?.billing?.startDate || plan.phases?.[0]?.plannedStart || null;
  (plan.phases || []).forEach(p => {
    p.weeks = p.weeks || p.caps?.maxWeeks || Math.max(1, weeksBetween(p.plannedStart, addDays(p.plannedEnd, 1)));
    p.goalText = p.goalText || '';
    p.nutrition = p.nutrition || {};
    p.nutrition.source = p.nutrition.source || 'generated';
    p.nutrition.trainingDay = p.nutrition.trainingDay || emptyDay();
    p.nutrition.restDay = p.nutrition.restDay || emptyDay();
    p.training = p.training || {};
    if (p.training.programRef === undefined) p.training.programRef = null;
  });
  return derive(plan);
}

/**
 * Dates, start weeks, order, caps and package totals from startDate + the
 * phase list. Phase dates a phase actually started/ended on (actualStart /
 * actualEnd) are left alone.
 */
function derive(plan) {
  let week = 1;
  (plan.phases || []).forEach((p, i) => {
    p.order = i + 1;
    p.startWeek = week;
    p.caps = { ...(p.caps || {}), maxWeeks: p.weeks };
    if (plan.startDate) {
      p.plannedStart = addDays(plan.startDate, (week - 1) * 7);
      p.plannedEnd = addDays(p.plannedStart, p.weeks * 7 - 1);
    }
    const any = (p.endCriteria?.any || []).filter(c => c.kind !== 'timeCap');
    const cap = (p.endCriteria?.any || []).find(c => c.kind === 'timeCap');
    p.endCriteria = { ...(p.endCriteria || {}), any: [...any, { ...(cap || { kind: 'timeCap', ruleId: 'coach' }), kind: 'timeCap', weeks: p.weeks }] };
    week += p.weeks;
  });
  const total = week - 1;
  if (plan.package) {
    plan.package.totalWeeks = total;
    if (plan.package.billing) {
      plan.package.billing.startDate = plan.startDate || plan.package.billing.startDate;
      plan.package.billing.blocks = Math.ceil(total / (plan.package.billing.blockWeeks || 4));
    }
  }
  return plan;
}

/** A new phase: nutrition and training carried over from `like` (the phase before). */
function newPhase({ phaseId, type, weeks, goalText, like }) {
  const base = like ? clone(like) : null;
  const nutrition = base?.nutrition
    ? { ...base.nutrition, source: 'coach', provenance: undefined, trainingDay: { ...base.nutrition.trainingDay }, restDay: { ...base.nutrition.restDay } }
    : { source: 'coach', trainingDay: emptyDay(), restDay: emptyDay() };
  delete nutrition.provenance;
  const training = base?.training ? { ...base.training, programRef: base.training.programRef ? { ...base.training.programRef } : null } : { programRef: null };
  delete training.provenance;
  return {
    phaseId,
    type,
    goal: GOAL_BY_TYPE[type],
    goalText: goalText || '',
    weeks,
    actualStart: null,
    actualEnd: null,
    caps: { maxWeeks: weeks },
    endCriteria: { any: [{ kind: 'timeCap', weeks, ruleId: 'coach' }] },
    nutrition,
    training,
    recovery: base?.recovery ? clone(base.recovery) : {},
    redFlags: [],
  };
}

/** A plan without an intake: the package's phases, nutrition left for the coach. */
function blankPlan({ registry, packageId, startDate, tier, client = {}, now = new Date(), planId }) {
  let pkg;
  try { pkg = registry.params(`pkg.${packageId}`); } catch { throw new Error(`Unknown package: ${packageId}`); }
  if (!isIsoDate(startDate)) throw new Error('startDate must be YYYY-MM-DD');
  const caps = registry.params('pkg.tier.adjustment_caps').caps;
  if (!(tier in caps)) throw new Error(`Unknown tier: ${tier}`);
  const plan = {
    schema: PLAN_SCHEMA,
    planId: planId || `pln_${require('crypto').randomUUID()}`,
    status: 'draft',
    version: 1,
    supersedes: null,
    client: { uid: client.uid || null, coachUid: client.coachUid || null, leadId: null },
    package: { id: packageId, name: pkg.name, tier, totalWeeks: 0, billing: { blockWeeks: pkg.blockWeeks, blocks: 0, startDate } },
    startDate,
    ruleVersion: `pocketcoach-rules@${registry.version}`,
    unverifiedRules: [],
    phases: pkg.phases.map((def, i) => newPhase({ phaseId: `ph${i + 1}`, type: def.type, weeks: def.weeks })),
    overrides: [],
    adjustments: [],
    approval: { generatedAt: now.toISOString(), generatedBy: 'blank', approvedAt: null, approvedBy: null, publishedAt: null },
  };
  return derive(plan);
}

/**
 * A draft from an imported plan document (src/plan/planImport.js
 * sanitizeImported): the coach's own phases and nutrition, no generator.
 * Values the import filled in are kept in phase.nutrition.suggested until
 * the coach edits them.
 */
function planFromImport({ registry, imported, startDate, tier, client = {}, now = new Date(), planId, fileName = '', by = 'coach' }) {
  if (!isIsoDate(startDate)) throw new Error('startDate must be YYYY-MM-DD');
  const caps = registry.params('pkg.tier.adjustment_caps').caps;
  if (!(tier in caps)) throw new Error(`Unknown tier: ${tier}`);
  if (!imported || !Array.isArray(imported.phases) || !imported.phases.length) throw new Error('The imported plan has no phases.');
  const phases = imported.phases.map((p, i) => {
    const phase = newPhase({ phaseId: `ph${i + 1}`, type: p.type, weeks: p.weeks, goalText: p.goalText });
    phase.nutrition = { source: 'coach', trainingDay: { ...p.trainingDay }, restDay: { ...p.restDay }, suggested: p.suggested || [] };
    return phase;
  });
  const plan = {
    schema: PLAN_SCHEMA,
    planId: planId || `pln_${require('crypto').randomUUID()}`,
    status: 'draft',
    version: 1,
    supersedes: null,
    client: { uid: client.uid || null, coachUid: client.coachUid || null, leadId: null },
    package: { id: 'import', name: imported.name || 'Coach plan', tier, totalWeeks: 0, billing: { blockWeeks: 4, blocks: 0, startDate } },
    startDate,
    notes: imported.notes || '',
    ruleVersion: `pocketcoach-rules@${registry.version}`,
    unverifiedRules: [],
    phases,
    overrides: [{ at: now.toISOString(), by, op: 'import', from: null, to: fileName || 'file', reason: `Imported from ${fileName || 'a plan file'}` }],
    adjustments: [],
    approval: { generatedAt: now.toISOString(), generatedBy: 'import', approvedAt: null, approvedBy: null, publishedAt: null },
  };
  return derive(plan);
}

/** The phase whose dates contain `isoDate`, or null. */
function phaseOn(plan, isoDate) {
  return (plan.phases || []).find(p => (p.actualStart || p.plannedStart) <= isoDate && isoDate <= (p.actualEnd || p.plannedEnd)) || null;
}

module.exports = {
  PLAN_SCHEMA, PLAN_SCHEMA_V1, PHASE_TYPES, GOAL_BY_TYPE, MAX_WEEKS_PER_PHASE, MAX_PHASES,
  upgradePlan, derive, newPhase, blankPlan, planFromImport, phaseOn, addDays, isIsoDate, emptyDay,
};
