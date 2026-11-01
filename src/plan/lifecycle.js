// Plan lifecycle: coach overrides (logged), approval, publication, and the
// adjustment ledger with per-tier quotas.
//
//   draft ──approve──▶ approved ──publish──▶ published
//     ▲                   │
//     └──── any override ─┘   (an edit after approval needs a new approval)
//
// Only a published plan is ever mirrored to the client.
'use strict';

const schema = require('./schema');

const ADJUSTMENT_TYPES = ['adhoc_client', 'coach_initiated', 'phase_transition', 'correction'];

function planError(code, message) {
  return Object.assign(new Error(message), { code });
}

// Every manual change on a /2 plan carries the coach's reason.
function requireReason(reason) {
  if (typeof reason !== 'string' || !reason.trim()) throw planError('plan.reason_required', 'Give a reason for this change; it is kept in the plan’s change log.');
}

function clone(plan) {
  return JSON.parse(JSON.stringify(plan));
}

// "phases[0].nutrition.restDay.kcal" → ['phases', 0, 'nutrition', 'restDay', 'kcal']
function parsePath(path) {
  if (typeof path !== 'string' || !/^[A-Za-z]\w*(\[\d+\]|\.[A-Za-z]\w*)*$/.test(path)) return null;
  return path.split(/\.|\[|\]/).filter(Boolean).map(seg => (/^\d+$/.test(seg) ? Number(seg) : seg));
}

// The coach may change targets and labels inside phases, but not identity,
// provenance, dates or the audit trail itself.
const EDITABLE_PREFIXES = [
  ['phases', '*', 'nutrition', 'restDay'],
  ['phases', '*', 'nutrition', 'trainingDay'],
  ['phases', '*', 'training', 'weeklySetsPerMuscle'],
  ['phases', '*', 'training', 'progression'],
  ['phases', '*', 'training', 'deloads'],
  ['phases', '*', 'recovery'],
  ['phases', '*', 'endCriteria'],
  ['phases', '*', 'caps'],
];

function isEditable(segments) {
  return EDITABLE_PREFIXES.some(prefix => prefix.every((p, i) => p === '*' ? Number.isInteger(segments[i]) : segments[i] === p)
    && segments.length > prefix.length);
}

function applyOverride(plan, { path, value, by, reason, at = new Date() }) {
  if (plan.status === 'published' || plan.status === 'superseded') {
    throw Object.assign(new Error('A published plan cannot be edited; create a new version.'), { code: 'plan.not_editable' });
  }
  const segments = parsePath(path);
  if (!segments || !isEditable(segments)) {
    throw Object.assign(new Error(`Field "${path}" cannot be edited.`), { code: 'plan.field_not_editable' });
  }
  const next = clone(plan);
  let parent = next;
  for (const seg of segments.slice(0, -1)) {
    parent = parent?.[seg];
    if (parent === undefined || parent === null || typeof parent !== 'object') {
      throw Object.assign(new Error(`Field "${path}" does not exist.`), { code: 'plan.field_missing' });
    }
  }
  const leaf = segments[segments.length - 1];
  if (!(leaf in parent)) throw Object.assign(new Error(`Field "${path}" does not exist.`), { code: 'plan.field_missing' });
  const from = parent[leaf];
  const sameKind = (from === null || value === null) || typeof from === typeof value;
  if (!sameKind || (typeof value === 'number' && !Number.isFinite(value))) {
    throw Object.assign(new Error(`Field "${path}" expects a ${typeof from}.`), { code: 'plan.field_type' });
  }
  if (next.schema === schema.PLAN_SCHEMA) requireReason(reason);
  parent[leaf] = value;
  next.overrides = [...(next.overrides || []), { at: at.toISOString(), by, path, from, to: value, reason: reason || '' }];
  if (next.schema === schema.PLAN_SCHEMA) {
    const phase = Number.isInteger(segments[1]) ? next.phases[segments[1]] : null;
    if (phase && segments[2] === 'caps' && segments[3] === 'maxWeeks') phase.weeks = value;
    if (phase && segments[2] === 'nutrition') phase.nutrition.source = 'coach';
    schema.derive(next);
  }
  if (next.status === 'approved') {
    next.status = 'draft';
    next.approval = { ...next.approval, approvedAt: null, approvedBy: null };
  }
  return next;
}

