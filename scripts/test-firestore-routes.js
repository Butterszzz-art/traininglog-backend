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
    __colPath: colPath,
    async get() {
      const data = store[colPath][docId];
      return { exists: !!data, get: (f) => data?.[f], data: () => data };
    },
    async set(data, opts) {
      store[colPath][docId] = opts?.merge ? { ...(store[colPath][docId] || {}), ...data } : data;
    },
    async delete() { delete store[colPath][docId]; },
    collection(subPath) { return collection(`${colPath}/${docId}/${subPath}`); }
  };
}
function collection(colPath) {
  store[colPath] = store[colPath] || {};
  const filters = [];
  let limitN = null;
  const api = {
    doc(id) {
      const docId = id || `auto_${Math.random().toString(36).slice(2, 8)}`;
      return docRefFor(colPath, docId);
    },
    async get() { // naive: ignores orderBy direction, applies == filters + limit only
      let entries = Object.entries(store[colPath] || {});
      for (const [field, value] of filters) {
        entries = entries.filter(([, data]) => data?.[field] === value);
      }
      if (limitN != null) entries = entries.slice(0, limitN);
      const docs = entries.map(([id, data]) => ({
        id, get: (f) => data[f], data: () => data, ref: docRefFor(colPath, id)
      }));
      return { docs, empty: docs.length === 0 };
    },
    orderBy() { return this; },
    where(field, op, value) { filters.push([field, value]); return this; },
    limit(n) { limitN = n; return this; }
  };
  return api;
}
function batch() {
  const ops = [];
  return {
    set(docRef, data, opts) { ops.push(() => docRef.set(data, opts)); return this; },
    delete(docRef) { ops.push(() => docRef.delete()); return this; },
    async commit() { for (const op of ops) await op(); }
  };
}
// Minimal recursiveDelete: removes the doc itself plus every collection this
// harness has created under it (docRefFor's .collection() names them
// `${parentColPath}/${docId}/${subName}`, so a simple path-prefix match finds
// all of them without needing a real Firestore tree walk).
async function recursiveDelete(docRef) {
  const prefix = `${docRef.__colPath}/${docRef.id}`;
  if (store[docRef.__colPath]) delete store[docRef.__colPath][docRef.id];
  for (const key of Object.keys(store)) {
    if (key === prefix || key.startsWith(`${prefix}/`)) delete store[key];
  }
}
const fakeDb = { collection, batch, recursiveDelete };

require.cache[require.resolve(firebasePath)] = {
  id: firebasePath, filename: firebasePath, loaded: true,
  exports: {
    // getUser/setCustomUserClaims/deleteUser: minimal stubs so
    // applyEntitlement() and DELETE /account can run end-to-end here too,
    // not just the Firestore-only routes the rest of this harness covers.
    auth: {
      getUser: async () => ({ customClaims: {} }),
      setCustomUserClaims: async () => {},
      deleteUser: async () => {}
    },
    db: fakeDb, FieldValue: { serverTimestamp: () => 'TS' }, firebaseEnabled: true, projectId: 'test-project', initError: null
  }
};

// Mock the 'airtable' package too — verifyCoachClientLink() deliberately
// always checks Airtable's CoachClients table regardless of migration status
// (that relationship isn't in Firestore yet), so testing /coach/workouts
// needs a controllable fake link result rather than a real network call.
const airtablePath = require.resolve('airtable', { paths: [BACKEND_DIR] });
class FakeAirtable {
  base() {
    return (tableName) => ({
      select() {
        return {
          async firstPage() {
            if (tableName === 'CoachClients') {
              // always "linked", and resolves to the migrated coach so
              // GET /exercise-videos's cross-coach lookup can reach Firestore
              const fields = { CoachId: 'migrateduser' };
              return [{ id: 'link1', fields, get: (f) => fields[f] }];
            }
            return [];
          },
          all: async () => []
        };
      }
    });
  }
}
require.cache[airtablePath] = { id: airtablePath, filename: airtablePath, loaded: true, exports: FakeAirtable };

// Pre-seed: "migrateduser" has completed signup-complete (usernames doc exists)
store['usernames'] = { migrateduser: { uid: 'uidABC123' }, clientuser: { uid: 'uidClient456' }, deleteuser: { uid: 'uidDelete789' } };
store['users'] = { uidABC123: { username: 'migrateduser', referralCode: 'REFCODE1' }, uidDelete789: { username: 'deleteuser', userPlan: 'pro' } };

