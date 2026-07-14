// Full-server test harness for Phase 2 route conversions (see PHASE2-NOTES.md).
//
// Mocks firebase.js's `db` via require.cache injection and authenticates
// with a locally-signed legacy-style JWT — this bypasses the
// email_verified gate that otherwise blocks testing protected routes
// without a real inbox to click a verification link from. Because
// resolveFirestoreUid() only cares about the username (looked up in the
// mocked usernames collection), this lets you deterministically exercise
// both the "migrated" (Firestore) and "not migrated" (Airtable fallback)
// branches for any route, with no live network calls at all.
//
// Run: node scripts/test-firestore-routes.js
//
// To test a newly-converted route, add request/assert blocks following the
// existing MacroTargets/Templates examples below, and pre-seed `store` with
// whatever Firestore documents that route's Firestore branch expects to read.
const path = require('path');
const http = require('http');

process.env.JWT_SECRET = 'test-secret-for-route-conversion-check';
process.env.AIRTABLE_TOKEN = 'fake-token';
process.env.AIRTABLE_BASE_ID = 'fakeBaseId';
const TEST_PORT = 39871;
process.env.PORT = String(TEST_PORT);

const BACKEND_DIR = path.join(__dirname, '..');
const firebasePath = path.join(BACKEND_DIR, 'firebase.js');

// ── Fake Firestore ───────────────────────────────────────────────────────────
const store = {}; // collectionPath -> { docId -> data }
function docRefFor(colPath, docId) {
  return {
    id: docId,
    async get() {
      const data = store[colPath][docId];
      return { exists: !!data, get: (f) => data?.[f], data: () => data };
    },
    async set(data, opts) {
      store[colPath][docId] = opts?.merge ? { ...(store[colPath][docId] || {}), ...data } : data;
    },
    async delete() { delete store[colPath][docId]; }
  };
}
function collection(colPath) {
  store[colPath] = store[colPath] || {};
  const filters = [];
  const api = {
    doc(id) {
      const docId = id || `auto_${Math.random().toString(36).slice(2, 8)}`;
      return docRefFor(colPath, docId);
    },
    async get() { // naive: ignores orderBy direction, applies == filters only
      let entries = Object.entries(store[colPath] || {});
      for (const [field, value] of filters) {
        entries = entries.filter(([, data]) => data?.[field] === value);
      }
      const docs = entries.map(([id, data]) => ({
        id, get: (f) => data[f], data: () => data, ref: docRefFor(colPath, id)
      }));
      return { docs };
    },
    orderBy() { return this; },
    where(field, op, value) { filters.push([field, value]); return this; }
  };
  return api;
}
const fakeDb = { collection };

require.cache[require.resolve(firebasePath)] = {
  id: firebasePath, filename: firebasePath, loaded: true,
  exports: { auth: {}, db: fakeDb, FieldValue: { serverTimestamp: () => 'TS' }, firebaseEnabled: true, projectId: 'test-project', initError: null }
};

// Pre-seed: "migrateduser" has completed signup-complete (usernames doc exists)
store['usernames'] = { migrateduser: { uid: 'uidABC123' } };
store['users'] = {};

const jwt = require(path.join(BACKEND_DIR, 'node_modules/jsonwebtoken'));
const legacyTokenMigrated = jwt.sign({ id: 'rec1', username: 'migrateduser' }, process.env.JWT_SECRET);
const legacyTokenUnmigrated = jwt.sign({ id: 'rec2', username: 'legacyonlyuser' }, process.env.JWT_SECRET);

require(path.join(BACKEND_DIR, 'server.js')); // self-listens on process.env.PORT