function approve(plan, { by, at = new Date() }) {
  if (plan.status !== 'draft') throw Object.assign(new Error('Only a draft can be approved.'), { code: 'plan.not_draft' });
  const next = clone(plan);
  next.status = 'approved';
  next.approval = { ...next.approval, approvedAt: at.toISOString(), approvedBy: by };
  return next;
}

function publish(plan, { at = new Date() }) {
  if (plan.status !== 'approved') throw Object.assign(new Error('Approve the plan before publishing it.'), { code: 'plan.not_approved' });
  const next = clone(plan);
  next.status = 'published';
  next.approval = { ...next.approval, publishedAt: at.toISOString() };
  return next;
}

// ── Adjustments ─────────────────────────────────────────────────────────────
// Only ad-hoc requests from the client count toward the tier's monthly cap.
// A phase-transition re-plan NEVER counts, whatever the caller passes.
function recordAdjustment(plan, { type, at = new Date(), note = '', billingMonth }) {
  if (!ADJUSTMENT_TYPES.includes(type)) throw Object.assign(new Error(`Unknown adjustment type: ${type}`), { code: 'plan.adjustment_type' });
  const next = clone(plan);
  next.adjustments = [...(next.adjustments || []), {
    id: `adj_${at.getTime().toString(36)}_${(next.adjustments || []).length + 1}`,
    at: at.toISOString(),
    type,
    countsTowardQuota: type === 'adhoc_client',
    billingMonth: billingMonth || billingMonthFor(plan, at),
    note,
  }];
  return next;
}

// Billing months run in 4-week blocks from the package start date.
function billingMonthFor(plan, at = new Date()) {
  const start = Date.parse(`${plan.package.billing.startDate}T00:00:00Z`);
  const blockMs = plan.package.billing.blockWeeks * 7 * 86400000;
  return Math.max(0, Math.floor((at.getTime() - start) / blockMs)) + 1;
}

function adjustmentQuota(plan, registry, at = new Date()) {
  const caps = registry.params('pkg.tier.adjustment_caps').caps;
  const cap = caps[plan.package.tier];
  const month = billingMonthFor(plan, at);
  const used = (plan.adjustments || []).filter(a => a.countsTowardQuota && a.type === 'adhoc_client' && a.billingMonth === month).length;
  return { tier: plan.package.tier, billingMonth: month, cap, used, remaining: cap === null ? null : Math.max(0, cap - used) };
}

// ── Structural edits (plan/2) ───────────────────────────────────────────────
// ops: [{ op, ... }], one reason for the batch. Each op lands in overrides[]
// as { at, by, op, phaseId, from, to, reason }. Phases stay contiguous; dates
// and start weeks are re-derived after every op.

const NUTRITION_LIMITS = { kcal: [800, 6000], proteinG: [0, 400], carbG: [0, 1000], fatG: [0, 300] };

function findPhase(plan, phaseId) {
  const i = plan.phases.findIndex(p => p.phaseId === phaseId);
  if (i === -1) throw planError('plan.phase_missing', `Phase "${phaseId}" does not exist.`);
  return i;
}

function intIn(value, min, max, label) {
  if (!Number.isInteger(value) || value < min || value > max) throw planError('plan.invalid_op', `${label} must be a whole number from ${min} to ${max}.`);
  return value;
}

function phaseSummary(p) {
  return { type: p.type, weeks: p.weeks, goalText: p.goalText };
}

function nextPhaseId(plan) {
  const max = plan.phases.reduce((m, p) => Math.max(m, Number(String(p.phaseId).replace(/\D/g, '')) || 0), 0);
  return `ph${max + 1}`;
}

