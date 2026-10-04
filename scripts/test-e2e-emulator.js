// End-to-end health check against the REAL backend (server.js) running on the
// Firebase emulators. Covers: health, intake (consent required, both form
// payloads), leads, signup, coach invite/accept, notes, master plan
// (preview → draft → adjust → approve → publish → client reads), check-in and
// phase-state sync, the daily-mission IDOR fix, lead retention, and account
// deletion (roster, plans, leads, user data, Auth).
//
// Uses only demo data in a throwaway emulator project — never production.
//
// 1. Start the emulators (firebase-tools):
//      firebase emulators:start --only firestore,auth --project demo-pocketcoach
// 2. Start the backend against them, in another terminal:
//      FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099 //      GCLOUD_PROJECT=demo-pocketcoach JWT_SECRET=local-e2e INTAKE_COACH_USERNAME=coachtest //      ADMIN_USERNAMES= PORT=3100 node server.js
// 3. Run this (same emulator env vars, API_URL if not :3100):
//      FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099 //      node scripts/test-e2e-emulator.js
// Restart the emulators between runs (the accounts it creates must not exist).
'use strict';

process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-pocketcoach';
if (!process.env.FIRESTORE_EMULATOR_HOST || !process.env.FIREBASE_AUTH_EMULATOR_HOST) {
  console.error('Set FIRESTORE_EMULATOR_HOST and FIREBASE_AUTH_EMULATOR_HOST — this script must only ever talk to the emulators.');
  process.exit(1);
}
const path = require('path');
const { initializeApp } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');
const { purgeStaleLeads } = require(path.join(__dirname, '..', 'src', 'leadRetention'));

const API = process.env.API_URL || 'http://127.0.0.1:3100';
const AUTH = `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com/v1`;
const app = initializeApp({ projectId: process.env.GCLOUD_PROJECT });
const auth = getAuth(app);
const db = getFirestore(app);

