// Firebase Admin SDK init — Phase 1 of the Firebase Auth migration.
// Requires FIREBASE_SERVICE_ACCOUNT env var: the full service-account JSON as a
// single string (Firebase Console → Project Settings → Service Accounts).
// When the var is missing, firebaseEnabled is false and the server keeps
// running on legacy JWT auth only.
const admin = require('firebase-admin');

let firebaseEnabled = false;
let db = null;
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
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
    projectId = serviceAccount.project_id || null;
    db = admin.firestore();
    firebaseEnabled = true;
    console.log(`[Firebase] Admin SDK initialized for project: ${projectId}`);
  } catch (err) {
    initError = err.message;
    console.error('[Firebase] FIREBASE_SERVICE_ACCOUNT is set but init failed:', err.message);
  }
} else {
  console.warn('[Firebase] FIREBASE_SERVICE_ACCOUNT not set — Firebase auth disabled, legacy JWT only.');
}

module.exports = { admin, db, firebaseEnabled, projectId, initError };