const jwt = require(path.join(BACKEND_DIR, 'node_modules/jsonwebtoken'));
const legacyTokenMigrated = jwt.sign({ id: 'rec1', username: 'migrateduser' }, process.env.JWT_SECRET);
const legacyTokenUnmigrated = jwt.sign({ id: 'rec2', username: 'legacyonlyuser' }, process.env.JWT_SECRET);
// Dedicated fixture for the account-deletion test — kept separate from
// migrateduser/uidABC123 since every other test in this file depends on
// that user still existing afterward, and deletion is (deliberately)
// irreversible in this harness too.
const legacyTokenDelete = jwt.sign({ id: 'rec3', username: 'deleteuser' }, process.env.JWT_SECRET);

// server.js only self-listens when run directly (require.main === module) —
// since the Cloud Functions migration it exports the Express app instead, so
// this harness has to start listening itself.
const app = require(path.join(BACKEND_DIR, 'server.js'));
app.listen(TEST_PORT);

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

    // ── Workouts ──
    r = await req('POST', '/workouts', legacyTokenMigrated, { date: '2026-07-01', title: 'Push Day', workout: { sets: [{ exerciseName: 'Bench', weight: 80, reps: 5 }] } });
    check('POST /workouts (migrated) 200', r.status === 200);
    const workoutId = r.body?.recordId;
    check('POST /workouts (migrated) wrote to Firestore (whole object)', store['users/uidABC123/workouts']?.[workoutId]?.workout?.sets?.[0]?.exerciseName === 'Bench');
    check('POST /workouts (migrated) also exploded sets subcollection', !!store[`users/uidABC123/workouts/${workoutId}/sets`]?.['0']);

    r = await req('GET', '/workouts', legacyTokenMigrated);
    check('GET /workouts (migrated) 200', r.status === 200);
    check('GET /workouts (migrated) returns whole workout object byte-for-byte', r.body?.items?.some(i => i.id === workoutId && i.workout?.sets?.[0]?.weight === 80));

    // ── sendTemplate: writes to the RECIPIENT's templates, not the sender's ──
    r = await req('POST', '/sendTemplate', legacyTokenMigrated, { fromUser: 'migrateduser', toUser: 'clientuser', templateName: 'Shared Plan', templateData: { log: [] } });
    check('POST /sendTemplate (recipient migrated) 200', r.status === 200);
    check('POST /sendTemplate wrote to RECIPIENT (uidClient456), not sender', Object.values(store['users/uidClient456/templates'] || {}).some(t => t.name === 'Shared Plan') && !Object.values(store['users/uidABC123/templates'] || {}).some(t => t.name === 'Shared Plan'));

    // ── coach/workouts: writes to the CLIENT's workouts, not the coach's ──
    r = await req('POST', '/coach/workouts', legacyTokenMigrated, { clientUsername: 'clientuser', date: '2026-07-02', workout: { sets: [{ exerciseName: 'Squat', weight: 100, reps: 5 }] } });
    check('POST /coach/workouts (client migrated) 200', r.status === 200);
    const coachLoggedId = r.body?.recordId;
    check('POST /coach/workouts wrote to CLIENT (uidClient456), stamped loggedByCoach', store['users/uidClient456/workouts']?.[coachLoggedId]?.workout?.loggedByCoach === 'migrateduser');
    check('POST /coach/workouts did not write to coach\'s own workouts', !store['users/uidABC123/workouts']?.[coachLoggedId]);

    // ── Plan / referral ──
    r = await req('GET', '/api/user/plan', legacyTokenMigrated);
    check('GET /api/user/plan (migrated) 200', r.status === 200);
    check('GET /api/user/plan (migrated) reads referralCode from Firestore', r.body?.referralCode === 'REFCODE1');

    r = await req('GET', '/api/referral/validate?code=REFCODE1', null);
    check('GET /api/referral/validate (Firestore hit) 200', r.status === 200);
    check('GET /api/referral/validate (Firestore hit) valid + referrerName', r.body?.valid === true && r.body?.referrerName === 'migrateduser'.slice(0, 8));

    r = await req('GET', '/api/referral/validate?code=NOSUCHCODE', null);
    check('GET /api/referral/validate (no match) valid:false', r.body?.valid === false);

    store['users']['uidClient456'] = { username: 'clientuser', referredByCode: 'REFCODE1' };
    r = await req('GET', '/api/referral/stats?username=migrateduser', null);
    check('GET /api/referral/stats (migrated) 200', r.status === 200);
    check('GET /api/referral/stats (migrated) counts Firestore-referred user', r.body?.referralCode === 'REFCODE1' && r.body?.referralCount === 1);

    // ── Exercise videos (coach: migrateduser, client: clientuser) ──
    const legacyTokenClient = jwt.sign({ id: 'rec3', username: 'clientuser' }, process.env.JWT_SECRET);

    r = await req('POST', '/coach/exercise-videos', legacyTokenMigrated, { exerciseName: 'Bench Press', videoUrl: 'https://example.com/bench.mp4', notes: 'grip width cue' });
    check('POST /coach/exercise-videos (migrated) 200', r.status === 200);
    const videoSlug = r.body?.id;
    check('POST /coach/exercise-videos (migrated) slug id', videoSlug === 'bench-press');
    check('POST /coach/exercise-videos (migrated) wrote to Firestore', store['coaches/uidABC123/exerciseVideos']?.[videoSlug]?.videoUrl === 'https://example.com/bench.mp4');

    r = await req('GET', '/coach/exercise-videos', legacyTokenMigrated);
    check('GET /coach/exercise-videos (migrated) 200', r.status === 200);
    check('GET /coach/exercise-videos (migrated) lists own video', r.body?.items?.some(i => i.id === videoSlug && i.exerciseName === 'Bench Press'));

    // Cross-user read: client fetches videos from their coach (migrateduser)
    r = await req('GET', '/exercise-videos', legacyTokenClient);
    check('GET /exercise-videos (client, coach migrated) 200', r.status === 200);
    check('GET /exercise-videos (client, coach migrated) sees coach\'s video via Firestore', r.body?.items?.some(i => i.exerciseName === 'Bench Press' && i.coachId === 'migrateduser'));

    r = await req('DELETE', `/coach/exercise-videos/${videoSlug}`, legacyTokenMigrated);
    check('DELETE /coach/exercise-videos/:id (migrated) 200', r.status === 200);
    check('DELETE /coach/exercise-videos/:id (migrated) removed', !store['coaches/uidABC123/exerciseVideos']?.[videoSlug]);

    r = await req('DELETE', '/coach/exercise-videos/doesnotexist', legacyTokenMigrated);
    check('DELETE /coach/exercise-videos/:id (migrated, missing) 404', r.status === 404);

    // ── Exercise library (global, not per-user — real bundled dataset) ──
    r = await req('POST', '/admin/exercises/seed', legacyTokenMigrated);
    check('POST /admin/exercises/seed 200', r.status === 200);
    check('POST /admin/exercises/seed seeded the whole real dataset (873)', r.body?.total === 873 && r.body?.seeded === 873);
    check('POST /admin/exercises/seed wrote to Firestore', Object.keys(store['exercises'] || {}).length === 873);

    r = await req('GET', '/exercises?q=bench%20press', legacyTokenMigrated);
    check('GET /exercises (q=bench press) 200', r.status === 200);
    check('GET /exercises (q=bench press) finds Dumbbell Bench Press', r.body?.items?.some(i => i.name === 'Dumbbell Bench Press'));

    r = await req('GET', '/exercises?muscleGroup=biceps&limit=5', legacyTokenMigrated);
    check('GET /exercises (muscleGroup=biceps) 200', r.status === 200);
    check('GET /exercises (muscleGroup=biceps) respects limit', r.body?.items?.length === 5 && r.body?.items?.every(i => i.muscleGroup === 'biceps'));

    r = await req('GET', '/exercises?limit=1000', legacyTokenMigrated);
    check('GET /exercises (limit=1000) returns the whole dataset for local caching', r.body?.items?.length === 873);

    // ── Coach/client flow: plan gate, invite, accept, share, alerts,
    // program library + assignment, log-for-client, videos, leave ──
    store['usernames'].plaincoach = { uid: 'uidPlain1' };
    store['users'].uidPlain1 = { username: 'plaincoach' };
    const tokPlain = jwt.sign({ id: 'rec9', username: 'plaincoach' }, process.env.JWT_SECRET);
    const tokCoach = legacyTokenMigrated;
    const tokClient = jwt.sign({ id: 'rec3', username: 'clientuser' }, process.env.JWT_SECRET);
    if (store['coaches/uidABC123/clients']) delete store['coaches/uidABC123/clients'].uidClient456;

    r = await req('POST', '/api/coach/clients/invite', tokPlain, { clientUsername: 'clientuser' });
    check('invite without Coach plan -> 403 coach.plan_required', r.status === 403 && r.body?.error?.code === 'coach.plan_required');

    store['users'].uidABC123.userPlan = 'coach';
    r = await req('POST', '/api/coach/clients/invite', tokCoach, { clientUsername: 'clientuser' });
    check('invite with Coach plan -> 201 pending', r.status === 201 && store['coaches/uidABC123/clients']?.uidClient456?.status === 'pending');

    r = await req('GET', '/api/coach/clients', tokCoach);
    const pendingRow = r.body?.clients?.find(c => c.id === 'uidClient456');
    check('roster shows pending client with ok status and no fake compliance', pendingRow?.status === 'pending' && pendingRow?.alertStatus === 'ok' && pendingRow?.compliancePercent === null);

    r = await req('GET', '/api/client/coach-sharing', tokClient);
    check('client sharing defaults all on', r.body?.sharing?.checkIns === true && r.body?.sharing?.bodyweight === true && r.body?.sharing?.workouts === true);

    r = await req('POST', '/api/client/coach-share', tokClient, { checkIns: [{ date: '2026-09-01', energy: 6 }] });
    check('share before accepting reaches no coach', r.status === 200 && r.body?.coaches === 0 && !store['coaches/uidABC123/clients'].uidClient456.checkIns);

    r = await req('POST', '/api/coach/clients/accept', tokClient, { coachUsername: 'migrateduser' });
    check('client accepts -> active on both sides', r.status === 200 && store['coaches/uidABC123/clients'].uidClient456.status === 'active' && store['users/uidClient456/coachInvites'].uidABC123.status === 'active');

    const today = new Date().toISOString().slice(0, 10);
    const snapshot = {
      checkIns: [{ date: today, energy: 7, sleep: 6, stress: 4, notes: 'good week' }],
      bodyweight: [{ date: '2026-01-01', weight: 82 }, { date: today, weight: 80.5 }],
      workouts: { thisWeek: 3, weekStart: today, weekly: [{ weekStart: today, count: 3 }] },
      compliancePercent: 50,
      activeProgramName: 'Coach PPL'
    };
    r = await req('POST', '/api/client/coach-share', tokClient, snapshot);
    const cdoc = store['coaches/uidABC123/clients'].uidClient456;
    check('share -> copied onto the coach doc', r.status === 200 && r.body?.coaches === 1 && cdoc.lastCheckInAt === today && cdoc.currentBodyweight === 80.5 && cdoc.compliancePercent === 50);

    r = await req('GET', '/api/coach/clients', tokCoach);
    const activeRow = r.body?.clients?.find(c => c.id === 'uidClient456');
    check('roster computes alerts from shared data (50% -> action)', activeRow?.alertStatus === 'action' && activeRow?.alerts?.some(a => a.id === 'low_compliance'));

    r = await req('GET', '/api/coach/clients/uidClient456', tokCoach);
    check('client detail returns check-in history + bodyweight series', r.status === 200 && r.body?.client?.checkIns?.[0]?.notes === 'good week' && r.body?.client?.bodyweight?.length === 2);

    r = await req('PUT', '/api/client/coach-sharing', tokClient, { bodyweight: false });
    check('turning bodyweight off clears it from the coach doc', r.body?.sharing?.bodyweight === false && store['coaches/uidABC123/clients'].uidClient456.bodyweight == null && store['coaches/uidABC123/clients'].uidClient456.currentBodyweight == null);
    await req('POST', '/api/client/coach-share', tokClient, snapshot);
    check('later shares respect the switch', store['coaches/uidABC123/clients'].uidClient456.currentBodyweight == null && store['coaches/uidABC123/clients'].uidClient456.lastCheckInAt === today);

    r = await req('PUT', '/api/coach/programs/p1', tokCoach, { name: 'Coach PPL', days: { Mon: ['Bench Press', { name: 'Row', sets: 4, reps: 8, repsMax: 10 }], Wed: ['Squat'] } });
    check('PUT /api/coach/programs saves to the library', r.status === 200 && store['coaches/uidABC123/programs']?.p1?.exerciseCount === 3);
    await req('PUT', '/api/coach/programs/empty', tokCoach, { name: 'Empty', days: {} });
    r = await req('GET', '/api/coach/programs', tokCoach);
    check('GET /api/coach/programs lists them', r.body?.programs?.length === 2);

    r = await req('PATCH', '/api/coach/clients/uidClient456', tokCoach, { programId: 'empty' });
    check('assigning an empty program -> 422', r.status === 422);
    r = await req('PATCH', '/api/coach/clients/uidClient456', tokCoach, { programId: 'p1', macroTargets: { calories: 2400, protein: 180, carbs: 250, fat: 70 }, nutritionSummary: '2400 kcal' });
    const asn = store['users/uidClient456/coachAssignment']?.uidABC123;
    check('assign program -> full program + macros reach the client', r.status === 200 && asn?.program?.days?.length === 2 && asn?.program?.days?.[0]?.exercises?.[1]?.sets?.length === 4 && asn?.macroTargets?.protein === 180 && asn?.currentProgram === 'Coach PPL');
    check('coach doc keeps the name, not the whole program', store['coaches/uidABC123/clients'].uidClient456.currentProgramId === 'p1' && !store['coaches/uidABC123/clients'].uidClient456.program);
    r = await req('GET', '/api/client/coach-assignment', tokClient);
    check('client reads the assigned program', r.body?.assignments?.[0]?.program?.title === 'Coach PPL');

    r = await req('POST', '/coach/workouts', tokCoach, { clientUid: 'uidClient456', date: today, workout: { sets: [{ exerciseName: 'Deadlift', weight: 140, reps: 3 }] } });
    check('log-for-client by uid via the Firestore link', r.status === 200 && store['users/uidClient456/workouts']?.[r.body?.recordId]?.workout?.loggedByCoach === 'migrateduser');
    r = await req('POST', '/coach/workouts', tokCoach, { clientUid: 'uidNobody', date: today, workout: { sets: [] } });
    check('log-for-client for an unlinked uid -> 403', r.status === 403);

    store['coaches/uidABC123/exerciseVideos'] = { 'hip-thrust': { exerciseName: 'Hip Thrust', videoUrl: 'https://example.com/ht', notes: '' } };
    r = await req('GET', '/exercise-videos', tokClient);
    check('client sees coach videos via the Firestore link, once', r.status === 200 && r.body?.items?.filter(i => i.exerciseName === 'Hip Thrust').length === 1);

    r = await req('DELETE', '/api/client/coaches/uidABC123', tokClient);
    check('client leaves -> link, shared data and assignment removed', r.status === 200 && !store['coaches/uidABC123/clients']?.uidClient456 && !store['users/uidClient456/coachInvites']?.uidABC123 && !store['users/uidClient456/coachAssignment']?.uidABC123);
    r = await req('DELETE', '/api/client/coaches/uidABC123', tokClient);
    check('leaving twice -> 404', r.status === 404);

    // ── DELETE /account (migrated user, Apple App Store Guideline 5.1.1(v)) ──
    // Uses a dedicated fixture (deleteuser/uidDelete789) rather than
    // migrateduser/uidABC123 — every test above this point still needs that
    // user to exist, and deletion is (deliberately) irreversible here too.
    // Seed a subcollection under both users/{uid} and coaches/{uid} so
    // recursiveDelete's cleanup is actually exercised, not just the two
    // top-level docs.
    store['users/uidDelete789/templates'] = { tpl1: { templateName: 'Old Program' } };
    store['coaches'] = store['coaches'] || {};
    store['coaches']['uidDelete789'] = { username: 'deleteuser' };
    store['coaches/uidDelete789/clients'] = { client1: { athleteDisplayName: 'Some Athlete' } };

    r = await req('DELETE', '/account', legacyTokenDelete);
    check('DELETE /account (migrated) 200', r.status === 200 && r.body?.success === true);
    check('DELETE /account (migrated) removed users/{uid}', !store['users']['uidDelete789']);
    check('DELETE /account (migrated) removed users/{uid} subcollection', !store['users/uidDelete789/templates']?.['tpl1']);
    check('DELETE /account (migrated) removed coaches/{uid}', !store['coaches']?.['uidDelete789']);
    check('DELETE /account (migrated) removed coaches/{uid} subcollection', !store['coaches/uidDelete789/clients']?.['client1']);
    check('DELETE /account (migrated) removed usernames mapping', !store['usernames']['deleteuser']);

    r = await req('DELETE', '/account', legacyTokenDelete);
    check('DELETE /account (already deleted) idempotent, not an error', r.status === 200);

    console.log('\n=== RESULTS ===');
    for (const { label, pass } of results) console.log((pass ? 'PASS' : 'FAIL') + ' - ' + label);
    const failed = results.filter(r => !r.pass);
    console.log(`\n${results.length - failed.length}/${results.length} passed`);
    process.exit(failed.length ? 1 : 0);
  })().catch(e => { console.error('TEST THREW:', e); process.exit(1); });
}, 1500);
