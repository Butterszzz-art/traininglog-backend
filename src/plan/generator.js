// Master plan generator: intake + package → a DRAFT plan (schema
// "pocketcoach.plan/1") with dated phases, per-phase nutrition, training
// volume, progression/deload policy, recovery flags and per-field rule
// provenance. Nothing here is shown to a client: a draft only reaches the
// client after the coach approves and publishes it (see routes in server.js).
//
// The maths is ClientIntake's (src/intakeCalculations.js, generated from
// ClientIntake/calculations.js — the source of truth). The registry
// (rules/*.json) supplies the parameters it runs with, so changing a rule
// changes the plan without touching any formula.
'use strict';

const crypto = require('crypto');
const calc = require('../intakeCalculations');

const PLAN_SCHEMA = 'pocketcoach.plan/1';
const GENERATOR = 'plan-generator@1';
const MUSCLES = ['chest', 'back', 'shoulders', 'biceps', 'triceps', 'quads', 'hamstrings', 'glutes', 'calves'];
// Intake settings that apply to every phase. energiebalansFactor is left
// out on purpose: it is phase-specific (cut vs build) and comes from the
// registry per phase.
const GLOBAL_SETTING_KEYS = ['trainingsdagenPerWeek', 'trainingsduurMinuten', 'MET', 'pal', 'tef', 'eiwitFactor', 'percentageVetVanREE', 'aantalMaaltijden', 'postTrainingBoost'];

function addDays(isoDate, days) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function isIsoDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

function trainingStatus(registry, years) {
  const { thresholdsYears, statuses } = registry.params('train.status.from_experience');
  const y = Number(years);
  if (!Number.isFinite(y)) return statuses[1];
  const idx = thresholdsYears.findIndex(t => y < t);
  return statuses[idx === -1 ? statuses.length - 1 : idx];
}

function validateInput({ intake, packageId, startDate, tier }, registry) {
  const p = intake?.persoonsgegevens;
  if (!p || typeof p.gewicht !== 'number' || typeof p.vetpercentage !== 'number') {
    throw new Error('intake.persoonsgegevens.gewicht and vetpercentage are required numbers');
  }
  try { registry.get(`pkg.${packageId}`); } catch { throw new Error(`Unknown package: ${packageId}`); }
  if (!isIsoDate(startDate)) throw new Error('startDate must be YYYY-MM-DD');
  const caps = registry.params('pkg.tier.adjustment_caps').caps;
  if (!(tier in caps)) throw new Error(`Unknown tier: ${tier} (expected ${Object.keys(caps).join(', ')})`);
}

