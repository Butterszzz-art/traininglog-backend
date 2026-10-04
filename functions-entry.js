// Cloud Functions entry point. This is the "main" file Firebase looks for
// when deploying this whole directory as the `default` functions codebase
// (see ../firebase.json's `source: "traininglog-backend-sync"`). It doesn't
// contain any app logic itself — it just wraps the existing Express app
// (server.js, unchanged) as a single HTTPS function. server.js already
// guards its own app.listen() call (only runs via `node server.js` directly),
// so requiring it here does not also try to bind a port.
const { onRequest } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { defineSecret } = require('firebase-functions/params');

// Secrets set via `firebase functions:secrets:set <NAME>` aren't visible to
// the function (or to the CLI's own local "discovery" pass, which is what
// was crashing on the missing JWT_SECRET) until they're declared here and
// passed to onRequest below — that's what actually populates
// process.env.<NAME> at runtime, so server.js's existing process.env reads
// need no changes. Add STRIPE_SECRET_KEY here once it's been set the same
// way (it's optional today — server.js already guards its absence).
const jwtSecret = defineSecret('JWT_SECRET');
const anthropicApiKey = defineSecret('ANTHROPIC_API_KEY');
const intakeCoachUsername = defineSecret('INTAKE_COACH_USERNAME');
const googleHealthClientId = defineSecret('GOOGLE_HEALTH_CLIENT_ID');
const googleHealthClientSecret = defineSecret('GOOGLE_HEALTH_CLIENT_SECRET');
const googleHealthRedirectUri = defineSecret('GOOGLE_HEALTH_REDIRECT_URI');
// Resend API key for emailing report and block alerts (src/moderationEmail.js).
const resendApiKey = defineSecret('RESEND_API_KEY');

const app = require('./server');

// All routes (POST /api/intake, /login, /coach/*, etc.) are served under
// this one function via Express's own internal routing — Firebase Hosting
// (once set up) or direct callers hit this same URL for every path.
exports.api = onRequest({
  secrets: [
    jwtSecret, anthropicApiKey, intakeCoachUsername,
    googleHealthClientId, googleHealthClientSecret, googleHealthRedirectUri,
    resendApiKey
  ]
}, app);

// Daily: delete intake leads older than 12 months that never became a
// client (the retention period stated in privacy.html). Needs the Cloud
// Scheduler API, which `firebase deploy` offers to enable on first deploy.
const { db, firebaseEnabled } = require('./firebase');
const { purgeStaleLeads } = require('./src/leadRetention');

exports.purgeStaleLeads = onSchedule({ schedule: 'every day 03:30', timeZone: 'Europe/Amsterdam' }, async () => {
  if (!firebaseEnabled) return;
  const { deleted, cutoff } = await purgeStaleLeads(db);
  console.info(`[Lead retention] Deleted ${deleted} lead(s) created before ${cutoff.toISOString()}`);
});
