// Master plans: the coach generates a DRAFT from a client's intake (or starts
// a blank one from a package), edits it (every edit is logged with a reason),
// approves it, and publishes it. Only a published plan is copied to the
// client; drafts never leave the coach side.
//
// Storage (server-only, see firestore.rules):
//   coaches/{coachUid}/plans/{planId}   the coach's working copy (any status)
//   users/{clientUid}/plans/{planId}    published copies the client can read
//
// Coach routes (mounted at /api/coach/plans, coach plan required):
//   GET    /meta                 registry version, packages, tiers, Butters University status
//   POST   /preview              { clientUid?, leadId | intake, instellingen?, packageId, startDate, tier }
//                                → generated plan, NOT saved
//   POST   /                     same body + clientUid → saves a draft
//                                ({ blank: true } skips the intake: phases from the package, no nutrition)
//   GET    /?clientUid=          the coach's plans (summaries)
//   GET    /:planId              full plan
//   PATCH  /:planId              { changes: [{ path, value, reason }] } and/or
//                                { ops: [{ op, … }], reason } → logged overrides
//                                (ops: addPhase, removePhase, movePhase, setPhase,
//                                setNutrition, linkProgram, setStart; see lifecycle.js)
//   POST   /:planId/approve
//   POST   /:planId/publish      copies it to the client (with a snapshot of each
//                                linked program), supersedes their previous plan
//   POST   /:planId/revise       new draft version of a published plan
// Client route (mounted at /api/client/plan):
//   GET    /                     the client's current published plan, or null
//
// Plans are "pocketcoach.plan/2" (src/plan/schema.js). Stored /1 plans are
// read through upgradePlan(); a /1 draft becomes /2 on its first edit.
'use strict';

const crypto = require('crypto');
const express = require('express');
const { generatePlan } = require('../plan/generator');
const lifecycle = require('../plan/lifecycle');
const schema = require('../plan/schema');
const coachShare = require('../coachShare');

const PLAN_ID_RE = /^pln_[0-9a-f-]{36}$/;
const PROGRAM_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;

function summarize(stored) {
  const plan = schema.upgradePlan(stored);
  return {
    planId: plan.planId,
    schema: plan.schema,
    status: plan.status,
    version: plan.version,
    supersedes: plan.supersedes || null,
    clientUid: plan.client?.uid || null,
    package: { id: plan.package.id, name: plan.package.name, tier: plan.package.tier, totalWeeks: plan.package.totalWeeks },
    startDate: plan.phases[0]?.plannedStart || null,
    endDate: plan.phases.at(-1)?.plannedEnd || null,
    phases: plan.phases.map(p => ({
      phaseId: p.phaseId, type: p.type, startWeek: p.startWeek, weeks: p.weeks,
      plannedStart: p.plannedStart, plannedEnd: p.plannedEnd, programRef: p.training?.programRef || null,
    })),
    unverifiedRules: plan.unverifiedRules?.length || 0,
    buConflicts: plan.butters?.conflicts?.length || 0,
    generatedAt: plan.approval?.generatedAt || null,
    publishedAt: plan.approval?.publishedAt || null,
  };
}

const kcalText = n => (n && n.kcal != null ? `${n.kcal} kcal · P ${n.proteinG} g · F ${n.fatG} g · C ${n.carbG} g` : 'not set');

// Short strings for the existing coach-assignment fields the app already
// shows (currentProgram / nutritionSummary), so older app screens still
// reflect the published plan.
function assignmentFields(plan) {
  const first = plan.phases[0];
  return {
    currentProgram: `${plan.package.name}: ${plan.phases.map(p => `${p.type} ${p.caps.maxWeeks}wk`).join(' → ')} (from ${first.plannedStart})`,
    nutritionSummary: `${first.type}: training day ${kcalText(first.nutrition.trainingDay)} · rest day ${kcalText(first.nutrition.restDay)}`,
  };
}

// What the client gets: their phases, targets, guidance and the program
// snapshots. The override log, rule provenance, red flags, the
// unverified-rule list and the Butters University review stay coach-side.
function clientView(plan) {
  const { overrides, unverifiedRules, butters, inputsSnapshot, injuryConflicts, ...rest } = plan;
  return {
    ...rest,
    phases: plan.phases.map(({ redFlags, ...phase }) => {
      const { provenance: _np, settingsUsed, ...nutrition } = phase.nutrition;
      const { provenance: _tp, ...training } = phase.training;
      return { ...phase, nutrition, training };
    }),
  };
}