function generatePlan({ intake, instellingen = {}, packageId, startDate, tier, client = {}, registry, now = new Date(), planId }) {
  validateInput({ intake, packageId, startDate, tier }, registry);

  const pkg = registry.params(`pkg.${packageId}`);
  const goalMap = registry.params('pkg.phase.goal_map').map;
  const pal = registry.params('nutr.pal.table');
  const tee = registry.params('nutr.training_day.expenditure');
  const used = new Set([`pkg.${packageId}`, 'pkg.phase.goal_map', 'nutr.bmr.method', 'nutr.pal.table', 'nutr.tef.factor',
    'nutr.training_day.expenditure', 'nutr.energy.factor', 'nutr.protein.g_per_kg', 'nutr.fat.pct_ree', 'nutr.meals.count',
    'nutr.meals.post_training_protein', 'train.volume.henselmans', 'train.status.from_experience', 'train.split.by_frequency',
    'train.volume.max_per_session', 'train.progression.scheme', 'train.deload.policy', 'safety.deficit.max',
    'safety.injury.conflicts', 'safety.sleep.min_hours', 'pkg.tier.adjustment_caps']);

  // Registry defaults, then the coach's per-client intake settings on top.
  const registrySettings = {
    pal: (pal.bySex[intake.persoonsgegevens.geslacht] || pal.values)[intake.lifestyle?.activityLevel] ?? pal.values[pal.fallback],
    tef: registry.resolve('nutr.tef.factor').value,
    MET: tee.MET,
    trainingsduurMinuten: tee.minutes,
    eiwitFactor: registry.resolve('nutr.protein.g_per_kg').value,
    percentageVetVanREE: registry.resolve('nutr.fat.pct_ree').value,
    aantalMaaltijden: registry.resolve('nutr.meals.count').value,
    postTrainingBoost: registry.resolve('nutr.meals.post_training_protein').value,
  };
  const coachSettings = {};
  for (const key of GLOBAL_SETTING_KEYS) {
    if (instellingen[key] !== undefined && instellingen[key] !== null) coachSettings[key] = instellingen[key];
  }
  const overrides = Object.entries(coachSettings)
    .filter(([key, value]) => registrySettings[key] !== undefined && registrySettings[key] !== value)
    .map(([key, value]) => ({
      at: now.toISOString(), by: 'coach (intake settings)', path: `settings.${key}`,
      from: registrySettings[key], to: value, reason: 'Per-client setting from the intake (instellingen)',
    }));

  const sessions = coachSettings.trainingsdagenPerWeek ?? intake.trainingsfrequentie?.huidig ?? 3;
  const status = trainingStatus(registry, intake.persoonsgegevens.trainingservaring);
  const female = intake.persoonsgegevens.geslacht === 'vrouw' ? 1 : 0;
  const recovery = registry.params('train.volume.henselmans').recovery.default;
  const split = registry.params('train.split.by_frequency');
  const maxPerSession = registry.params('train.volume.max_per_session').default;
  const progression = registry.params('train.progression.scheme');
  const deload = registry.params('train.deload.policy');
  const sleepMin = registry.params('safety.sleep.min_hours').default;

  let cursor = startDate;
  const phases = pkg.phases.map((def, i) => {
    const goal = goalMap[def.type];
    // Deficit by body fat, surplus by training status (Butters University).
    const energyRange = calc.energiebalansBereik(goal, intake.persoonsgegevens);
    const energy = registry.cite('nutr.energy.factor', energyRange.standaard);
    const settings = { ...registrySettings, ...coachSettings, trainingsdagenPerWeek: sessions, energiebalansFactor: energy.value };
    const result = calc.berekenClient({ ...intake, doel: { ...(intake.doel || {}), categorie: goal } }, settings);

    const splitDef = calc.bepaalSplitsdagen(sessions);
    const muscleFrequency = split.muscleFrequency[String(splitDef.dagen.length)] ?? 2;
    const weeklySets = calc.trainingsvolumeAdvies(status, female, recovery, energy.value, muscleFrequency);
    const setsPerSession = Math.round((weeklySets / muscleFrequency) * 10) / 10;

    const plannedStart = cursor;
    const plannedEnd = addDays(plannedStart, def.weeks * 7 - 1);
    cursor = addDays(plannedEnd, 1);

    const endCriteria = [{ kind: 'timeCap', weeks: def.weeks, ruleId: `pkg.${packageId}` }];
    if (def.type === 'cut') {
      // The target value is the coach's call per client (bodyweight, body
      // fat or waist); the generator only reserves the slot.
      endCriteria.unshift({ kind: 'target', metric: 'bodyweightKg7dAvg', op: '<=', value: null, setBy: 'coach', ruleId: `pkg.${packageId}` });
    }

    const flags = [...result.rodeVlaggen];
    if (setsPerSession > maxPerSession) {
      flags.push({ niveau: 'oranje', bericht: `~${setsPerSession} sets per muscle per session exceeds ~${maxPerSession}: add a training day or lower the volume.`, ruleId: 'train.volume.max_per_session' });
    }

    return {
      phaseId: `ph${i + 1}`,
      order: i + 1,
      type: def.type,
      goal,
      plannedStart,
      plannedEnd,
      actualStart: null,
      actualEnd: null,
      caps: { maxWeeks: def.weeks },
      endCriteria: { any: endCriteria },
      nutrition: {
        maintenanceKcal: result.onderhoudPerDag,
        bmr: result.bmr,
        restDay: { kcal: result.beoogdeInnameRustdag, proteinG: result.macros.eiwit, fatG: result.macros.vet, carbG: result.macros.koolhydratenRustdag },
        trainingDay: { kcal: result.beoogdeInnameTrainingsdag, proteinG: result.macros.eiwit, fatG: result.macros.vet, carbG: result.macros.koolhydratenTrainingsdag },
        ranges: result.bereiken,
        mealSplit: result.maaltijdVerdeling,
        settingsUsed: result.instellingenGebruikt,
        provenance: {
          bmr: registry.cite('nutr.bmr.method', result.bmr),
          pal: registry.cite('nutr.pal.table', settings.pal),
          tef: registry.cite('nutr.tef.factor', settings.tef),
          kcal: energy,
          proteinG: registry.cite('nutr.protein.g_per_kg', settings.eiwitFactor),
          fatG: registry.cite('nutr.fat.pct_ree', settings.percentageVetVanREE),
          mealSplit: registry.cite('nutr.meals.post_training_protein', settings.postTrainingBoost),
        },
      },
      training: {
        split: { ...splitDef, sessionsPerWeek: sessions, muscleFrequency, ruleId: 'train.split.by_frequency' },
        weeklySetsPerMuscle: Object.fromEntries(MUSCLES.map(m => [m, Math.round(weeklySets)])),
        setsPerSession,
        provenance: {
          weeklySetsPerMuscle: { ...registry.cite('train.volume.henselmans', weeklySets), inputs: { status, female, recovery, energyFactor: energy.value, muscleFrequency } },
          status: registry.cite('train.status.from_experience', status),
        },
        progression: { ...progression, ruleId: 'train.progression.scheme' },
        deloads: { ...deload, ruleId: 'train.deload.policy' },
        programRef: null,
      },
      recovery: {
        sleepHoursFlagBelow: sleepMin,
        ruleIds: ['safety.sleep.min_hours'],
      },
      redFlags: flags,
    };
  });

  const totalWeeks = pkg.phases.reduce((n, p) => n + p.weeks, 0);
  const allRules = [...used].map(id => registry.get(id));

  return {
    schema: PLAN_SCHEMA,
    planId: planId || `pln_${crypto.randomUUID()}`,
    status: 'draft',
    version: 1,
    supersedes: null,
    client: { uid: client.uid || null, coachUid: client.coachUid || null, leadId: client.leadId || null },
    package: {
      id: packageId,
      name: pkg.name,
      tier,
      totalWeeks,
      billing: { blockWeeks: pkg.blockWeeks, blocks: Math.ceil(totalWeeks / pkg.blockWeeks), startDate },
    },
    ruleVersion: `pocketcoach-rules@${registry.version}`,
    unverifiedRules: allRules.filter(r => !r.verified).map(r => r.id),
    // How the rules behind this plan stand against Butters University.
    butters: {
      source: registry.butters || null,
      conflicts: allRules.filter(r => r.bu?.status === 'conflict').map(r => ({ ruleId: r.id, note: r.bu.note || '' })),
      partial: allRules.filter(r => r.bu?.status === 'partial').map(r => r.id),
    },
    inputsSnapshot: {
      gewicht: intake.persoonsgegevens.gewicht,
      vetpercentage: intake.persoonsgegevens.vetpercentage,
      geslacht: intake.persoonsgegevens.geslacht || null,
      trainingservaring: intake.persoonsgegevens.trainingservaring ?? null,
      activityLevel: intake.lifestyle?.activityLevel || null,
      trainingsdagenPerWeek: sessions,
      apparatuur: intake.materiaal?.apparatuur || [],
    },
    injuryConflicts: calc.detecteerBlessureConflicten(intake.blessures),
    phases,
    overrides,
    adjustments: [],
    approval: { generatedAt: now.toISOString(), generatedBy: GENERATOR, approvedAt: null, approvedBy: null, publishedAt: null },
  };
}

module.exports = { generatePlan, addDays, PLAN_SCHEMA, MUSCLES };
