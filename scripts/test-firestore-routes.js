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
function collection(colPath) {
  store[colPath] = store[colPath] || {};
  return {
    doc(id) {
      const docId = id || `auto_${Math.random().toString(36).slice(2, 8)}`;
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
    },
    async get() { // naive orderBy support: ignore ordering, just return all
      const docs = Object.entries(store[colPath] || {}).map(([id, data]) => ({
        id, get: (f) => data[f], data: () => data
      }));
      return { docs };
    },
    orderBy() { return this; }
  };
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

    console.log('\n=== RESULTS ===');
    for (const { label, pass } of results) console.log((pass ? 'PASS' : 'FAIL') + ' - ' + label);
    const failed = results.filter(r => !r.pass);
    console.log(`\n${results.length - failed.length}/${results.length} passed`);
    process.exit(failed.length ? 1 : 0);
  })().catch(e => { console.error('TEST THREW:', e); process.exit(1); });
}, 1500);
