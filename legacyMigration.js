// Phase 2: copies one legacy Airtable user's data into their new Firestore uid.
// Called once, from POST /auth/signup-complete, only when the signer proved
// ownership of the legacy username by verifying their old password.
//
// Scope note: Workouts/Programs (WorkoutJSON/ProgramData) are migrated for
// correctness, but as of the Phase 2 audit those two Airtable tables hold
// almost no real data for any user — actual workout/program history lives in
// each browser's localStorage and never made it to Airtable. This migration
// cannot recover that; it only carries over what already exists server-side
// (Templates, macro targets/logs, bodyweight, measurements, cardio, crossfit,
// mobility, daily missions, and — if the user is a coach — their roster).
'use strict';

function safeParseJson(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

async function migrateLegacyUserData({ username, uid, base, db, FieldValue, escapeAirtableFormulaValue }) {
  const safeUsername = escapeAirtableFormulaValue(username);
  const filter = `{Username}='${safeUsername}'`;
  const counts = {};
  const errors = {};
  let isCoach = false;

  async function migrateSimpleTable(tableName, collectionPath, mapFields) {
    try {
      const records = await base(tableName).select({ filterByFormula: filter, pageSize: 100 }).all();
      await Promise.all(records.map(r =>
        db.collection(collectionPath).doc(r.id).set(mapFields(r), { merge: true })
      ));
      counts[tableName] = records.length;
    } catch (err) {
      errors[tableName] = err.message;
      console.error(`[LegacyMigration] ${tableName} failed for uid ${uid}:`, err.message);
    }
  }

  // ── Templates: title/date/log[] blob, schema drifted over time (some
  // entries have dropsetArray/restPauseArray/etc. that others don't) — store
  // the parsed blob as-is rather than forcing a rigid shape.
  await migrateSimpleTable('Templates', `users/${uid}/templates`, r => ({
    name: r.get('TemplateName') || 'Untitled Template',
    templateData: safeParseJson(r.get('TemplateData'), null),
    migratedFrom: r.id
  }));

  // ── Workouts: WorkoutJSON packs an entire session (sets) into one blob.
  // Explode into a sets subcollection per the schema doc's design. In
  // practice this table is nearly empty (see module note above) — this
  // exists for correctness if/when it does hold data.
  try {
    const records = await base('Workouts').select({ filterByFormula: filter, pageSize: 100 }).all();
    for (const r of records) {
      const workout = safeParseJson(r.get('WorkoutJSON'), {});
      const workoutRef = db.collection(`users/${uid}/workouts`).doc(r.id);
      await workoutRef.set({
        date: r.get('Date') || null,
        title: r.get('Title') || 'Workout',
        sessionVolume: r.get('SessionVolume') ?? null,
        migratedFrom: r.id
      }, { merge: true });
      const sets = Array.isArray(workout.sets)
        ? workout.sets
        : Array.isArray(workout.exercises)
          ? workout.exercises.flatMap(ex => Array.isArray(ex.sets) ? ex.sets.map(s => ({ ...s, exerciseName: s.exerciseName || ex.exercise || ex.name })) : [])
          : [];
      await Promise.all(sets.map((s, i) =>
        workoutRef.collection('sets').doc(String(i)).set({
          exerciseName: s.exerciseName || s.exercise || null,
          weight: s.weight ?? null,
          reps: s.reps ?? null,
          rpe: s.rpe ?? null,
          setNumber: s.setNumber ?? i + 1
        })
      ));
    }
    counts.Workouts = records.length;
  } catch (err) {
    errors.Workouts = err.message;
    console.error(`[LegacyMigration] Workouts failed for uid ${uid}:`, err.message);
  }

  // ── Programs: ProgramData blob shape unconfirmed (empty in every sampled
  // record) — store parsed as-is alongside the known outer fields.
  await migrateSimpleTable('Programs', `users/${uid}/programs`, r => ({
    name: r.get('ProgramName') || 'Unnamed',
    startDate: r.get('StartDate') || null,
    isActive: r.get('IsActive') || false,
    programData: safeParseJson(r.get('ProgramData'), null),
    migratedFrom: r.id
  }));

  // ── MacroTargets: single set of numbers per user, not a history — fields
  // directly on the user doc rather than a subcollection (small/bounded).
  try {
    const records = await base('MacroTargets').select({ filterByFormula: filter, maxRecords: 1 }).firstPage();
    if (records.length) {
      const r = records[0];
      await db.collection('users').doc(uid).set({
        macroTargets: {
          calories: r.get('Calories') ?? null,
          protein: r.get('Protein') ?? null,
          fat: r.get('Fat') ?? null,
          carbs: r.get('Carbs') ?? null
        }
      }, { merge: true });
      counts.MacroTargets = 1;
    } else {
      counts.MacroTargets = 0;
    }
  } catch (err) {
    errors.MacroTargets = err.message;
  }

  await migrateSimpleTable('DailyMacros', `users/${uid}/dailyMacros`, r => ({
    date: r.get('Date') || null,
    calories: r.get('Calories') ?? null,
    proteinGrams: r.get('ProteinGrams') ?? null,
    carbGrams: r.get('CarbGrams') ?? null,
    fatGrams: r.get('FatGrams') ?? null,
    type: r.get('Type') || null,
    logData: safeParseJson(r.get('LogData'), null),
    migratedFrom: r.id
  }));

  await migrateSimpleTable('BodyweightLog', `users/${uid}/bodyweightArchives`, r => ({
    periodStart: r.get('PeriodStart') || null,
    periodEnd: r.get('PeriodEnd') || null,
    startWeightKg: r.get('StartWeightKg') ?? null,
    endWeightKg: r.get('EndWeightKg') ?? null,
    avgWeightKg: r.get('AvgWeightKg') ?? null,
    weightChangeKg: r.get('WeightChangeKg') ?? null,
    kgPerWeek: r.get('KgPerWeek') ?? null,
    caloriesDelta: r.get('CaloriesDelta') ?? null,
    entryCount: r.get('EntryCount') ?? null,
    entries: safeParseJson(r.get('EntriesJson'), []),
    archivedAt: r.get('ArchivedAt') || null,
    migratedFrom: r.id
  }));

  await migrateSimpleTable('BodyMeasurements', `users/${uid}/measurements`, r => ({
    date: r.get('Date') || null,
    neck: r.get('Neck') ?? null,
    shoulders: r.get('Shoulders') ?? null,
    chest: r.get('Chest') ?? null,
    waist: r.get('Waist') ?? null,
    hips: r.get('Hips') ?? null,
    arm: r.get('Arm') ?? null,
    thigh: r.get('Thigh') ?? null,
    syncedAt: r.get('SyncedAt') || null,
    migratedFrom: r.id
  }));

  await migrateSimpleTable('CardioLog', `users/${uid}/cardioLogs`, r => ({
    date: r.get('Date') || null,
    type: r.get('Type') || null,
    duration: r.get('Duration') ?? null,
    distance: r.get('Distance') ?? null,
    calories: r.get('Calories') ?? null,
    estimatedCalories: r.get('EstimatedCalories') ?? null,
    met: r.get('MET') ?? null,
    notes: r.get('Notes') || '',
    syncedAt: r.get('SyncedAt') || null,
    migratedFrom: r.id
  }));

  await migrateSimpleTable('CrossFitLog', `users/${uid}/crossfitLogs`, r => ({
    date: r.get('Date') || null,
    workoutName: r.get('WorkoutName') || null,
    minutes: r.get('Minutes') ?? null,
    seconds: r.get('Seconds') ?? null,
    rounds: r.get('Rounds') ?? null,
    notes: r.get('Notes') || '',
    exercises: safeParseJson(r.get('ExercisesJson'), []),
    syncedAt: r.get('SyncedAt') || null,
    migratedFrom: r.id
  }));

  // DailyMissionState is keyed by UserId, not Username, but this app has no
  // separate user-id system pre-Firebase — UserId is populated with the
  // username string by the existing PUT /api/bodybuilding/daily-mission route.
  try {
    const records = await base('DailyMissionState')
      .select({ filterByFormula: `{UserId}='${safeUsername}'`, pageSize: 100 }).all();
    await Promise.all(records.map(r =>
      db.collection(`users/${uid}/dailyMissions`).doc(r.id).set({
        date: r.get('Date') || null,
        state: safeParseJson(r.get('StateJson'), null),
        updatedAt: r.get('UpdatedAt') || null,
        migratedFrom: r.id
      }, { merge: true })
    ));
    counts.DailyMissionState = records.length;
  } catch (err) {
    errors.DailyMissionState = err.message;
  }

  // Only self-created routines migrate here — coach-assigned ones belong to
  // the assigning coach's own migration and need a cross-account reference
  // this pass doesn't build yet (known gap, see PHASE2-NOTES.md).
  await migrateSimpleTable('MobilityRoutines', `users/${uid}/mobilityRoutines`, r => ({
    routineId: r.get('RoutineId') || null,
    name: r.get('Name') || '',
    type: r.get('Type') || '',
    targetArea: r.get('TargetArea') || '',
    frequencyPerWeek: r.get('FrequencyPerWeek') ?? null,
    exercises: safeParseJson(r.get('Exercises'), []),
    assignedByCoach: r.get('AssignedByCoach') || false,
    coachNotes: r.get('CoachNotes') || '',
    createdAt: r.get('CreatedAt') || null,
    migratedFrom: r.id
  }));

  await migrateSimpleTable('MobilitySessions', `users/${uid}/mobilitySessions`, r => ({
    sessionId: r.get('SessionId') || null,
    routineId: r.get('RoutineId') || null,
    completedAt: r.get('CompletedAt') || null,
    notes: r.get('Notes') || '',
    migratedFrom: r.id
  }));

  // ── Coach roster: if this legacy username was ever used as a CoachId,
  // this account is a coach — migrate their roster and flag isCoach so the
  // caller can update custom claims accordingly.
  try {
    const records = await base('CoachClients')
      .select({ filterByFormula: `{CoachId}='${safeUsername}'`, pageSize: 100 }).all();
    if (records.length) {
      isCoach = true;
      await Promise.all(records.map(r =>
        db.collection(`coaches/${uid}/clients`).doc(r.id).set({
          athleteUid: null, // legacy ClientId is an Airtable id, not a Firebase uid — resolved when that athlete migrates
          athleteDisplayName: r.get('ClientName') || '',
          email: r.get('Email') || '',
          status: r.get('Status') || 'active',
          trainingMode: r.get('TrainingMode') || '',
          currentProgram: r.get('CurrentProgram') || null,
          lastCheckInAt: r.get('LastCheckIn') || null,
          alertStatus: r.get('AlertStatus') || 'ok',
          nutritionSummary: r.get('NutritionSummary') || '',
          latestCheckInJson: safeParseJson(r.get('LatestCheckInJson'), null),
          migratedFrom: r.id
        }, { merge: true })
      ));
    }
    counts.CoachClients = records.length;
  } catch (err) {
    errors.CoachClients = err.message;
  }

  return { counts, errors, isCoach };
}

module.exports = { migrateLegacyUserData };
