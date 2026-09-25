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
let usernameReads = 0; // reads of usernames/* (resolveFirestoreUid cache check)
function docRefFor(colPath, docId) {
  return {
    id: docId,
    __colPath: colPath,
    async get() {
      if (colPath === 'usernames') usernameReads++;
      const data = store[colPath][docId];
      return { id: docId, exists: !!data, get: (f) => data?.[f], data: () => data };
    },
    async set(data, opts) {
      const prev = store[colPath][docId] || {};
      const resolved = {};
      for (const [k, v] of Object.entries(data)) {
        resolved[k] = v && typeof v === 'object' && '__increment' in v ? (Number(prev[k]) || 0) + v.__increment : v;
      }
      store[colPath][docId] = opts?.merge ? { ...prev, ...resolved } : resolved;
    },
    async delete() { delete store[colPath][docId]; },
    collection(subPath) { return collection(`${colPath}/${docId}/${subPath}`); }
  };
}
function collection(colPath) {
  store[colPath] = store[colPath] || {};
  const filters = [];
  let limitN = null;
  let order = null;
  let afterId = null;
  const api = {
    doc(id) {
      const docId = id || `auto_${Math.random().toString(36).slice(2, 8)}`;
      return docRefFor(colPath, docId);
    },
    async get() { // naive: single orderBy, == filters, startAfter(snapshot), limit
      let entries = Object.entries(store[colPath] || {});
      for (const [field, value] of filters) {
        entries = entries.filter(([, data]) => data?.[field] === value);
      }
      if (order) {
        const [field, dir] = order;
        entries.sort(([ia, a], [ib, b]) => {
          const x = a?.[field], y = b?.[field];
          const c = x === y ? (ia < ib ? -1 : ia > ib ? 1 : 0) : (x == null ? -1 : y == null ? 1 : x < y ? -1 : 1);
          return dir === 'desc' ? -c : c;
        });
      }
      if (afterId != null) {
        const i = entries.findIndex(([id]) => id === afterId);
        if (i !== -1) entries = entries.slice(i + 1);
      }
      if (limitN != null) entries = entries.slice(0, limitN);
      const docs = entries.map(([id, data]) => ({
        id, get: (f) => data[f], data: () => data, ref: docRefFor(colPath, id)
      }));
      return { docs, empty: docs.length === 0 };
    },
    orderBy(field, dir) { order = [field, dir || 'asc']; return this; },
    startAfter(snap) { afterId = snap.id; return this; },
    where(field, op, value) { filters.push([field, value]); return this; },
    limit(n) { limitN = n; return this; }
  };
  return api;
}
function batch() {
  const ops = [];
  return {
    set(docRef, data, opts) { ops.push(() => docRef.set(data, opts)); return this; },
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
// Transactions: reads go straight through, writes are applied at the end.
async function runTransaction(fn) {
  const writes = [];
  const tx = {
    get: (ref) => ref.get(),
    set(ref, data, opts) { writes.push(() => ref.set(data, opts)); return tx; }
  };
  const result = await fn(tx);
  for (const w of writes) await w();
  return result;
}
const getAll = (...refs) => Promise.all(refs.map(r => r.get()));
const fakeDb = { collection, batch, recursiveDelete, runTransaction, getAll };

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
    db: fakeDb, FieldValue: { serverTimestamp: () => 'TS', increment: (n) => ({ __increment: n }) }, firebaseEnabled: true, projectId: 'test-project', initError: null
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

    r = await req('POST', '/dailylogs', legacyTokenMigrated, { date: '2026-07-01', CaloriesTotal: 2700, ProteinTotal: 190 });
    check('POST /dailylogs (same day re-save) overwrites the day, no duplicate', Object.keys(store['users/uidABC123/dailyMacros']).length === 1 && store['users/uidABC123/dailyMacros']['2026-07-01_log']?.calories === 2700);
    r = await req('POST', '/dailylogs', legacyTokenMigrated, { date: '2026-07-01', Type: 'Macros', CaloriesTotal: 2600, ProteinTotal: 190 });
    check('POST /dailylogs (different Type) is a separate doc', !!store['users/uidABC123/dailyMacros']['2026-07-01_Macros']);

    r = await req('GET', '/dailylogs?username=migrateduser', legacyTokenMigrated);
    check('GET /dailylogs (migrated) 200', r.status === 200);
    check('GET /dailylogs (migrated) reshapes to Airtable-style fields', r.body?.records?.some(rec => rec.Calories === 2600 && rec.ProteinGrams === 190));

    // ── Bodyweight ──
    r = await req('POST', '/bodyweight/archive', legacyTokenMigrated, { periodStart: '2026-06-01', periodEnd: '2026-06-28', entries: [{ date: '2026-06-01', weightKg: 80 }, { date: '2026-06-28', weightKg: 79 }] });
    check('POST /bodyweight/archive (migrated) 201', r.status === 201);
    check('POST /bodyweight/archive (migrated) wrote to Firestore', Object.values(store['users/uidABC123/bodyweightArchives'] || {}).some(d => d.startWeightKg === 80 && d.endWeightKg === 79));

    await req('POST', '/bodyweight/archive', legacyTokenMigrated, { periodStart: '2026-06-01', periodEnd: '2026-06-28', entries: [{ date: '2026-06-01', weightKg: 80 }, { date: '2026-06-28', weightKg: 79 }] });
    check('POST /bodyweight/archive (re-sent period) does not duplicate', Object.keys(store['users/uidABC123/bodyweightArchives']).length === 1 && !!store['users/uidABC123/bodyweightArchives']['2026-06-01_2026-06-28']);

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
    check('POST /workouts (migrated) no longer writes a sets subcollection', !store[`users/uidABC123/workouts/${workoutId}/sets`]);
    check('POST /workouts (migrated) incremented leaderboard totals', store['users']['uidABC123'].totalVolume === 400 && store['users']['uidABC123'].workoutCount === 1);

    r = await req('GET', '/workouts', legacyTokenMigrated);
    check('GET /workouts (migrated) 200', r.status === 200);
    check('GET /workouts (migrated) returns whole workout object byte-for-byte', r.body?.items?.some(i => i.id === workoutId && i.workout?.sets?.[0]?.weight === 80));

    // Client-supplied id: a retried POST overwrites the same doc (no duplicate,
    // no double-counted totals), and totals follow the new volume.
    const retryBody = { date: '2026-07-03', title: 'Pull Day', workout: { id: 'client-uuid-1', sets: [{ exerciseName: 'Row', weight: 60, reps: 10 }] } };
    r = await req('POST', '/workouts', legacyTokenMigrated, retryBody);
    check('POST /workouts (client id) uses the app id as doc id', r.status === 200 && r.body?.recordId === 'client-uuid-1');
    r = await req('POST', '/workouts', legacyTokenMigrated, { ...retryBody, workout: { ...retryBody.workout, sets: [{ exerciseName: 'Row', weight: 70, reps: 10 }] } });
    check('POST /workouts (client id retry) same doc id', r.body?.recordId === 'client-uuid-1');
    check('POST /workouts (client id retry) no duplicate doc', Object.keys(store['users/uidABC123/workouts']).length === 2);
    check('POST /workouts (client id retry) totals not double-counted', store['users']['uidABC123'].workoutCount === 2 && store['users']['uidABC123'].totalVolume === 400 + 700);

    r = await req('POST', '/workouts', legacyTokenMigrated, { date: '2026-07-04', workout: { id: 'bad/id', sets: [] } });
    check('POST /workouts (unsafe client id) falls back to auto id', r.status === 200 && r.body?.recordId !== 'bad/id' && !String(r.body?.recordId).includes('/'));

    // Opt-in paging (newest first): default still returns everything.
    r = await req('GET', '/workouts', legacyTokenMigrated);
    check('GET /workouts (no limit) returns full history', r.body?.items?.length === 3 && r.body?.nextCursor === null);
    r = await req('GET', '/workouts?limit=2', legacyTokenMigrated);
    check('GET /workouts?limit=2 returns 2 + nextCursor', r.body?.items?.length === 2 && r.body?.items?.[0]?.date === '2026-07-04' && !!r.body?.nextCursor);
    r = await req('GET', `/workouts?limit=2&cursor=${r.body?.nextCursor}`, legacyTokenMigrated);
    check('GET /workouts?cursor= returns the remaining page', r.body?.items?.length === 1 && r.body?.items?.[0]?.id === workoutId && r.body?.nextCursor === null);

    // ── Leaderboard: reads per-user counters, not every workout ──
    r = await req('GET', '/leaderboard', legacyTokenMigrated);
    check('GET /leaderboard 200', r.status === 200);
    check('GET /leaderboard uses users/{uid} totals', r.body?.items?.some(i => i.username === 'migrateduser' && i.totalVolume === 1100 && i.workoutCount === 3));

    // ── Sync routes are idempotent: re-sending the same entries doesn't duplicate ──
    const cardioBefore = Object.keys(store['users/uidABC123/cardioLogs'] || {}).length;
    const cardioEntries = [{ date: '2026-06-02', type: 'Bike', duration: 45 }, { id: 'cardio-1', date: '2026-06-03', type: 'Row', duration: 20 }];
    await req('POST', '/cardio/sync', legacyTokenMigrated, { entries: cardioEntries });
    r = await req('POST', '/cardio/sync', legacyTokenMigrated, { entries: cardioEntries });
    check('POST /cardio/sync (resend) 201', r.status === 201 && r.body?.count === 2);
    check('POST /cardio/sync (resend) did not duplicate', Object.keys(store['users/uidABC123/cardioLogs']).length === cardioBefore + 2);
    check('POST /cardio/sync keeps an entry id as doc id', !!store['users/uidABC123/cardioLogs']['cardio-1']);

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

    // ── resolveFirestoreUid cache: repeat requests skip the usernames read ──
    await req('GET', '/workouts', legacyTokenMigrated);
    const readsBefore = usernameReads;
    await req('GET', '/workouts', legacyTokenMigrated);
    await req('GET', '/programs', legacyTokenMigrated);
    check('resolveFirestoreUid cached (no usernames reads on repeat requests)', usernameReads === readsBefore);

    // Warm the cache for the deletion fixture so the test below proves
    // deletion drops it (not just that it was never cached).
    await req('POST', '/macrotargets', legacyTokenDelete, { calories: 2000 });

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

    await req('POST', '/macrotargets', legacyTokenDelete, { calories: 2100 });
    check('DELETE /account dropped the cached uid (no write to the deleted uid)', !store['users']['uidDelete789']);

    console.log('\n=== RESULTS ===');
    for (const { label, pass } of results) console.log((pass ? 'PASS' : 'FAIL') + ' - ' + label);
    const failed = results.filter(r => !r.pass);
    console.log(`\n${results.length - failed.length}/${results.length} passed`);
    process.exit(failed.length ? 1 : 0);
  })().catch(e => { console.error('TEST THREW:', e); process.exit(1); });
}, 1500);