const results = [];
const check = (section, label, cond, detail) => { results.push({ section, label, pass: !!cond, detail }); };
async function call(method, path, token, body) {
  const res = await fetch(API + path, {
    method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null; try { json = await res.json(); } catch {}
  return { status: res.status, body: json };
}
async function authRest(path, body) {
  const r = await fetch(`${AUTH}/${path}?key=fake-api-key`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return r.json();
}

// Firebase signup the way the app does it: create the Auth user, complete
// signup (claims username), verify the email, sign in again for fresh claims.
async function createAccount(username, email) {
  const password = 'Test-password-123';
  const su = await authRest('accounts:signUp', { email, password, returnSecureToken: true });
  const done = await call('POST', '/auth/signup-complete', su.idToken, { username, consents: { ageConfirmed: true, healthData: true } });
  await auth.updateUser(su.localId, { emailVerified: true });
  const si = await authRest('accounts:signInWithPassword', { email, password, returnSecureToken: true });
  return { uid: su.localId, token: si.idToken, username, email, signupStatus: done.status };
}

function intake(email, overrides = {}) {
  return {
    persoonsgegevens: { naam: 'Ana E2E', email, leeftijd: 29, lengte: 168, gewicht: 68, vetpercentage: 27, geslacht: 'vrouw', trainingservaring: 2 },
    huidigeKracht: [{ oefening: 'Squat', kg: 60, herhalingen: 8, sets: 3 }],
    doel: { categorie: 'vetverlies', tekst: 'Strakker' },
    trainingsfrequentie: { huidig: 4, trainingsmomenten: [] },
    blessures: { tekst: 'knie', vermijdenOefeningen: [] },
    peds: { gebruikt: false, toelichting: '' },
    lifestyle: { activityLevel: 'erg actief', stressLevel: 'veel_stress', slaap: { uren: 5, kwaliteit: 'matig' } },
    vetpercentageMeting: { huidplooimeter: true },
    materiaal: { apparatuur: ['squat_rack'] },
    genen: { enkelomtrek: 21.5 },
    ...overrides,
  };
}

(async () => {
  // ── 0. Health ──
  let r = await call('GET', '/healthz');
  check('health', 'GET /healthz', r.status === 200);
  r = await call('GET', '/health');
  check('health', 'GET /health reports Firebase enabled', r.status === 200 && r.body?.firebase?.enabled === true);
  r = await call('GET', '/api/client/plan');
  check('health', 'protected route without token → 401', r.status === 401);

  // ── 1. Coach account (must exist before intake: leads go to INTAKE_COACH_USERNAME) ──
  const coach = await createAccount('coachtest', 'coach.e2e@example.com');
  check('accounts', 'coach signup-complete', coach.signupStatus === 200 || coach.signupStatus === 201, coach.signupStatus);
  await db.collection('users').doc(coach.uid).set({ userPlan: 'coach', subStatus: 'active' }, { merge: true });

  // ── 2. Intake (public) ──
  r = await call('POST', '/api/intake', null, { intake: intake('ana.e2e@example.com') });
  check('intake', 'without consent → 422 intake.consent_required', r.status === 422 && r.body?.error?.code === 'intake.consent_required');
  r = await call('POST', '/api/intake', null, { intake: intake('ana.e2e@example.com'), consents: { healthData: true, version: 'intake-2026-10-04' } });
  check('intake', 'PocketCoach form payload with consent → 201', r.status === 201 && r.body?.leadId);
  const leadId = r.body?.leadId;
  check('intake', 'calculations returned (erg actief uses PAL 1.725)', r.body?.calculations?.instellingenGebruikt?.pal === 1.725);
  check('intake', 'veel_stress raises a red flag', (r.body?.calculations?.rodeVlaggen || []).some(f => /stress/i.test(f.bericht)));
  r = await call('POST', '/api/intake', null, { intake: intake('other.e2e@example.com', { persoonsgegevens: { naam: 'Other', email: 'other.e2e@example.com', gewicht: 90, vetpercentage: 20, geslacht: 'man' } }), instellingen: { eiwitFactor: 2.0 }, consents: { healthData: true, version: 'intake-2026-10-04' } });
  check('intake', 'ClientIntake payload (with instellingen) → 201', r.status === 201);
  r = await call('POST', '/api/intake', null, { intake: { persoonsgegevens: { naam: 'x' } }, consents: { healthData: true } });
  check('intake', 'invalid payload → 422', r.status === 422);
  const leadDoc = await db.collection(`coaches/${coach.uid}/leads`).doc(leadId).get();
  check('intake', 'lead stored with consent record', leadDoc.exists && leadDoc.get('consents.healthData') === true && leadDoc.get('consents.version') === 'intake-2026-10-04');

  // ── 3. Leads (coach) ──
  r = await call('GET', '/api/coach/leads', coach.token);
  check('leads', 'coach sees both leads', r.status === 200 && r.body?.leads?.length === 2);

  // ── 4. Client account + coaching link ──
  const client = await createAccount('ana_e2e', 'ana.e2e@example.com');
  check('accounts', 'client signup-complete', client.signupStatus === 200 || client.signupStatus === 201, client.signupStatus);
  r = await call('GET', '/api/coach/leads', client.token);
  check('leads', 'free client cannot read leads → 403', r.status === 403);
  r = await call('POST', '/api/coach/clients/invite', coach.token, { clientUsername: 'ana_e2e' });
  check('coaching', 'coach invites client', r.status === 200 || r.status === 201, r.body?.error);
  r = await call('GET', '/api/client/coach-invites', client.token);
  check('coaching', 'client sees the invite', r.status === 200 && JSON.stringify(r.body).includes('coachtest'));
  r = await call('POST', '/api/coach/clients/accept', client.token, { coachUsername: 'coachtest' });
  check('coaching', 'client accepts', r.status === 200, r.body?.error);
  r = await call('GET', '/api/coach/clients', coach.token);
  check('coaching', 'client on coach roster', r.status === 200 && r.body?.clients?.some(c => c.id === client.uid));
  r = await call('PATCH', `/api/coach/leads/${leadId}`, coach.token, { status: 'converted' });
  check('leads', 'lead marked converted', r.status === 200);
  r = await call('POST', `/api/coach/clients/${client.uid}/notes`, coach.token, { text: 'Welcome aboard' });
  check('coaching', 'coach sends a note', r.status === 200 || r.status === 201, r.body?.error);
  r = await call('GET', '/api/client/coach-notes', client.token);
  check('coaching', 'client reads the note', r.status === 200 && JSON.stringify(r.body).includes('Welcome aboard'));

  // ── 5. Master plan ──
  r = await call('GET', '/api/coach/plans/meta', coach.token);
  check('plans', 'meta: 2 packages, 3 tiers', r.status === 200 && r.body?.packages?.length === 2 && Object.keys(r.body?.tiers || {}).length === 3);
  r = await call('GET', '/api/coach/plans/meta', client.token);
  check('plans', 'client cannot use coach plan routes → 403', r.status === 403);
  const planReq = { clientUid: client.uid, leadId, packageId: 'cut_cycle_32', startDate: '2026-10-12', tier: 'medium' };
  r = await call('POST', '/api/coach/plans/preview', coach.token, planReq);
  check('plans', 'preview generates 4 phases', r.status === 200 && r.body?.plan?.phases?.length === 4, r.body?.error);
  const plansBefore = await db.collection(`coaches/${coach.uid}/plans`).get();
  check('plans', 'preview saves nothing', plansBefore.empty);
  r = await call('POST', '/api/coach/plans', coach.token, planReq);
  check('plans', 'create draft', r.status === 201 && r.body?.plan?.status === 'draft', r.body?.error);
  const planId = r.body?.plan?.planId;
  r = await call('GET', '/api/client/plan', client.token);
  check('plans', 'client sees nothing before publication', r.status === 200 && r.body?.plan === null);
  r = await call('PATCH', `/api/coach/plans/${planId}`, coach.token, { changes: [{ path: 'phases[0].endCriteria.any[0].value', value: 63, reason: 'agreed goal' }] });
  check('plans', 'adjust cut target (logged)', r.status === 200 && r.body?.plan?.overrides?.length >= 1);
  r = await call('POST', `/api/coach/plans/${planId}/publish`, coach.token);
  check('plans', 'publish before approval refused → 409', r.status === 409);
  r = await call('POST', `/api/coach/plans/${planId}/approve`, coach.token);
  check('plans', 'approve', r.status === 200 && r.body?.plan?.status === 'approved');
  r = await call('POST', `/api/coach/plans/${planId}/publish`, coach.token);
  check('plans', 'publish', r.status === 200 && r.body?.plan?.status === 'published', r.body?.error);
  r = await call('GET', '/api/client/plan', client.token);
  check('plans', 'client reads the published plan with the 63 kg target', r.body?.plan?.planId === planId && r.body.plan.phases[0].endCriteria.any[0].value === 63);
  check('plans', 'client copy has no override log or provenance', r.body?.plan && !r.body.plan.overrides && !r.body.plan.phases[0].nutrition.provenance);
  r = await call('GET', '/api/client/coach-assignment', client.token);
  check('plans', 'coach assignment summary updated', r.status === 200 && JSON.stringify(r.body).includes('Cut Cycle'));
  const notif = await db.collection('notifications').where('to', '==', 'ana_e2e').get();
  check('plans', 'client notified of the plan', notif.docs.some(d => d.get('type') === 'coach_plan'));

  // ── 6. Check-in + phase-state sync ──
  r = await call('POST', '/api/sync/push', client.token, { items: [
    { store: 'tl_checkins_v1', id: 'date:2026-10-11', data: { date: '2026-10-11', bodyweight: 67.6, phase: 'mini_cut' }, updatedAt: Date.now() },
    { store: 'tl_phase_state_v1', id: 'value', data: '{"mode":"mini_cut"}', updatedAt: Date.now() },
  ] });
  check('sync', 'push check-in + phase state', r.status === 200 && r.body?.applied === 2, r.body);
  r = await call('GET', '/api/sync/pull', client.token);
  const stores = (r.body?.items || []).map(i => i.store);
  check('sync', 'pull returns both', r.status === 200 && stores.includes('tl_checkins_v1') && stores.includes('tl_phase_state_v1'), r.status);

  // ── 7. IDOR fix ──
  r = await call('PUT', '/api/bodybuilding/daily-mission/coachtest', client.token, { workoutComplete: true });
  check('security', "client cannot write the coach's daily mission → 403", r.status === 403);
  r = await call('PUT', '/api/bodybuilding/daily-mission/ana_e2e', client.token, { workoutComplete: true });
  check('security', 'client writes own daily mission', r.status === 200 && r.body?.saved === true);

  // ── 8. Lead retention ──
  const old = await db.collection(`coaches/${coach.uid}/leads`).add({ naam: 'Old', status: 'new', createdAt: Timestamp.fromDate(new Date('2024-01-01')) });
  const oldConverted = await db.collection(`coaches/${coach.uid}/leads`).add({ naam: 'Old client', status: 'converted', createdAt: Timestamp.fromDate(new Date('2024-01-01')) });
  const purge = await purgeStaleLeads(db);
  check('retention', 'stale unconverted lead purged', !(await old.get()).exists && purge.deleted === 1);
  check('retention', 'converted lead kept', (await oldConverted.get()).exists);

  // ── 9. Account deletion (client) ──
  r = await call('DELETE', '/account', client.token);
  check('deletion', 'DELETE /account', r.status === 200, r.body?.error);
  check('deletion', 'removed from coach roster (incl. notes)', !(await db.collection(`coaches/${coach.uid}/clients`).doc(client.uid).get()).exists
    && (await db.collection(`coaches/${coach.uid}/clients/${client.uid}/notes`).get()).empty);
  check('deletion', "coach's plans for the client removed", (await db.collection(`coaches/${coach.uid}/plans`).where('clientUid', '==', client.uid).get()).empty);
  check('deletion', "intake lead with the client's email removed", !(await db.collection(`coaches/${coach.uid}/leads`).doc(leadId).get()).exists);
  check('deletion', "other prospect's lead kept", (await db.collection(`coaches/${coach.uid}/leads`).get()).docs.some(d => d.get('naam') === 'Other'));
  check('deletion', 'user doc (plans, sync items) removed', !(await db.collection('users').doc(client.uid).get()).exists
    && (await db.collection(`users/${client.uid}/syncItems`).get()).empty);
  let authGone = false; try { await auth.getUser(client.uid); } catch (e) { authGone = e.code === 'auth/user-not-found'; }
  check('deletion', 'Auth user removed', authGone);

  // ── Report ──
  let section = '';
  for (const x of results) {
    if (x.section !== section) { section = x.section; console.log(`\n[${section}]`); }
    console.log(`  ${x.pass ? 'PASS' : 'FAIL'}  ${x.label}${!x.pass && x.detail !== undefined ? '  → ' + JSON.stringify(x.detail) : ''}`);
  }
  const failed = results.filter(x => !x.pass).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('E2E crashed:', e); process.exit(2); });
