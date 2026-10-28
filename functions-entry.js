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
// AI provider keys (src/coach/client.js): Ollama Cloud first, Groq for
// short calls, OpenRouter as overflow. ANTHROPIC_API_KEY would override
// them all but isn't declared, because a declared secret that doesn't
// exist fails the deploy.
const ollamaApiKey = defineSecret('OLLAMA_API_KEY');
const groqApiKey = defineSecret('GROQ_API_KEY');
const openRouterApiKey = defineSecret('OPENROUTER_API_KEY');
const intakeCoachUsername = defineSecret('INTAKE_COACH_USERNAME');
const googleHealthClientId = defineSecret('GOOGLE_HEALTH_CLIENT_ID');
const googleHealthClientSecret = defineSecret('GOOGLE_HEALTH_CLIENT_SECRET');
const googleHealthRedirectUri = defineSecret('GOOGLE_HEALTH_REDIRECT_URI');
// Resend API key for emailing report and block alerts (src/moderationEmail.js).
const resendApiKey = defineSecret('RESEND_API_KEY');
// USDA FoodData Central key for food search (src/routes/food.js). Free from
// https://fdc.nal.usda.gov/api-key-signup — set it before deploying.
const usdaApiKey = defineSecret('USDA_API_KEY');

const app = require('./server');

// All routes (POST /api/intake, /login, /coach/*, etc.) are served under
// this one function via Express's own internal routing — Firebase Hosting
// (once set up) or direct callers hit this same URL for every path.
exports.api = onRequest({
  // The default 60s cuts off the streaming AI coach (POST /api/ai/coach),
  // which can run several model rounds with tool lookups in one request, and
  // program import (POST /api/ai/coach/import-program), where free models
  // can take minutes to write out a month of training.
  timeoutSeconds: 540,
  secrets: [
    jwtSecret, ollamaApiKey, groqApiKey, openRouterApiKey, intakeCoachUsername,
    googleHealthClientId, googleHealthClientSecret, googleHealthRedirectUri,
    resendApiKey, usdaApiKey
  ]
}, app);

// Daily: delete intake leads older than 12 months that never became a
// client (the retention period stated in privacy.html). Needs the Cloud
// Scheduler API, which `firebase deploy` offers to enable on first deploy.
const { db, firebaseEnabled } = require('./firebaseAdmin');
const { purgeStaleLeads } = require('./src/leadRetention');

exports.purgeStaleLeads = onSchedule({ schedule: 'every day 03:30', timeZone: 'Europe/Amsterdam' }, async () => {
  if (!firebaseEnabled) return;
  const { deleted, cutoff } = await purgeStaleLeads(db);
  console.info(`[Lead retention] Deleted ${deleted} lead(s) created before ${cutoff.toISOString()}`);
});