function applyOp(plan, op, log) {
  switch (op && op.op) {
    case 'addPhase': {
      if (plan.phases.length >= schema.MAX_PHASES) throw planError('plan.invalid_op', `A plan has at most ${schema.MAX_PHASES} phases.`);
      if (!schema.PHASE_TYPES.includes(op.type)) throw planError('plan.invalid_op', `Phase type must be one of ${schema.PHASE_TYPES.join(', ')}.`);
      const weeks = intIn(op.weeks, 1, schema.MAX_WEEKS_PER_PHASE, 'Weeks');
      const after = op.afterPhaseId ? findPhase(plan, op.afterPhaseId) : plan.phases.length - 1;
      // The editor may name the new phase so later ops in the same batch can point at it.
      let phaseId = nextPhaseId(plan);
      if (op.phaseId !== undefined) {
        if (typeof op.phaseId !== 'string' || !/^ph[a-z0-9_-]{1,24}$/i.test(op.phaseId) || plan.phases.some(p => p.phaseId === op.phaseId)) {
          throw planError('plan.invalid_op', 'phaseId must look like "ph…" and be new.');
        }
        phaseId = op.phaseId;
      }
      const phase = schema.newPhase({ phaseId, type: op.type, weeks, goalText: String(op.goalText || '').slice(0, 300), like: plan.phases[after] });
      plan.phases.splice(after + 1, 0, phase);
      log({ op: 'addPhase', phaseId: phase.phaseId, from: null, to: phaseSummary(phase) });
      return;
    }
    case 'removePhase': {
      const i = findPhase(plan, op.phaseId);
      if (plan.phases.length === 1) throw planError('plan.invalid_op', 'A plan needs at least one phase.');
      const [gone] = plan.phases.splice(i, 1);
      log({ op: 'removePhase', phaseId: gone.phaseId, from: phaseSummary(gone), to: null });
      return;
    }
    case 'movePhase': {
      const i = findPhase(plan, op.phaseId);
      const to = intIn(op.toIndex, 0, plan.phases.length - 1, 'toIndex');
      const [p] = plan.phases.splice(i, 1);
      plan.phases.splice(to, 0, p);
      log({ op: 'movePhase', phaseId: p.phaseId, from: i, to });
      return;
    }
    case 'setPhase': {
      const p = plan.phases[findPhase(plan, op.phaseId)];
      const from = phaseSummary(p);
      if (op.type !== undefined) {
        if (!schema.PHASE_TYPES.includes(op.type)) throw planError('plan.invalid_op', `Phase type must be one of ${schema.PHASE_TYPES.join(', ')}.`);
        p.type = op.type;
        p.goal = schema.GOAL_BY_TYPE[op.type];
        // A bodyweight target only makes sense for a cut.
        if (op.type !== 'cut') p.endCriteria.any = (p.endCriteria.any || []).filter(c => c.kind !== 'target');
      }
      if (op.weeks !== undefined) p.weeks = intIn(op.weeks, 1, schema.MAX_WEEKS_PER_PHASE, 'Weeks');
      if (op.goalText !== undefined) p.goalText = String(op.goalText || '').slice(0, 300);
      log({ op: 'setPhase', phaseId: p.phaseId, from, to: phaseSummary(p) });
      return;
    }
    case 'setNutrition': {
      const p = plan.phases[findPhase(plan, op.phaseId)];
      const dayTypes = op.dayType === 'both' ? ['trainingDay', 'restDay'] : [op.dayType];
      if (!dayTypes.every(d => d === 'trainingDay' || d === 'restDay')) throw planError('plan.invalid_op', 'dayType must be trainingDay, restDay or both.');
      const values = {};
      for (const [key, [min, max]] of Object.entries(NUTRITION_LIMITS)) {
        if (op[key] === undefined) continue;
        const v = op[key];
        if (v !== null && (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max)) throw planError('plan.invalid_op', `${key} must be between ${min} and ${max}.`);
        values[key] = v === null ? null : Math.round(v * 10) / 10;
      }
      if (!Object.keys(values).length) throw planError('plan.invalid_op', 'Send at least one of kcal, proteinG, carbG, fatG.');
      dayTypes.forEach(d => {
        const before = { ...(p.nutrition[d] || schema.emptyDay()) };
        p.nutrition[d] = { ...before, ...values };
        // A value the import suggested counts as the coach's once they change it.
        if (Array.isArray(p.nutrition.suggested)) {
          p.nutrition.suggested = p.nutrition.suggested.filter(s => {
            const [dt, key] = s.split('.');
            return !(dt === d && key in values && values[key] !== before[key]);
          });
        }
        log({ op: 'setNutrition', phaseId: p.phaseId, dayType: d, from: before, to: { ...p.nutrition[d] } });
      });
      p.nutrition.source = 'coach';
      return;
    }
    case 'removeAttachment': {
      if (!plan.attachment) throw planError('plan.invalid_op', 'This plan has no attached file.');
      log({ op: 'removeAttachment', from: plan.attachment.fileName, to: null });
      delete plan.attachment;
      return;
    }
    case 'linkProgram': {
      const p = plan.phases[findPhase(plan, op.phaseId)];
      const from = p.training.programRef || null;
      if (op.programId === null || op.programId === '') {
        p.training.programRef = null;
      } else {
        // The route resolves the program from the coach's library and passes it as op.program.
        if (!op.program || typeof op.program.name !== 'string') throw planError('plan.program_missing', 'That program is not in your library.');
        p.training.programRef = {
          programId: String(op.programId),
          name: op.program.name,
          rev: op.program.rev || null,
          weekOffset: op.weekOffset === undefined ? 0 : intIn(op.weekOffset, 0, 51, 'Week offset'),
        };
      }
      log({ op: 'linkProgram', phaseId: p.phaseId, from, to: p.training.programRef });
      return;
    }
    case 'setStart': {
      if (!schema.isIsoDate(op.startDate) || new Date(`${op.startDate}T00:00:00Z`).getUTCDay() !== 1) {
        throw planError('plan.invalid_op', 'The plan starts on a Monday (YYYY-MM-DD).');
      }
      log({ op: 'setStart', from: plan.startDate, to: op.startDate });
      plan.startDate = op.startDate;
      return;
    }
    default:
      throw planError('plan.invalid_op', `Unknown op "${op && op.op}".`);
  }
}

