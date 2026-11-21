// HTTP tests for coach Pro codes (src/coachCode.js routes in server.js):
// GET /api/coach/code, POST /api/coach/code/regenerate, POST /api/client/coach-code,
// and the coachPro / plan fields on GET /api/user/plan.
// Same fake-Firestore harness as test-firestore-routes.js.
//
// Run: node scripts/test-coach-code-routes.js
const path = require('path');
const http = require('http');

process.env.JWT_SECRET = 'test-secret-for-route-conversion-check';
process.env.AIRTABLE_TOKEN = 'fake-token';
process.env.AIRTABLE_BASE_ID = 'fakeBaseId';
const TEST_PORT = 39874;
process.env.PORT = String(TEST_PORT);
process.env.ADMIN_USERNAMES = 'Bossman'; // an admin with no plan of their own

const BACKEND_DIR = path.join(__dirname, '..');
const firebasePath = path.join(BACKEND_DIR, 'firebaseAdmin.js');

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
    async create(data) {
      if (store[colPath][docId]) { const e = new Error('6 ALREADY_EXISTS'); e.code = 6; throw e; }
      store[colPath][docId] = { ...data };
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
      // Only the signup-consent tests use a Firebase ID token; every other
      // token is rejected here exactly as before (no verifyIdToken stub).
      verifyIdToken: async (t) => {
        if (t === 'fb-signup-token') return { uid: 'uidSignup1', email: 'new@example.com', email_verified: false };
        throw new Error('not a firebase token');
      },
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

store['usernames'] = { coachy: { uid: 'uCoach' }, athlete: { uid: 'uAth' }, other: { uid: 'uOther' }, bossman: { uid: 'uAdmin' }, adminclient: { uid: 'uAdminClient' } };
store['users'] = {
  uCoach: { username: 'coachy', userPlan: 'coach' },
  uAth: { username: 'athlete' },
  uOther: { username: 'other' },
  uAdmin: { username: 'bossman' },
  uAdminClient: { username: 'adminclient' },
};

const jwt = require(path.join(BACKEND_DIR, 'node_modules/jsonwebtoken'));
const tok = name => jwt.sign({ id: 'rec_' + name, username: name }, process.env.JWT_SECRET);

const app = require(path.join(BACKEND_DIR, 'server.js'));
const server = app.listen(TEST_PORT);

function req(method, urlPath, token, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({
      method, port: TEST_PORT, path: urlPath, headers: {
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
  const check = (label, cond, extra) => results.push({ label, pass: !!cond, extra });

  let r = await req('GET', '/api/coach/code', tok('athlete'));
  check('athlete without Coach plan cannot get a coach code (403)', r.status === 403);

  r = await req('GET', '/api/coach/code', tok('coachy'));
  check('coach gets a code', r.status === 200 && /^[A-Z2-9]{8}$/.test(r.body?.code) && r.body?.display?.length === 9, r.body);
  const code = r.body.code;
  r = await req('GET', '/api/coach/code', tok('coachy'));
  check('coach gets the same code again', r.body?.code === code);

  r = await req('GET', '/api/user/plan', tok('athlete'));
  check('athlete starts free with no coachPro', r.body?.plan === 'free' && r.body?.coachPro === null, r.body);

  r = await req('POST', '/api/client/coach-code', tok('athlete'), { code: 'ZZZZZZZZ' });
  check('unknown code → 404', r.status === 404 && r.body?.error?.code === 'coach_code.not_found');

  r = await req('POST', '/api/client/coach-code', tok('coachy'), { code });
  check('coach can not use their own code (422)', r.status === 422);

  r = await req('POST', '/api/client/coach-code', tok('athlete'), { code: (code.slice(0, 4) + '-' + code.slice(4)).toLowerCase() });
  check('athlete redeems the code (formatted, lower case)', r.status === 200 && r.body?.coachUsername === 'coachy' && r.body?.plan === 'pro', r.body);
  check('roster doc is active', store['coaches/uCoach/clients']?.uAth?.status === 'active');
  check('client mirror is active', store['users/uAth/coachInvites']?.uCoach?.status === 'active');

  r = await req('GET', '/api/user/plan', tok('athlete'));
  check('athlete is now Pro via coach_code', r.body?.plan === 'pro' && r.body?.planSource === 'coach_code'
    && r.body?.coachPro?.status === 'active' && r.body?.coachPro?.coachUsername === 'coachy', r.body);

  r = await req('POST', '/api/client/coach-code', tok('athlete'), { code });
  check('redeeming again is fine', r.status === 200 && r.body?.alreadyLinked === true);

  // Regenerate: old code stops working, athlete keeps Pro.
  r = await req('POST', '/api/coach/code/regenerate', tok('coachy'));
  const fresh = r.body?.code;
  check('regenerate gives a new code', r.status === 200 && fresh && fresh !== code);
  r = await req('POST', '/api/client/coach-code', tok('other'), { code });
  check('old code no longer works', r.status === 404);
  r = await req('GET', '/api/user/plan', tok('athlete'));
  check('athlete keeps Pro after regenerate', r.body?.plan === 'pro');

  // Coach plan lapses. Redeeming re-checks the coach's plan fresh.
  store['users'].uCoach.userPlan = 'free';
  r = await req('POST', '/api/client/coach-code', tok('other'), { code: fresh });
  check('code from a coach without the plan → 409', r.status === 409 && r.body?.error?.code === 'coach_code.coach_inactive', r.body);
  check('no link made for a refused code', !store['coaches/uCoach/clients']?.uOther);
  r = await req('GET', '/api/user/plan', tok('athlete'));
  check('athlete Pro paused while coach plan lapsed', r.body?.plan === 'free' && r.body?.coachPro?.status === 'paused', r.body);
  store['users'].uCoach.userPlan = 'coach';
  r = await req('POST', '/api/client/coach-code', tok('other'), { code: fresh });
  check('second athlete redeems once the coach resubscribes', r.status === 200, r.body);
  r = await req('GET', '/api/user/plan', tok('athlete'));
  check('first athlete Pro is back too', r.body?.plan === 'pro' && r.body?.coachPro?.status === 'active', r.body);

  // Client leaves → revoked.
  r = await req('DELETE', '/api/client/coaches/uCoach', tok('athlete'));
  check('athlete leaves coach', r.status === 200);
  r = await req('GET', '/api/user/plan', tok('athlete'));
  check('athlete back to free after leaving', r.body?.plan === 'free' && r.body?.coachPro?.status === 'revoked', r.body);

  // Coach removes client → revoked.
  r = await req('DELETE', '/api/coach/clients/uOther', tok('coachy'));
  check('coach removes second athlete', r.status === 200);
  r = await req('GET', '/api/user/plan', tok('other'));
  check('removed athlete back to free', r.body?.plan === 'free' && r.body?.coachPro?.status === 'revoked', r.body);

  // Entering the code again restores it.
  await req('POST', '/api/client/coach-code', tok('athlete'), { code: fresh });
  r = await req('GET', '/api/user/plan', tok('athlete'));
  check('re-entering the code restores Pro', r.body?.plan === 'pro' && r.body?.coachPro?.status === 'active', r.body);

  // An admin with no subscription reads as Coach, and their code gives Pro.
  r = await req('GET', '/api/user/plan', tok('bossman'));
  check('admin reads as the Coach plan', r.body?.plan === 'coach' && r.body?.planSource === 'admin' && r.body?.admin === true, r.body);
  r = await req('GET', '/api/coach/code', tok('bossman'));
  check('admin gets a coach code', r.status === 200 && /^[A-Z2-9]{8}$/.test(r.body?.code), r.body);
  const adminCode = r.body?.code;
  r = await req('POST', '/api/client/coach-code', tok('adminclient'), { code: adminCode });
  check('client redeems the admin\'s code', r.status === 200 && r.body?.plan === 'pro', r.body);
  r = await req('GET', '/api/user/plan', tok('adminclient'));
  check('admin\'s client is Pro and stays active', r.body?.plan === 'pro' && r.body?.coachPro?.status === 'active', r.body);

  const failed = results.filter(x => !x.pass);
  for (const x of results) console.log(`${x.pass ? 'PASS' : 'FAIL'} ${x.label}${x.pass ? '' : ' ' + JSON.stringify(x.extra || '')}`);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  server.close();
  process.exit(failed.length ? 1 : 0);
})().catch(err => { console.error(err); process.exit(1); });
