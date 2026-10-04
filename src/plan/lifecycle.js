// Plan lifecycle: coach overrides (logged), approval, publication, and the
// adjustment ledger with per-tier quotas.
//
//   draft ──approve──▶ approved ──publish──▶ published
//     ▲                   │
//     └──── any override ─┘   (an edit after approval needs a new approval)
//
// Only a published plan is ever mirrored to the client.
'use strict';

const ADJUSTMENT_TYPES = ['adhoc_client', 'coach_initiated', 'phase_transition', 'correction'];

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
  parent[leaf] = value;
  next.overrides = [...(next.overrides || []), { at: at.toISOString(), by, path, from, to: value, reason: reason || '' }];
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

module.exports = { applyOverride, approve, publish, recordAdjustment, adjustmentQuota, billingMonthFor, parsePath, ADJUSTMENT_TYPES };