setTimeout(() => {
  const port = TEST_PORT;

  function req(method, urlPath, token, body) {
    return new Promise((resolve, reject) => {
      const data = body ? JSON.stringify(body) : null;
      const r = http.request({
        method, port, path: urlPath, headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {})
        }
      }, res => {
        let chunks = '';
        res.on('data', c => chunks += c);
        res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(chunks) }); } catch { resolve({ status: res.statusCode, body: chunks }); } });
      });
      r.on('error', reject);
      if (data) r.write(data);
      r.end();
    });
  }

  (async () => {
    const results = [];
    const check = (label, cond) => results.push({ label, pass: !!cond });

    // ── MacroTargets: migrated user → Firestore ──
    let r = await req('POST', '/macrotargets', legacyTokenMigrated, { calories: 2500, protein: 180, fat: 70, carbs: 250 });
    check('POST /macrotargets (migrated) 200', r.status === 200);
    check('POST /macrotargets (migrated) wrote to Firestore', store['users']['uidABC123']?.macroTargets?.calories === 2500);

    r = await req('GET', '/macrotargets', legacyTokenMigrated);
    check('GET /macrotargets (migrated) 200', r.status === 200);
    check('GET /macrotargets (migrated) returns Airtable-shaped fields', r.body?.item?.Calories === 2500 && r.body?.item?.Protein === 180);

    // ── MacroTargets: unmigrated user → falls through to Airtable branch ──
    // (will fail against the real Airtable API since AIRTABLE_TOKEN is fake —
    // that's expected and fine: we're only checking it did NOT take the
    // Firestore branch, i.e. store stays untouched for this user)
    r = await req('POST', '/macrotargets', legacyTokenUnmigrated, { calories: 999 });
    check('POST /macrotargets (unmigrated) did not write Firestore', !store['users']['uidABC123'] || store['users']['uidABC123'].macroTargets.calories === 2500);
    check('POST /macrotargets (unmigrated) fell through (not a Firestore 200 with recordId=uid)', !(r.status === 200 && r.body?.recordId === 'uidABC123'));

    // ── Templates: migrated user → Firestore CRUD ──
    r = await req('POST', '/templates', legacyTokenMigrated, { templateName: 'Push Day', templateData: { log: [{ exercise: 'Bench' }] } });
    check('POST /templates (migrated) 200', r.status === 200);
    const createdId = r.body?.record?.id;
    check('POST /templates (migrated) returned an id', !!createdId);
    check('POST /templates (migrated) wrote to Firestore', !!store[`users/uidABC123/templates`]?.[createdId]);

    r = await req('GET', '/templates', legacyTokenMigrated);
    check('GET /templates (migrated) 200', r.status === 200);
    check('GET /templates (migrated) lists the created template', r.body?.items?.some(i => i.id === createdId && i.name === 'Push Day'));
    const item = r.body?.items?.find(i => i.id === createdId);
    check('GET /templates (migrated) data field is a JSON string', typeof item?.data === 'string' && JSON.parse(item.data).log[0].exercise === 'Bench');

    r = await req('DELETE', `/templates/${createdId}`, legacyTokenMigrated);
    check('DELETE /templates/:id (migrated) 200', r.status === 200);
    check('DELETE /templates/:id (migrated) removed from Firestore', !store[`users/uidABC123/templates`]?.[createdId]);

    r = await req('DELETE', '/templates/doesnotexist', legacyTokenMigrated);
    check('DELETE /templates/:id (migrated, missing) 404', r.status === 404);

    // ── DailyLogs (dailyMacros) ──
    r = await req('POST', '/dailylogs', legacyTokenMigrated, { date: '2026-07-01', CaloriesTotal: 2600, ProteinTotal: 190 });
    check('POST /dailylogs (migrated) 201', r.status === 201);
    check('POST /dailylogs (migrated) wrote to Firestore', Object.values(store['users/uidABC123/dailyMacros'] || {}).some(d => d.calories === 2600));

    r = await req('GET', '/dailylogs?username=migrateduser', legacyTokenMigrated);
    check('GET /dailylogs (migrated) 200', r.status === 200);
    check('GET /dailylogs (migrated) reshapes to Airtable-style fields', r.body?.records?.some(rec => rec.Calories === 2600 && rec.ProteinGrams === 190));

    // ── Bodyweight ──
    r = await req('POST', '/bodyweight/archive', legacyTokenMigrated, { periodStart: '2026-06-01', periodEnd: '2026-06-28', entries: [{ date: '2026-06-01', weightKg: 80 }, { date: '2026-06-28', weightKg: 79 }] });
    check('POST /bodyweight/archive (migrated) 201', r.status === 201);
    check('POST /bodyweight/archive (migrated) wrote to Firestore', Object.values(store['users/uidABC123/bodyweightArchives'] || {}).some(d => d.startWeightKg === 80 && d.endWeightKg === 79));

    r = await req('GET', '/bodyweight?username=migrateduser', legacyTokenMigrated);
    check('GET /bodyweight (migrated) 200', r.status === 200);
    check('GET /bodyweight (migrated) lists archive', r.body?.items?.some(i => i.startWeightKg === 80));

    // ── Measurements ──
    r = await req('POST', '/measurements/sync', legacyTokenMigrated, { entries: [{ date: '2026-06-01', waist: 85 }] });
    check('POST /measurements/sync (migrated) 201', r.status === 201);
    check('POST /measurements/sync (migrated) wrote to Firestore', Object.values(store['users/uidABC123/measurements'] || {}).some(d => d.waist === 85));

    r = await req('GET', '/measurements?username=migrateduser', legacyTokenMigrated);
    check('GET /measurements (migrated) 200', r.status === 200);
    check('GET /measurements (migrated) lists entry', r.body?.items?.some(i => i.waist === 85));

    // ── Cardio ──
    r = await req('POST', '/cardio/sync', legacyTokenMigrated, { entries: [{ date: '2026-06-01', type: 'Run', duration: 30 }] });
    check('POST /cardio/sync (migrated) 201', r.status === 201);
    check('POST /cardio/sync (migrated) wrote to Firestore', Object.values(store['users/uidABC123/cardioLogs'] || {}).some(d => d.type === 'Run' && d.duration === 30));

    r = await req('GET', '/cardio?username=migrateduser', legacyTokenMigrated);
    check('GET /cardio (migrated) 200', r.status === 200);
    check('GET /cardio (migrated) lists entry', r.body?.items?.some(i => i.type === 'Run'));

    // ── CrossFit ──
    r = await req('POST', '/crossfit/sync', legacyTokenMigrated, { entries: [{ date: '2026-06-01', name: 'Fran', minutes: 5, exercises: [{ name: 'Thrusters' }] }] });
    check('POST /crossfit/sync (migrated) 201', r.status === 201);
    check('POST /crossfit/sync (migrated) wrote to Firestore', Object.values(store['users/uidABC123/crossfitLogs'] || {}).some(d => d.workoutName === 'Fran'));

    r = await req('GET', '/crossfit?username=migrateduser', legacyTokenMigrated);
    check('GET /crossfit (migrated) 200', r.status === 200);
    check('GET /crossfit (migrated) lists entry with exercises array', r.body?.items?.some(i => i.workoutName === 'Fran' && i.exercises?.[0]?.name === 'Thrusters'));

    // ── Programs ──
    r = await req('POST', '/programs', legacyTokenMigrated, { program: { name: 'PPL', startDate: '2026-06-01' } });
    check('POST /programs (migrated) 201', r.status === 201);
    const programId = r.body?.recordId;
    check('POST /programs (migrated) returned an id', !!programId);
    check('POST /programs (migrated) wrote to Firestore', !!store['users/uidABC123/programs']?.[programId]);

    r = await req('GET', '/programs', legacyTokenMigrated);
    check('GET /programs (migrated) 200', r.status === 200);
    check('GET /programs (migrated) lists the created program', r.body?.items?.some(i => i.id === programId && i.name === 'PPL'));

    r = await req('PATCH', `/programs/${programId}/active`, legacyTokenMigrated, {});
    check('PATCH /programs/:id/active (migrated) 200', r.status === 200);
    check('PATCH /programs/:id/active (migrated) set isActive', store['users/uidABC123/programs']?.[programId]?.isActive === true);

    r = await req('PATCH', '/programs/doesnotexist/active', legacyTokenMigrated, {});
    check('PATCH /programs/:id/active (migrated, missing) 404', r.status === 404);

    r = await req('DELETE', `/programs/${programId}`, legacyTokenMigrated);
    check('DELETE /programs/:id (migrated) 200', r.status === 200);
    check('DELETE /programs/:id (migrated) removed from Firestore', !store['users/uidABC123/programs']?.[programId]);

    // ── Daily mission ──
    r = await req('PUT', '/api/bodybuilding/daily-mission/migrateduser', legacyTokenMigrated, { streak: 5 });
    check('PUT /daily-mission (migrated) 200', r.status === 200);
    check('PUT /daily-mission (migrated) saved:true', r.body?.saved === true);
    check('PUT /daily-mission (migrated) wrote to Firestore', Object.values(store['users/uidABC123/dailyMissions'] || {}).some(d => d.state?.streak === 5));

    // Upsert: same day again should update the same doc, not create a second one
    const missionCountBefore = Object.keys(store['users/uidABC123/dailyMissions'] || {}).length;
    r = await req('PUT', '/api/bodybuilding/daily-mission/migrateduser', legacyTokenMigrated, { streak: 6 });
    const missionCountAfter = Object.keys(store['users/uidABC123/dailyMissions'] || {}).length;
    check('PUT /daily-mission (migrated) upserts same day', missionCountAfter === missionCountBefore && Object.values(store['users/uidABC123/dailyMissions']).some(d => d.state?.streak === 6));

    // ── Mobility routines + sessions ──
    r = await req('POST', '/mobility/routines', legacyTokenMigrated, { name: 'Hip mobility', exercises: [{ name: 'Cossack squat' }] });
    check('POST /mobility/routines (migrated) 201', r.status === 201);
    const routineId = r.body?.recordId;
    check('POST /mobility/routines (migrated) wrote to Firestore', !!store['users/uidABC123/mobilityRoutines']?.[routineId]);

    r = await req('GET', '/mobility/routines?username=migrateduser', legacyTokenMigrated);
    check('GET /mobility/routines (migrated) 200', r.status === 200);
    check('GET /mobility/routines (migrated) lists routine', r.body?.items?.some(i => i.id === routineId && i.name === 'Hip mobility'));

    r = await req('DELETE', `/mobility/routines/${routineId}`, legacyTokenMigrated);
    check('DELETE /mobility/routines/:id (migrated) 200', r.status === 200);
    check('DELETE /mobility/routines/:id (migrated) removed', !store['users/uidABC123/mobilityRoutines']?.[routineId]);

    r = await req('POST', '/mobility/sessions', legacyTokenMigrated, { routineId: 'r1', notes: 'felt good' });
    check('POST /mobility/sessions (migrated) 201', r.status === 201);
    check('POST /mobility/sessions (migrated) wrote to Firestore', Object.values(store['users/uidABC123/mobilitySessions'] || {}).some(d => d.notes === 'felt good'));

    r = await req('GET', '/mobility/sessions?username=migrateduser', legacyTokenMigrated);
    check('GET /mobility/sessions (migrated) 200', r.status === 200);
    check('GET /mobility/sessions (migrated) lists session', r.body?.items?.some(i => i.notes === 'felt good'));

    // ── Coach clients ──
    store['coaches/uidABC123/clients'] = { rec1: { athleteDisplayName: 'Alice', email: 'a@x.com', status: 'active' } };
    r = await req('GET', '/api/coach/clients?coachId=migrateduser', legacyTokenMigrated);
    check('GET /api/coach/clients (migrated) 200', r.status === 200);
    check('GET /api/coach/clients (migrated) lists roster', r.body?.clients?.some(c => c.clientName === 'Alice' && c.email === 'a@x.com'));

    console.log('\n=== RESULTS ===');
    for (const { label, pass } of results) console.log((pass ? 'PASS' : 'FAIL') + ' - ' + label);
    const failed = results.filter(r => !r.pass);
    console.log(`\n${results.length - failed.length}/${results.length} passed`);
    process.exit(failed.length ? 1 : 0);
  })().catch(e => { console.error('TEST THREW:', e); process.exit(1); });
}, 1500);
