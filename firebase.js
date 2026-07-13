// Firebase Admin SDK init — Phase 1 of the Firebase Auth migration.
// Requires FIREBASE_SERVICE_ACCOUNT env var: the full service-account JSON as a
// single string (Firebase Console → Project Settings → Service Accounts).
// When the var is missing, firebaseEnabled is false and the server keeps
// running on legacy JWT auth only.
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
    console.log(`[Firebase] Admin SDK initialized for project: ${projectId}`);
  } catch (err) {
    initError = err.message;
    console.error('[Firebase] FIREBASE_SERVICE_ACCOUNT is set but init failed:', err.message);
  }
} else {
  console.warn('[Firebase] FIREBASE_SERVICE_ACCOUNT not set — Firebase auth disabled, legacy JWT only.');
}

module.exports = { auth, db, FieldValue, firebaseEnabled, projectId, initError };