function applyOps(plan, ops, { by, reason, at = new Date() }) {
  if (plan.status === 'published' || plan.status === 'superseded') {
    throw planError('plan.not_editable', 'A published plan cannot be edited; make a new version.');
  }
  requireReason(reason);
  if (!Array.isArray(ops) || !ops.length || ops.length > 50) throw planError('plan.invalid_payload', 'Send 1–50 ops.');
  const next = schema.upgradePlan(plan);
  const entries = [];
  const log = entry => entries.push({ at: at.toISOString(), by, ...entry, reason: reason.trim().slice(0, 500) });
  ops.forEach(op => { applyOp(next, op, log); schema.derive(next); });
  next.overrides = [...(next.overrides || []), ...entries];
  if (next.status === 'approved') {
    next.status = 'draft';
    next.approval = { ...next.approval, approvedAt: null, approvedBy: null };
  }
  return next;
}

/** A new draft version of a published plan; publishing it supersedes this one. */
function revise(plan, { by, newPlanId, at = new Date() }) {
  if (plan.status !== 'published') throw planError('plan.not_published', 'Only a published plan can get a new version.');
  const next = schema.upgradePlan(plan);
  next.planId = newPlanId;
  next.status = 'draft';
  next.version = (plan.version || 1) + 1;
  next.supersedes = plan.planId;
  delete next.programs; // snapshotted again when this version is published
  next.approval = { generatedAt: at.toISOString(), generatedBy: `revision of ${plan.planId}`, approvedAt: null, approvedBy: null, publishedAt: null };
  next.overrides = [...(next.overrides || []), { at: at.toISOString(), by, op: 'revise', from: plan.planId, to: newPlanId, reason: `New version ${next.version}` }];
  return next;
}

module.exports = {
  applyOverride, applyOps, revise, approve, publish, recordAdjustment, adjustmentQuota, billingMonthFor, parsePath,
  ADJUSTMENT_TYPES, NUTRITION_LIMITS,
};