function createCoachPlansRouter({ db, FieldValue, registry, sendError, sendSuccess, resolveCallerUid, notifyPlanPublished = async () => {}, now = () => new Date() }) {
  const router = express.Router();

  async function coachUidOr409(req, res) {
    const uid = await resolveCallerUid(req.user);
    if (!uid) sendError(res, 409, 'coach.not_migrated', 'Your account needs to complete migration first. Contact support.');
    return uid;
  }

  async function onRoster(coachUid, clientUid) {
    if (typeof clientUid !== 'string' || !clientUid || clientUid.includes('/')) return false;
    const snap = await db.collection(`coaches/${coachUid}/clients`).doc(clientUid).get();
    return snap.exists;
  }

  async function loadProgram(coachUid, programId) {
    if (typeof programId !== 'string' || !PROGRAM_ID_RE.test(programId)) return null;
    const snap = await db.collection(`coaches/${coachUid}/programs`).doc(programId).get();
    return snap.exists ? snap.data() : null;
  }

  // Builds the generator input from the request: the intake comes from one
  // of the coach's own leads, or (for a quick what-if) straight from the body.
  async function buildInput(coachUid, body) {
    let intake = body.intake;
    let instellingen = body.instellingen || {};
    let leadId = null;
    if (body.leadId) {
      leadId = String(body.leadId);
      if (leadId.includes('/')) throw Object.assign(new Error('Invalid leadId.'), { status: 422, code: 'plan.invalid_lead' });
      const lead = await db.collection(`coaches/${coachUid}/leads`).doc(leadId).get();
      if (!lead.exists) throw Object.assign(new Error('This lead does not exist.'), { status: 404, code: 'plan.lead_not_found' });
      intake = lead.get('intake');
      instellingen = { ...(lead.get('instellingen') || {}), ...(body.instellingen || {}) };
    }
    if (!intake || typeof intake !== 'object') throw Object.assign(new Error('Provide leadId or intake.'), { status: 422, code: 'plan.missing_intake' });
    return { intake, instellingen, leadId };
  }

  function generate(input, body, coachUid, clientUid) {
    try {
      return schema.upgradePlan(generatePlan({
        intake: input.intake,
        instellingen: input.instellingen,
        packageId: body.packageId,
        startDate: body.startDate,
        tier: body.tier,
        client: { uid: clientUid || null, coachUid, leadId: input.leadId },
        registry,
        now: now(),
      }));
    } catch (err) {
      throw Object.assign(err, { status: 422, code: 'plan.invalid_input' });
    }
  }

  function blank(body, coachUid, clientUid) {
    try {
      return schema.blankPlan({ registry, packageId: body.packageId, startDate: body.startDate, tier: body.tier, client: { uid: clientUid, coachUid }, now: now() });
    } catch (err) {
      throw Object.assign(err, { status: 422, code: 'plan.invalid_input' });
    }
  }

  const fail = (res, err, where) => {
    if (err.status) return sendError(res, err.status, err.code, err.message);
    console.error(`${where} failed:`, err);
    return sendError(res, 500, 'plan.server_error', 'Something went wrong with this plan.');
  };

  const save = (own, plan) => own.ref.set({ ...plan, clientUid: own.clientUid, updatedAt: FieldValue.serverTimestamp() });

  router.get('/meta', (_req, res) => {
    const packages = registry.all().filter(r => /^pkg\.(?!phase|tier)/.test(r.id)).map(r => ({
      id: r.id.slice(4), name: r.params.name, blockWeeks: r.params.blockWeeks, phases: r.params.phases,
    }));
    const tiers = registry.params('pkg.tier.adjustment_caps').caps;
    return sendSuccess(res, 200, {
      registryVersion: registry.version, packages, tiers, butters: registry.buttersSummary(),
      phaseTypes: schema.PHASE_TYPES, nutritionLimits: lifecycle.NUTRITION_LIMITS,
    });
  });

  router.post('/preview', async (req, res) => {
    try {
      const coachUid = await coachUidOr409(req, res);
      if (!coachUid) return;
      const body = req.body || {};
      if (body.blank) return sendSuccess(res, 200, { plan: blank(body, coachUid, body.clientUid || null) });
      const input = await buildInput(coachUid, body);
      return sendSuccess(res, 200, { plan: generate(input, body, coachUid, body.clientUid) });
    } catch (err) { return fail(res, err, 'POST /api/coach/plans/preview'); }
  });

  router.post('/', async (req, res) => {
    try {
      const coachUid = await coachUidOr409(req, res);
      if (!coachUid) return;
      const body = req.body || {};
      if (!(await onRoster(coachUid, body.clientUid))) {
        return sendError(res, 404, 'coach.not_linked', 'This client is not linked to your roster.');
      }
      const plan = body.blank ? blank(body, coachUid, body.clientUid) : generate(await buildInput(coachUid, body), body, coachUid, body.clientUid);
      await db.collection(`coaches/${coachUid}/plans`).doc(plan.planId).set({ ...plan, clientUid: body.clientUid, updatedAt: FieldValue.serverTimestamp() });
      return sendSuccess(res, 201, { plan });
    } catch (err) { return fail(res, err, 'POST /api/coach/plans'); }
  });

  router.get('/', async (req, res) => {
    try {
      const coachUid = await coachUidOr409(req, res);
      if (!coachUid) return;
      let query = db.collection(`coaches/${coachUid}/plans`);
      if (typeof req.query.clientUid === 'string' && req.query.clientUid) query = query.where('clientUid', '==', req.query.clientUid);
      const snap = await query.get();
      const plans = snap.docs.map(d => summarize(d.data()))
        .sort((a, b) => String(b.generatedAt).localeCompare(String(a.generatedAt)));
      return sendSuccess(res, 200, { plans });
    } catch (err) { return fail(res, err, 'GET /api/coach/plans'); }
  });

  async function loadOwn(req, res) {
    const coachUid = await coachUidOr409(req, res);
    if (!coachUid) return null;
    const planId = String(req.params.planId || '');
    if (!PLAN_ID_RE.test(planId)) { sendError(res, 422, 'plan.invalid_id', 'Invalid plan id.'); return null; }
    const ref = db.collection(`coaches/${coachUid}/plans`).doc(planId);
    const snap = await ref.get();
    if (!snap.exists) { sendError(res, 404, 'plan.not_found', 'This plan does not exist.'); return null; }
    const { updatedAt, clientUid, ...plan } = snap.data();
    return { coachUid, ref, plan: schema.upgradePlan(plan), clientUid };
  }

  router.get('/:planId', async (req, res) => {
    try {
      const own = await loadOwn(req, res);
      if (!own) return;
      return sendSuccess(res, 200, { plan: own.plan });
    } catch (err) { return fail(res, err, 'GET /api/coach/plans/:planId'); }
  });

  router.patch('/:planId', async (req, res) => {
    try {
      const own = await loadOwn(req, res);
      if (!own) return;
      const changes = Array.isArray(req.body?.changes) ? req.body.changes : [];
      const ops = Array.isArray(req.body?.ops) ? req.body.ops : [];
      if ((!changes.length && !ops.length) || changes.length > 50 || ops.length > 50) {
        return sendError(res, 422, 'plan.invalid_payload', 'Send 1–50 changes as { path, value, reason } and/or 1–50 ops with a reason.');
      }
      // linkProgram: the program must be in this coach's library.
      for (const op of ops) {
        if (op && op.op === 'linkProgram' && op.programId) {
          const program = await loadProgram(own.coachUid, op.programId);
          if (!program) return sendError(res, 404, 'plan.program_missing', 'That program is not in your library.');
          op.program = { name: program.name, rev: program.updatedAt || null };
        }
      }
      let plan = own.plan;
      try {
        for (const c of changes) {
          plan = lifecycle.applyOverride(plan, { path: c.path, value: c.value, reason: typeof c.reason === 'string' ? c.reason.slice(0, 500) : '', by: req.user.username, at: now() });
        }
        if (ops.length) plan = lifecycle.applyOps(plan, ops, { by: req.user.username, reason: req.body.reason, at: now() });
      } catch (err) {
        return sendError(res, err.code === 'plan.not_editable' ? 409 : 422, err.code || 'plan.invalid_change', err.message);
      }
      await save(own, plan);
      return sendSuccess(res, 200, { plan });
    } catch (err) { return fail(res, err, 'PATCH /api/coach/plans/:planId'); }
  });

  router.post('/:planId/approve', async (req, res) => {
    try {
      const own = await loadOwn(req, res);
      if (!own) return;
      let plan;
      try { plan = lifecycle.approve(own.plan, { by: req.user.username, at: now() }); }
      catch (err) { return sendError(res, 409, err.code, err.message); }
      await save(own, plan);
      return sendSuccess(res, 200, { plan });
    } catch (err) { return fail(res, err, 'POST /api/coach/plans/:planId/approve'); }
  });

  router.post('/:planId/revise', async (req, res) => {
    try {
      const own = await loadOwn(req, res);
      if (!own) return;
      let plan;
      try { plan = lifecycle.revise(own.plan, { by: req.user.username, newPlanId: `pln_${crypto.randomUUID()}`, at: now() }); }
      catch (err) { return sendError(res, 409, err.code, err.message); }
      await db.collection(`coaches/${own.coachUid}/plans`).doc(plan.planId).set({ ...plan, clientUid: own.clientUid, updatedAt: FieldValue.serverTimestamp() });
      return sendSuccess(res, 201, { plan });
    } catch (err) { return fail(res, err, 'POST /api/coach/plans/:planId/revise'); }
  });

  router.post('/:planId/publish', async (req, res) => {
    try {
      const own = await loadOwn(req, res);
      if (!own) return;
      if (!(await onRoster(own.coachUid, own.clientUid))) {
        return sendError(res, 404, 'coach.not_linked', 'This client is no longer linked to your roster.');
      }
      const missing = own.plan.phases.find(p => ['trainingDay', 'restDay'].some(d => p.nutrition?.[d]?.kcal == null));
      if (missing) {
        return sendError(res, 409, 'plan.nutrition_missing', `Set training-day and rest-day nutrition for every phase first (phase ${missing.order}, ${missing.type}).`);
      }
      let plan;
      try { plan = lifecycle.publish(own.plan, { at: now() }); }
      catch (err) { return sendError(res, 409, err.code, err.message); }

      // Snapshot each linked program as the client will follow it.
      const programs = {};
      for (const p of plan.phases) {
        const ref = p.training?.programRef;
        if (!ref || programs[ref.programId]) continue;
        const stored = await loadProgram(own.coachUid, ref.programId);
        if (!stored) return sendError(res, 409, 'plan.program_missing', `"${ref.name}" is no longer in your library. Link another program first.`);
        programs[ref.programId] = coachShare.toClientProgram(stored, { coachUsername: req.user.username, programId: ref.programId, rev: stored.updatedAt || null });
        ref.rev = stored.updatedAt || null;
        ref.name = stored.name || ref.name;
      }
      plan.programs = programs;

      // The client's previous published plan from this coach is superseded.
      const clientPlans = db.collection(`users/${own.clientUid}/plans`);
      const previous = await clientPlans.where('status', '==', 'published').get();
      const batch = db.batch();
      for (const doc of previous.docs) {
        if (doc.get('client')?.coachUid !== own.coachUid) continue;
        batch.set(doc.ref, { status: 'superseded' }, { merge: true });
        batch.set(db.collection(`coaches/${own.coachUid}/plans`).doc(doc.id), { status: 'superseded' }, { merge: true });
        if (!plan.supersedes) plan.supersedes = doc.id;
        plan.version = Math.max(plan.version || 1, (Number(doc.get('version')) || 1) + 1);
      }
      const fields = assignmentFields(plan);
      // Older app builds only know coachAssignment.program: give them the
      // first phase's program so their Start button follows the plan too.
      const firstRef = plan.phases.find(p => p.training?.programRef)?.training.programRef;
      const programFields = firstRef ? { program: programs[firstRef.programId], currentProgramId: firstRef.programId } : {};
      batch.set(own.ref, { ...plan, clientUid: own.clientUid, updatedAt: FieldValue.serverTimestamp() });
      batch.set(clientPlans.doc(plan.planId), clientView(plan));
      batch.set(db.collection(`coaches/${own.coachUid}/clients`).doc(own.clientUid), { ...fields, ...(firstRef ? { currentProgramId: firstRef.programId } : {}), currentPlanId: plan.planId, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
      batch.set(db.collection(`users/${own.clientUid}/coachAssignment`).doc(own.coachUid), { coachUsername: req.user.username, ...fields, ...programFields, currentPlanId: plan.planId, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
      await batch.commit();
      await notifyPlanPublished({ coachUsername: req.user.username, clientUid: own.clientUid, fields }).catch(err =>
        console.warn('[plans] publish notification failed:', err.message));
      return sendSuccess(res, 200, { plan });
    } catch (err) { return fail(res, err, 'POST /api/coach/plans/:planId/publish'); }
  });

  return router;
}

function createClientPlanRouter({ db, sendError, sendSuccess, resolveCallerUid }) {
  const router = express.Router();
  router.get('/', async (req, res) => {
    try {
      const uid = await resolveCallerUid(req.user);
      if (!uid) return sendSuccess(res, 200, { plan: null });
      const snap = await db.collection(`users/${uid}/plans`).where('status', '==', 'published').get();
      const plans = snap.docs.map(d => d.data())
        .sort((a, b) => String(b.approval?.publishedAt).localeCompare(String(a.approval?.publishedAt)));
      return sendSuccess(res, 200, { plan: plans[0] ? schema.upgradePlan(plans[0]) : null });
    } catch (err) {
      console.error('GET /api/client/plan failed:', err);
      return sendError(res, 500, 'plan.server_error', 'Could not load your plan.');
    }
  });
  return router;
}

module.exports = { createCoachPlansRouter, createClientPlanRouter, summarize, assignmentFields, clientView };
