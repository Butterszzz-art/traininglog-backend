// Firebase Admin SDK init.
//
// Two credential paths, tried in order:
// 1. FIREBASE_SERVICE_ACCOUNT env var (full service-account JSON as a single
//    string, from Firebase Console → Project Settings → Service Accounts) —
//    needed when this code runs *outside* Google's infrastructure (e.g. the
//    old Render deployment, or a developer's own machine).
// 2. Application Default Credentials, with no explicit credential at all —
//    what actually applies now that this runs as a Cloud Function: Google
//    automatically attaches the function's own service account, which
//    already has access to this same project's Firestore/Auth, no secret to
//    manage. This is `initializeApp()`'s normal default behavior; explicit
//    cert() is only needed for path 1.
//
// firebase-admin v12+ dropped the old admin.credential.cert() / admin.auth() /
// admin.firestore() namespace from the default CommonJS export — those live
// in modular submodules now (firebase-admin/app, /auth, /firestore).
const { initializeApp, cert } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');

let firebaseEnabled = false;
let db = null;
let auth = null;
let projectId = null;
let initError = null;

const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
if (raw) {
  try {
    const serviceAccount = JSON.parse(raw);
    // Render/Heroku-style env var UIs frequently mangle the private_key's
    // escaped newlines when the JSON is pasted in — normalize defensively.
    // This is a no-op if the newlines are already correct.
    if (typeof serviceAccount.private_key === 'string') {
      serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
    }
    const app = initializeApp({ credential: cert(serviceAccount) });
    projectId = serviceAccount.project_id || null;
    auth = getAuth(app);
    db = getFirestore(app);
    firebaseEnabled = true;
    console.log(`[Firebase] Admin SDK initialized for project: ${projectId} (explicit service account)`);
  } catch (err) {
    initError = err.message;
    console.error('[Firebase] FIREBASE_SERVICE_ACCOUNT is set but init failed:', err.message);
  }
} else {
  try {
    const app = initializeApp();
    projectId = process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT || null;
    auth = getAuth(app);
    db = getFirestore(app);
    firebaseEnabled = true;
    console.log(`[Firebase] Admin SDK initialized for project: ${projectId} (application default credentials)`);
  } catch (err) {
    // Expected outside GCP (e.g. plain `node server.js` on a laptop with no
    // gcloud ADC set up) — falls back to legacy JWT auth, same as before.
    initError = err.message;
    console.warn('[Firebase] No FIREBASE_SERVICE_ACCOUNT and no application default credentials available — Firebase auth disabled, legacy JWT only.');
  }
}

module.exports = { auth, db, FieldValue, firebaseEnabled, projectId, initError };
