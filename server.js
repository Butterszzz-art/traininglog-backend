const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const Airtable = require('airtable');
const fetch = require('node-fetch');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const leaderboardRoute = require('./leaderboard');
const { router: aiRouter } = require('./src/routes/ai');
const { createPremiumRouter } = require('./src/routes/premium');
const { createProfilesRouter, deleteProfile, parseTerms: parseProfileTerms, containsObjectionable } = require('./src/routes/profiles');
const { DEFAULT_OBJECTIONABLE_TERMS } = require('./src/objectionableTerms');
const { normalizeExercise, exerciseFilter, addDays } = require('./src/activitySyncExercise');
const { HEALTH_METRICS_SCOPE, RECOVERY_TYPES, recoveryFilter, mergeRecoveryPoints, hasHealthMetricsScope } = require('./src/activitySyncRecovery');
const { DAILY_VITALS, SCALE_SAMPLES, dailyFilter, sampleFilter, mergeDailyVitals, mergeWeighIns } = require('./src/activitySyncBody');
const { createAppleIapRouter, createAppleVerifiers } = require('./src/routes/appleIap');
const { createPlanAccess, parseUsernames } = require('./src/planAccess');
const { createEntitlements, pickEffective, legacyEntitlement, toDate, SUBSCRIPTION_SOURCES } = require('./src/entitlements');
const { createCoachCodes, formatCode } = require('./src/coachCode');
const fs = require('fs');
const path = require('path');
const { createModerationNotifier } = require('./src/moderationEmail');
const { createFriendsRouter, deleteFriendships } = require('./src/routes/friends');
const { createGroupsRouter, removeUserFromGroups } = require('./src/routes/groups');
const { createFeedRouter, deleteFeedPosts } = require('./src/routes/feed');
const { createSharesRouter, deleteShares } = require('./src/routes/shares');
const { createCalendarRouter, createCalendarFeedHandler, deleteCalendarFeed } = require('./src/routes/calendar');
const { deleteUserMealPhotos } = require('./src/mealShare');
const { createNotificationsRouter, notifyVolumePasses, deleteNotifications } = require('./src/routes/notifications');
const coachNotifications = require('./src/coachNotifications');
const { createSyncRouter, syncDocId } = require('./src/routes/sync');
const { createCoachNutritionRouter } = require('./src/routes/coachNutrition');
const { createCoachFoodsRouter, createClientCoachFoodsRouter } = require('./src/routes/coachFoods');
const coachMeals = require('./src/routes/coachMeals');
const { createFoodRouter } = require('./src/routes/food');
const { createCoachPlansRouter, createClientPlanRouter } = require('./src/routes/plans');
const { createCoachVideosRouter, createClientCoachVideosRouter } = require('./src/routes/coachVideos');
const { createRegistry } = require('./src/rules/registry');
const { FieldPath } = require('firebase-admin/firestore');
const { createExerciseBoardRouter, recordExerciseBests, forgetExerciseSession, deleteExerciseBests } = require('./src/routes/exerciseBoard');
const { pairId: friendPairId } = require('./src/routes/friends');
const { isBlockedEitherWay, profileKey } = require('./src/routes/profiles');
const { auth: fbAuth, db, FieldValue, firebaseEnabled, projectId: firebaseProjectId, initError: firebaseInitError } = require('./firebaseAdmin');
// Pro/Coach access from every source (subscriptions, passes, trials, …) —
// see src/entitlements.js.
const entitlements = createEntitlements({ db });
const { berekenClient } = require('./src/intakeCalculations');
const { compactWorkout, readStoredWorkout } = require('./workoutFormat');
const { computeSessionVolume, safeDocId, naturalDocId, syncEntryDocId, saveWorkoutWithTotals, batchSetAll, queryHistoryPage } = require('./workoutStore');

// The "Last updated" date of terms.html / privacy.html in the app repo. Bump it
// whenever either changes so users/{uid}.consents shows which version was agreed.
const TERMS_VERSION = '2026-10-02';
const coachShare = require('./src/coachShare');
const checkInPhotos = require('./src/checkInPhotos');
const checkInComments = require('./src/checkInComments');
const coachMessages = require('./src/coachMessages');
const formChecks = require('./src/formChecks');
const coachLibrary = require('./src/routes/coachLibrary');
const coachAutomations = require('./src/coachAutomations');

const app = express();

// Trust exactly one reverse-proxy hop. Required now that this runs as a
// Cloud Function: Google's load balancer sits in front of every request and
// sets X-Forwarded-For, but Express's default (trust nothing) makes
// express-rate-limit treat that header as spoofed, throwing
// ERR_ERL_UNEXPECTED_X_FORWARDED_FOR on every rate-limited route — which was
// silently hanging requests (signup, intake, /health, username checks)
// instead of ever sending a response. `true` (trust every hop, unbounded)
// fixes that error but trips a *different* express-rate-limit check
// (ERR_ERL_PERMISSIVE_TRUST_PROXY) since it'd let a client forge its own
// X-Forwarded-For prefix to dodge rate limiting; `1` trusts only the single
// real hop Google's infrastructure adds, which is both correct and what
// express-rate-limit expects. Render never had a proxy hop in front of the
// app, so this was never needed until now.
app.set('trust proxy', 1);

// ── Environment validation ────────────────────────────────────────────────────
// Required: AIRTABLE_TOKEN, AIRTABLE_BASE_ID, JWT_SECRET, ANTHROPIC_API_KEY
const missing = ['AIRTABLE_TOKEN', 'AIRTABLE_BASE_ID', 'JWT_SECRET']
  .filter(k => !process.env[k]);
if (missing.length) {
  console.warn(`[WARN] Missing env vars: ${missing.join(', ')}`);
}
// Deliberately not a hard throw here (it used to be): this file is now also
// require()'d by functions-entry.js, including during `firebase deploy`'s

// local "discovery" pass, which runs this module without the real Secret
// Manager value for JWT_SECRET — a throw at load time crashes that pass even
// though the actual deployed function has JWT_SECRET set correctly. All real
// uses of JWT_SECRET are inside request handlers (jwt.verify/jwt.sign), so a
// genuinely missing secret in a live deployment now fails per-request
// instead of refusing to start — same trade-off already made for
// Stripe/Airtable/Firebase elsewhere in this file.
if (!process.env.JWT_SECRET) {
  console.error('[FATAL] JWT_SECRET is not set — every authenticated route will fail until this is configured.');
}

const AIRTABLE_BASE_ID   = process.env.AIRTABLE_BASE_ID;
const AIRTABLE_API_TOKEN = process.env.AIRTABLE_API_TOKEN || process.env.AIRTABLE_TOKEN || null;
const JWT_SECRET         = process.env.JWT_SECRET;

// ── Tables ────────────────────────────────────────────────────────────────────
const WORKOUTS_TABLE      = 'Workouts';
const MACRO_TARGETS_TABLE = 'MacroTargets';
const DAILY_LOGS_TABLE    = process.env.AIRTABLE_DAILY_LOGS_TABLE    || 'DailyMacros';
const USERS_TABLE         = process.env.AIRTABLE_USERS_TABLE         || 'Users';
const TEMPLATES_TABLE_NAME = process.env.AIRTABLE_TEMPLATES_TABLE    || 'Templates';
const USERNAME_FIELD      = 'Username';

// ── Airtable client ───────────────────────────────────────────────────────────
const airtableEnabled = Boolean(AIRTABLE_API_TOKEN && AIRTABLE_BASE_ID);
// This account has hit Airtable's monthly API request quota (confirmed via
// direct probe: every call gets an instant 429 PUBLIC_API_BILLING_LIMIT_EXCEEDED,
// from anywhere, not just from this deployment) — so every Airtable call
// fails right now regardless of network path. Two settings to stop that from
// turning into a hang instead of a fast, catchable error:
// - requestTimeout: defaults to 5 minutes in this package, far longer than
//   Cloud Run's 60s request budget (this used to run on Render, which had no
//   such limit).
// - noRetryIfRateLimited: this package retries 429s with backoff by default,
//   which on a *persistent* 429 (a monthly quota, not a transient burst) just
//   burns through the whole request budget retrying against a wall that
//   won't open until next month's reset or a plan upgrade.
const base = airtableEnabled
  ? new Airtable({ apiKey: AIRTABLE_API_TOKEN, requestTimeout: 8000, noRetryIfRateLimited: true }).base(AIRTABLE_BASE_ID)
  : null;

if (!airtableEnabled) {
  console.warn('[WARN] Airtable disabled — AIRTABLE_TOKEN or AIRTABLE_BASE_ID not set.');
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function sendError(res, status, code, message, detail) {
  const payload = { success: false, error: { code, message } };
  if (detail) payload.error.detail = detail;
  return res.status(status).json(payload);
}

function sendSuccess(res, status, data = {}) {
  return res.status(status).json({ success: true, ...data });
}

function escapeAirtableFormulaValue(value) {
  return String(value).replace(/'/g, "''");
}

function safeJsonParse(value, fallback = null) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

function airtableHeaders() {
  return {
    Authorization: `Bearer ${AIRTABLE_API_TOKEN}`,
    'Content-Type': 'application/json'
  };
}

// fetch wrapper with 8-second timeout for all Airtable REST calls
function airtableFetch(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  return fetch(url, { ...options, signal: controller.signal })
    .finally(() => clearTimeout(timer));
}

// ── Auth middleware ───────────────────────────────────────────────────────────
// Transitional dual-mode auth (Phase 1 of Firebase migration):
//  - Firebase ID tokens (iss = securetoken.google.com/<project>) verified via
//    Admin SDK; email must be verified; username/tier/isCoach come from custom claims.
//  - Legacy custom JWTs still accepted until the cutover (removed in step 7 of
//    the migration plan, after end-to-end verification).
function isFirebaseIdToken(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    return typeof payload.iss === 'string' && payload.iss.startsWith('https://securetoken.google.com/');
  } catch {
    return false;
  }
}

// { skipEmailVerification } is used only by the signup-completion endpoint —
// the user has just created the account and cannot have verified yet.
async function verifyFirebaseToken(token, { skipEmailVerification = false } = {}) {
  const decoded = await fbAuth.verifyIdToken(token);
  if (!skipEmailVerification && !decoded.email_verified) {
    const err = new Error('Email not verified');
    err.code = 'auth.email_not_verified';
    throw err;
  }
  return {
    uid: decoded.uid,
    email: decoded.email,
    emailVerified: Boolean(decoded.email_verified),
    username: decoded.username,   // custom claim, set at signup-complete
    tier: decoded.tier || 'free', // custom claim
    isCoach: Boolean(decoded.isCoach),
    authProvider: 'firebase'
  };
}

function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return sendError(res, 401, 'auth.missing_token', 'Authorization token is required.');
  }

  if (firebaseEnabled && isFirebaseIdToken(token)) {
    verifyFirebaseToken(token)
      .then(user => {
        if (!user.username) {
          return sendError(res, 403, 'auth.signup_incomplete',
            'Account has no username claim. Complete signup via /auth/signup-complete.');
        }
        req.user = user;
        next();
      })
      .catch(err => {
        if (err.code === 'auth.email_not_verified') {
          return sendError(res, 403, 'auth.email_not_verified',
            'Email not verified. Check your inbox for the verification link.');
        }
        return sendError(res, 401, 'auth.invalid_token', 'Token invalid or expired. Please re-authenticate.');
      });
    return;
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      if (err.name === 'JsonWebTokenError' && err.message === 'invalid signature') {
        return sendError(res, 403, 'auth.invalid_signature',
          'Token signature is invalid. Clear stored token and sign in again.');
      }
      return sendError(res, 403, 'auth.invalid_token', 'Token invalid or expired. Please re-authenticate.');
    }
    req.user = user;
    next();
  });
}

// History GETs take ?username= for backwards compatibility, but only ever
// return the signed-in user's own data. Omitted -> the caller's own username;
// someone else's -> 403 (sent here, returns null).
function ownUsername(req, res) {
  const own = req.user?.username || '';
  const requested = typeof req.query.username === 'string' ? req.query.username.trim() : '';
  if (requested && requested.toLowerCase() !== own.toLowerCase()) {
    sendError(res, 403, 'auth.forbidden', 'You can only read your own data.');
    return null;
  }
  if (!own) {
    sendError(res, 403, 'auth.forbidden', 'Account has no username.');
    return null;
  }
  return own;
}

// ── Stripe (requires STRIPE_SECRET_KEY) ────────────────────────────────────────
// Initialized here, above CORS/body-parsing, because the webhook route below
// needs `stripe`/`stripeEnabled` and must itself be registered before the
// global express.json() middleware (see that route for why).
const stripeEnabled = Boolean(process.env.STRIPE_SECRET_KEY);
let stripe = null;
if (stripeEnabled) {
  const Stripe = require('stripe');
  stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
}

// ── CORS ──────────────────────────────────────────────────────────────────────
const defaultOrigins = 'https://pocketcoachcoms.org,http://localhost:5173';
const allowed = (process.env.CORS_ORIGINS ?? defaultOrigins)
  .split(',').map(s => s.trim()).filter(Boolean);

const allowAll    = allowed.length === 0;
const allowedSet  = new Set(allowed);

// Security headers
app.use(helmet());

app.use(cors({
  origin(origin, cb) {
    if (!origin) return cb(null, true);
    if (allowAll) return cb(null, true);
    // The native apps' WebViews send capacitor://localhost (iOS) and
    // https://localhost (Android). Node's URL parser returns "null" as the
    // origin for non-web schemes like capacitor://, so match the raw header too.
    if (allowedSet.has(origin)) return cb(null, true);
    try {
      if (allowedSet.has(new URL(origin).origin)) return cb(null, true);
      console.warn(`Blocked CORS origin: ${origin}`);
      return cb(null, false);
    } catch {
      return cb(null, false);
    }
  },
  credentials: true,
  allowedHeaders: ['Content-Type', 'Authorization'],
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']
}));

// POST /api/stripe/webhook — Stripe calls this directly, not through the app,
// so it must see the RAW request body to verify the signature
// (stripe.webhooks.constructEvent needs the exact bytes Stripe signed, not a
// re-serialized JSON object). Registered with its own express.raw() ABOVE
// the blanket express.json() call right below — Express stops at the first
// route that sends a response, so express.json() never touches this path.
// Configure this URL + get the matching secret from the Stripe Dashboard →
// Developers → Webhooks, and set STRIPE_WEBHOOK_SECRET.
//
// This closes gap #6 from PHASE2-NOTES.md: no webhook existed anywhere in
// this codebase, so userPlan/subStatus never actually updated after a real
// Stripe checkout completed — a paying user's account stayed on "free"
// until someone manually fixed it.
const stripeWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET || null;

app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!stripeEnabled || !stripeWebhookSecret) {
    console.warn('[Stripe webhook] Event received but Stripe/webhook secret is not configured — ignoring.');
    return res.status(503).send('Stripe webhook not configured');
  }

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], stripeWebhookSecret);
  } catch (err) {
    console.error('[Stripe webhook] Signature verification failed:', err.message);
    return res.status(400).send(`Webhook signature verification failed: ${err.message}`);
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        const { username, plan, billing } = session.metadata || {};
        if (username && plan) {
          await applyEntitlement({
            username, plan, status: 'active', billingCycle: billing || 'monthly',
            source: 'stripe', sourceCustomerId: session.customer,
          });
        }
        break;
      }
      case 'customer.subscription.created':
      case 'customer.subscription.updated': {
        const sub = event.data.object;
        const { username, plan, billing } = sub.metadata || {};
        if (username && plan) {
          await applyEntitlement({
            username, plan, status: sub.status, // active | trialing | past_due | unpaid | ...
            periodEnd: sub.current_period_end ? new Date(sub.current_period_end * 1000).toISOString() : null,
            billingCycle: billing || 'monthly',
            source: 'stripe', sourceCustomerId: sub.customer,
          });
        }
        break;
      }
      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        const { username } = sub.metadata || {};
        if (username) {
          await applyEntitlement({
            username, plan: 'free', status: 'canceled',
            source: 'stripe', sourceCustomerId: sub.customer,
          });
        }
        break;
      }
      case 'invoice.payment_failed': {
        // Renewal failed — Stripe will retry per its retry schedule (or per
        // Smart Retries if enabled); reflect past_due immediately rather
        // than waiting for the eventual subscription.updated/deleted event.
        const invoice = event.data.object;
        if (invoice.subscription) {
          const sub = await stripe.subscriptions.retrieve(invoice.subscription);
          const { username, plan, billing } = sub.metadata || {};
          if (username && plan) {
            await applyEntitlement({
              username, plan, status: 'past_due', billingCycle: billing || 'monthly',
              source: 'stripe', sourceCustomerId: sub.customer,
            });
          }
        }
        break;
      }
      default:
        break; // unhandled event types are fine to ignore
    }
    return res.json({ received: true });
  } catch (err) {
    console.error(`[Stripe webhook] Failed handling ${event.type}:`, err.message);
    // 500 so Stripe retries — a failure here is our-side (e.g. a Firestore
    // write error), not a reason to tell Stripe the event was bad.
    return res.status(500).send('Webhook handler failed');
  }
});

// The AI coach routes (src/routes/coach.js) take the phone's whole coach data
// pack — weeks of workouts, bodyweight, sleep and intake — which can outgrow
// 256kb. express.json() skips bodies that are already parsed, so this runs first.
// Program import carries the coach's file as base64 (8 MB cap → ~11 MB JSON).
app.use('/api/ai/coach/import-program', express.json({ limit: '12mb' }));
app.use('/api/ai/coach/import-plan', express.json({ limit: '12mb' }));
// Creating a plan from an imported file may carry the PDF to attach (≤ 600 KB).
app.use('/api/coach/plans', express.json({ limit: '2mb' }));
// Check-in photos: up to 10 photos of ~450 KB each, sent as data URLs.
app.use('/api/client/checkin-photos', express.json({ limit: '7mb' }));
app.use('/api/ai/coach', express.json({ limit: '1mb' }));
app.use(express.json({ limit: '256kb' }));

// ── Rate limiting ─────────────────────────────────────────────────────────────
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 min
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: { code: 'auth.rate_limited', message: 'Too many login attempts. Try again in 15 minutes.' } }
});

// `workout` + `workoutFormat` fields for a workout doc: the compact form
// (workoutFormat.js — verified lossless, falls back to the original) and
// always an explicit workoutFormat (null = stored as sent), so an overwrite
// or merge can never leave a stale marker next to an uncompacted workout.
function storedWorkoutFields(workout) {
  const { workout: stored, format } = compactWorkout(workout);
  return { workout: stored, workoutFormat: format };
}


// ── Routes ────────────────────────────────────────────────────────────────────

// Health check
app.get('/healthz', (_req, res) => res.send('ok'));
app.get('/health', async (_req, res) => {
  const hasToken  = Boolean(process.env.AIRTABLE_API_TOKEN || process.env.AIRTABLE_TOKEN);
  const hasBaseId = Boolean(process.env.AIRTABLE_BASE_ID);
  const hasJwt    = Boolean(process.env.JWT_SECRET);

  // This used to ping all 7 Airtable tables live on every /health call —
  // removed. Firestore is the actual source of truth post-Phase-2, so
  // Airtable being unreachable no longer means the app is unhealthy; it was
  // also actively broken (Airtable's account is over its monthly API quota,
  // see the requestTimeout/noRetryIfRateLimited comment on the Airtable
  // client above), so this loop was taking the full ~60s timeout budget on
  // every single health check and returning 504 instead of ever answering.
  // "enabled" below is just an env-var presence check, no network call.
  const ok = hasJwt;
  res.status(ok ? 200 : 503).json({
    status: ok ? 'ok' : 'misconfigured',
    env: {
      AIRTABLE_TOKEN:   hasToken  ? 'SET' : 'MISSING',
      AIRTABLE_BASE_ID: hasBaseId ? 'SET' : 'MISSING',
      JWT_SECRET:       hasJwt    ? 'SET' : 'MISSING',
      FIREBASE_SERVICE_ACCOUNT: process.env.FIREBASE_SERVICE_ACCOUNT ? 'SET' : 'MISSING',
    },
    // Activity Sync (Google Health) is off until all three are SET.
    activitySync: {
      GOOGLE_HEALTH_CLIENT_ID:     process.env.GOOGLE_HEALTH_CLIENT_ID ? 'SET' : 'MISSING',
      GOOGLE_HEALTH_CLIENT_SECRET: process.env.GOOGLE_HEALTH_CLIENT_SECRET ? 'SET' : 'MISSING',
      GOOGLE_HEALTH_REDIRECT_URI:  process.env.GOOGLE_HEALTH_REDIRECT_URI ? 'SET' : 'MISSING',
    },
    firebase: {
      enabled: firebaseEnabled,
      projectId: firebaseProjectId,
      initError: firebaseInitError || null,
    },
    airtable: {
      enabled: airtableEnabled,
      note: 'Legacy fallback for not-yet-migrated accounts only — no longer live-checked here.',
    },
  });
});

// ── User plan endpoint ───────────────────────────────────────────────────────
// Shared by GET /api/user/plan and the premium-content routes so both read the
// plan from the same place: Firestore first, Airtable for not-yet-migrated accounts.
// opts.verifyCoachCode=false skips the coach-code check (src/coachCode.js);
// that check itself asks for the coach's plan, and must not recurse.
async function getUserPlanInfo(username, opts = {}) {
  if (!username) return { plan: 'free', status: 'none' };

  const uid = await resolveFirestoreUid(username);
  if (uid) {
    // Coach-code Pro first, so a lapsed coach plan or removed link counts below.
    let coachPro = null;
    if (opts.verifyCoachCode !== false) {
      try { coachPro = await coachCodes.verify(uid); } catch (err) {
        console.error('[getUserPlanInfo] coach code check failed:', err.message);
      }
    }
    const snap = await db.collection('users').doc(uid).get();
    const u = snap.exists ? snap.data() : {};
    // Effective plan across every entitlement source (src/entitlements.js).
    // `plan`/`status` stay backward compatible: a subscription reports its own
    // status; any other source (pass, trial, lifetime, …) reports 'active'.
    let effective;
    try {
      effective = await entitlements.resolveEffectivePlan(uid, new Date(), u);
    } catch (err) {
      // Entitlements unreadable → fall back to the subscription fields alone.
      console.error('[getUserPlanInfo] entitlements lookup failed:', err.message);
      const legacy = legacyEntitlement(u);
      effective = pickEffective(legacy ? [legacy] : []);
    }
    const fromSubscription = effective.plan === 'free' || SUBSCRIPTION_SOURCES.has(effective.source);
    const lastMoment = toDate(u.lastMomentTrialAt);
    return {
      plan: effective.plan,
      status: fromSubscription ? (u.subStatus || 'none') : 'active',
      periodEnd: u.subCurrentPeriodEnd || '',
      billingCycle: u.billingCycle || '',
      source: u.subSource || '', // 'stripe' | 'apple' — which store manages the subscription
      referralCode: u.referralCode || '',
      referralCredits: Number(u.referralCredits) || 0,
      planSource: effective.plan === 'free' ? null : effective.source,
      planExpiresAt: effective.expiresAt ? effective.expiresAt.toISOString() : null,
      trial: {
        usedReverseTrial: u.usedReverseTrial === true,
        lastMomentTrialAt: lastMoment ? lastMoment.toISOString() : null,
      },
      ai: null, // filled in by PAY2-3 (AI metering)
      coachPro, // { status: 'active' | 'paused' | 'revoked', coachUsername } or null
    };
  }

  const user = await getUserByUsername(username);
  if (!user) return { plan: 'free', status: 'none' };

  const f = user.fields;
  return {
    plan: f.UserPlan || 'free',
    status: f.SubStatus || 'none',
    periodEnd: f.SubCurrentPeriodEnd || '',
    billingCycle: f.BillingCycle || '',
    referralCode: f.ReferralCode || '',
    referralCredits: Number(f.ReferralCredits) || 0,
  };
}

// Paid-plan gate for AI features (src/planAccess.js). ADMIN_USERNAMES always
// get full access.
const planAccess = createPlanAccess({
  getPlanInfo: getUserPlanInfo,
  adminUsernames: parseUsernames(process.env.ADMIN_USERNAMES),
  sendError,
});
const requirePaidPlan = planAccess.requirePaidPlan;
const requireCoachPlan = planAccess.requireCoachPlan;

// Coach Pro codes (src/coachCode.js): a coach's code gives the athlete who
// enters it Pro while the coach keeps the Coach plan.
const coachCodes = createCoachCodes({
  db,
  coachHasPlan: async coachUid => {
    const name = await usernameForUid(coachUid);
    return !!name && hasCoachAccess(name, { verifyCoachCode: false });
  },
});

app.get('/api/user/plan', authenticateToken, async (req, res) => {
  try {
    const info = await getUserPlanInfo(req.user?.username);
    // `admin` lets the app unlock paid features for admins without
    // pretending they hold a subscription.
    return res.json({ ...info, admin: planAccess.isAdmin(req.user?.username) });
  } catch (err) {
    console.error('[GET /api/user/plan]', err.message);
    // Not a 200 "free": the app would overwrite a paying user's cached plan.
    return sendError(res, 503, 'plan.lookup_failed', 'Could not load your plan. Please try again.');
  }
});

app.post('/api/stripe/create-checkout-session', authenticateToken, async (req, res) => {
  if (!stripeEnabled) return res.status(503).json({ error: 'Stripe not configured' });
  // Always the caller's own account — a body `username` is ignored, so a
  // subscription (and its referral-credit trial) can't be pointed at someone else.
  const username = req.user?.username;
  const { plan, billing, withdrawalWaiver } = req.body;
  if (!username || !plan) return res.status(400).json({ error: 'username and plan required' });
  // EU/UK consumers have a 14-day right of withdrawal. The checkout sheet asks
  // them to request that the paid service start within it (terms.html#refunds);
  // without that request we'd owe a full refund for any days already used.
  if (withdrawalWaiver !== true) {
    return res.status(400).json({ error: 'Please confirm you want your subscription to start straight away.' });
  }

  const priceMap = {
    'pro-monthly': process.env.STRIPE_PRO_MONTHLY_PRICE_ID,
    'pro-annual': process.env.STRIPE_PRO_ANNUAL_PRICE_ID,
    'coach-monthly': process.env.STRIPE_COACH_MONTHLY_PRICE_ID,
    'coach-annual': process.env.STRIPE_COACH_ANNUAL_PRICE_ID,
  };
  const priceId = priceMap[plan + '-' + (billing || 'monthly')];
  if (!priceId) return res.status(400).json({ error: 'Invalid plan/billing combination' });

  try {
    const uid = await resolveFirestoreUid(username);
    let credits = 0;
    let stripeCustomerId = null;
    if (uid) {
      const snap = await db.collection('users').doc(uid).get();
      const u = snap.exists ? snap.data() : {};
      credits = Number(u.referralCredits) || 0;
      stripeCustomerId = u.stripeCustomerId || null;
    } else {
      const user = await getUserByUsername(username);
      credits = user ? (Number(user.fields.ReferralCredits) || 0) : 0;
      stripeCustomerId = user?.fields?.StripeCustomerId || null;
    }
    const trialDays = credits > 0 ? credits * 30 : 7;

    const sessionParams = {
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: (process.env.APP_URL || 'https://pocketcoachcoms.org') + '/payment-success.html?plan=' + plan,
      cancel_url: (process.env.APP_URL || 'https://pocketcoachcoms.org') + '/#pricing',
      subscription_data: {
        trial_period_days: trialDays,
        metadata: {
          username, plan, billing: billing || 'monthly',
          // Record of the withdrawal-period request, kept with the subscription.
          withdrawalWaiverAcceptedAt: new Date().toISOString(),
          termsVersion: TERMS_VERSION
        }
      },
      metadata: { username, plan, billing: billing || 'monthly' },
    };
    if (stripeCustomerId) sessionParams.customer = stripeCustomerId;

    const session = await stripe.checkout.sessions.create(sessionParams);
    return res.json({ url: session.url });
  } catch (err) {
    console.error('[Stripe checkout]', err.message);
    return res.status(500).json({ error: 'Could not create checkout session' });
  }
});

app.get('/api/stripe/portal', authenticateToken, async (req, res) => {
  if (!stripeEnabled) return res.status(503).json({ error: 'Stripe not configured' });
  // Always the caller's own portal — never one named in ?username=.
  const username = req.user?.username;
  if (!username) return res.status(400).json({ error: 'username required' });

  try {
    const uid = await resolveFirestoreUid(username);
    let customerId;
    if (uid) {
      const snap = await db.collection('users').doc(uid).get();
      customerId = snap.exists ? snap.get('stripeCustomerId') : null;
    } else {
      const user = await getUserByUsername(username);
      customerId = user?.fields?.StripeCustomerId;
    }
    if (!customerId) return res.status(400).json({ error: 'No Stripe customer found' });

    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: (process.env.APP_URL || 'https://pocketcoachcoms.org') + '/#settings',
    });
    return res.json({ url: session.url });
  } catch (err) {
    console.error('[Stripe portal]', err.message);
    return res.status(500).json({ error: 'Could not create portal session' });
  }
});

// ── Apple In-App Purchase (IAP) ─────────────────────────────────────────────────
// The iOS payment rail — see src/routes/appleIap.js. Off until
// APPLE_IAP_ENABLED=true. Sandbox purchases (TestFlight, App Review) always
// verify; production purchases verify once APPLE_APP_ID (the app's numeric
// Apple ID from App Store Connect) is set.
const appleIapEnabled = process.env.APPLE_IAP_ENABLED === 'true';
let appleVerifiers = [];
if (appleIapEnabled) {
  try {
    const { SignedDataVerifier, Environment } = require('@apple/app-store-server-library');
    appleVerifiers = createAppleVerifiers({
      SignedDataVerifier, Environment,
      // Apple Root CA - G3, from https://www.apple.com/certificateauthority/
      // (SHA-256 63:34:3A:BF:…:3E:91:79).
      rootCertificates: [fs.readFileSync(path.join(__dirname, 'certs', 'AppleRootCA-G3.cer'))],
      bundleId: process.env.APPLE_BUNDLE_ID || 'org.pocketcoachcoms.app',
      appAppleId: process.env.APPLE_APP_ID,
    });
  } catch (err) {
    console.error('[Apple IAP] Failed to initialize verifiers:', err.message);
    appleVerifiers = [];
  }
}
app.use('/api/iap/apple', createAppleIapRouter({
  db, enabled: appleIapEnabled, verifiers: appleVerifiers, applyEntitlement,
  resolveUid: resolveFirestoreUid, authenticate: authenticateToken, sendError, sendSuccess,
}));

// ── Account deletion ──────────────────────────────────────────────────────────
// Apple App Store Guideline 5.1.1(v) requires apps that support account
// creation to also offer in-app, self-service account deletion — pointing
// users at a support email does not satisfy it. This must remove enough that
// the same username/email can be used to sign up again afterward.
//
// Primary path is Firebase/Firestore (the only track new signups use since
// /register and /login were retired — see the 410 responses above). A
// best-effort Airtable cleanup also runs for two leftover cases: (a) accounts
// that reclaimed a pre-Firebase username before the Airtable reclaim path was
// removed and may still have an old Users row, and (b) any account that never
// migrated at all, callable here only for as long as it still holds an
// unexpired legacy JWT. Each Airtable table delete is independent and
// swallows its own error so one failing table (e.g. a stale rate limit)
// doesn't stop the rest — this endpoint should make maximum forward
// progress, not succeed or fail atomically.
//
// Only cancels the Stripe rail — an Apple IAP subscription (see
// applyEntitlement/subSource below) cannot be canceled from our backend at
// all; Apple is the merchant of record and only the user (iOS Settings →
// [name] → Subscriptions) or an App Store Connect refund can stop it. This
// only stops us from continuing to *grant* access once the account is gone.
async function cancelStripeSubscriptions(customerId) {
  if (!stripeEnabled || !customerId) return;
  try {
    const subs = await stripe.subscriptions.list({ customer: customerId, status: 'all', limit: 100 });
    await Promise.all(
      subs.data
        .filter(s => !['canceled', 'incomplete_expired'].includes(s.status))
        .map(s => stripe.subscriptions.cancel(s.id).catch(err =>
          console.error(`[Account deletion] Failed to cancel subscription ${s.id}:`, err.message)))
    );
  } catch (err) {
    console.error('[Account deletion] Stripe subscription lookup failed:', err.message);
  }
}

// recursiveDelete walks users/{uid} and coaches/{uid} and every subcollection
// under them (templates, workouts + their sets, programs, macro/body/cardio/
// crossfit logs, mobility routines & sessions, coach clients & exercise
// videos — see PHASE2-NOTES.md's collection-home table) in one call each, so
// this doesn't need to know every subcollection name individually.
// A client's data also lives on their coaches' side: each coach's roster
// entry (coaches/{coachUid}/clients/{uid}, with the notes under it). The
// client's own coachInvites/coachAssignment docs name those coaches, so read
// them before users/{uid} is wiped.
async function deleteFromCoachRosters(uid) {
  const [invites, assignments] = await Promise.all([
    db.collection(`users/${uid}/coachInvites`).get(),
    db.collection(`users/${uid}/coachAssignment`).get(),
  ]);
  const coachUids = new Set([...invites.docs, ...assignments.docs].map(d => d.id));
  for (const coachUid of coachUids) {
    await db.recursiveDelete(db.collection(`coaches/${coachUid}/clients`).doc(uid));
    // The coach's master plans for this client (drafts included).
    const plans = await db.collection(`coaches/${coachUid}/plans`).where('clientUid', '==', uid).get();
    for (const doc of plans.docs) await doc.ref.delete();
  }
}

// Intake leads are stored before the person has an account, so they carry
// no uid — match them by the email given on the intake form.
async function deleteIntakeLeads(email) {
  if (!email || !INTAKE_COACH_USERNAME) return;
  const coachUid = await resolveFirestoreUid(INTAKE_COACH_USERNAME);
  if (!coachUid) return;
  const leads = db.collection(`coaches/${coachUid}/leads`);
  const variants = [...new Set([String(email).trim(), String(email).trim().toLowerCase()])];
  for (const value of variants) {
    const snap = await leads.where('intake.persoonsgegevens.email', '==', value).get();
    for (const doc of snap.docs) await doc.ref.delete();
  }
}

async function deleteFirestoreAccount(uid, username, email) {
  await deleteFromCoachRosters(uid);
  await deleteIntakeLeads(email);
  // As a coach, remove my invite and assignment from each client's side.
  const asCoach = await db.collection(`coaches/${uid}/clients`).get();
  for (const d of asCoach.docs) {
    await db.collection(`users/${d.id}/coachInvites`).doc(uid).delete();
    await db.collection(`users/${d.id}/coachAssignment`).doc(uid).delete();
  }
  await coachCodes.removeForCoach(uid); // their coach code stops working
  await db.recursiveDelete(db.collection('users').doc(uid));
  await db.recursiveDelete(db.collection('coaches').doc(uid)); // no-op if this user never coached anyone
  await db.collection('usernames').doc(String(username).toLowerCase()).delete();
  await deleteProfile(db, username);
  await deleteFriendships(db, username);
  await removeUserFromGroups(db, username);
  await deleteFeedPosts(db, username);
  await deleteShares(db, username);
  await deleteUserMealPhotos(db, profileKey(username));
  // Check-in comment threads, as a client and as a coach (check-in photos
  // live under users/{uid} and went with it above).
  await checkInComments.deleteComments(db, { clientUid: uid });
  await checkInComments.deleteComments(db, { coachUid: uid });
  await coachMessages.deleteMessages(db, { clientUid: uid });
  await coachMessages.deleteMessages(db, { coachUid: uid });
  await formChecks.deleteFormChecks(db, { clientUid: uid });
  await formChecks.deleteFormChecks(db, { coachUid: uid });
  await deleteExerciseBests(db, username);
  await deleteNotifications(db, username);
  await deleteCalendarFeed(db, username);
  forgetCachedUid(username);
}

// Every Airtable table that stores per-user rows keyed by the plain Username
// field (USERNAME_FIELD) — mirrors the route-cutover table in PHASE2-NOTES.md.
// DailyMissionState (keyed by UserId) and CoachClients (keyed by CoachId/
// ClientId/ClientName) are handled separately below since they use different
// field names.
//
// A function, not a plain array: several of these table constants
// (BODYWEIGHT_TABLE, CARDIO_TABLE, PROGRAMS_TABLE, MOBILITY_*_TABLE etc.) are
// declared further down the file, after this point in module load order —
// building the array eagerly here would throw "Cannot access ... before
// initialization". Called lazily inside deleteLegacyAirtableAccount(), at
// request time, well after the whole module (and every const in it) has
// finished loading.
function legacyUsernameKeyedTables() {
  return [
    WORKOUTS_TABLE, MACRO_TARGETS_TABLE, DAILY_LOGS_TABLE, TEMPLATES_TABLE_NAME,
    BODYWEIGHT_TABLE, MEASUREMENTS_TABLE, CARDIO_TABLE, CROSSFIT_TABLE,
    PROGRAMS_TABLE, MOBILITY_ROUTINES_TABLE, MOBILITY_SESSIONS_TABLE,
  ];
}

async function deleteAirtableRecordsWhere(tableName, formula) {
  if (!airtableEnabled) return;
  try {
    const records = await base(tableName).select({ filterByFormula: formula }).all();
    for (let i = 0; i < records.length; i += 10) {
      const chunk = records.slice(i, i + 10).map(r => r.id);
      if (chunk.length) await base(tableName).destroy(chunk);
    }
  } catch (err) {
    console.error(`[Account deletion] Failed clearing ${tableName}:`, err.message);
  }
}

async function deleteLegacyAirtableAccount(username, userRecordId) {
  const safe = escapeAirtableFormulaValue(username);
  for (const table of legacyUsernameKeyedTables()) {
    await deleteAirtableRecordsWhere(table, `{${USERNAME_FIELD}}='${safe}'`);
  }
  await deleteAirtableRecordsWhere(DAILY_MISSION_TABLE, `{UserId}='${safe}'`);
  await deleteAirtableRecordsWhere(COACH_CLIENTS_TABLE,
    `OR({CoachId}='${safe}',{ClientId}='${safe}',{ClientName}='${safe}')`);
  if (userRecordId) {
    try { await base(USERS_TABLE).destroy([userRecordId]); }
    catch (err) { console.error('[Account deletion] Failed deleting Users row:', err.message); }
  }
}

app.delete('/account', authenticateToken, async (req, res) => {
  const username = req.user?.username;
  if (!username) return sendError(res, 400, 'account.no_username', 'No username on this session.');

  try {
    const uid = await resolveFirestoreUid(username);
    const legacyUser = airtableEnabled ? await getUserByUsername(username) : null;

    let stripeCustomerId = legacyUser?.fields?.StripeCustomerId || null;
    let email = req.user?.email || null;
    if (uid) {
      const snap = await db.collection('users').doc(uid).get();
      stripeCustomerId = snap.get('stripeCustomerId') || stripeCustomerId;
      email = email || snap.get('email') || null;
    }
    await cancelStripeSubscriptions(stripeCustomerId);

    if (uid) await deleteFirestoreAccount(uid, username, email);
    if (legacyUser || !uid) await deleteLegacyAirtableAccount(username, legacyUser?.id);

    if (uid && firebaseEnabled) {
      await fbAuth.deleteUser(uid).catch(err =>
        console.error('[Account deletion] Failed deleting Firebase Auth user:', err.message));
    }

    console.info(`[Account deletion] Completed for "${username}" (uid: ${uid || 'none'})`);
    return sendSuccess(res, 200, { deleted: true });
  } catch (err) {
    console.error('[DELETE /account]', err.message);
    return sendError(res, 500, 'account.delete_failed', 'Could not delete account. Please try again or contact support.');
  }
});

// ── Referral endpoints ───────────────────────────────────────────────────────
app.get('/api/referral/validate', async (req, res) => {
  const code = req.query.code;
  if (!code) return res.json({ valid: false });

  // A referral code's owner could be on either side depending on when they
  // migrated — check Firestore first, then fall back to Airtable.
  if (firebaseEnabled) {
    try {
      const snap = await db.collection('users').where('referralCode', '==', code).limit(1).get();
      if (!snap.empty) {
        const u = snap.docs[0].data();
        return res.json({ valid: true, referrerName: (u.username || '').slice(0, 8) });
      }
    } catch (err) {
      console.error('[GET /api/referral/validate] Firestore lookup failed:', err.message);
    }
  }

  if (!airtableEnabled) return res.json({ valid: false });
  try {
    const safe = escapeAirtableFormulaValue(code);
    const records = await base(USERS_TABLE).select({ filterByFormula: `{ReferralCode}='${safe}'`, maxRecords: 1 }).firstPage();
    if (!records.length) return res.json({ valid: false });
    return res.json({ valid: true, referrerName: (records[0].fields.Username || '').slice(0, 8) });
  } catch { return res.json({ valid: false }); }
});

app.get('/api/referral/stats', authenticateToken, async (req, res) => {
  const username = req.user?.username;
  if (!username) return res.json({ referralCode: '', referralCredits: 0, referralCount: 0 });
  try {
    const uid = await resolveFirestoreUid(username);
    let code = '', credits = 0;
    if (uid) {
      const snap = await db.collection('users').doc(uid).get();
      const u = snap.exists ? snap.data() : {};
      code = u.referralCode || '';
      credits = Number(u.referralCredits) || 0;
    } else if (airtableEnabled) {
      const user = await getUserByUsername(username);
      if (!user) return res.json({ referralCode: '', referralCredits: 0, referralCount: 0 });
      code = user.fields.ReferralCode || '';
      credits = Number(user.fields.ReferralCredits) || 0;
    } else {
      return res.json({ referralCode: '', referralCredits: 0, referralCount: 0 });
    }

    // Referred users can land in either store depending on when each of
    // them migrated — count both and sum, regardless of which store the
    // referrer's own code came from.
    let count = 0;
    if (code) {
      if (firebaseEnabled) {
        try {
          const referredSnap = await db.collection('users').where('referredByCode', '==', code).get();
          count += referredSnap.docs.length;
        } catch (err) {
          console.error('[GET /api/referral/stats] Firestore count failed:', err.message);
        }
      }
      if (airtableEnabled) {
        const safe = escapeAirtableFormulaValue(code);
        const referred = await base(USERS_TABLE).select({ filterByFormula: `{ReferredBy}='${safe}'` }).firstPage();
        // Exclude anyone who's since migrated — they're already counted via
        // the Firestore branch above (referredByCode), and would otherwise
        // be double-counted (old Airtable row + new Firestore doc).
        const stillLegacy = await Promise.all(referred.map(async r =>
          (await resolveFirestoreUid(r.fields?.Username)) ? null : r
        ));
        count += stillLegacy.filter(Boolean).length;
      }
    }
    return res.json({ referralCode: code, referralCredits: credits, referralCount: count });
  } catch { return res.json({ referralCode: '', referralCredits: 0, referralCount: 0 }); }
});

// Env check — no sensitive values
app.get('/envcheck', (_req, res) => {
  res.json({ success: true, airtableConfigured: airtableEnabled });
});

// Config — base ID only, no token exposed, safe to be public
app.get('/config', (_req, res) => {
  res.json({ airtableBaseId: AIRTABLE_BASE_ID || null });
});

// ── Firestore migration routing ───────────────────────────────────────────────
// Phase 2 route cutover: resolves a Firestore uid from a username, regardless
// of whether THIS request came in on a Firebase ID token or a legacy JWT (the
// lookup only depends on whether that username ever completed
// /auth/signup-complete, not which token type is attached to the request).
//
// Per-route rule this enables: if a uid resolves, that user has migrated —
// read/write Firestore exclusively for this route. If not, they haven't
// migrated — read/write Airtable exactly as before. This is deliberately NOT
// a dual-write/fallback-merge: once migrated, Firestore is the sole source of
// truth for a converted route (legacyMigration.js already copied their
// history at migration time), so there's no risk of a route silently serving
// a stale partial view from two half-populated stores.
// Almost every route resolves username -> uid first, which cost one Firestore
// read per request. Found mappings are cached per instance for
// UID_CACHE_TTL_MS: a username only ever maps to one uid (set once at
// signup-complete), and deleteFirestoreAccount() drops its entry here.
// "Not found" is deliberately not cached, so a user who finishes
// signup-complete moves off the Airtable path immediately. Caveat: another
// warm instance can keep a deleted account's mapping for up to the TTL.
const UID_CACHE_TTL_MS = 5 * 60 * 1000;
const UID_CACHE_MAX = 10000;
const uidCache = new Map(); // lowercased username -> { uid, at }

function forgetCachedUid(username) {
  if (username) uidCache.delete(String(username).toLowerCase());
}

async function resolveFirestoreUid(username) {
  if (!firebaseEnabled || !username) return null;
  const key = String(username).toLowerCase();
  const hit = uidCache.get(key);
  if (hit && Date.now() - hit.at < UID_CACHE_TTL_MS) return hit.uid;
  try {
    const snap = await db.collection('usernames').doc(key).get();
    const uid = snap.exists ? (snap.get('uid') || null) : null;
    if (uid) {
      if (uidCache.size >= UID_CACHE_MAX) uidCache.delete(uidCache.keys().next().value); // evict oldest
      uidCache.set(key, { uid, at: Date.now() });
    } else {
      uidCache.delete(key);
    }
    return uid;
  } catch (err) {
    console.error('[Firestore] resolveFirestoreUid failed:', err.message);
    return null; // fail safe to the Airtable path rather than erroring the request
  }
}

// Get full user record by username (for plan/billing queries)
async function getUserByUsername(username) {
  if (!airtableEnabled) return null;
  try {
    const safe = escapeAirtableFormulaValue(username);
    const records = await base(USERS_TABLE)
      .select({ filterByFormula: `{Username}='${safe}'`, maxRecords: 1 })
      .firstPage();
    if (!records.length) return null;
    return { id: records[0].id, fields: records[0].fields };
  } catch { return null; }
}

// Update user plan fields in Airtable
async function updateUserPlan(recordId, fields) {
  if (!airtableEnabled || !recordId) return false;
  try {
    await base(USERS_TABLE).update([{ id: recordId, fields }]);
    return true;
  } catch (err) {
    console.error('[updateUserPlan] Failed:', err.message);
    return false;
  }
}

// Single write path for subscription state — the Stripe webhook and the
// Apple IAP handlers (both further down) both call this, so both payment
// rails converge on the exact same users/{uid} fields that
// GET /api/user/plan already reads, instead of each rail growing its own
// slightly-different update logic. Also syncs the `tier` custom claim, since
// that's what gates routes for Firebase-auth'd users and only refreshes on
// the client's next ID-token refresh (getIdToken(true) after checkout).
//
// Supersedes the old syncTierClaim() helper (PAY-1, never had a caller) —
// same claim-sync behavior, plus subStatus/periodEnd/billingCycle/source.
//
// Accepts EITHER `username` (the Stripe rail's checkout/subscription
// metadata carries username, not uid) OR `uid` directly (the Apple rail
// resolves uid from the appAccountToken set at purchase time — see
// payments.js — since Apple notifications don't carry a username at all).
async function applyEntitlement({ username, uid, plan, status, periodEnd = null, billingCycle = null, source, sourceCustomerId = null, revoked = false }) {
  if (!firebaseEnabled) return false;
  let resolvedUid = uid || null;
  try {
    if (!resolvedUid && username) {
      resolvedUid = await resolveFirestoreUid(username);
    }
    if (!resolvedUid) {
      console.warn(`[applyEntitlement] No Firestore uid for ${username ? `username "${username}"` : `uid "${uid}"`} — cannot apply entitlement.`);
      return false;
    }

    const fields = {
      userPlan: plan,
      subStatus: status,
      subCurrentPeriodEnd: periodEnd,
      billingCycle,
      subSource: source, // 'stripe' | 'apple' — which rail owns this subscription
    };
    if (source === 'stripe' && sourceCustomerId) fields.stripeCustomerId = sourceCustomerId;
    if (source === 'apple' && sourceCustomerId) fields.appleOriginalTransactionId = sourceCustomerId;
    await db.collection('users').doc(resolvedUid).set(fields, { merge: true });

    // Mirror into users/{uid}/entitlements. The user-doc fields above stay the
    // source of truth for subscriptions, so a failed mirror is logged, not fatal.
    try {
      await entitlements.mirrorSubscription(resolvedUid, { plan, status, rail: source, ref: sourceCustomerId || '', revoked });
    } catch (err) {
      console.error('[applyEntitlement] entitlement mirror failed:', err.message);
    }

    const { customClaims = {} } = await fbAuth.getUser(resolvedUid);
    await fbAuth.setCustomUserClaims(resolvedUid, { ...customClaims, tier: plan });
    return true;
  } catch (err) {
    console.error('[applyEntitlement] Failed:', err.message);
    return false;
  }
}

// Generate unique referral code
function generateReferralCode(username) {
  const base36 = username.replace(/[^a-zA-Z0-9]/g, '').toUpperCase().slice(0, 5);
  const rand = Math.random().toString(36).substring(2, 6).toUpperCase();
  return `${base36}-${rand}`;
}

// Register — hard cutover (see /login): Airtable no longer accepts new
// accounts. Every client now goes through Firebase signup + /auth/signup-complete.
// Route kept (rather than deleted) so a rollback is a one-line revert.
app.post('/register', loginLimiter, async (_req, res) => {
  return sendError(res, 410, 'auth.legacy_registration_disabled',
    'Username/password signup has moved. Please use the app’s sign-up flow.');
});

// Login — legacy Airtable-credentialed route, retired now that migration is
// complete (no pre-Firebase accounts remain to verify against Airtable).
// Route kept, like /register, so a rollback is a one-line revert. Every
// client now goes through Firebase (see /auth/email-for-username + the
// client SDK's signInWithEmailAndPassword).
app.post('/login', loginLimiter, async (_req, res) => {
  return sendError(res, 410, 'auth.legacy_login_disabled',
    'Username/password login has moved. Please use the app’s sign-in flow.');
});

// ── Firebase Auth endpoints (Phase 1 migration) ───────────────────────────────
const USERNAME_RE = /^[a-zA-Z0-9_.-]{2,64}$/;

// Words rejected in usernames, display names and bios: the built-in list plus
// any extras in OBJECTIONABLE_TERMS (comma-separated, `*` wildcards allowed).
const OBJECTIONABLE_TERMS = [
  ...DEFAULT_OBJECTIONABLE_TERMS,
  ...parseProfileTerms(process.env.OBJECTIONABLE_TERMS),
];

// Sends the 400 and returns true if `username` can't be registered. Usernames
// are public (leaderboard, feed, friends), so they get the same
// objectionable-content check as display names and bios.
function rejectUsername(res, username) {
  if (!USERNAME_RE.test(username)) {
    sendError(res, 400, 'auth.invalid_username',
      'Username must be 2-64 characters: letters, numbers, dot, dash, underscore.');
    return true;
  }
  if (containsObjectionable(username, OBJECTIONABLE_TERMS)) {
    sendError(res, 400, 'auth.objectionable_username',
      'That username isn’t allowed. Please choose another.');
    return true;
  }
  return false;
}

const usernameCheckLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60, // typed availability checks are chattier than login attempts
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: { code: 'auth.rate_limited', message: 'Too many requests. Try again shortly.' } }
});

// GET /auth/username-available?username=
app.get('/auth/username-available', usernameCheckLimiter, async (req, res) => {
  if (!firebaseEnabled) return sendError(res, 503, 'auth.firebase_disabled', 'Firebase auth is not configured.');
  const username = typeof req.query.username === 'string' ? req.query.username.trim() : '';
  if (rejectUsername(res, username)) return;
  try {
    // Firestore is the sole source of truth for accounts now — the Airtable
    // legacy-reclaim check was retired once migration completed (it also used
    // to take the whole signup flow down whenever Airtable's API quota was
    // exhausted, since a fresh signup had no need to touch Airtable at all).
    const snap = await db.collection('usernames').doc(username.toLowerCase()).get();
    return sendSuccess(res, 200, { username, available: !snap.exists });
  } catch (err) {
    console.error('[AUTH] username-available failed:', err.message);
    return sendError(res, 500, 'auth.server_error', 'Could not check username.');
  }
});

// POST /auth/signup-complete — body { username, referredBy?, consents },
// Bearer = fresh
// Firebase ID token. Runs after createUserWithEmailAndPassword:
//  1. claims usernames/{username} + creates users/{uid} in one transaction
//  2. sets custom claims (username, tier: 'free', isCoach: false)
//
// `consents` must be { ageConfirmed: true, healthData: true } — the two
// unticked boxes on the signup form. The Terms require users to be 16+, and
// GDPR Art. 9 needs an explicit, affirmative opt-in before we store health
// data, so signup is refused without both. What was agreed, and when, is kept
// on users/{uid}.consents as the record of that consent.
//
// The Airtable legacy-reclaim path (matching a username against an old
// pre-Firebase Users row, verifying its password, migrating its data) was
// retired now that migration is complete — there are no legacy accounts left
// to reclaim, and keeping that check meant every single signup depended on
// Airtable's API being up, which took the whole signup flow down whenever
// Airtable's request quota was exhausted (see the removed `airtableEnabled`
// branch in git history if this ever needs resurrecting).
app.post('/auth/signup-complete', loginLimiter, async (req, res) => {
  if (!firebaseEnabled) return sendError(res, 503, 'auth.firebase_disabled', 'Firebase auth is not configured.');

  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return sendError(res, 401, 'auth.missing_token', 'Authorization token is required.');

  let fbUser;
  try {
    // Email cannot be verified yet — the account was created seconds ago
    fbUser = await verifyFirebaseToken(token, { skipEmailVerification: true });
  } catch {
    return sendError(res, 401, 'auth.invalid_token', 'Token invalid or expired.');
  }

  const username = typeof req.body?.username === 'string' ? req.body.username.trim() : '';
  const referredByCode = typeof req.body?.referredBy === 'string' ? req.body.referredBy.trim() : '';
  if (rejectUsername(res, username)) return;
  const consents = req.body?.consents || {};
  if (consents.ageConfirmed !== true) {
    return sendError(res, 400, 'auth.age_not_confirmed', 'You must confirm you are 16 or older.');
  }
  if (consents.healthData !== true) {
    return sendError(res, 400, 'auth.health_consent_required',
      'Consent to store your health and fitness data is required to use Pocket Coach.');
  }

  try {
    const usernameRef = db.collection('usernames').doc(username.toLowerCase());
    const userRef = db.collection('users').doc(fbUser.uid);
    const referralCode = generateReferralCode(username);
    const tier = 'free';

    // Resolve referral code → referrer uid where possible (schema doc: transform, not copy)
    let referredByUid = null;
    if (referredByCode) {
      const referrer = await db.collection('users')
        .where('referralCode', '==', referredByCode).limit(1).get();
      if (!referrer.empty) referredByUid = referrer.docs[0].id;
    }

    await db.runTransaction(async tx => {
      const [nameSnap, userSnap] = await Promise.all([tx.get(usernameRef), tx.get(userRef)]);
      if (userSnap.exists) {
        const claimed = userSnap.get('username');
        if (claimed && claimed.toLowerCase() !== username.toLowerCase()) {
          const err = new Error('Account already has a username.');
          err.code = 'auth.already_registered';
          throw err;
        }
      }
      if (nameSnap.exists && nameSnap.get('uid') !== fbUser.uid) {
        const err = new Error('That username is already taken.');
        err.code = 'auth.username_taken';
        throw err;
      }
      tx.set(usernameRef, { uid: fbUser.uid });
      tx.set(userRef, {
        uid: fbUser.uid,
        username,
        email: fbUser.email || null,
        createdAt: FieldValue.serverTimestamp(),
        userPlan: tier,
        subStatus: 'none',
        subCurrentPeriodEnd: null,
        billingCycle: null,
        stripeCustomerId: null,
        referralCode,
        referralCredits: 0,
        referredByCode: referredByCode || null,
        referredByUid,
        isCoach: false,
        consents: {
          ageConfirmed: true,
          healthData: true,
          termsVersion: TERMS_VERSION,
          acceptedAt: FieldValue.serverTimestamp()
        }
      }, { merge: true });
    });

    await fbAuth.setCustomUserClaims(fbUser.uid, {
      username,
      tier,
      isCoach: false
    });

    console.info(`[AUTH] Signup complete for "${username}" (uid ${fbUser.uid})`);
    return sendSuccess(res, 201, { username, referralCode });
  } catch (err) {
    if (err.code === 'auth.username_taken') {
      return sendError(res, 409, 'auth.username_taken', 'That username is already taken.');
    }
    if (err.code === 'auth.already_registered') {
      return sendError(res, 409, 'auth.already_registered', 'This account already completed signup.');
    }
    console.error('[AUTH] signup-complete failed:', err.message);
    return sendError(res, 500, 'auth.signup_failed', 'Failed to complete signup.');
  }
});

// POST /auth/email-for-username — body { username }. Login is by username (plan:
// required, not optional); Firebase authenticates by email, so resolve first.
app.post('/auth/email-for-username', loginLimiter, async (req, res) => {
  if (!firebaseEnabled) return sendError(res, 503, 'auth.firebase_disabled', 'Firebase auth is not configured.');
  const username = typeof req.body?.username === 'string' ? req.body.username.trim() : '';
  if (!USERNAME_RE.test(username)) {
    return sendError(res, 404, 'auth.unknown_username', 'No account found for that username.');
  }
  try {
    const snap = await db.collection('usernames').doc(username.toLowerCase()).get();
    if (!snap.exists) return sendError(res, 404, 'auth.unknown_username', 'No account found for that username.');
    const { email } = await fbAuth.getUser(snap.get('uid'));
    if (!email) return sendError(res, 404, 'auth.unknown_username', 'No account found for that username.');
    return sendSuccess(res, 200, { email });
  } catch (err) {
    console.error('[AUTH] email-for-username failed:', err.message);
    return sendError(res, 500, 'auth.server_error', 'Could not resolve username.');
  }
});

// POST /saveWorkout — RETIRED. Older app builds post the whole in-progress
// workout here after every exercise added. It used to append each one to an
// in-memory array that nothing read and nothing ever cleared (so instance
// memory only grew). Workouts reach Firestore via POST /workouts instead
// (the app's archiver). Still answers 200 so old builds don't queue retries.
app.post('/saveWorkout', authenticateToken, (req, res) => {
  const { username, workout } = req.body || {};
  if (!username || !workout) {
    return sendError(res, 400, 'workout.validation', 'username and workout are required.');
  }
  sendSuccess(res, 200, { message: 'Workout saved' });
});

// POST /workouts
app.post('/workouts', authenticateToken, async (req, res) => {
  try {
    const username = req.user.username;
    const { date, title, workout } = req.body || {};
    if (!date || !workout) {
      return sendError(res, 422, 'workouts.invalid_payload', 'date and workout are required.');
    }

    const sessionVolume = computeSessionVolume(workout);

    const uid = await resolveFirestoreUid(username);
    if (uid) {
      // The whole `workout` object is stored as-is (not exploded) so GET can
      // return it byte-for-byte — that's the API's existing contract. (A
      // per-set `sets` subcollection used to be written too; nothing read
      // it, and it cost one extra doc + write per set.)
      //
      // The app's own workout id is used as the doc id when present, so a
      // retried POST (e.g. the archiver timing out after the write landed)
      // overwrites the same doc instead of duplicating it.
      const workoutsCol = db.collection(`users/${uid}/workouts`);
      const clientId = safeDocId(workout.id);
      const docRef = clientId ? workoutsCol.doc(clientId) : workoutsCol.doc();
      const totals = await saveWorkoutWithTotals({
        db, FieldValue, uid, docRef,
        data: { date: String(date), title: String(title || 'Workout'), sessionVolume, ...storedWorkoutFields(workout) }
      });
      // Exercise leaderboard bests; a failure here must not fail the save.
      try {
        await recordExerciseBests(db, { username, workoutId: docRef.id, date, workout });
      } catch (err) {
        console.error('[exercise board] recording bests failed:', err.message);
      }
      await notifyVolumePasses(db, { uid, username, ...totals });
      return sendSuccess(res, 200, { recordId: docRef.id });
    }

    if (!airtableEnabled) {
      return sendError(res, 503, 'workouts.airtable_disabled', 'Airtable is not configured.',
        'Set AIRTABLE_BASE_ID and AIRTABLE_API_TOKEN in environment variables.');
    }

    const url = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(WORKOUTS_TABLE)}`;
    const response = await airtableFetch(url, {
      method: 'POST',
      headers: airtableHeaders(),
      body: JSON.stringify({
        records: [{
          fields: {
            [USERNAME_FIELD]: String(username),
            Date:             String(date),
            Title:            String(title || 'Workout'),
            WorkoutJSON:      JSON.stringify(workout),
            SessionVolume:    sessionVolume
          }
        }]
      })
    });

    const data = await response.json();
    if (!response.ok) {
      return sendError(res, 422, 'workouts.airtable_rejected', 'Airtable rejected the request.',
        data?.error?.message || JSON.stringify(data));
    }
    return sendSuccess(res, 200, { recordId: data?.records?.[0]?.id || null });
  } catch (err) {
    return sendError(res, 500, 'workouts.server_error', String(err));
  }
});

// GET /workouts
app.get('/workouts', authenticateToken, async (req, res) => {
  try {
    const username = req.user.username;

    const uid = await resolveFirestoreUid(username);
    if (uid) {
      // ?since=YYYY-MM-DD limits to workouts on or after that day — the app's
      // sync only needs the recent window it keeps on the device.
      const since = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.since || '')) ? String(req.query.since) : null;
      let col = db.collection(`users/${uid}/workouts`);
      if (since) col = col.where('date', '>=', since);
      const { docs, nextCursor } = await queryHistoryPage(col, 'date', req.query);
      const items = docs.map(d => ({
        id: d.id, username, date: d.get('date'), title: d.get('title'),
        workout: readStoredWorkout(d.get('workout'), d.get('workoutFormat')) ?? null
      }));
      return sendSuccess(res, 200, { items, nextCursor });
    }

    if (!airtableEnabled) return sendError(res, 503, 'workouts.airtable_disabled', 'Airtable is not configured.');

    const safeUsername = escapeAirtableFormulaValue(username);
    const params = new URLSearchParams({
      filterByFormula: `{${USERNAME_FIELD}}='${safeUsername}'`,
      'sort[0][field]': 'Date',
      'sort[0][direction]': 'desc'
    });
    const url = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(WORKOUTS_TABLE)}?${params}`;
    const response = await airtableFetch(url, { headers: airtableHeaders() });
    const data = await response.json();

    if (!response.ok) {
      return sendError(res, 422, 'workouts.airtable_rejected', 'Airtable rejected the request.',
        data?.error?.message || JSON.stringify(data));
    }

    const items = (data.records || []).map(rec => {
      const f = rec.fields || {};
      let workout = null;
      try { workout = JSON.parse(f.WorkoutJSON || '{}'); } catch {}
      return { id: rec.id, username: f.Username, date: f.Date, title: f.Title, workout };
    });

    return sendSuccess(res, 200, { items });
  } catch (err) {
    return sendError(res, 500, 'workouts.server_error', String(err));
  }
});

// DELETE /workouts/:id — removes one of the caller's own workouts, so a
// workout deleted on one device disappears from the others (and from the
// leaderboard totals and exercise board).
app.delete('/workouts/:id', authenticateToken, async (req, res) => {
  try {
    const username = req.user.username;
    const id = safeDocId(req.params.id);
    if (!id) return sendError(res, 422, 'workouts.invalid_id', 'Invalid workout id.');

    const uid = await resolveFirestoreUid(username);
    if (!uid) return sendError(res, 409, 'workouts.not_migrated', 'This account can’t delete synced workouts.');

    const docRef = db.collection(`users/${uid}/workouts`).doc(id);
    const userRef = db.collection('users').doc(uid);
    let existed = false;
    await db.runTransaction(async tx => {
      const prev = await tx.get(docRef);
      existed = prev.exists;
      if (!prev.exists) return;
      tx.delete(docRef);
      tx.set(userRef, {
        totalVolume: FieldValue.increment(-(Number(prev.get('sessionVolume')) || 0)),
        workoutCount: FieldValue.increment(-1)
      }, { merge: true });
    });
    if (existed) {
      try {
        await forgetExerciseSession(db, { username, workoutId: id });
      } catch (err) {
        console.error('[exercise board] forgetting session failed:', err.message);
      }
    }
    // Deleting something already gone is a success: the device wanted it gone.
    return sendSuccess(res, 200, { deleted: existed });
  } catch (err) {
    return sendError(res, 500, 'workouts.server_error', String(err));
  }
});

// GET /macrotargets
app.get('/macrotargets', authenticateToken, async (req, res) => {
  try {
    const username = req.user.username;

    // Firestore path: this user has migrated (Phase 2 route cutover) — it's
    // the sole source of truth for them now, regardless of which auth token
    // this particular request carries.
    const uid = await resolveFirestoreUid(username);
    if (uid) {
      const userSnap = await db.collection('users').doc(uid).get();
      const mt = userSnap.exists ? userSnap.get('macroTargets') : null;
      const item = mt ? { id: uid, createdTime: null, Calories: mt.calories ?? null, Protein: mt.protein ?? null, Fat: mt.fat ?? null, Carbs: mt.carbs ?? null } : null;
      return sendSuccess(res, 200, { item });
    }

    if (!airtableEnabled) return sendError(res, 503, 'macrotargets.airtable_disabled', 'Airtable is not configured.');

    const safeUsername = escapeAirtableFormulaValue(username);
    const params = new URLSearchParams({
      filterByFormula: `{${USERNAME_FIELD}}='${safeUsername}'`,
      maxRecords: '1'
    });
    const url = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(MACRO_TARGETS_TABLE)}?${params}`;
    const response = await airtableFetch(url, { headers: airtableHeaders() });
    const data = await response.json();

    if (!response.ok) {
      return sendError(res, 422, 'macrotargets.airtable_rejected', 'Airtable rejected the request.',
        data?.error?.message || JSON.stringify(data));
    }

    const rec = data?.records?.[0] || null;
    return sendSuccess(res, 200, { item: rec ? { id: rec.id, createdTime: rec.createdTime, ...rec.fields } : null });
  } catch (err) {
    return sendError(res, 500, 'macrotargets.server_error', String(err));
  }
});

// POST /macrotargets — upsert macro targets for a user (one record per user)
app.post('/macrotargets', authenticateToken, async (req, res) => {
  try {
    const username = req.user.username;
    const { calories, protein, fat, carbs } = req.body || {};

    const uid = await resolveFirestoreUid(username);
    if (uid) {
      await db.collection('users').doc(uid).set({
        macroTargets: {
          calories: calories != null ? Number(calories) : null,
          protein:  protein  != null ? Number(protein)  : null,
          fat:      fat      != null ? Number(fat)      : null,
          carbs:    carbs    != null ? Number(carbs)    : null
        }
      }, { merge: true });
      return sendSuccess(res, 200, { recordId: uid });
    }

    if (!airtableEnabled) {
      return sendError(res, 503, 'macrotargets.airtable_disabled', 'Airtable is not configured.');
    }

    const fields = {
      [USERNAME_FIELD]: String(username),
      Calories: calories != null ? Number(calories) : null,
      Protein:  protein  != null ? Number(protein)  : null,
      Fat:      fat      != null ? Number(fat)      : null,
      Carbs:    carbs    != null ? Number(carbs)    : null
    };

    // Upsert: update existing record if one exists, otherwise create
    const safeUsername = escapeAirtableFormulaValue(username);
    const existing = await base(MACRO_TARGETS_TABLE)
      .select({ filterByFormula: `{${USERNAME_FIELD}}='${safeUsername}'`, maxRecords: 1 })
      .firstPage();

    let recordId;
    if (existing.length) {
      const updated = await base(MACRO_TARGETS_TABLE).update([{ id: existing[0].id, fields }]);
      recordId = updated[0]?.id;
    } else {
      const [created] = await base(MACRO_TARGETS_TABLE).create([{ fields }]);
      recordId = created.id;
    }

    return sendSuccess(res, 200, { recordId });
  } catch (err) {
    return sendError(res, 500, 'macrotargets.server_error', String(err));
  }
});

// POST /dailylogs — save daily macro log
app.post('/dailylogs', authenticateToken, async (req, res) => {
  try {
    // Support both flat body and legacy { fields: { ... } } wrapper from frontend
    const body = req.body?.fields ? req.body.fields : req.body || {};

    const date     = body.Date || body.date;
    const username = req.user.username;

    if (!date || !username) {
      return sendError(res, 422, 'dailylogs.invalid_payload', 'date and username are required.');
    }

    // Accept both naming conventions the frontend uses
    const calories     = body.CaloriesTotal ?? body.Calories     ?? body.calories     ?? null;
    const proteinGrams = body.ProteinTotal  ?? body.ProteinGrams ?? body.protein       ?? null;
    const carbGrams    = body.CarbsTotal    ?? body.CarbGrams    ?? body.carbs         ?? null;
    const fatGrams     = body.FatTotal      ?? body.FatGrams     ?? body.fat           ?? null;

    const uid = await resolveFirestoreUid(username);
    if (uid) {
      // Each save is the whole day's snapshot (all meals + totals), so one
      // doc per date+type: re-saving the day overwrites instead of piling up
      // a new doc per save.
      const dailyCol = db.collection(`users/${uid}/dailyMacros`);
      const dailyId = naturalDocId(date, body.Type || 'log');
      const docRef = dailyId ? dailyCol.doc(dailyId) : dailyCol.doc();
      await docRef.set({
        date: String(date),
        calories, proteinGrams, carbGrams, fatGrams,
        type: body.Type ? String(body.Type) : null,
        logData: body.LogData != null ? (typeof body.LogData === 'string' ? safeJsonParse(body.LogData) : body.LogData) : null
      });
      return res.status(201).json({ success: true, id: docRef.id });
    }

    if (!airtableEnabled) {
      return sendError(res, 503, 'dailylogs.airtable_disabled', 'Airtable is not configured.');
    }

    const fields = {
      Date:             String(date),
      [USERNAME_FIELD]: String(username),
      Calories:         calories     != null ? Number(calories)     : null,
      ProteinGrams:     proteinGrams != null ? Number(proteinGrams) : null,
      CarbGrams:        carbGrams    != null ? Number(carbGrams)    : null,
      FatGrams:         fatGrams     != null ? Number(fatGrams)     : null,
      ...(body.Type    ? { Type:    String(body.Type)                        } : {}),
      ...(body.LogData ? { LogData: typeof body.LogData === 'string'
                                    ? body.LogData : JSON.stringify(body.LogData) } : {})
    };

    const [record] = await base(DAILY_LOGS_TABLE).create([{ fields }]);
    return res.status(201).json({ success: true, id: record.id });
  } catch (err) {
    console.error('POST /dailylogs failed:', err);
    return sendError(res, 500, 'dailylogs.server_error', err?.message || 'Failed to create daily log.');
  }
});

// GET /dailylogs — fetch daily logs for a user
app.get('/dailylogs', authenticateToken, async (req, res) => {
  try {
    const username = ownUsername(req, res);
    if (!username) return;

    const uid = await resolveFirestoreUid(username);
    if (uid) {
      const { docs, nextCursor } = await queryHistoryPage(db.collection(`users/${uid}/dailyMacros`), 'date', req.query);
      const records = docs.map(d => ({
        id: d.id,
        Date: d.get('date'),
        Calories: d.get('calories'),
        ProteinGrams: d.get('proteinGrams'),
        CarbGrams: d.get('carbGrams'),
        FatGrams: d.get('fatGrams'),
        ...(d.get('type') ? { Type: d.get('type') } : {}),
        ...(d.get('logData') != null ? { LogData: JSON.stringify(d.get('logData')) } : {})
      }));
      return res.json({ success: true, records, nextCursor });
    }

    if (!airtableEnabled) return res.json({ records: [] });

    const safeUsername = escapeAirtableFormulaValue(username);
    const records = await base(DAILY_LOGS_TABLE)
      .select({
        filterByFormula: `{${USERNAME_FIELD}}='${safeUsername}'`,
        sort: [{ field: 'Date', direction: 'desc' }],
        pageSize: 100
      })
      .all();

    return res.json({ success: true, records: records.map(r => ({ id: r.id, ...r.fields })) });
  } catch (err) {
    console.error('GET /dailylogs failed:', err);
    return sendError(res, 500, 'dailylogs.server_error', err?.message || 'Failed to fetch daily logs.');
  }
});

// POST /templates
app.post('/templates', authenticateToken, async (req, res) => {
  const username = req.user.username;
  const { templateName, templateData } = req.body || {};
  if (!templateName || !templateData) {
    return sendError(res, 400, 'templates.invalid_payload', 'templateName and templateData are required.');
  }

  const uid = await resolveFirestoreUid(username);
  if (uid) {
    try {
      // Storage convention matches legacyMigration.js: templateData stored
      // parsed (not stringified) — the object shape has drifted over time
      // (some records carry dropsetArray/restPauseArray/etc that others
      // don't), so it's kept as-is rather than forced into a rigid schema.
      const docRef = db.collection(`users/${uid}/templates`).doc();
      await docRef.set({ name: String(templateName), templateData });
      return sendSuccess(res, 200, { record: { id: docRef.id, fields: { TemplateName: templateName, Username: username } } });
    } catch (err) {
      console.error('POST /templates (Firestore) failed:', err);
      return sendError(res, 500, 'templates.server_error', 'Server error saving template.');
    }
  }

  if (!airtableEnabled) {
    return sendError(res, 503, 'templates.airtable_disabled', 'Airtable is not configured.');
  }

  try {
    const url = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(TEMPLATES_TABLE_NAME)}`;
    const response = await airtableFetch(url, {
      method: 'POST',
      headers: airtableHeaders(),
      body: JSON.stringify({
        records: [{
          fields: {
            Username:     String(username),
            TemplateName: String(templateName),
            TemplateData: JSON.stringify(templateData)
          }
        }]
      })
    });

    if (!response.ok) {
      const text = await response.text();
      return sendError(res, response.status, 'templates.airtable_rejected', 'Airtable rejected the request.', text);
    }

    const result = await response.json();
    return sendSuccess(res, 200, { record: result?.records?.[0] || result });
  } catch (err) {
    console.error('POST /templates failed:', err);
    return sendError(res, 500, 'templates.server_error', 'Server error saving template.');
  }
});

// GET /templates
app.get('/templates', authenticateToken, async (req, res) => {
  const owner = req.user.username;

  const uid = await resolveFirestoreUid(owner);
  if (uid) {
    try {
      const snap = await db.collection(`users/${uid}/templates`).orderBy('name').get();
      const items = snap.docs.map(d => ({
        id: d.id,
        name: d.get('name') || 'Untitled Template',
        username: owner,
        // Stringified to match the API's existing contract (the frontend
        // JSON.parses this field itself) — Airtable's TemplateData was
        // always a JSON string, so this keeps both paths interchangeable.
        data: JSON.stringify(d.get('templateData') ?? null)
      }));
      return sendSuccess(res, 200, { items, owner });
    } catch (err) {
      console.error('GET /templates (Firestore) failed:', err);
      return sendError(res, 500, 'templates.fetch_failed', 'Failed to load templates.', err?.message);
    }
  }

  if (!airtableEnabled) {
    return sendError(res, 503, 'templates.airtable_disabled', 'Airtable is not configured.');
  }

  try {
    const safeOwner = escapeAirtableFormulaValue(owner);
    const records = await base(TEMPLATES_TABLE_NAME)
      .select({
        filterByFormula: `({Username}='${safeOwner}')`,
        pageSize: 100,
        sort: [{ field: 'TemplateName', direction: 'asc' }]
      })
      .all();

    const items = records.map(r => ({
      id:       r.id,
      name:     r.get('TemplateName') || r.get('Name') || 'Untitled Template',
      username: r.get('Username') || '',
      data:     r.get('TemplateData')
    }));

    return sendSuccess(res, 200, { items, owner });
  } catch (e) {
    const statusCode = e?.statusCode;
    console.error('GET /templates failed:', { owner, error: e?.message, statusCode });

    if (statusCode >= 400 && statusCode < 500) {
      const forbidden = statusCode === 403;
      return sendError(res, forbidden ? 401 : statusCode,
        forbidden ? 'templates.airtable_forbidden' : 'templates.airtable_rejected',
        forbidden ? 'Airtable credentials were rejected.' : 'Airtable rejected the request.',
        e?.message);
    }
    if (statusCode >= 500) {
      return sendError(res, 502, 'templates.airtable_unavailable', 'Upstream Airtable service failed.', e?.message);
    }
    return sendError(res, 500, 'templates.fetch_failed', 'Failed to load templates.', e?.message);
  }
});

// ── Bodyweight & Measurements ─────────────────────────────────────────────────
const BODYWEIGHT_TABLE   = process.env.AIRTABLE_BODYWEIGHT_TABLE   || 'BodyweightLog';
const MEASUREMENTS_TABLE = process.env.AIRTABLE_MEASUREMENTS_TABLE || 'BodyMeasurements';

// POST /bodyweight/archive — archive a 4-week snapshot of bodyweight entries
app.post('/bodyweight/archive', authenticateToken, async (req, res) => {
  try {
    const username = req.user.username;
    const { periodStart, periodEnd, entries, trend } = req.body || {};
    if (!Array.isArray(entries) || !entries.length) {
      return sendError(res, 422, 'bodyweight.invalid_payload', 'entries array is required.');
    }

    // Compute summary stats from the entries
    const kgValues = entries.map(e => typeof e.weightKg === 'number' ? e.weightKg : null).filter(v => v !== null);
    const startWeightKg = kgValues[0]   ?? null;
    const endWeightKg   = kgValues[kgValues.length - 1] ?? null;
    const avgWeightKg   = kgValues.length
      ? Math.round((kgValues.reduce((s, v) => s + v, 0) / kgValues.length) * 10) / 10
      : null;
    const weightChangeKg = (startWeightKg !== null && endWeightKg !== null)
      ? Math.round((endWeightKg - startWeightKg) * 10) / 10
      : null;
    const kgPerWeek = typeof trend?.kgPerWeek === 'number' ? Math.round(trend.kgPerWeek * 100) / 100 : null;
    const caloriesDelta = typeof trend?.caloriesDelta === 'number' ? trend.caloriesDelta : null;

    const uid = await resolveFirestoreUid(username);
    if (uid) {
      // Keyed by the archived period so a re-sent archive overwrites itself.
      const archiveCol = db.collection(`users/${uid}/bodyweightArchives`);
      const archiveId = naturalDocId(periodStart, periodEnd);
      const docRef = archiveId ? archiveCol.doc(archiveId) : archiveCol.doc();
      await docRef.set({
        periodStart: periodStart ? String(periodStart) : '',
        periodEnd: periodEnd ? String(periodEnd) : '',
        startWeightKg, endWeightKg, avgWeightKg, weightChangeKg, kgPerWeek, caloriesDelta,
        entryCount: entries.length,
        entries,
        archivedAt: new Date().toISOString()
      });
      return sendSuccess(res, 201, { recordId: docRef.id });
    }

    if (!airtableEnabled) return sendError(res, 503, 'bodyweight.airtable_disabled', 'Airtable is not configured.');

    const url = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(BODYWEIGHT_TABLE)}`;
    const response = await airtableFetch(url, {
      method: 'POST',
      headers: airtableHeaders(),
      body: JSON.stringify({
        records: [{
          fields: {
            [USERNAME_FIELD]: String(username),
            PeriodStart:    periodStart ? String(periodStart) : '',
            PeriodEnd:      periodEnd   ? String(periodEnd)   : '',
            StartWeightKg:  startWeightKg,
            EndWeightKg:    endWeightKg,
            AvgWeightKg:    avgWeightKg,
            WeightChangeKg: weightChangeKg,
            KgPerWeek:      typeof trend?.kgPerWeek === 'number' ? Math.round(trend.kgPerWeek * 100) / 100 : null,
            CaloriesDelta:  typeof trend?.caloriesDelta === 'number' ? trend.caloriesDelta : null,
            EntryCount:     entries.length,
            EntriesJson:    JSON.stringify(entries),
            ArchivedAt:     new Date().toISOString()
          }
        }]
      })
    });

    const data = await response.json();
    if (!response.ok) {
      return sendError(res, 422, 'bodyweight.airtable_rejected', 'Airtable rejected the request.',
        data?.error?.message || JSON.stringify(data));
    }
    return sendSuccess(res, 201, { recordId: data?.records?.[0]?.id || null });
  } catch (err) {
    console.error('POST /bodyweight/archive failed:', err);
    return sendError(res, 500, 'bodyweight.server_error', String(err));
  }
});

// GET /bodyweight?username= — fetch archived bodyweight snapshots
app.get('/bodyweight', authenticateToken, async (req, res) => {
  try {
    const username = ownUsername(req, res);
    if (!username) return;

    const uid = await resolveFirestoreUid(username);
    if (uid) {
      const snap = await db.collection(`users/${uid}/bodyweightArchives`).orderBy('periodStart', 'desc').get();
      const items = snap.docs.map(d => ({
        id: d.id,
        periodStart: d.get('periodStart'),
        periodEnd: d.get('periodEnd'),
        startWeightKg: d.get('startWeightKg'),
        endWeightKg: d.get('endWeightKg'),
        avgWeightKg: d.get('avgWeightKg'),
        weightChangeKg: d.get('weightChangeKg'),
        kgPerWeek: d.get('kgPerWeek'),
        caloriesDelta: d.get('caloriesDelta'),
        entryCount: d.get('entryCount'),
        archivedAt: d.get('archivedAt')
      }));
      return sendSuccess(res, 200, { items });
    }

    if (!airtableEnabled) return res.json({ success: true, items: [] });

    const safeUsername = escapeAirtableFormulaValue(username);
    const records = await base(BODYWEIGHT_TABLE)
      .select({
        filterByFormula: `{${USERNAME_FIELD}}='${safeUsername}'`,
        sort: [{ field: 'PeriodStart', direction: 'desc' }],
        pageSize: 100
      })
      .all();

    const items = records.map(r => ({
      id:             r.id,
      periodStart:    r.get('PeriodStart'),
      periodEnd:      r.get('PeriodEnd'),
      startWeightKg:  r.get('StartWeightKg'),
      endWeightKg:    r.get('EndWeightKg'),
      avgWeightKg:    r.get('AvgWeightKg'),
      weightChangeKg: r.get('WeightChangeKg'),
      kgPerWeek:      r.get('KgPerWeek'),
      caloriesDelta:  r.get('CaloriesDelta'),
      entryCount:     r.get('EntryCount'),
      archivedAt:     r.get('ArchivedAt')
    }));

    return sendSuccess(res, 200, { items });
  } catch (err) {
    console.error('GET /bodyweight failed:', err);
    return sendError(res, 500, 'bodyweight.server_error', String(err));
  }
});

// POST /measurements/sync — save individual measurement entries not yet synced
app.post('/measurements/sync', authenticateToken, async (req, res) => {
  try {
    const username = req.user.username;
    const { entries } = req.body || {};
    if (!Array.isArray(entries) || !entries.length) {
      return sendError(res, 422, 'measurements.invalid_payload', 'entries array is required.');
    }

    const uid = await resolveFirestoreUid(username);
    if (uid) {
      const col = db.collection(`users/${uid}/measurements`);
      // Batched (one commit instead of N round-trips) and keyed by the
      // entry's own id or a content hash, so a re-sent entry overwrites
      // its existing doc rather than duplicating it.
      const writes = entries.map(e => ({
        ref: col.doc(syncEntryDocId(e)),
        data: {
          date: String(e.date || ''),
          neck: e.neck != null ? Number(e.neck) : null,
          shoulders: e.shoulders != null ? Number(e.shoulders) : null,
          chest: e.chest != null ? Number(e.chest) : null,
          waist: e.waist != null ? Number(e.waist) : null,
          hips: e.hips != null ? Number(e.hips) : null,
          arm: e.arm != null ? Number(e.arm) : null,
          thigh: e.thigh != null ? Number(e.thigh) : null,
          syncedAt: new Date().toISOString()
        }
      }));
      await batchSetAll(db, writes);
      const recordIds = writes.map(w => w.ref.id);
      return sendSuccess(res, 201, { count: recordIds.length, recordIds });
    }

    if (!airtableEnabled) return sendError(res, 503, 'measurements.airtable_disabled', 'Airtable is not configured.');

    const url = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(MEASUREMENTS_TABLE)}`;

    // Airtable allows max 10 records per create call — batch if needed
    const batches = [];
    for (let i = 0; i < entries.length; i += 10) batches.push(entries.slice(i, i + 10));

    const recordIds = [];
    for (const batch of batches) {
      const response = await airtableFetch(url, {
        method: 'POST',
        headers: airtableHeaders(),
        body: JSON.stringify({
          records: batch.map(e => ({
            fields: {
              [USERNAME_FIELD]: String(username),
              Date:       String(e.date || ''),
              Neck:       e.neck       != null ? Number(e.neck)       : null,
              Shoulders:  e.shoulders  != null ? Number(e.shoulders)  : null,
              Chest:      e.chest      != null ? Number(e.chest)      : null,
              Waist:      e.waist      != null ? Number(e.waist)      : null,
              Hips:       e.hips       != null ? Number(e.hips)       : null,
              Arm:        e.arm        != null ? Number(e.arm)        : null,
              Thigh:      e.thigh      != null ? Number(e.thigh)      : null,
              SyncedAt:   new Date().toISOString()
            }
          }))
        })
      });
      const data = await response.json();
      if (!response.ok) {
        return sendError(res, 422, 'measurements.airtable_rejected', 'Airtable rejected the request.',
          data?.error?.message || JSON.stringify(data));
      }
      (data.records || []).forEach(r => recordIds.push(r.id));
    }

    return sendSuccess(res, 201, { count: recordIds.length, recordIds });
  } catch (err) {
    console.error('POST /measurements/sync failed:', err);
    return sendError(res, 500, 'measurements.server_error', String(err));
  }
});

// GET /measurements?username= — fetch synced measurement history
app.get('/measurements', authenticateToken, async (req, res) => {
  try {
    const username = ownUsername(req, res);
    if (!username) return;

    const uid = await resolveFirestoreUid(username);
    if (uid) {
      const { docs, nextCursor } = await queryHistoryPage(db.collection(`users/${uid}/measurements`), 'date', req.query);
      const items = docs.map(d => ({
        id: d.id,
        date: d.get('date'),
        neck: d.get('neck'),
        shoulders: d.get('shoulders'),
        chest: d.get('chest'),
        waist: d.get('waist'),
        hips: d.get('hips'),
        arm: d.get('arm'),
        thigh: d.get('thigh'),
        syncedAt: d.get('syncedAt')
      }));
      return sendSuccess(res, 200, { items, nextCursor });
    }

    if (!airtableEnabled) return res.json({ success: true, items: [] });

    const safeUsername = escapeAirtableFormulaValue(username);
    const records = await base(MEASUREMENTS_TABLE)
      .select({
        filterByFormula: `{${USERNAME_FIELD}}='${safeUsername}'`,
        sort: [{ field: 'Date', direction: 'desc' }],
        pageSize: 100
      })
      .all();

    const items = records.map(r => ({
      id:         r.id,
      date:       r.get('Date'),
      neck:       r.get('Neck'),
      shoulders:  r.get('Shoulders'),
      chest:      r.get('Chest'),
      waist:      r.get('Waist'),
      hips:       r.get('Hips'),
      arm:        r.get('Arm'),
      thigh:      r.get('Thigh'),
      syncedAt:   r.get('SyncedAt')
    }));

    return sendSuccess(res, 200, { items });
  } catch (err) {
    console.error('GET /measurements failed:', err);
    return sendError(res, 500, 'measurements.server_error', String(err));
  }
});

// ── Cardio & CrossFit ─────────────────────────────────────────────────────────
const CARDIO_TABLE   = process.env.AIRTABLE_CARDIO_TABLE   || 'CardioLog';
const CROSSFIT_TABLE = process.env.AIRTABLE_CROSSFIT_TABLE || 'CrossFitLog';

// POST /cardio/sync — sync individual cardio entries (4-week cadence from frontend)
app.post('/cardio/sync', authenticateToken, async (req, res) => {
  try {
    const username = req.user.username;
    const { entries } = req.body || {};
    if (!Array.isArray(entries) || !entries.length) {
      return sendError(res, 422, 'cardio.invalid_payload', 'entries array is required.');
    }

    const uid = await resolveFirestoreUid(username);
    if (uid) {
      const col = db.collection(`users/${uid}/cardioLogs`);
      // Batched (one commit instead of N round-trips) and keyed by the
      // entry's own id or a content hash, so a re-sent entry overwrites
      // its existing doc rather than duplicating it.
      const writes = entries.map(e => ({
        ref: col.doc(syncEntryDocId(e)),
        data: {
          date: String(e.date || ''),
          type: String(e.type || ''),
          duration: e.duration != null ? Number(e.duration) : null,
          distance: e.distance != null ? Number(e.distance) : null,
          calories: e.calories != null ? Number(e.calories) : null,
          estimatedCalories: e.estimatedCalories != null ? Number(e.estimatedCalories) : null,
          met: e.met != null ? Number(e.met) : null,
          notes: e.notes ? String(e.notes) : '',
          syncedAt: new Date().toISOString()
        }
      }));
      await batchSetAll(db, writes);
      const recordIds = writes.map(w => w.ref.id);
      return sendSuccess(res, 201, { count: recordIds.length, recordIds });
    }

    if (!airtableEnabled) return sendError(res, 503, 'cardio.airtable_disabled', 'Airtable is not configured.');

    const url = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(CARDIO_TABLE)}`;
    const batches = [];
    for (let i = 0; i < entries.length; i += 10) batches.push(entries.slice(i, i + 10));

    const recordIds = [];
    for (const batch of batches) {
      const response = await airtableFetch(url, {
        method: 'POST',
        headers: airtableHeaders(),
        body: JSON.stringify({
          records: batch.map(e => ({
            fields: {
              [USERNAME_FIELD]:   String(username),
              Date:               String(e.date || ''),
              Type:               String(e.type || ''),
              Duration:           e.duration          != null ? Number(e.duration)          : null,
              Distance:           e.distance          != null ? Number(e.distance)          : null,
              Calories:           e.calories          != null ? Number(e.calories)          : null,
              EstimatedCalories:  e.estimatedCalories != null ? Number(e.estimatedCalories) : null,
              MET:                e.met               != null ? Number(e.met)               : null,
              Notes:              e.notes ? String(e.notes) : '',
              SyncedAt:           new Date().toISOString()
            }
          }))
        })
      });
      const data = await response.json();
      if (!response.ok) {
        return sendError(res, 422, 'cardio.airtable_rejected', 'Airtable rejected the request.',
          data?.error?.message || JSON.stringify(data));
      }
      (data.records || []).forEach(r => recordIds.push(r.id));
    }

    return sendSuccess(res, 201, { count: recordIds.length, recordIds });
  } catch (err) {
    console.error('POST /cardio/sync failed:', err);
    return sendError(res, 500, 'cardio.server_error', String(err));
  }
});

// GET /cardio?username= — fetch synced cardio history
app.get('/cardio', authenticateToken, async (req, res) => {
  try {
    const username = ownUsername(req, res);
    if (!username) return;

    const uid = await resolveFirestoreUid(username);
    if (uid) {
      const { docs, nextCursor } = await queryHistoryPage(db.collection(`users/${uid}/cardioLogs`), 'date', req.query);
      const items = docs.map(d => ({
        id: d.id,
        date: d.get('date'),
        type: d.get('type'),
        duration: d.get('duration'),
        distance: d.get('distance'),
        calories: d.get('calories'),
        estimatedCalories: d.get('estimatedCalories'),
        met: d.get('met'),
        notes: d.get('notes'),
        syncedAt: d.get('syncedAt')
      }));
      return sendSuccess(res, 200, { items, nextCursor });
    }

    if (!airtableEnabled) return res.json({ success: true, items: [] });

    const safeUsername = escapeAirtableFormulaValue(username);
    const records = await base(CARDIO_TABLE)
      .select({
        filterByFormula: `{${USERNAME_FIELD}}='${safeUsername}'`,
        sort: [{ field: 'Date', direction: 'desc' }],
        pageSize: 100
      })
      .all();

    const items = records.map(r => ({
      id:                 r.id,
      date:               r.get('Date'),
      type:               r.get('Type'),
      duration:           r.get('Duration'),
      distance:           r.get('Distance'),
      calories:           r.get('Calories'),
      estimatedCalories:  r.get('EstimatedCalories'),
      met:                r.get('MET'),
      notes:              r.get('Notes'),
      syncedAt:           r.get('SyncedAt')
    }));

    return sendSuccess(res, 200, { items });
  } catch (err) {
    console.error('GET /cardio failed:', err);
    return sendError(res, 500, 'cardio.server_error', String(err));
  }
});

// POST /crossfit/sync — sync CrossFit WOD entries (4-week cadence from frontend)
app.post('/crossfit/sync', authenticateToken, async (req, res) => {
  try {
    const username = req.user.username;
    const { entries } = req.body || {};
    if (!Array.isArray(entries) || !entries.length) {
      return sendError(res, 422, 'crossfit.invalid_payload', 'entries array is required.');
    }

    const uid = await resolveFirestoreUid(username);
    if (uid) {
      const col = db.collection(`users/${uid}/crossfitLogs`);
      // Batched (one commit instead of N round-trips) and keyed by the
      // entry's own id or a content hash, so a re-sent entry overwrites
      // its existing doc rather than duplicating it.
      const writes = entries.map(e => ({
        ref: col.doc(syncEntryDocId(e)),
        data: {
          date: String(e.date || ''),
          workoutName: String(e.name || e.workoutName || ''),
          minutes: e.minutes != null ? Number(e.minutes) : null,
          seconds: e.seconds != null ? Number(e.seconds) : null,
          rounds: e.rounds != null ? Number(e.rounds) : null,
          notes: e.notes ? String(e.notes) : '',
          exercises: e.exercises || [],
          syncedAt: new Date().toISOString()
        }
      }));
      await batchSetAll(db, writes);
      const recordIds = writes.map(w => w.ref.id);
      return sendSuccess(res, 201, { count: recordIds.length, recordIds });
    }

    if (!airtableEnabled) return sendError(res, 503, 'crossfit.airtable_disabled', 'Airtable is not configured.');

    const url = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(CROSSFIT_TABLE)}`;
    const batches = [];
    for (let i = 0; i < entries.length; i += 10) batches.push(entries.slice(i, i + 10));

    const recordIds = [];
    for (const batch of batches) {
      const response = await airtableFetch(url, {
        method: 'POST',
        headers: airtableHeaders(),
        body: JSON.stringify({
          records: batch.map(e => ({
            fields: {
              [USERNAME_FIELD]: String(username),
              Date:             String(e.date || ''),
              WorkoutName:      String(e.name || e.workoutName || ''),
              Minutes:          e.minutes != null ? Number(e.minutes) : null,
              Seconds:          e.seconds != null ? Number(e.seconds) : null,
              Rounds:           e.rounds  != null ? Number(e.rounds)  : null,
              Notes:            e.notes ? String(e.notes) : '',
              ExercisesJson:    e.exercises ? JSON.stringify(e.exercises) : '',
              SyncedAt:         new Date().toISOString()
            }
          }))
        })
      });
      const data = await response.json();
      if (!response.ok) {
        return sendError(res, 422, 'crossfit.airtable_rejected', 'Airtable rejected the request.',
          data?.error?.message || JSON.stringify(data));
      }
      (data.records || []).forEach(r => recordIds.push(r.id));
    }

    return sendSuccess(res, 201, { count: recordIds.length, recordIds });
  } catch (err) {
    console.error('POST /crossfit/sync failed:', err);
    return sendError(res, 500, 'crossfit.server_error', String(err));
  }
});

// GET /crossfit?username= — fetch synced CrossFit history
app.get('/crossfit', authenticateToken, async (req, res) => {
  try {
    const username = ownUsername(req, res);
    if (!username) return;

    const uid = await resolveFirestoreUid(username);
    if (uid) {
      const { docs, nextCursor } = await queryHistoryPage(db.collection(`users/${uid}/crossfitLogs`), 'date', req.query);
      const items = docs.map(d => ({
        id: d.id,
        date: d.get('date'),
        workoutName: d.get('workoutName'),
        minutes: d.get('minutes'),
        seconds: d.get('seconds'),
        rounds: d.get('rounds'),
        notes: d.get('notes'),
        exercises: d.get('exercises') || [],
        syncedAt: d.get('syncedAt')
      }));
      return sendSuccess(res, 200, { items, nextCursor });
    }

    if (!airtableEnabled) return res.json({ success: true, items: [] });

    const safeUsername = escapeAirtableFormulaValue(username);
    const records = await base(CROSSFIT_TABLE)
      .select({
        filterByFormula: `{${USERNAME_FIELD}}='${safeUsername}'`,
        sort: [{ field: 'Date', direction: 'desc' }],
        pageSize: 100
      })
      .all();

    const items = records.map(r => ({
      id:           r.id,
      date:         r.get('Date'),
      workoutName:  r.get('WorkoutName'),
      minutes:      r.get('Minutes'),
      seconds:      r.get('Seconds'),
      rounds:       r.get('Rounds'),
      notes:        r.get('Notes'),
      exercises:    (() => { try { return JSON.parse(r.get('ExercisesJson') || '[]'); } catch { return []; } })(),
      syncedAt:     r.get('SyncedAt')
    }));

    return sendSuccess(res, 200, { items });
  } catch (err) {
    console.error('GET /crossfit failed:', err);
    return sendError(res, 500, 'crossfit.server_error', String(err));
  }
});

// ── Activity Sync (Google Health API) ───────────────────────────────────────
// OAuth 2.0 Authorization Code flow (activity_and_fitness scope only, for
// now). Tokens live in their own top-level collection (activitySyncTokens/{uid})
// rather than on the user doc so they're never exposed if the client SDK ever
// reads users/{uid} directly — that collection is server-only, see
// firestore.rules.
//
// This replaces the old Fitbit Web API integration, which Google is turning
// down September 30, 2026. Google Health API is a different platform: OAuth
// runs through Google's own accounts.google.com / oauth2.googleapis.com
// endpoints (registered in Google Cloud Console, not dev.fitbit.com), and
// there's an extra step vs. Fitbit — the token response carries no user id,
// so a users.getIdentity call resolves the Health-API-internal user id
// (`healthUserId`) that every later dataTypes.dataPoints call needs.
const GOOGLE_HEALTH_CLIENT_ID     = process.env.GOOGLE_HEALTH_CLIENT_ID || null;
const GOOGLE_HEALTH_CLIENT_SECRET = process.env.GOOGLE_HEALTH_CLIENT_SECRET || null;
const GOOGLE_HEALTH_REDIRECT_URI  = process.env.GOOGLE_HEALTH_REDIRECT_URI || null;
const activitySyncEnabled = Boolean(GOOGLE_HEALTH_CLIENT_ID && GOOGLE_HEALTH_CLIENT_SECRET && GOOGLE_HEALTH_REDIRECT_URI);
if (!activitySyncEnabled) console.warn('[WARN] Activity Sync disabled — GOOGLE_HEALTH_CLIENT_ID/GOOGLE_HEALTH_CLIENT_SECRET/GOOGLE_HEALTH_REDIRECT_URI not set.');

const ACTIVITY_SYNC_APP_URL = process.env.APP_URL || 'https://pocketcoachcoms.org';
const ACTIVITY_SYNC_SCOPE = [
  'https://www.googleapis.com/auth/googlehealth.activity_and_fitness.readonly',
  'https://www.googleapis.com/auth/googlehealth.sleep.readonly',
  // Resting heart rate + HRV (GET /api/activity-sync/recovery). Users who
  // connected before this was added are asked to reconnect (status.needsReconnect).
  HEALTH_METRICS_SCOPE
].join(' ');
const GOOGLE_HEALTH_API_BASE = 'https://health.googleapis.com/v4';

async function requestGoogleHealthToken(bodyParams) {
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      ...bodyParams,
      client_id: GOOGLE_HEALTH_CLIENT_ID,
      client_secret: GOOGLE_HEALTH_CLIENT_SECRET
    })
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data?.error_description || data?.error || 'Google token request failed');
  return data;
}

// Resolves the Health-API-internal user id for the access token's account.
// Any of the readonly scopes (activity_and_fitness included) authorizes this call.
async function fetchHealthUserId(accessToken) {
  const response = await fetch(`${GOOGLE_HEALTH_API_BASE}/users/me/identity`, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data?.error?.message || 'users.getIdentity failed');
  return data.healthUserId;
}

async function saveActivitySyncTokens(uid, tokenResponse, healthUserId) {
  await db.collection('activitySyncTokens').doc(uid).set({
    accessToken: tokenResponse.access_token,
    // Google only returns a refresh_token on first consent (or when prompt=consent
    // forces re-consent) — a refresh call's response has none, so don't overwrite
    // a previously-stored one with undefined.
    ...(tokenResponse.refresh_token ? { refreshToken: tokenResponse.refresh_token } : {}),
    expiresAt: Date.now() + (Number(tokenResponse.expires_in) || 0) * 1000,
    ...(healthUserId ? { healthUserId } : {}),
    scope: tokenResponse.scope || '',
    updatedAt: new Date().toISOString()
  }, { merge: true });
}

// Returns { accessToken, healthUserId } for uid, refreshing the access token
// if expired, or null if not connected / the refresh token was revoked on
// Google's side.
async function getValidActivitySyncSession(uid) {
  const ref = db.collection('activitySyncTokens').doc(uid);
  const snap = await ref.get();
  if (!snap.exists) return null;

  const token = snap.data();
  if (token.expiresAt > Date.now() + 60000) {
    return { accessToken: token.accessToken, healthUserId: token.healthUserId };
  }

  try {
    const refreshed = await requestGoogleHealthToken({ grant_type: 'refresh_token', refresh_token: token.refreshToken });
    await saveActivitySyncTokens(uid, refreshed);
    return { accessToken: refreshed.access_token, healthUserId: token.healthUserId };
  } catch (err) {
    console.error('[ActivitySync] token refresh failed, clearing stored token:', err.message);
    await ref.delete().catch(() => {});
    return null;
  }
}

// GET /api/activity-sync/status
app.get('/api/activity-sync/status', authenticateToken, async (req, res) => {
  if (!activitySyncEnabled) return sendError(res, 503, 'activity_sync.disabled', 'Activity Sync is not configured.');
  if (!req.user.uid) return sendSuccess(res, 200, { connected: false });
  try {
    const snap = await db.collection('activitySyncTokens').doc(req.user.uid).get();
    // Connected before the heart-rate/HRV permission existed → reconnect once.
    const needsReconnect = snap.exists && !hasHealthMetricsScope(snap.data()?.scope);
    return sendSuccess(res, 200, { connected: snap.exists, needsReconnect });
  } catch (err) {
    console.error('GET /api/activity-sync/status failed:', err);
    return sendError(res, 500, 'activity_sync.server_error', String(err));
  }
});

// GET /api/activity-sync/connect — returns the Google consent-screen URL for the frontend to redirect to
app.get('/api/activity-sync/connect', authenticateToken, (req, res) => {
  if (!activitySyncEnabled) return sendError(res, 503, 'activity_sync.disabled', 'Activity Sync is not configured.');
  if (!req.user.uid) {
    return sendError(res, 403, 'activity_sync.requires_firebase_auth', 'Please sign in again before connecting Activity Sync.');
  }
  // Google's redirect back to /callback carries no Authorization header, so the
  // uid rides in a short-lived signed state param instead (CSRF protection too).
  const state = jwt.sign({ uid: req.user.uid }, JWT_SECRET, { expiresIn: '10m' });
  const url = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
    response_type: 'code',
    client_id: GOOGLE_HEALTH_CLIENT_ID,
    redirect_uri: GOOGLE_HEALTH_REDIRECT_URI,
    scope: ACTIVITY_SYNC_SCOPE,
    access_type: 'offline', // required to get a refresh_token back
    prompt: 'consent',      // forces a refresh_token on every connect, not just the first ever
    state
  });
  return sendSuccess(res, 200, { url });
});

// GET /api/activity-sync/callback — Google redirects the user's browser here
// after consent; not authenticateToken since it's a direct browser
// navigation, not a fetch call from the frontend.
app.get('/api/activity-sync/callback', async (req, res) => {
  const { code, state, error } = req.query;
  if (error || !code || !state) {
    return res.redirect(`${ACTIVITY_SYNC_APP_URL}/?activitySync=error`);
  }

  let uid;
  try {
    ({ uid } = jwt.verify(String(state), JWT_SECRET));
  } catch {
    return res.redirect(`${ACTIVITY_SYNC_APP_URL}/?activitySync=error`);
  }

  try {
    const tokenResponse = await requestGoogleHealthToken({
      grant_type: 'authorization_code',
      code: String(code),
      redirect_uri: GOOGLE_HEALTH_REDIRECT_URI
    });
    const healthUserId = await fetchHealthUserId(tokenResponse.access_token);
    await saveActivitySyncTokens(uid, tokenResponse, healthUserId);
    return res.redirect(`${ACTIVITY_SYNC_APP_URL}/?activitySync=connected`);
  } catch (err) {
    console.error('GET /api/activity-sync/callback failed:', err.message);
    return res.redirect(`${ACTIVITY_SYNC_APP_URL}/?activitySync=error`);
  }
});

// POST /api/activity-sync/disconnect
app.post('/api/activity-sync/disconnect', authenticateToken, async (req, res) => {
  if (!req.user.uid) return sendSuccess(res, 200, {});
  const ref = db.collection('activitySyncTokens').doc(req.user.uid);
  try {
    const snap = await ref.get();
    if (snap.exists) {
      const { accessToken } = snap.data();
      await fetch('https://oauth2.googleapis.com/revoke', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: accessToken })
      }).catch(err => console.warn('[ActivitySync] revoke call failed (non-fatal):', err.message));
    }
    await ref.delete();
    return sendSuccess(res, 200, {});
  } catch (err) {
    console.error('POST /api/activity-sync/disconnect failed:', err);
    return sendError(res, 500, 'activity_sync.server_error', String(err));
  }
});

// Data types fetched for the daily summary. Field names and types are from
// Google's v4 reference (developers.google.com/health/reference/rest/v4/*RollupValue):
// int64 fields (steps, distance, active minutes) arrive as JSON strings,
// durations as "123.5s" strings, and only kcalSum is a plain number.
const ACTIVITY_SYNC_DATA_TYPES = ['steps', 'distance', 'active-minutes', 'total-calories', 'sedentary-period'];

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

// Parses a protobuf Duration string ("3600s", "3.5s") to minutes.
function durationToMinutes(value) {
  if (typeof value !== 'string') return 0;
  return toNumber(value.replace(/s$/, '')) / 60;
}

// Builds the activity summary from the per-data-type rollup points. A missing
// rollup (no device worn, or that one fetch failed) counts as 0.
function buildActivitySummary(rollups) {
  const activeLevels = rollups['active-minutes']?.activeMinutes?.activeMinutesRollupByActivityLevel || [];
  return {
    steps:            toNumber(rollups.steps?.steps?.countSum),
    distanceKm:       toNumber(rollups.distance?.distance?.millimetersSum) / 1e6,
    caloriesOut:      toNumber(rollups['total-calories']?.totalCalories?.kcalSum),
    activeMinutes:    Math.round(activeLevels.reduce((sum, l) => sum + toNumber(l?.activeMinutesSum), 0)),
    sedentaryMinutes: Math.round(durationToMinutes(rollups['sedentary-period']?.sedentaryPeriod?.durationSum))
  };
}

// YYYY-MM-DD → the CivilDateTime shape dailyRollUp's range expects.
function civilDate(dateStr) {
  const [year, month, day] = dateStr.split('-').map(Number);
  return { date: { year, month, day } };
}

// One dailyRollUp call covering local dates start..endInclusive, returning
// the rollup points keyed by their YYYY-MM-DD date. Google caps the range at
// 14 days for active-minutes/total-calories and 90 for the rest.
async function fetchRollupRange(accessToken, healthUserId, dataType, start, endInclusive) {
  const response = await fetch(
    `${GOOGLE_HEALTH_API_BASE}/users/${healthUserId}/dataTypes/${dataType}/dataPoints:dailyRollUp`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        range: { start: civilDate(start), end: civilDate(addDays(endInclusive, 1)) },
        windowSizeDays: 1
      })
    }
  );
  const data = await response.json();
  if (!response.ok) throw new Error(data?.error?.message || `dailyRollUp(${dataType}) failed`);
  const byDate = {};
  (data.rollupDataPoints || []).forEach((point, i) => {
    const d = point?.civilStartTime?.date;
    const key = d?.year && d?.month && d?.day
      ? `${d.year}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}`
      : addDays(start, i);
    byDate[key] = point;
  });
  return byDate;
}

async function fetchDailyRollup(accessToken, healthUserId, dataType, date) {
  const byDate = await fetchRollupRange(accessToken, healthUserId, dataType, date, date);
  return byDate[date] || Object.values(byDate)[0] || null;
}

// GET /api/activity-sync/activity?date=YYYY-MM-DD — steps/activity summary
// for one day (defaults to today). Fetched live from Google Health API and
// cached in Firestore.
app.get('/api/activity-sync/activity', authenticateToken, async (req, res) => {
  if (!activitySyncEnabled) return sendError(res, 503, 'activity_sync.disabled', 'Activity Sync is not configured.');
  if (!req.user.uid) {
    return sendError(res, 403, 'activity_sync.requires_firebase_auth', 'Please sign in again before syncing activity.');
  }

  const date = typeof req.query.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date)
    ? req.query.date
    : new Date().toISOString().slice(0, 10);

  try {
    const session = await getValidActivitySyncSession(req.user.uid);
    if (!session) return sendError(res, 409, 'activity_sync.not_connected', 'Activity Sync is not connected.');

    // Fetched in parallel (the app gives this request 8s), and one failing
    // data type doesn't sink the others. If every one fails, report the error.
    const results = await Promise.allSettled(ACTIVITY_SYNC_DATA_TYPES.map(dataType =>
      fetchDailyRollup(session.accessToken, session.healthUserId, dataType, date)));
    const rollups = {};
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') rollups[ACTIVITY_SYNC_DATA_TYPES[i]] = r.value;
      else console.warn(`[ActivitySync] dailyRollUp(${ACTIVITY_SYNC_DATA_TYPES[i]}) failed:`, r.reason?.message);
    });
    if (results.every(r => r.status === 'rejected')) throw results[0].reason;

    const activity = { date, ...buildActivitySummary(rollups), syncedAt: new Date().toISOString() };

    await db.collection(`users/${req.user.uid}/activitySync`).doc(date).set(activity, { merge: true });

    return sendSuccess(res, 200, { activity });
  } catch (err) {
    console.error('GET /api/activity-sync/activity failed:', err);
    return sendError(res, 500, 'activity_sync.server_error', String(err));
  }
});

// GET /api/activity-sync/daily?start=YYYY-MM-DD&end=YYYY-MM-DD — steps,
// distance, calories burned and active minutes for each local date in
// start..end (inclusive, at most 14 days; default the 7 days ending today).
// The app uses the history for a "calories burned per day" average.
const DAILY_HISTORY_TYPES = ['steps', 'distance', 'active-minutes', 'total-calories'];
const DAILY_HISTORY_MAX_DAYS = 14;

app.get('/api/activity-sync/daily', authenticateToken, async (req, res) => {
  if (!activitySyncEnabled) return sendError(res, 503, 'activity_sync.disabled', 'Activity Sync is not configured.');
  if (!req.user.uid) {
    return sendError(res, 403, 'activity_sync.requires_firebase_auth', 'Please sign in again before syncing activity.');
  }

  const isDate = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
  const end = isDate(req.query.end) ? req.query.end : new Date().toISOString().slice(0, 10);
  const start = isDate(req.query.start) ? req.query.start : addDays(end, -6);
  const spanDays = (new Date(end) - new Date(start)) / 86400000;
  if (!(spanDays >= 0 && spanDays < DAILY_HISTORY_MAX_DAYS)) {
    return sendError(res, 400, 'activity_sync.bad_range', `start must be on or before end, at most ${DAILY_HISTORY_MAX_DAYS} days apart.`);
  }

  try {
    const session = await getValidActivitySyncSession(req.user.uid);
    if (!session) return sendError(res, 409, 'activity_sync.not_connected', 'Activity Sync is not connected.');

    const results = await Promise.allSettled(DAILY_HISTORY_TYPES.map(dataType =>
      fetchRollupRange(session.accessToken, session.healthUserId, dataType, start, end)));
    const byType = {};
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') byType[DAILY_HISTORY_TYPES[i]] = r.value;
      else console.warn(`[ActivitySync] dailyRollUp(${DAILY_HISTORY_TYPES[i]}) history failed:`, r.reason?.message);
    });
    if (results.every(r => r.status === 'rejected')) throw results[0].reason;

    const days = [];
    for (let date = start; date <= end; date = addDays(date, 1)) {
      const rollups = {};
      DAILY_HISTORY_TYPES.forEach(t => { rollups[t] = byType[t]?.[date] || null; });
      const hasData = DAILY_HISTORY_TYPES.some(t => rollups[t]);
      const { sedentaryMinutes, ...summary } = buildActivitySummary(rollups);
      days.push({ date, hasData, ...summary });
    }
    return sendSuccess(res, 200, { start, end, days });
  } catch (err) {
    console.error('GET /api/activity-sync/daily failed:', err);
    return sendError(res, 500, 'activity_sync.server_error', String(err));
  }
});

// GET /api/activity-sync/recovery?start=YYYY-MM-DD&end=YYYY-MM-DD — daily
// resting heart rate (bpm) and HRV (ms) for local dates start..end
// (inclusive, at most 31 days; default the 8 days ending today, enough for
// today plus a 7-day baseline). Needs the health-metrics scope; connections
// made before it was added get 403 activity_sync.needs_reconnect.
const RECOVERY_MAX_DAYS = 31;

async function listRecoveryPoints(session, type, start, endExclusive) {
  let lastError = null;
  for (const filterName of type.filterNames) {
    const params = new URLSearchParams({ filter: recoveryFilter(filterName, start, endExclusive), pageSize: '100' });
    const response = await fetch(
      `${GOOGLE_HEALTH_API_BASE}/users/${session.healthUserId}/dataTypes/${type.dataType}/dataPoints?${params}`,
      { headers: { Authorization: `Bearer ${session.accessToken}` } }
    );
    const data = await response.json();
    if (response.ok) return data.dataPoints || [];
    lastError = Object.assign(new Error(data?.error?.message || `${type.dataType} list failed`), { status: response.status });
    if (response.status !== 400) break; // only a rejected filter is worth retrying
  }
  throw lastError;
}

app.get('/api/activity-sync/recovery', authenticateToken, async (req, res) => {
  if (!activitySyncEnabled) return sendError(res, 503, 'activity_sync.disabled', 'Activity Sync is not configured.');
  if (!req.user.uid) {
    return sendError(res, 403, 'activity_sync.requires_firebase_auth', 'Please sign in again before syncing recovery data.');
  }

  const isDate = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
  const end = isDate(req.query.end) ? req.query.end : new Date().toISOString().slice(0, 10);
  const start = isDate(req.query.start) ? req.query.start : addDays(end, -7);
  const spanDays = (new Date(end) - new Date(start)) / 86400000;
  if (!(spanDays >= 0 && spanDays < RECOVERY_MAX_DAYS)) {
    return sendError(res, 400, 'activity_sync.bad_range', `start must be on or before end, at most ${RECOVERY_MAX_DAYS} days apart.`);
  }

  try {
    const session = await getValidActivitySyncSession(req.user.uid);
    if (!session) return sendError(res, 409, 'activity_sync.not_connected', 'Activity Sync is not connected.');

    const results = await Promise.allSettled(RECOVERY_TYPES.map(type =>
      listRecoveryPoints(session, type, start, addDays(end, 1))));
    if (results.some(r => r.status === 'rejected' && r.reason?.status === 403)) {
      return sendError(res, 403, 'activity_sync.needs_reconnect', 'Reconnect Activity Sync to share heart rate and HRV.');
    }
    if (results.every(r => r.status === 'rejected')) throw results[0].reason;

    const pointsByType = {};
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') pointsByType[RECOVERY_TYPES[i].dataType] = r.value;
      else console.warn(`[ActivitySync] ${RECOVERY_TYPES[i].dataType} list failed:`, r.reason?.message);
    });
    return sendSuccess(res, 200, { start, end, days: mergeRecoveryPoints(pointsByType) });
  } catch (err) {
    console.error('GET /api/activity-sync/recovery failed:', err);
    return sendError(res, 500, 'activity_sync.server_error', String(err));
  }
});

// GET /api/activity-sync/body?start=YYYY-MM-DD&end=YYYY-MM-DD — everything
// the Body tab's analysis needs for local dates start..end (inclusive, at
// most 31 days; default the 30 days ending today):
//   days:     daily vitals { date, restingHeartRate, hrvMs, spo2,
//             respiratoryRate, skinTempDelta, vo2Max }
//   weighIns: smart-scale readings { date, weightKg, bodyFatPercent }
// Each data type is fetched on its own; a type the user's device doesn't
// record just comes back empty. needsReconnect is true when Google refused a
// type for lack of the health-metrics scope.
const BODY_MAX_DAYS = 31;

// dataPoints.list with each candidate filter in turn (Google's docs spell
// the filter field two ways); only a 400 moves on to the next spelling.
async function listWithFilters(session, dataType, filters) {
  let lastError = null;
  for (const filter of filters) {
    const points = [];
    let pageToken = '';
    let ok = true;
    for (let page = 0; page < 5; page++) {
      const params = new URLSearchParams({ filter, pageSize: '100' });
      if (pageToken) params.set('pageToken', pageToken);
      const response = await fetch(
        `${GOOGLE_HEALTH_API_BASE}/users/${session.healthUserId}/dataTypes/${dataType}/dataPoints?${params}`,
        { headers: { Authorization: `Bearer ${session.accessToken}` } }
      );
      const data = await response.json();
      if (!response.ok) {
        lastError = Object.assign(new Error(data?.error?.message || `${dataType} list failed`), { status: response.status });
        ok = false;
        break;
      }
      points.push(...(data.dataPoints || []));
      pageToken = data.nextPageToken || '';
      if (!pageToken) break;
    }
    if (ok) return points;
    if (lastError.status !== 400) break;
  }
  throw lastError;
}

app.get('/api/activity-sync/body', authenticateToken, async (req, res) => {
  if (!activitySyncEnabled) return sendError(res, 503, 'activity_sync.disabled', 'Activity Sync is not configured.');
  if (!req.user.uid) {
    return sendError(res, 403, 'activity_sync.requires_firebase_auth', 'Please sign in again before syncing body data.');
  }

  const isDate = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
  const end = isDate(req.query.end) ? req.query.end : new Date().toISOString().slice(0, 10);
  const start = isDate(req.query.start) ? req.query.start : addDays(end, -29);
  const spanDays = (new Date(end) - new Date(start)) / 86400000;
  if (!(spanDays >= 0 && spanDays < BODY_MAX_DAYS)) {
    return sendError(res, 400, 'activity_sync.bad_range', `start must be on or before end, at most ${BODY_MAX_DAYS} days apart.`);
  }

  try {
    const session = await getValidActivitySyncSession(req.user.uid);
    if (!session) return sendError(res, 409, 'activity_sync.not_connected', 'Activity Sync is not connected.');

    const endExclusive = addDays(end, 1);
    const jobs = [
      ...DAILY_VITALS.map(t => ({ t, filters: t.filterNames.map(n => dailyFilter(n, start, endExclusive)) })),
      ...SCALE_SAMPLES.map(t => ({ t, filters: t.filterNames.map(n => sampleFilter(n, start, endExclusive)) }))
    ];
    const results = await Promise.allSettled(jobs.map(j => listWithFilters(session, j.t.dataType, j.filters)));

    const points = {};
    let needsReconnect = false;
    results.forEach((r, i) => {
      const { dataType } = jobs[i].t;
      if (r.status === 'fulfilled') points[dataType] = r.value;
      else {
        if (r.reason?.status === 403) needsReconnect = true;
        console.warn(`[ActivitySync] ${dataType} list failed:`, r.reason?.message);
      }
    });
    if (results.every(r => r.status === 'rejected') && !needsReconnect) throw results[0].reason;

    return sendSuccess(res, 200, {
      start,
      end,
      days: mergeDailyVitals(points),
      weighIns: mergeWeighIns(points),
      needsReconnect
    });
  } catch (err) {
    console.error('GET /api/activity-sync/body failed:', err);
    return sendError(res, 500, 'activity_sync.server_error', String(err));
  }
});

// Sleep has no dailyRollUp (sessions can span midnight), so it's fetched via
// dataPoints.list, filtered on the session's local (civil) end time. "Last
// night" is attributed to the day the user wakes up: sessions ending from
// local noon the day before through local noon of `date`. The main overnight
// sleep wins over naps; otherwise the latest-ending one.
const SLEEP_ASLEEP_STAGES = ['LIGHT', 'DEEP', 'REM', 'ASLEEP', 'RESTLESS'];

async function fetchSleepSession(accessToken, healthUserId, date) {
  const filter = `sleep.interval.civil_end_time >= "${addDays(date, -1)}T12:00:00" AND sleep.interval.civil_end_time < "${date}T12:00:00"`;

  const response = await fetch(
    `${GOOGLE_HEALTH_API_BASE}/users/${healthUserId}/dataTypes/sleep/dataPoints?`
    + new URLSearchParams({ filter, pageSize: '25' }),
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  const data = await response.json();
  if (!response.ok) throw new Error(data?.error?.message || 'sleep dataPoints.list failed');

  const sessions = (data.dataPoints || [])
    .map(p => p?.sleep)
    .filter(s => s?.interval?.startTime && s?.interval?.endTime);
  if (!sessions.length) return null;

  const endOf = s => new Date(s.interval.endTime).getTime();
  const pool = sessions.filter(s => s.metadata?.mainSleep);
  const latest = (pool.length ? pool : sessions).reduce((best, s) => (endOf(s) > endOf(best) ? s : best));
  const interval = latest.interval;

  const stageMinutes = { LIGHT: 0, DEEP: 0, REM: 0, AWAKE: 0, ASLEEP: 0, RESTLESS: 0 };
  for (const stage of latest.stages || []) {
    const type = String(stage?.type || '').toUpperCase();
    const mins = (new Date(stage.endTime) - new Date(stage.startTime)) / 60000;
    if (Number.isFinite(mins) && mins > 0 && type in stageMinutes) stageMinutes[type] += mins;
  }
  const stagedAsleep = SLEEP_ASLEEP_STAGES.reduce((sum, t) => sum + stageMinutes[t], 0);
  // Google's own summary is the better number when present (int64 → string).
  const summaryAsleep = Number(latest.summary?.minutesAsleep);
  const sleepMinutes = Number.isFinite(summaryAsleep) && summaryAsleep > 0 ? summaryAsleep : stagedAsleep;
  const timeInBedMinutes = (new Date(interval.endTime) - new Date(interval.startTime)) / 60000;
  const awakenings = (latest.shortAwakenings || []).length;

  return {
    bedtime: interval.startTime,
    wakeTime: interval.endTime,
    sleepMinutes: Math.round(sleepMinutes),
    timeInBedMinutes: Math.round(timeInBedMinutes),
    lightMinutes: Math.round(stageMinutes.LIGHT),
    deepMinutes: Math.round(stageMinutes.DEEP),
    remMinutes: Math.round(stageMinutes.REM),
    awakeMinutes: Math.round(stageMinutes.AWAKE),
    awakenings
  };
}

// Original estimate — Google/Fitbit's own sleep-scoring algorithms are not
// public, so this is NOT a reproduction of any vendor's score. Weighted on
// duration-vs-goal (50pts), the deep+REM "restorative" proportion of total
// sleep (35pts, scored against ~45% as a typical healthy reference ratio),
// and restfulness (15pts, -1 per awakening). The frontend must label this
// as an estimate, not present it as an authoritative/clinical score.
function computeSleepScore({ sleepMinutes, deepMinutes, remMinutes, awakenings }, goalMinutes) {
  const goal = Number(goalMinutes) > 0 ? Number(goalMinutes) : 480; // default 8h
  const durationScore = Math.min(sleepMinutes / goal, 1) * 50;
  const restorativeRatio = sleepMinutes > 0 ? (deepMinutes + remMinutes) / sleepMinutes : 0;
  const qualityScore = Math.min(restorativeRatio / 0.45, 1) * 35;
  const restfulnessScore = Math.max(15 - Math.min(awakenings, 15), 0);
  // "Classic" sleep (no stage breakdown) has no deep/REM data, so score it on
  // duration and restfulness alone, scaled to 100, instead of capping it at 65.
  const hasStages = deepMinutes + remMinutes > 0;
  const score = Math.round(hasStages
    ? durationScore + qualityScore + restfulnessScore
    : (durationScore + restfulnessScore) * (100 / 65));
  const label = score >= 90 ? 'Excellent' : score >= 80 ? 'Good' : score >= 60 ? 'Fair' : 'Poor';
  return { score, label };
}

// GET /api/activity-sync/sleep?date=YYYY-MM-DD&goalMinutes=480 — last
// night's sleep (defaults to the night ending on `date`, or today).
// goalMinutes is optional, passed in from the frontend's own
// settings.profile.goals.sleepTarget (hours*60) rather than looked up
// server-side, since profile goals live client-side in this app.
app.get('/api/activity-sync/sleep', authenticateToken, async (req, res) => {
  if (!activitySyncEnabled) return sendError(res, 503, 'activity_sync.disabled', 'Activity Sync is not configured.');
  if (!req.user.uid) {
    return sendError(res, 403, 'activity_sync.requires_firebase_auth', 'Please sign in again before syncing sleep.');
  }

  const date = typeof req.query.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date)
    ? req.query.date
    : new Date().toISOString().slice(0, 10);
  const goalMinutes = Number(req.query.goalMinutes) > 0 ? Number(req.query.goalMinutes) : 480;

  try {
    const session = await getValidActivitySyncSession(req.user.uid);
    if (!session) return sendError(res, 409, 'activity_sync.not_connected', 'Activity Sync is not connected.');

    const sleepSession = await fetchSleepSession(session.accessToken, session.healthUserId, date);
    if (!sleepSession) return sendError(res, 404, 'activity_sync.no_sleep_data', 'No sleep data found for that night.');

    const { score, label } = computeSleepScore(sleepSession, goalMinutes);
    const sleep = { date, ...sleepSession, score, label, syncedAt: new Date().toISOString() };

    await db.collection(`users/${req.user.uid}/activitySync`).doc(date).set({ sleep }, { merge: true });

    return sendSuccess(res, 200, { sleep });
  } catch (err) {
    console.error('GET /api/activity-sync/sleep failed:', err);
    return sendError(res, 500, 'activity_sync.server_error', String(err));
  }
});

// GET /api/activity-sync/exercises?start=YYYY-MM-DD&end=YYYY-MM-DD — workouts
// recorded by the user's tracker that started on local dates start..end
// (inclusive; default: the 7 days ending `end`, which defaults to today).
// The app merges these into its cardio log.
const EXERCISE_MAX_RANGE_DAYS = 31;
const EXERCISE_MAX_PAGES = 4; // Google caps exercise pages at 25 points

app.get('/api/activity-sync/exercises', authenticateToken, async (req, res) => {
  if (!activitySyncEnabled) return sendError(res, 503, 'activity_sync.disabled', 'Activity Sync is not configured.');
  if (!req.user.uid) {
    return sendError(res, 403, 'activity_sync.requires_firebase_auth', 'Please sign in again before syncing workouts.');
  }

  const isDate = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
  const end = isDate(req.query.end) ? req.query.end : new Date().toISOString().slice(0, 10);
  const start = isDate(req.query.start) ? req.query.start : addDays(end, -6);
  const spanDays = (new Date(end) - new Date(start)) / 86400000;
  if (!(spanDays >= 0 && spanDays < EXERCISE_MAX_RANGE_DAYS)) {
    return sendError(res, 400, 'activity_sync.bad_range', `start must be on or before end, at most ${EXERCISE_MAX_RANGE_DAYS} days apart.`);
  }

  try {
    const session = await getValidActivitySyncSession(req.user.uid);
    if (!session) return sendError(res, 409, 'activity_sync.not_connected', 'Activity Sync is not connected.');

    const points = [];
    let pageToken = '';
    for (let page = 0; page < EXERCISE_MAX_PAGES; page++) {
      const params = new URLSearchParams({ filter: exerciseFilter(start, end), pageSize: '25' });
      if (pageToken) params.set('pageToken', pageToken);
      const response = await fetch(
        `${GOOGLE_HEALTH_API_BASE}/users/${session.healthUserId}/dataTypes/exercise/dataPoints?${params}`,
        { headers: { Authorization: `Bearer ${session.accessToken}` } }
      );
      const data = await response.json();
      if (!response.ok) throw new Error(data?.error?.message || 'exercise dataPoints.list failed');
      points.push(...(data.dataPoints || []));
      pageToken = data.nextPageToken || '';
      if (!pageToken) break;
    }

    const exercises = points.map(normalizeExercise).filter(Boolean);
    return sendSuccess(res, 200, { start, end, exercises });
  } catch (err) {
    console.error('GET /api/activity-sync/exercises failed:', err);
    return sendError(res, 500, 'activity_sync.server_error', String(err));
  }
});

// ── Programs ──────────────────────────────────────────────────────────────────
const PROGRAMS_TABLE = process.env.AIRTABLE_PROGRAMS_TABLE || 'Programs';

// POST /programs — save a new program
// POST /saveProgram — legacy alias used by ProgramTab.js
async function saveProgramHandler(req, res) {
  try {
    // Accept both { program } and { draft } shapes from the frontend
    const body = req.body || {};
    const program = body.program || body.draft || body;
    const username = req.user.username;

    if (!username) return sendError(res, 422, 'programs.missing_username', 'username / userId is required.');
    if (!program.name) return sendError(res, 422, 'programs.missing_name', 'Program name is required.');

    const uid = await resolveFirestoreUid(username);
    if (uid) {
      const docRef = db.collection(`users/${uid}/programs`).doc();
      await docRef.set({
        name: String(program.name),
        startDate: program.startDate ? String(program.startDate) : '',
        isActive: true,
        programData: program,
        createdAt: new Date().toISOString()
      });
      return sendSuccess(res, 201, { recordId: docRef.id });
    }

    if (!airtableEnabled) return sendError(res, 503, 'programs.airtable_disabled', 'Airtable is not configured.');

    const url = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(PROGRAMS_TABLE)}`;
    const response = await airtableFetch(url, {
      method: 'POST',
      headers: airtableHeaders(),
      body: JSON.stringify({
        records: [{
          fields: {
            [USERNAME_FIELD]: String(username),
            ProgramName:  String(program.name),
            ProgramData:  JSON.stringify(program),
            StartDate:    program.startDate ? String(program.startDate) : '',
            IsActive:     true,
            CreatedAt:    new Date().toISOString()
          }
        }]
      })
    });

    const data = await response.json();
    if (!response.ok) {
      return sendError(res, 422, 'programs.airtable_rejected', 'Airtable rejected the request.',
        data?.error?.message || JSON.stringify(data));
    }

    return sendSuccess(res, 201, { recordId: data?.records?.[0]?.id || null });
  } catch (err) {
    console.error('POST /programs failed:', err);
    return sendError(res, 500, 'programs.server_error', String(err));
  }
}

app.post('/programs',    authenticateToken, saveProgramHandler);
app.post('/saveProgram', authenticateToken, saveProgramHandler); // legacy alias

// GET /programs?username=... — load all programs for a user
app.get('/programs', authenticateToken, async (req, res) => {
  try {
    const username = req.user.username;

    const uid = await resolveFirestoreUid(username);
    if (uid) {
      const snap = await db.collection(`users/${uid}/programs`).orderBy('createdAt', 'desc').get();
      const items = snap.docs.map(d => ({
        id: d.id,
        name: d.get('name') || d.get('programData')?.name || 'Unnamed',
        startDate: d.get('startDate') || d.get('programData')?.startDate || '',
        isActive: d.get('isActive') || false,
        createdAt: d.get('createdAt') || '',
        programData: d.get('programData') ?? null
      }));
      return sendSuccess(res, 200, { items });
    }

    if (!airtableEnabled) return res.json({ success: true, items: [] });

    const safeUsername = escapeAirtableFormulaValue(username);
    const records = await base(PROGRAMS_TABLE)
      .select({
        filterByFormula: `{${USERNAME_FIELD}}='${safeUsername}'`,
        sort: [{ field: 'CreatedAt', direction: 'desc' }],
        pageSize: 100
      })
      .all();

    const items = records.map(r => {
      let programData = null;
      try { programData = r.get('ProgramData') ? JSON.parse(r.get('ProgramData')) : null; } catch {}
      return {
        id:          r.id,
        name:        r.get('ProgramName') || programData?.name || 'Unnamed',
        startDate:   r.get('StartDate')   || programData?.startDate || '',
        isActive:    r.get('IsActive')    || false,
        createdAt:   r.get('CreatedAt')   || '',
        programData
      };
    });

    return sendSuccess(res, 200, { items });
  } catch (err) {
    console.error('GET /programs failed:', err);
    return sendError(res, 500, 'programs.server_error', String(err));
  }
});

// PATCH /programs/:id/active — set a program as active (clears others)
app.patch('/programs/:id/active', authenticateToken, async (req, res) => {
  const { id } = req.params;
  if (!id) return sendError(res, 400, 'programs.missing_id', 'Record ID is required.');

  const uid = await resolveFirestoreUid(req.user.username);
  if (uid) {
    try {
      const col = db.collection(`users/${uid}/programs`);
      const targetSnap = await col.doc(id).get();
      if (!targetSnap.exists) return sendError(res, 404, 'programs.not_found', 'Program not found.');

      const activeSnap = await col.where('isActive', '==', true).get();
      await Promise.all(activeSnap.docs.map(d => d.ref.set({ isActive: false }, { merge: true })));
      await col.doc(id).set({ isActive: true }, { merge: true });
      return sendSuccess(res, 200, { recordId: id });
    } catch (err) {
      console.error('PATCH /programs/:id/active (Firestore) failed:', err);
      return sendError(res, 500, 'programs.server_error', String(err));
    }
  }

  const username = typeof req.query.username === 'string' ? req.query.username.trim()
    : (req.body?.username || '');
  if (!airtableEnabled) return sendError(res, 503, 'programs.airtable_disabled', 'Airtable is not configured.');

  try {
    // First clear all active flags for this user
    if (username) {
      const safeUsername = escapeAirtableFormulaValue(username);
      const existing = await base(PROGRAMS_TABLE)
        .select({ filterByFormula: `AND({${USERNAME_FIELD}}='${safeUsername}',{IsActive}=1)` })
        .all();
      if (existing.length) {
        // Airtable update max 10 records per call — batch
        const toDeactivate = existing.map(r => ({ id: r.id, fields: { IsActive: false } }));
        for (let i = 0; i < toDeactivate.length; i += 10) {
          await base(PROGRAMS_TABLE).update(toDeactivate.slice(i, i + 10));
        }
      }
    }

    // Set the target program as active
    const updated = await base(PROGRAMS_TABLE).update([{ id, fields: { IsActive: true } }]);
    return sendSuccess(res, 200, { recordId: updated[0]?.id });
  } catch (err) {
    console.error('PATCH /programs/:id/active failed:', err);
    return sendError(res, 500, 'programs.server_error', String(err));
  }
});

// DELETE /programs/:id
app.delete('/programs/:id', authenticateToken, async (req, res) => {
  const { id } = req.params;
  if (!id) return sendError(res, 400, 'programs.missing_id', 'Record ID is required.');

  const uid = await resolveFirestoreUid(req.user.username);
  if (uid) {
    // Ownership is implicit — the doc only exists under this uid's own subcollection.
    try {
      const docRef = db.collection(`users/${uid}/programs`).doc(id);
      const snap = await docRef.get();
      if (!snap.exists) return sendError(res, 404, 'programs.not_found', 'Program not found.');
      await docRef.delete();
      return sendSuccess(res, 200, { deleted: id });
    } catch (err) {
      console.error('DELETE /programs/:id (Firestore) failed:', err);
      return sendError(res, 500, 'programs.server_error', String(err));
    }
  }

  if (!airtableEnabled) return sendError(res, 503, 'programs.airtable_disabled', 'Airtable is not configured.');

  try {
    // Verify ownership before deleting
    const record = await base(PROGRAMS_TABLE).find(id);
    if (!record || record.fields[USERNAME_FIELD] !== req.user.username) {
      return sendError(res, 403, 'programs.forbidden', 'You do not own this program.');
    }
    const url = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(PROGRAMS_TABLE)}/${encodeURIComponent(id)}`;
    const response = await airtableFetch(url, { method: 'DELETE', headers: airtableHeaders() });
    if (!response.ok) {
      const text = await response.text();
      return sendError(res, response.status, 'programs.airtable_rejected', 'Airtable rejected the delete.', text);
    }
    return sendSuccess(res, 200, { deleted: id });
  } catch (err) {
    console.error('DELETE /programs/:id failed:', err);
    return sendError(res, 500, 'programs.server_error', String(err));
  }
});

// POST /sendTemplate — share a template with another user by copying it to their record
app.post('/sendTemplate', authenticateToken, async (req, res) => {
  const { fromUser, toUser, templateName, templateData } = req.body || {};
  if (!fromUser || !toUser || !templateName || !templateData) {
    return sendError(res, 400, 'templates.invalid_payload', 'fromUser, toUser, templateName, and templateData are required.');
  }

  // Only to accepted friends (and not blocked either way) — otherwise anyone
  // could drop templates into any account. The sender is the caller, never
  // the body's fromUser.
  const me = profileKey(req.user?.username);
  const to = profileKey(toUser);
  if (!me || !to || me === to) return sendError(res, 422, 'templates.invalid_recipient', 'Enter a friend’s username.');
  if (firebaseEnabled) {
    const friendship = await db.collection('friendships').doc(friendPairId(me, to)).get();
    if (!friendship.exists || friendship.get('status') !== 'accepted' || await isBlockedEitherWay(db, me, to)) {
      return sendError(res, 403, 'templates.not_friends', 'You can only share templates with friends.');
    }
  }

  // Cross-user write: resolve the RECIPIENT's uid, not the caller's.
  const toUid = await resolveFirestoreUid(toUser);
  if (toUid) {
    try {
      const docRef = db.collection(`users/${toUid}/templates`).doc();
      await docRef.set({ name: String(templateName), templateData });
      return sendSuccess(res, 200, { record: { id: docRef.id, fields: { TemplateName: templateName, Username: toUser } } });
    } catch (err) {
      console.error('POST /sendTemplate (Firestore) failed:', err);
      return sendError(res, 500, 'templates.server_error', 'Server error sharing template.');
    }
  }

  if (!airtableEnabled) {
    return sendError(res, 503, 'templates.airtable_disabled', 'Airtable is not configured.');
  }

  try {
    const url = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(TEMPLATES_TABLE_NAME)}`;
    const response = await airtableFetch(url, {
      method: 'POST',
      headers: airtableHeaders(),
      body: JSON.stringify({
        records: [{
          fields: {
            Username:     String(toUser),
            TemplateName: String(templateName),
            TemplateData: JSON.stringify(templateData)
          }
        }]
      })
    });

    if (!response.ok) {
      const text = await response.text();
      return sendError(res, response.status, 'templates.airtable_rejected', 'Airtable rejected the request.', text);
    }

    const result = await response.json();
    return sendSuccess(res, 200, { record: result?.records?.[0] || result });
  } catch (err) {
    console.error('POST /sendTemplate failed:', err);
    return sendError(res, 500, 'templates.server_error', 'Server error sharing template.');
  }
});

// DELETE /templates/:id — delete a template record by Airtable record ID
app.delete('/templates/:id', authenticateToken, async (req, res) => {
  const { id } = req.params;
  if (!id) return sendError(res, 400, 'templates.missing_id', 'Record ID is required.');

  const uid = await resolveFirestoreUid(req.user.username);
  if (uid) {
    // Ownership is implicit — the doc only exists under this uid's own
    // templates subcollection, unlike Airtable's shared-table model.
    try {
      const docRef = db.collection(`users/${uid}/templates`).doc(id);
      const snap = await docRef.get();
      if (!snap.exists) return sendError(res, 404, 'templates.not_found', 'Template not found.');
      await docRef.delete();
      return sendSuccess(res, 200, { deleted: id });
    } catch (err) {
      console.error('DELETE /templates/:id (Firestore) failed:', err);
      return sendError(res, 500, 'templates.server_error', 'Server error deleting template.');
    }
  }

  if (!airtableEnabled) return sendError(res, 503, 'templates.airtable_disabled', 'Airtable is not configured.');

  try {
    // Verify ownership before deleting
    const record = await base(TEMPLATES_TABLE_NAME).find(id);
    if (!record || record.fields[USERNAME_FIELD] !== req.user.username) {
      return sendError(res, 403, 'templates.forbidden', 'You do not own this template.');
    }
    const url = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(TEMPLATES_TABLE_NAME)}/${encodeURIComponent(id)}`;
    const response = await airtableFetch(url, { method: 'DELETE', headers: airtableHeaders() });

    if (!response.ok) {
      const text = await response.text();
      return sendError(res, response.status, 'templates.airtable_rejected', 'Airtable rejected the delete.', text);
    }

    return sendSuccess(res, 200, { deleted: id });
  } catch (err) {
    console.error('DELETE /templates/:id failed:', err);
    return sendError(res, 500, 'templates.server_error', 'Server error deleting template.');
  }
});

// POST /days/upsert + POST /days + GET /days — RETIRED (PHASE2-NOTES.md).
// Confirmed write-only dead weight: the frontend's workoutTimer.js posts here
// fire-and-forget, but nothing anywhere ever calls GET /days to read it back.
// Real data lives in Workouts/DailyMacros/CardioLog/BodyweightLog instead.
// Routes stay registered (so any cached old client build doesn't start
// getting 404s) but no longer touch Airtable or Firestore.
function upsertDayHandler(req, res) {
  return sendSuccess(res, 200, { day: req.body || {} });
}

app.post('/days/upsert', authenticateToken, upsertDayHandler);
app.post('/days',        authenticateToken, upsertDayHandler);

app.get('/days', authenticateToken, (_req, res) => {
  return res.json({ items: [] });
});

// ── Coach Dashboard ───────────────────────────────────────────────────────────
const COACH_CLIENTS_TABLE      = process.env.AIRTABLE_COACH_CLIENTS_TABLE || 'CoachClients';
const DAILY_MISSION_TABLE      = process.env.AIRTABLE_DAILY_MISSION_TABLE || 'DailyMissionState';

// GET /api/coach/clients?coachId= — return all clients linked to a coach
app.get('/api/coach/clients', authenticateToken, requireCoachPlan, async (req, res) => {
  try {
    const requestedCoachId = typeof req.query.coachId === 'string' ? req.query.coachId.trim() : '';
    if (requestedCoachId && requestedCoachId !== req.user.username) {
      return sendError(res, 403, 'coach.forbidden', 'coachId does not match the authenticated user.');
    }
    const coachId = req.user.username;

    // coachId is the coach's own username (legacyMigration.js migrates
    // CoachClients rows into coaches/{coachUid}/clients using that same key).
    const uid = await resolveFirestoreUid(coachId);
    if (uid) {
      const snap = await db.collection(`coaches/${uid}/clients`).orderBy('athleteDisplayName').get();
      const now = new Date();
      const clients = snap.docs.map(d => coachClientSummary(d.id, d.data() || {}, now));
      return sendSuccess(res, 200, { clients });
    }

    if (!airtableEnabled) return res.json({ success: true, clients: [] });

    const safeCoachId = escapeAirtableFormulaValue(coachId);
    const records = await base(COACH_CLIENTS_TABLE)
      .select({
        filterByFormula: `{CoachId}='${safeCoachId}'`,
        sort: [{ field: 'ClientName', direction: 'asc' }],
        pageSize: 100
      })
      .all();

    const clients = records.map(r => ({
      id:                   r.id,
      clientId:             r.get('ClientId')             || r.id,
      clientName:           r.get('ClientName')           || '',
      email:                r.get('Email')                || '',
      status:               r.get('Status')               || 'active',
      trainingMode:         r.get('TrainingMode')         || '',
      currentProgram:       r.get('CurrentProgram')       || '',
      lastCheckIn:          r.get('LastCheckIn')          || null,
      alertStatus:          r.get('AlertStatus')          || 'ok',
      currentNutritionSummary: r.get('NutritionSummary') || '',
      latestCheckInData:    (() => {
        try { return JSON.parse(r.get('LatestCheckInJson') || 'null'); } catch { return null; }
      })()
    }));

    return sendSuccess(res, 200, { clients });
  } catch (err) {
    console.error('GET /api/coach/clients failed:', err);
    return sendError(res, 500, 'coach.server_error', String(err));
  }
});

// Roster row for one client doc. Alerts are computed here, at read time, from
// whatever the client has shared (see src/coachShare.js), so "days since
// check-in" is always current and nothing is flagged on missing data.
function coachClientSummary(id, data, now = new Date()) {
  const { alerts, alertStatus } = coachShare.computeClientAlerts(data, now);
  return {
    id,
    clientId: id,
    clientName: data.athleteDisplayName || '',
    email: data.email || '',
    status: data.status || 'active',
    trainingMode: data.trainingMode || '',
    currentProgram: data.currentProgram || '',
    currentProgramId: data.currentProgramId || '',
    activeProgramName: data.activeProgramName || '',
    lastCheckIn: data.lastCheckInAt || null,
    alertStatus,
    alerts,
    currentNutritionSummary: data.nutritionSummary || '',
    macroTargets: data.macroTargets || null,
    macroPlan: data.macroPlan || null,
    mealPlanSummary: data.mealPlanSummary || '',
    hideNutritionNumbers: data.hideNutritionNumbers === true,
    latestCheckInData: data.latestCheckInJson ?? null,
    compliancePercent: data.compliancePercent ?? null,
    workoutsLoggedThisWeek: data.workoutsWeekStart === coachShare.weekStartOf(now) ? (data.workoutsLoggedThisWeek ?? null) : null,
    currentBodyweight: data.currentBodyweight ?? null,
    weeklyWeightChangePercent: data.weeklyWeightChangePercent ?? null,
    sharing: data.sharing || null,
    lastSharedAt: data.lastSharedAt || null,
    // Check-in dates with photos, dates the coach has commented on, and dates
    // where the client wrote last (src/checkInComments.js).
    photoDates: Array.isArray(data.photoDates) ? data.photoDates : [],
    coachCommentDates: Array.isArray(data.coachCommentDates) ? data.coachCommentDates : [],
    awaitingReplyDates: Array.isArray(data.awaitingReplyDates) ? data.awaitingReplyDates : [],
    // Inbox summary and the open check-in request (src/coachMessages.js).
    ...coachMessages.rosterSummary(data),
    // Check-in frequency and the coach's own questions; the newest check-in
    // the coach marked reviewed.
    checkInSettings: coachShare.sanitizeCheckInSettings(data.checkInSettings || {}),
    roadmap: coachShare.sanitizeRoadmap(data.roadmap),
    reviewedCheckInDate: typeof data.reviewedCheckInDate === 'string' ? data.reviewedCheckInDate : null
  };
}

// True when coaches/{coachUid}/clients/{clientUid} exists and is accepted.
async function isActiveCoachLink(coachUid, clientUid) {
  if (!coachUid || !clientUid) return false;
  const snap = await db.collection(`coaches/${coachUid}/clients`).doc(clientUid).get();
  return snap.exists && snap.get('status') === 'active';
}

// Linking clients is a Coach-plan feature. INTAKE_COACH_USERNAME (the account
// that owns the public intake form) is always allowed, and COACH_PLAN_REQUIRED=false
// turns the check off (e.g. for a beta).
async function hasCoachAccess(username, opts) {
  if (process.env.COACH_PLAN_REQUIRED === 'false') return true;
  if (process.env.INTAKE_COACH_USERNAME && String(username).toLowerCase() === String(process.env.INTAKE_COACH_USERNAME).toLowerCase()) return true;
  const info = await getUserPlanInfo(username, opts);
  return info.plan === 'coach';
}

// Verify a coach-client relationship exists in the CoachClients table.
async function verifyCoachClientLink(coachUsername, clientUsername) {
  if (!airtableEnabled) return false;
  const safeCoach = escapeAirtableFormulaValue(coachUsername);
  const safeClient = escapeAirtableFormulaValue(clientUsername);
  const records = await base(COACH_CLIENTS_TABLE)
    .select({
      filterByFormula: `AND({CoachId}='${safeCoach}',OR({ClientId}='${safeClient}',{ClientName}='${safeClient}'))`,
      maxRecords: 1
    })
    .firstPage();
  return records.length > 0;
}

// ── Real client linking (invite / accept / remove) ──────────────────────────
// Not wired up to the mobile app yet — the current "Add Client" UI there just
// writes a local, unlinked record on the coach's own device. This is the
// real, server-side relationship for when that UI is ready to call it: it
// links a coach to an ACTUAL registered athlete account (looked up by
// username) rather than a freeform note, so both sides can see and act on the
// relationship. Firestore-only — legacy (non-migrated) accounts fall back to
// the existing Airtable CoachClients table, which none of this touches.
//
// Flow: coach invites by username (POST .../invite, status "pending") →
// client accepts (POST .../accept) → status flips to "active" on both mirror
// docs. Mirrors are written on each side — coaches/{coachUid}/clients/{clientUid}
// for the coach's roster (already read by GET /api/coach/clients above) and
// users/{clientUid}/coachInvites/{coachUid} for the client's own view — so
// each party can query their side without depending on the other's collection.

const coachInviteLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: { code: 'coach.rate_limited', message: 'Too many requests. Try again shortly.' } }
});

// Firebase-auth'd requests carry the caller's uid on req.user already;
// legacy JWTs only carry {id, username}, so fall back to the same
// usernames/{} lookup the rest of the migration uses.
async function resolveCallerUid(user) {
  if (user?.uid) return user.uid;
  return resolveFirestoreUid(user?.username);
}

// users/{uid}.username, for notifications on routes that only know the uid.
async function usernameForUid(uid) {
  const snap = await db.collection('users').doc(uid).get();
  return snap.exists ? snap.get('username') || '' : '';
}

// POST /api/coach/clients/invite — body: { clientUsername }
// Coach invites an existing athlete account to link as a client.
app.post('/api/coach/clients/invite', authenticateToken, requireCoachPlan, coachInviteLimiter, async (req, res) => {
  if (!firebaseEnabled) return sendError(res, 503, 'coach.firebase_disabled', 'Client linking requires a migrated (Firebase) account.');
  try {
    const clientUsername = typeof req.body?.clientUsername === 'string' ? req.body.clientUsername.trim() : '';
    if (!USERNAME_RE.test(clientUsername)) {
      return sendError(res, 422, 'coach.invalid_username', 'Enter a valid client username.');
    }
    if (clientUsername.toLowerCase() === String(req.user.username || '').toLowerCase()) {
      return sendError(res, 422, 'coach.cannot_invite_self', 'You can’t add yourself as a client.');
    }

    const coachUid = await resolveCallerUid(req.user);
    if (!coachUid) {
      return sendError(res, 409, 'coach.not_migrated', 'Your account needs to complete migration before linking clients. Contact support.');
    }
    if (!(await hasCoachAccess(req.user.username))) {
      return sendError(res, 403, 'coach.plan_required', 'Inviting clients needs the Coach plan.');
    }

    const clientUid = await resolveFirestoreUid(clientUsername);
    if (!clientUid) {
      return sendError(res, 404, 'coach.client_not_found', 'No account found with that username.');
    }

    const clientDocRef = db.collection(`coaches/${coachUid}/clients`).doc(clientUid);
    const existing = await clientDocRef.get();
    if (existing.exists) {
      const status = existing.get('status');
      return sendError(res, 409, 'coach.already_linked',
        status === 'pending' ? 'An invite is already pending for this client.' : 'This client is already linked to your roster.');
    }

    const clientUserSnap = await db.collection('users').doc(clientUid).get();
    const clientEmail = clientUserSnap.exists ? (clientUserSnap.get('email') || '') : '';
    const inviteRef = db.collection(`users/${clientUid}/coachInvites`).doc(coachUid);
    const now = FieldValue.serverTimestamp();

    const batch = db.batch();
    batch.set(clientDocRef, {
      athleteDisplayName: clientUsername,
      email: clientEmail,
      status: 'pending',
      invitedBy: req.user.username,
      invitedAt: now
    });
    batch.set(inviteRef, {
      coachUsername: req.user.username,
      status: 'pending',
      invitedAt: now
    });
    await batch.commit();
    await coachNotifications.notifyCoachInvite(db, { coachUsername: req.user.username, clientUsername });

    return sendSuccess(res, 201, {
      client: { id: clientUid, clientId: clientUid, clientName: clientUsername, email: clientEmail, status: 'pending' }
    });
  } catch (err) {
    console.error('POST /api/coach/clients/invite failed:', err);
    return sendError(res, 500, 'coach.server_error', String(err));
  }
});

// POST /api/coach/clients/accept — body: { coachUsername }. Called by the
// invited athlete to confirm the relationship; flips both mirror docs to active.
app.post('/api/coach/clients/accept', authenticateToken, coachInviteLimiter, async (req, res) => {
  if (!firebaseEnabled) return sendError(res, 503, 'coach.firebase_disabled', 'Client linking requires a migrated (Firebase) account.');
  try {
    const coachUsername = typeof req.body?.coachUsername === 'string' ? req.body.coachUsername.trim() : '';
    if (!USERNAME_RE.test(coachUsername)) {
      return sendError(res, 422, 'coach.invalid_username', 'Missing or invalid coach username.');
    }

    const clientUid = await resolveCallerUid(req.user);
    if (!clientUid) {
      return sendError(res, 409, 'coach.not_migrated', 'Your account needs to complete migration first. Contact support.');
    }
    const coachUid = await resolveFirestoreUid(coachUsername);
    if (!coachUid) {
      return sendError(res, 404, 'coach.not_found', 'No coach account found with that username.');
    }

    const inviteRef = db.collection(`users/${clientUid}/coachInvites`).doc(coachUid);
    const clientDocRef = db.collection(`coaches/${coachUid}/clients`).doc(clientUid);
    const [inviteSnap, clientSnap] = await Promise.all([inviteRef.get(), clientDocRef.get()]);

    if (!inviteSnap.exists || !clientSnap.exists) {
      return sendError(res, 404, 'coach.invite_not_found', 'No pending invite from that coach.');
    }
    if (inviteSnap.get('status') !== 'pending') {
      return sendError(res, 409, 'coach.invite_not_pending', 'This invite is no longer pending.');
    }

    const userSnap = await db.collection('users').doc(clientUid).get();
    const sharing = coachShare.normalizeSharing(userSnap.exists ? userSnap.get('coachSharing') : null);

    const now = FieldValue.serverTimestamp();
    const batch = db.batch();
    batch.set(inviteRef, { status: 'active', acceptedAt: now }, { merge: true });
    batch.set(clientDocRef, { status: 'active', acceptedAt: now, sharing }, { merge: true });
    await batch.commit();
    await coachNotifications.coachInviteAccepted(db, {
      coachUsername: inviteSnap.get('coachUsername') || coachUsername, clientUsername: req.user.username,
    });
    await welcomeNewClient({ coachUid, coachUsername: inviteSnap.get('coachUsername') || coachUsername, clientUid, clientUsername: req.user.username });

    return sendSuccess(res, 200, { coachUsername, coachUid, status: 'active', sharing });
  } catch (err) {
    console.error('POST /api/coach/clients/accept failed:', err);
    return sendError(res, 500, 'coach.server_error', String(err));
  }
});

// GET /api/client/coach-invites — authenticated athlete's own view of
// users/{uid}/coachInvites, both pending (needs an Accept action) and
// active (already linked). The invite/accept routes above have existed
// since this flow was built, but nothing ever read this collection back —
// there was no way for an athlete to see or act on an invite at all.
app.get('/api/client/coach-invites', authenticateToken, async (req, res) => {
  if (!firebaseEnabled) return sendError(res, 503, 'coach.firebase_disabled', 'Client linking requires a migrated (Firebase) account.');
  try {
    const clientUid = await resolveCallerUid(req.user);
    if (!clientUid) {
      return sendError(res, 409, 'coach.not_migrated', 'Your account needs to complete migration first. Contact support.');
    }

    const snap = await db.collection(`users/${clientUid}/coachInvites`).orderBy('invitedAt', 'desc').get();
    const invites = snap.docs.map(d => ({
      coachUid: d.id,
      coachUsername: d.get('coachUsername') || '',
      status: d.get('status') || 'pending',
      invitedAt: d.get('invitedAt') || null,
      acceptedAt: d.get('acceptedAt') || null
    }));

    return sendSuccess(res, 200, { invites });
  } catch (err) {
    console.error('GET /api/client/coach-invites failed:', err);
    return sendError(res, 500, 'coach.server_error', String(err));
  }
});

// Removes a coach↔client link from both sides: the coach's roster doc (with
// its notes subcollection and every piece of data the client shared), the
// client's invite, and whatever the coach assigned. The client's own copy of
// past coach notes (users/{uid}/coachNotes) is theirs and stays.
async function unlinkCoachClient(coachUid, clientUid) {
  await db.recursiveDelete(db.collection(`coaches/${coachUid}/clients`).doc(clientUid));
  await db.collection(`users/${clientUid}/coachInvites`).doc(coachUid).delete();
  await db.collection(`users/${clientUid}/coachAssignment`).doc(coachUid).delete();
  await endPhotoSharing(coachUid, clientUid);
  // Pro from this coach's code ends with the link.
  await coachCodes.verify(clientUid).catch(err => console.error('[unlinkCoachClient] coach code check failed:', err.message));
}

// GET /api/client/coach-sharing — the athlete's switches for what linked
// coaches can see. Check-ins, bodyweight and workouts default to on; the
// food log (nutrition) is off until the client turns it on.
app.get('/api/client/coach-sharing', authenticateToken, async (req, res) => {
  if (!firebaseEnabled) return sendError(res, 503, 'coach.firebase_disabled', 'Client linking requires a migrated (Firebase) account.');
  try {
    const uid = await resolveCallerUid(req.user);
    if (!uid) return sendError(res, 409, 'coach.not_migrated', 'Your account needs to complete migration first. Contact support.');
    const snap = await db.collection('users').doc(uid).get();
    const stored = snap.exists ? snap.get('coachSharing') : null;
    return sendSuccess(res, 200, { sharing: coachShare.normalizeSharing(stored), decided: coachShare.decidedSharing(stored) });
  } catch (err) {
    console.error('GET /api/client/coach-sharing failed:', err);
    return sendError(res, 500, 'coach.server_error', String(err));
  }
});

// Active coaches for a client, from the client's own invite mirror.
async function activeCoachUidsFor(clientUid) {
  const snap = await db.collection(`users/${clientUid}/coachInvites`).where('status', '==', 'active').get();
  return snap.docs.map(d => d.id);
}

// PUT /api/client/coach-sharing — body: { checkIns?, bodyweight?, workouts?, nutrition? }
// Turning a switch off also deletes that data from every coach's copy.
app.put('/api/client/coach-sharing', authenticateToken, async (req, res) => {
  if (!firebaseEnabled) return sendError(res, 503, 'coach.firebase_disabled', 'Client linking requires a migrated (Firebase) account.');
  try {
    const uid = await resolveCallerUid(req.user);
    if (!uid) return sendError(res, 409, 'coach.not_migrated', 'Your account needs to complete migration first. Contact support.');
    const userRef = db.collection('users').doc(uid);
    // Store only the switches the client has set, so an undecided one (the
    // food log) stays undecided when another switch changes.
    const stored = coachShare.mergeSharing((await userRef.get()).get?.('coachSharing'), req.body);
    const sharing = coachShare.normalizeSharing(stored);
    await userRef.set({ coachSharing: stored }, { merge: true });

    const cleared = {};
    for (const key of coachShare.SHARING_KEYS) {
      if (!sharing[key]) for (const f of coachShare.SHARE_FIELDS[key]) cleared[f] = FieldValue.delete ? FieldValue.delete() : null;
    }
    // Check-in photos need both the check-ins and the photos switch. Turning
    // either off deletes them. (An undecided photos switch only hides them:
    // photos sent before the switch existed wait for the client's answer.)
    if (!sharing.checkIns || (req.body && req.body.photos === false)) {
      await checkInPhotos.deleteAllPhotos(db, uid);
      cleared.photoDates = FieldValue.delete ? FieldValue.delete() : null;
    }
    const coachUids = await activeCoachUidsFor(uid);
    if (coachUids.length) {
      const batch = db.batch();
      for (const coachUid of coachUids) {
        batch.set(db.collection(`coaches/${coachUid}/clients`).doc(uid), { sharing, ...cleared }, { merge: true });
      }
      await batch.commit();
    }
    return sendSuccess(res, 200, { sharing, decided: coachShare.decidedSharing(stored) });
  } catch (err) {
    console.error('PUT /api/client/coach-sharing failed:', err);
    return sendError(res, 500, 'coach.server_error', String(err));
  }
});

const coachShareLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: { code: 'coach.rate_limited', message: 'Too many requests. Try again shortly.' } }
});

// POST /api/client/coach-share — the athlete's app pushes a snapshot
// (recent check-ins, bodyweight series, weekly workout counts, compliance).
// It's filtered by the athlete's sharing switches and copied onto every
// active coach's roster doc. No-op (200, coaches: 0) when not coached.
app.post('/api/client/coach-share', authenticateToken, coachShareLimiter, async (req, res) => {
  if (!firebaseEnabled) return sendError(res, 503, 'coach.firebase_disabled', 'Client linking requires a migrated (Firebase) account.');
  try {
    const uid = await resolveCallerUid(req.user);
    if (!uid) return sendError(res, 409, 'coach.not_migrated', 'Your account needs to complete migration first. Contact support.');
    const coachUids = await activeCoachUidsFor(uid);
    if (!coachUids.length) return sendSuccess(res, 200, { coaches: 0 });

    const userSnap = await db.collection('users').doc(uid).get();
    const sharing = coachShare.normalizeSharing(userSnap.exists ? userSnap.get('coachSharing') : null);
    const fields = coachShare.buildShareFields(req.body, sharing);
    const payload = { ...fields, sharing, lastSharedAt: new Date().toISOString().slice(0, 10), sharedAt: FieldValue.serverTimestamp() };

    const batch = db.batch();
    for (const coachUid of coachUids) {
      batch.set(db.collection(`coaches/${coachUid}/clients`).doc(uid), payload, { merge: true });
    }
    await batch.commit();
    return sendSuccess(res, 200, { coaches: coachUids.length, sharing });
  } catch (err) {
    console.error('POST /api/client/coach-share failed:', err);
    return sendError(res, 500, 'coach.server_error', String(err));
  }
});

// GET /api/coach/clients/:clientUid — full detail for one client, including
// the shared check-in history, bodyweight series and weekly workout counts.
app.get('/api/coach/clients/:clientUid', authenticateToken, requireCoachPlan, async (req, res) => {
  if (!firebaseEnabled) return sendError(res, 503, 'coach.firebase_disabled', 'Client linking requires a migrated (Firebase) account.');
  try {
    const clientUid = String(req.params.clientUid || '').trim();
    const coachUid = await resolveCallerUid(req.user);
    if (!coachUid) return sendError(res, 409, 'coach.not_migrated', 'Your account needs to complete migration first. Contact support.');
    const snap = await db.collection(`coaches/${coachUid}/clients`).doc(clientUid).get();
    if (!snap.exists) return sendError(res, 404, 'coach.not_linked', 'This client is not linked to your roster.');
    const data = snap.data() || {};
    // How many photos each check-in has (src/checkInPhotos.js), read from
    // the client's own index so the count is never stale.
    const photoIndex = (data.status || 'active') === 'active' && await clientPhotosAllowed(clientUid)
      ? await checkInPhotos.readIndex(db, clientUid) : {};
    const client = {
      ...coachClientSummary(clientUid, data),
      checkIns: (Array.isArray(data.checkIns) ? data.checkIns : [])
        .map(c => (c && photoIndex[c.date] ? { ...c, photoCount: photoIndex[c.date] } : c)),
      bodyweight: Array.isArray(data.bodyweight) ? data.bodyweight : [],
      weeklyWorkouts: Array.isArray(data.weeklyWorkouts) ? data.weeklyWorkouts : [],
      mealPlan: data.mealPlan || null
    };
    return sendSuccess(res, 200, { client });
  } catch (err) {
    console.error('GET /api/coach/clients/:clientUid failed:', err);
    return sendError(res, 500, 'coach.server_error', String(err));
  }
});

// ── Check-in photos (src/checkInPhotos.js) ──────────────────────────────────
// The client attaches photos (usually posing photos) to a check-in; linked
// coaches see them with that check-in while check-in sharing is on.

const checkInPhotoLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: { code: 'checkin_photos.rate_limited', message: 'Too many uploads. Try again shortly.' } }
});

const CHECKIN_PHOTO_ERRORS = {
  missing: [422, 'checkin_photos.missing', 'Add at least one photo.'],
  too_many: [422, 'checkin_photos.too_many', `Send at most ${checkInPhotos.MAX_PHOTOS} photos with a check-in.`],
  too_large: [413, 'checkin_photos.too_large', 'A photo is too large.'],
  invalid: [422, 'checkin_photos.invalid', 'Photos must be JPEG, PNG or WebP images.'],
};

// The client's live switches (not the copy on a roster doc): photos need
// check-ins and photos both on.
async function clientPhotosAllowed(clientUid) {
  const snap = await db.collection('users').doc(clientUid).get();
  return coachShare.photosAllowed(snap.exists ? snap.get('coachSharing') : null);
}

// Each active coach's roster row lists the check-in dates with photos, so the
// dashboard can flag new ones without reading the client's index.
async function syncPhotoDates(clientUid, index) {
  const dates = Object.keys(index || {}).sort().reverse();
  const coachUids = await activeCoachUidsFor(clientUid);
  await Promise.all(coachUids.map(c => db.collection(`coaches/${c}/clients`).doc(clientUid).set({ photoDates: dates }, { merge: true })));
}

// A coach <-> client link ended (either side): their comment threads go, and
// the client's photos go once no active coach is left to see them.
async function endPhotoSharing(coachUid, clientUid) {
  await checkInComments.deleteComments(db, { coachUid, clientUid });
  await coachMessages.deleteMessages(db, { coachUid, clientUid });
  await formChecks.deleteFormChecks(db, { coachUid, clientUid });
  if (!(await activeCoachUidsFor(clientUid)).length) await checkInPhotos.deleteAllPhotos(db, clientUid);
}

// PUT /api/client/checkin-photos/:date — body { photos: [{ image, pose? }] }
// replaces the photos on that check-in. Refused while check-in sharing is off.
app.put('/api/client/checkin-photos/:date', authenticateToken, checkInPhotoLimiter, async (req, res) => {
  if (!firebaseEnabled) return sendError(res, 503, 'coach.firebase_disabled', 'Check-in photos require a migrated (Firebase) account.');
  try {
    const date = checkInPhotos.isoDate(req.params.date);
    if (!date) return sendError(res, 422, 'checkin_photos.invalid_date', 'Use a YYYY-MM-DD date.');
    const uid = await resolveCallerUid(req.user);
    if (!uid) return sendError(res, 409, 'coach.not_migrated', 'Your account needs to complete migration first. Contact support.');
    const userSnap = await db.collection('users').doc(uid).get();
    const sharing = coachShare.normalizeSharing(userSnap.exists ? userSnap.get('coachSharing') : null);
    if (!sharing.checkIns) return sendError(res, 403, 'checkin_photos.sharing_off', 'Check-in sharing is turned off.');
    if (!sharing.photos) return sendError(res, 403, 'checkin_photos.photos_off', 'Photo sharing with your coach is turned off.');
    const parsed = checkInPhotos.parsePhotoList(req.body);
    if (parsed.error) {
      const [status, code, message] = CHECKIN_PHOTO_ERRORS[parsed.error];
      return sendError(res, status, code, message);
    }
    const index = await checkInPhotos.savePhotos(db, uid, date, parsed.photos);
    if (!index) return sendError(res, 422, 'checkin_photos.too_old', 'Only your most recent check-ins can have photos.');
    await syncPhotoDates(uid, index);
    return sendSuccess(res, 200, { date, count: index[date] });
  } catch (err) {
    console.error('PUT /api/client/checkin-photos/:date failed:', err);
    return sendError(res, 500, 'coach.server_error', String(err));
  }
});

// DELETE /api/client/checkin-photos/:date — removes that check-in's photos.
app.delete('/api/client/checkin-photos/:date', authenticateToken, async (req, res) => {
  if (!firebaseEnabled) return sendError(res, 503, 'coach.firebase_disabled', 'Check-in photos require a migrated (Firebase) account.');
  try {
    const date = checkInPhotos.isoDate(req.params.date);
    if (!date) return sendError(res, 422, 'checkin_photos.invalid_date', 'Use a YYYY-MM-DD date.');
    const uid = await resolveCallerUid(req.user);
    if (!uid) return sendError(res, 409, 'coach.not_migrated', 'Your account needs to complete migration first. Contact support.');
    await syncPhotoDates(uid, await checkInPhotos.deletePhotos(db, uid, date));
    return sendSuccess(res, 200, { date, count: 0 });
  } catch (err) {
    console.error('DELETE /api/client/checkin-photos/:date failed:', err);
    return sendError(res, 500, 'coach.server_error', String(err));
  }
});

// GET /api/coach/clients/:clientUid/checkin-photos/:date — the photos on one
// of a linked client's check-ins: { photos: [{ index, pose, image }] }.
app.get('/api/coach/clients/:clientUid/checkin-photos/:date', authenticateToken, requireCoachPlan, async (req, res) => {
  if (!firebaseEnabled) return sendError(res, 503, 'coach.firebase_disabled', 'Client linking requires a migrated (Firebase) account.');
  try {
    const clientUid = String(req.params.clientUid || '').trim();
    const date = checkInPhotos.isoDate(req.params.date);
    if (!clientUid || !date) return sendError(res, 422, 'checkin_photos.invalid_request', 'A client and a YYYY-MM-DD date are required.');
    const coachUid = await resolveCallerUid(req.user);
    if (!coachUid) return sendError(res, 409, 'coach.not_migrated', 'Your account needs to complete migration first. Contact support.');
    const snap = await db.collection(`coaches/${coachUid}/clients`).doc(clientUid).get();
    if (!snap.exists || (snap.get('status') || 'active') !== 'active') return sendError(res, 404, 'coach.not_linked', 'This client is not linked to your roster.');
    // The client's live switch, not the copy on the roster doc.
    res.set('Cache-Control', 'private, no-store');
    if (!(await clientPhotosAllowed(clientUid))) return sendSuccess(res, 200, { date, photos: [] });
    return sendSuccess(res, 200, { date, photos: await checkInPhotos.readPhotos(db, clientUid, date) });
  } catch (err) {
    console.error('GET /api/coach/clients/:clientUid/checkin-photos/:date failed:', err);
    return sendError(res, 500, 'coach.server_error', String(err));
  }
});

// ── Coach program library ────────────────────────────────────────────────────
// coaches/{coachUid}/programs/{programId}: "pocketcoach.program/2"
// (src/programs/model.js): weeks → days → rows. Older single-week docs
// ({ name, days: { Mon: [...] } }) are read as one repeating week. Shared by
// the mobile builder and the desktop console.
app.get('/api/coach/programs', authenticateToken, requireCoachPlan, async (req, res) => {
  if (!firebaseEnabled) return sendError(res, 503, 'coach.firebase_disabled', 'Coach programs require a migrated (Firebase) account.');
  try {
    const coachUid = await resolveCallerUid(req.user);
    if (!coachUid) return sendError(res, 409, 'coach.not_migrated', 'Your account needs to complete migration first. Contact support.');
    const snap = await db.collection(`coaches/${coachUid}/programs`).get();
    // Older docs are the single-week { name, days: { Mon: [...] } } shape:
    // always answer in the current shape (v2 plus the legacy `days` view).
    const programs = snap.docs.map(d => {
      const raw = d.data() || {};
      const p = coachShare.sanitizeCoachProgram(raw);
      return p ? { id: d.id, ...p, updatedAt: raw.updatedAt || null } : null;
    }).filter(Boolean)
      .sort((a, b) => String(a.name).localeCompare(String(b.name)));
    return sendSuccess(res, 200, { programs });
  } catch (err) {
    console.error('GET /api/coach/programs failed:', err);
    return sendError(res, 500, 'coach.server_error', String(err));
  }
});

const PROGRAM_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;

// PUT /api/coach/programs/:id — create or replace one program.
app.put('/api/coach/programs/:id', authenticateToken, requireCoachPlan, coachInviteLimiter, async (req, res) => {
  if (!firebaseEnabled) return sendError(res, 503, 'coach.firebase_disabled', 'Coach programs require a migrated (Firebase) account.');
  try {
    const id = String(req.params.id || '');
    if (!PROGRAM_ID_RE.test(id)) return sendError(res, 422, 'coach.invalid_program_id', 'Invalid program id.');
    const program = coachShare.sanitizeCoachProgram(req.body);
    if (!program) return sendError(res, 422, 'coach.invalid_payload', 'Program name is required.');
    const coachUid = await resolveCallerUid(req.user);
    if (!coachUid) return sendError(res, 409, 'coach.not_migrated', 'Your account needs to complete migration first. Contact support.');
    const ref = db.collection(`coaches/${coachUid}/programs`).doc(id);
    // An older app build only knows one week: don't let it flatten a
    // multi-week program by saving over it.
    if (coachShare.isV1ProgramBody(req.body)) {
      const existing = await ref.get();
      const prev = existing.exists ? coachShare.sanitizeCoachProgram(existing.data()) : null;
      if (prev && prev.weekCount > 1) {
        return sendError(res, 409, 'coach.program_multi_week', 'This program has several weeks. Edit it in the coach dashboard.');
      }
    }
    const saved = { ...program, updatedAt: new Date().toISOString() };
    await ref.set(saved);
    return sendSuccess(res, 200, { program: { id, ...saved } });
  } catch (err) {
    console.error('PUT /api/coach/programs/:id failed:', err);
    return sendError(res, 500, 'coach.server_error', String(err));
  }
});

app.delete('/api/coach/programs/:id', authenticateToken, requireCoachPlan, async (req, res) => {
  if (!firebaseEnabled) return sendError(res, 503, 'coach.firebase_disabled', 'Coach programs require a migrated (Firebase) account.');
  try {
    const coachUid = await resolveCallerUid(req.user);
    if (!coachUid) return sendError(res, 409, 'coach.not_migrated', 'Your account needs to complete migration first. Contact support.');
    const ref = db.collection(`coaches/${coachUid}/programs`).doc(String(req.params.id || ''));
    if (!(await ref.get()).exists) return sendError(res, 404, 'coach.program_not_found', 'Program not found.');
    await ref.delete();
    return sendSuccess(res, 200, { deleted: req.params.id });
  } catch (err) {
    console.error('DELETE /api/coach/programs/:id failed:', err);
    return sendError(res, 500, 'coach.server_error', String(err));
  }
});

// DELETE /api/coach/clients/:clientUid — coach removes (or cancels a pending
// invite to) a client. Client-initiated unlink is a natural follow-up to add
// once the mobile app actually surfaces this relationship, not built yet.
app.delete('/api/coach/clients/:clientUid', authenticateToken, requireCoachPlan, async (req, res) => {
  if (!firebaseEnabled) return sendError(res, 503, 'coach.firebase_disabled', 'Client linking requires a migrated (Firebase) account.');
  try {
    const clientUid = String(req.params.clientUid || '').trim();
    if (!clientUid) return sendError(res, 422, 'coach.missing_client_id', 'clientUid is required.');

    const coachUid = await resolveCallerUid(req.user);
    if (!coachUid) {
      return sendError(res, 409, 'coach.not_migrated', 'Your account needs to complete migration first. Contact support.');
    }

    const clientDocRef = db.collection(`coaches/${coachUid}/clients`).doc(clientUid);
    const existing = await clientDocRef.get();
    if (!existing.exists) {
      return sendError(res, 404, 'coach.not_linked', 'This client is not linked to your roster.');
    }

    await unlinkCoachClient(coachUid, clientUid);
    await coachNotifications.coachInviteWithdrawn(db, {
      coachUsername: req.user.username, clientUsername: existing.get('athleteDisplayName') || await usernameForUid(clientUid),
    });

    return sendSuccess(res, 200, { clientUid, removed: true });
  } catch (err) {
    console.error('DELETE /api/coach/clients/:clientUid failed:', err);
    return sendError(res, 500, 'coach.server_error', String(err));
  }
});

// DELETE /api/client/coaches/:coachUid — the athlete declines a pending
// invite or leaves a coach they're linked to. The app's Your Coach section
// has called this since the client-side coaching work, but the route only
// existed on an unmerged branch, so Decline and Leave failed with a 404.
// Same path and response as that branch (feat/coaching-readiness), so it
// can drop its copy when it's rebased.
app.delete('/api/client/coaches/:coachUid', authenticateToken, async (req, res) => {
  if (!firebaseEnabled) return sendError(res, 503, 'coach.firebase_disabled', 'Client linking requires a migrated (Firebase) account.');
  try {
    const coachUid = String(req.params.coachUid || '').trim();
    if (!coachUid || coachUid.includes('/')) return sendError(res, 422, 'coach.missing_coach_id', 'coachUid is required.');
    const clientUid = await resolveCallerUid(req.user);
    if (!clientUid) {
      return sendError(res, 409, 'coach.not_migrated', 'Your account needs to complete migration first. Contact support.');
    }
    const inviteRef = db.collection(`users/${clientUid}/coachInvites`).doc(coachUid);
    const invite = await inviteRef.get();
    if (!invite.exists) return sendError(res, 404, 'coach.not_linked', 'You are not linked to this coach.');
    const wasPending = invite.get('status') === 'pending';

    // The coach's roster entry (and the notes under it), then the athlete's
    // own mirrors of the invite and of what the coach assigned.
    await db.recursiveDelete(db.collection(`coaches/${coachUid}/clients`).doc(clientUid));
    await inviteRef.delete();
    await db.collection(`users/${clientUid}/coachAssignment`).doc(coachUid).delete();
    // Comment threads with this coach, and the photos if no coach is left.
    await endPhotoSharing(coachUid, clientUid);
    // Pro from this coach's code ends with the link.
    await coachCodes.verify(clientUid).catch(err => console.error('[client leave] coach code check failed:', err.message));

    await coachNotifications.coachLeftByClient(db, {
      coachUsername: invite.get('coachUsername') || await usernameForUid(coachUid),
      clientUsername: req.user.username,
      wasPending,
    });
    return sendSuccess(res, 200, { coachUid, removed: true, declined: wasPending });
  } catch (err) {
    console.error('DELETE /api/client/coaches/:coachUid failed:', err);
    return sendError(res, 500, 'coach.server_error', String(err));
  }
});

// ── Coach Pro codes (src/coachCode.js) ─────────────────────────────────────
// A coach shares their code; an athlete enters it under Settings › Account,
// which links them to the coach (no separate accept: typing the code is the
// consent) and gives them Pro while the coach keeps the Coach plan.

const coachCodeRedeemLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10, // codes are short; keep guessing slow
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: { code: 'coach_code.rate_limited', message: 'Too many tries. Wait a few minutes and try again.' } }
});

function coachCodeBody(code) {
  return { code, display: formatCode(code) };
}

// GET /api/coach/code — the coach's code (made on first call).
app.get('/api/coach/code', authenticateToken, requireCoachPlan, async (req, res) => {
  if (!firebaseEnabled) return sendError(res, 503, 'coach.firebase_disabled', 'Coach codes need a migrated (Firebase) account.');
  try {
    const coachUid = await resolveCallerUid(req.user);
    if (!coachUid) return sendError(res, 409, 'coach.not_migrated', 'Your account needs to complete migration first. Contact support.');
    const code = await coachCodes.getOrCreate(coachUid, req.user.username);
    return sendSuccess(res, 200, coachCodeBody(code));
  } catch (err) {
    console.error('GET /api/coach/code failed:', err);
    return sendError(res, 500, 'coach.server_error', 'Could not load your coach code.');
  }
});

// POST /api/coach/code/regenerate — a new code; the old one stops working.
// Clients who already joined keep Pro.
app.post('/api/coach/code/regenerate', authenticateToken, requireCoachPlan, coachInviteLimiter, async (req, res) => {
  if (!firebaseEnabled) return sendError(res, 503, 'coach.firebase_disabled', 'Coach codes need a migrated (Firebase) account.');
  try {
    const coachUid = await resolveCallerUid(req.user);
    if (!coachUid) return sendError(res, 409, 'coach.not_migrated', 'Your account needs to complete migration first. Contact support.');
    const code = await coachCodes.regenerate(coachUid, req.user.username);
    return sendSuccess(res, 200, coachCodeBody(code));
  } catch (err) {
    console.error('POST /api/coach/code/regenerate failed:', err);
    return sendError(res, 500, 'coach.server_error', 'Could not make a new code.');
  }
});

// POST /api/client/coach-code — body: { code }. Links the caller to the coach
// and gives them Pro.
app.post('/api/client/coach-code', authenticateToken, coachCodeRedeemLimiter, async (req, res) => {
  if (!firebaseEnabled) return sendError(res, 503, 'coach.firebase_disabled', 'Coach codes need a migrated (Firebase) account.');
  try {
    const clientUid = await resolveCallerUid(req.user);
    if (!clientUid) return sendError(res, 409, 'coach.not_migrated', 'Your account needs to complete migration first. Contact support.');

    const found = await coachCodes.lookup(req.body?.code);
    if (!found) return sendError(res, 404, 'coach_code.not_found', 'That code doesn’t match a coach. Check it and try again.');
    const { coachUid, code } = found;
    if (coachUid === clientUid) return sendError(res, 422, 'coach_code.own_code', 'That’s your own coach code. Share it with your clients.');

    const coachUsername = await usernameForUid(coachUid) || found.coachUsername;
    coachCodes.forgetCoach(coachUid); // check the coach's plan fresh
    if (!coachUsername || !(await coachCodes.coachIsActive(coachUid))) {
      return sendError(res, 409, 'coach_code.coach_inactive', 'This coach’s plan isn’t active, so the code can’t give Pro right now.');
    }

    // Link to the coach, the same two mirror docs an accepted invite has.
    const clientDocRef = db.collection(`coaches/${coachUid}/clients`).doc(clientUid);
    const inviteRef = db.collection(`users/${clientUid}/coachInvites`).doc(coachUid);
    const [clientSnap, userSnap] = await Promise.all([clientDocRef.get(), db.collection('users').doc(clientUid).get()]);
    const alreadyLinked = clientSnap.exists && clientSnap.get('status') === 'active';
    if (!alreadyLinked) {
      const sharing = coachShare.normalizeSharing(userSnap.exists ? userSnap.get('coachSharing') : null);
      const now = FieldValue.serverTimestamp();
      const batch = db.batch();
      batch.set(clientDocRef, {
        athleteDisplayName: req.user.username,
        email: userSnap.exists ? (userSnap.get('email') || '') : '',
        status: 'active',
        invitedBy: 'coach_code',
        invitedAt: clientSnap.exists ? (clientSnap.get('invitedAt') || now) : now,
        acceptedAt: now,
        sharing,
      }, { merge: true });
      batch.set(inviteRef, {
        coachUsername,
        status: 'active',
        invitedAt: now,
        acceptedAt: now,
        via: 'coach_code',
      }, { merge: true });
      await batch.commit();
      await coachNotifications.coachInviteAccepted(db, { coachUsername, clientUsername: req.user.username })
        .catch(err => console.error('[coach code] notification failed:', err.message));
      await welcomeNewClient({ coachUid, coachUsername, clientUid, clientUsername: req.user.username });
    }

    await coachCodes.grant(clientUid, { coachUid, coachUsername, code });
    return sendSuccess(res, 200, { coachUsername, coachUid, plan: 'pro', linked: true, alreadyLinked });
  } catch (err) {
    console.error('POST /api/client/coach-code failed:', err);
    return sendError(res, 500, 'coach.server_error', 'Could not use that code. Please try again.');
  }
});

// ── Coach → client assignment + notes ───────────────────────────────────────
// Program assignment, macro/nutrition summary, and notes were all coach-side
// UI features (both coach/coach.js and coaching-enhanced.js) that only ever
// wrote to the COACH'S OWN browser localStorage — nothing reached the
// client's account at all, despite UI copy implying it did. currentProgram
// and nutritionSummary already exist as real fields on the coach's client
// doc (read by GET /api/coach/clients above); this PATCH is the missing
// write side. Notes are new: mirrored the same way coachInvites already is
// (coach-side history + client-side inbox) so each party queries their own
// side without needing read access into the other's collection.

// PATCH /api/coach/clients/:clientUid — body: { currentProgram?, nutritionSummary?,
// trainingMode?, programId?, macroTargets?, hideNutritionNumbers? }
//   hideNutritionNumbers: true = the client's app hides calorie and macro
//     numbers so they only log (for clients who shouldn't count).
//   programId: a program from the coach's library (GET /api/coach/programs).
//     Its full content is converted to the app's program format and copied to
//     the client's assignment, so they can import it; '' clears it.
//   macroTargets: { calories, protein, carbs, fat } the client can apply.
//   macroPlan: { days: { training, rest?, high?, low? } (grams each),
//     schedule: { mon..sun: day type }, note? } — goes live in the client's
//     Macros tab. Also fills macroTargets with the training day for older
//     app versions. null clears it.
app.patch('/api/coach/clients/:clientUid', authenticateToken, requireCoachPlan, coachInviteLimiter, async (req, res) => {
  if (!firebaseEnabled) return sendError(res, 503, 'coach.firebase_disabled', 'Client linking requires a migrated (Firebase) account.');
  try {
    const clientUid = String(req.params.clientUid || '').trim();
    if (!clientUid) return sendError(res, 422, 'coach.missing_client_id', 'clientUid is required.');

    const fields = {};      // written to both the coach's doc and the client's mirror
    const clientOnly = {};  // full program content: client's mirror only
    for (const key of ['currentProgram', 'nutritionSummary', 'trainingMode']) {
      if (typeof req.body?.[key] === 'string') fields[key] = req.body[key].slice(0, 2000);
    }
    if (req.body?.macroTargets !== undefined) {
      const targets = req.body.macroTargets === null ? null : coachShare.sanitizeMacroTargets(req.body.macroTargets);
      if (req.body.macroTargets !== null && !targets) {
        return sendError(res, 422, 'coach.invalid_macros', 'macroTargets needs numeric calories, protein, carbs and fat.');
      }
      fields.macroTargets = targets;
    }
    if (req.body?.macroPlan !== undefined) {
      const plan = req.body.macroPlan === null ? null : coachShare.sanitizeMacroPlan(req.body.macroPlan);
      if (req.body.macroPlan !== null && !plan) {
        return sendError(res, 422, 'coach.invalid_macro_plan', 'macroPlan needs protein, carbs and fat for the training day, and for every other day type filled in.');
      }
      fields.macroPlan = plan;
      if (plan && req.body.macroTargets === undefined) fields.macroTargets = { ...plan.days.training };
    }
    if (typeof req.body?.hideNutritionNumbers === 'boolean') fields.hideNutritionNumbers = req.body.hideNutritionNumbers;
    // Long-term roadmap (phases and milestones); null clears it.
    if (req.body?.roadmap !== undefined) {
      const roadmap = req.body.roadmap === null ? null : coachShare.sanitizeRoadmap(req.body.roadmap);
      if (req.body.roadmap !== null && !roadmap) {
        return sendError(res, 422, 'coach.invalid_roadmap', 'A roadmap needs at least one phase (name, start and end date) or one milestone.');
      }
      fields.roadmap = roadmap;
    }
    if (req.body?.checkInSettings !== undefined) {
      const settings = coachShare.sanitizeCheckInSettings(req.body.checkInSettings);
      if (!settings) return sendError(res, 422, 'coach.invalid_checkin_settings', 'checkInSettings needs everyDays and questions.');
      fields.checkInSettings = settings;
    }
    // Meal plan (src/routes/coachMeals.js): on both docs, so the coach can
    // open and change it later; client lists only carry the one-line summary.
    if (req.body?.mealPlan !== undefined) {
      if (req.body.mealPlan === null) {
        fields.mealPlan = null;
        fields.mealPlanSummary = '';
      } else {
        const r = coachMeals.sanitizeMealPlan({ ...req.body.mealPlan, note: req.body.message ?? req.body.mealPlan.note });
        if (r.error) return sendError(res, 422, 'coach.invalid_meal_plan', r.error);
        fields.mealPlan = r.plan;
        fields.mealPlanSummary = r.summary;
      }
    }
    const programId = typeof req.body?.programId === 'string' ? req.body.programId.trim() : null;
    if (!Object.keys(fields).length && programId === null) {
      return sendError(res, 422, 'coach.invalid_payload', 'Provide at least one of currentProgram, programId, nutritionSummary, macroTargets, macroPlan, mealPlan, trainingMode, hideNutritionNumbers, checkInSettings, roadmap.');
    }

    const coachUid = await resolveCallerUid(req.user);
    if (!coachUid) {
      return sendError(res, 409, 'coach.not_migrated', 'Your account needs to complete migration first. Contact support.');
    }

    const clientDocRef = db.collection(`coaches/${coachUid}/clients`).doc(clientUid);
    const existing = await clientDocRef.get();
    if (!existing.exists) {
      return sendError(res, 404, 'coach.not_linked', 'This client is not linked to your roster.');
    }

    if (programId === '') {
      fields.currentProgram = '';
      fields.currentProgramId = '';
      clientOnly.program = null;
    } else if (programId) {
      const progSnap = await db.collection(`coaches/${coachUid}/programs`).doc(programId).get();
      if (!progSnap.exists) return sendError(res, 404, 'coach.program_not_found', 'That program is not in your library.');
      const stored = progSnap.data() || {};
      const program = coachShare.toClientProgram(stored, { coachUsername: req.user.username, programId, rev: stored.updatedAt || null });
      if (!program || !program.days.length) {
        return sendError(res, 422, 'coach.program_empty', 'Add at least one exercise to this program before assigning it.');
      }
      fields.currentProgram = program.title;
      fields.currentProgramId = programId;
      clientOnly.program = program;
      // What the client's "New from your coach" sheet shows, with the coach's optional note.
      const note = typeof req.body?.message === 'string' ? req.body.message.trim().slice(0, 500) : '';
      clientOnly.programAnnouncement = { programId, title: program.title, message: note, at: new Date().toISOString(), key: `program:${programId}:${Date.now().toString(36)}` };
    }

    const now = FieldValue.serverTimestamp();
    const batch = db.batch();
    batch.set(clientDocRef, { ...fields, updatedAt: now }, { merge: true });
    // Mirror onto the client's own doc so their app can show what their
    // coach has set, the same mirroring pattern coachInvites already uses.
    batch.set(db.collection(`users/${clientUid}/coachAssignment`).doc(coachUid), {
      coachUsername: req.user.username,
      ...fields,
      ...clientOnly,
      updatedAt: now
    }, { merge: true });
    await batch.commit();
    // Tells the dashboard whether the client was told, so the coach isn't
    // left guessing: 'notified', 'not_linked' (invite not accepted yet) or
    // 'muted' (coaching notifications off, or nothing to announce).
    const linkStatus = existing.get('status') || 'pending';
    let delivery = linkStatus === 'active' ? 'muted' : 'not_linked';
    if (linkStatus === 'active') {
      const a = clientOnly.programAnnouncement;
      const mp = fields.mealPlan;
      const sent = await coachNotifications.notifyCoachPlan(db, {
        coachUsername: req.user.username, clientUsername: existing.get('athleteDisplayName') || await usernameForUid(clientUid), fields,
        announce: a ? { kind: 'program', name: a.title, message: a.message, key: a.key }
          : mp ? { kind: 'meals', name: 'meal plan', message: mp.note, key: mp.key } : null,
      });
      if (sent > 0) delivery = 'notified';
    }

    return sendSuccess(res, 200, { clientUid, ...fields, linkStatus, delivery });
  } catch (err) {
    console.error('PATCH /api/coach/clients/:clientUid failed:', err);
    return sendError(res, 500, 'coach.server_error', String(err));
  }
});

// GET /api/client/coach-assignment — authenticated athlete's own view of
// whatever their coach(es) have set via the PATCH above.
app.get('/api/client/coach-assignment', authenticateToken, async (req, res) => {
  if (!firebaseEnabled) return sendError(res, 503, 'coach.firebase_disabled', 'Client linking requires a migrated (Firebase) account.');
  try {
    const clientUid = await resolveCallerUid(req.user);
    if (!clientUid) {
      return sendError(res, 409, 'coach.not_migrated', 'Your account needs to complete migration first. Contact support.');
    }
    const snap = await db.collection(`users/${clientUid}/coachAssignment`).get();
    const assignments = snap.docs.map(d => ({ coachUid: d.id, ...d.data() }));
    return sendSuccess(res, 200, { assignments });
  } catch (err) {
    console.error('GET /api/client/coach-assignment failed:', err);
    return sendError(res, 500, 'coach.server_error', String(err));
  }
});

// The coach's welcome automation, for a client who just became active. The
// message is a normal coach note, so it shows in the thread and notifies.
function welcomeNewClient(args) {
  return coachAutomations.sendWelcome(db, {
    ...args,
    onSent: async ({ coachUid, clientUid, coachUsername, clientUsername, text }) => {
      await coachMessages.recordCoachNote(db, { coachUid, clientUid, text });
      await coachNotifications.notifyCoachNote(db, { coachUsername, clientUsername });
    },
  });
}

const coachNoteLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: { code: 'coach.rate_limited', message: 'Too many requests. Try again shortly.' } }
});

// POST /api/coach/clients/:clientUid/notes — body: { text }
app.post('/api/coach/clients/:clientUid/notes', authenticateToken, requireCoachPlan, coachNoteLimiter, async (req, res) => {
  if (!firebaseEnabled) return sendError(res, 503, 'coach.firebase_disabled', 'Client linking requires a migrated (Firebase) account.');
  try {
    const clientUid = String(req.params.clientUid || '').trim();
    const text = typeof req.body?.text === 'string' ? req.body.text.trim().slice(0, 4000) : '';
    if (!clientUid) return sendError(res, 422, 'coach.missing_client_id', 'clientUid is required.');
    if (!text) return sendError(res, 422, 'coach.invalid_payload', 'text is required.');

    const coachUid = await resolveCallerUid(req.user);
    if (!coachUid) {
      return sendError(res, 409, 'coach.not_migrated', 'Your account needs to complete migration first. Contact support.');
    }

    const clientDocRef = db.collection(`coaches/${coachUid}/clients`).doc(clientUid);
    const existing = await clientDocRef.get();
    if (!existing.exists) {
      return sendError(res, 404, 'coach.not_linked', 'This client is not linked to your roster.');
    }

    const now = FieldValue.serverTimestamp();
    const noteRef = db.collection(`coaches/${coachUid}/clients/${clientUid}/notes`).doc();
    const note = { text, from: req.user.username, coachUsername: req.user.username, createdAt: now };

    const batch = db.batch();
    batch.set(noteRef, note);
    batch.set(db.collection(`users/${clientUid}/coachNotes`).doc(noteRef.id), note);
    await batch.commit();
    await coachMessages.recordCoachNote(db, { coachUid, clientUid, text });
    await coachNotifications.notifyCoachNote(db, {
      coachUsername: req.user.username, clientUsername: existing.get('athleteDisplayName') || await usernameForUid(clientUid),
    });

    return sendSuccess(res, 201, { noteId: noteRef.id });
  } catch (err) {
    console.error('POST /api/coach/clients/:clientUid/notes failed:', err);
    return sendError(res, 500, 'coach.server_error', String(err));
  }
});

// GET /api/coach/clients/:clientUid/notes — coach's own sent-notes history
// for one client (their own subcollection, not the client's mirror).
app.get('/api/coach/clients/:clientUid/notes', authenticateToken, requireCoachPlan, async (req, res) => {
  if (!firebaseEnabled) return sendError(res, 503, 'coach.firebase_disabled', 'Client linking requires a migrated (Firebase) account.');
  try {
    const clientUid = String(req.params.clientUid || '').trim();
    if (!clientUid) return sendError(res, 422, 'coach.missing_client_id', 'clientUid is required.');

    const coachUid = await resolveCallerUid(req.user);
    if (!coachUid) {
      return sendError(res, 409, 'coach.not_migrated', 'Your account needs to complete migration first. Contact support.');
    }

    const snap = await db.collection(`coaches/${coachUid}/clients/${clientUid}/notes`).orderBy('createdAt', 'desc').limit(100).get();
    const notes = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    return sendSuccess(res, 200, { notes });
  } catch (err) {
    console.error('GET /api/coach/clients/:clientUid/notes failed:', err);
    return sendError(res, 500, 'coach.server_error', String(err));
  }
});

// GET /api/client/coach-notes — authenticated athlete's own inbox of notes
// sent by any coach they're linked to.
app.get('/api/client/coach-notes', authenticateToken, async (req, res) => {
  if (!firebaseEnabled) return sendError(res, 503, 'coach.firebase_disabled', 'Client linking requires a migrated (Firebase) account.');
  try {
    const clientUid = await resolveCallerUid(req.user);
    if (!clientUid) {
      return sendError(res, 409, 'coach.not_migrated', 'Your account needs to complete migration first. Contact support.');
    }
    const snap = await db.collection(`users/${clientUid}/coachNotes`).orderBy('createdAt', 'desc').limit(100).get();
    const notes = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    return sendSuccess(res, 200, { notes });
  } catch (err) {
    console.error('GET /api/client/coach-notes failed:', err);
    return sendError(res, 500, 'coach.server_error', String(err));
  }
});

// ── Client intake (leads) ───────────────────────────────────────────────────
// Single-tenant for now: one coach account (INTAKE_COACH_USERNAME) owns every
// lead. A prospect fills out the public intake form before they have (or
// necessarily ever get) a Pocket Coach account, so there's no uid to attach
// the write to on their side — this mirrors ClientIntake's standalone app,
// just pointed at this backend's Firestore project instead of a separate one.
// Promoting a lead to a real client re-uses the existing invite flow above
// once they sign up.
const INTAKE_COACH_USERNAME = process.env.INTAKE_COACH_USERNAME || null;

const intakeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: { code: 'intake.rate_limited', message: 'Too many submissions. Try again later.' } }
});

// POST /api/intake — public, unauthenticated. body: { intake, instellingen? }
app.post('/api/intake', intakeLimiter, async (req, res) => {
  if (!firebaseEnabled) return sendError(res, 503, 'intake.firebase_disabled', 'Intake requires a migrated (Firebase) backend.');
  if (!INTAKE_COACH_USERNAME) return sendError(res, 503, 'intake.not_configured', 'INTAKE_COACH_USERNAME is not set.');

  try {
    const intake = req.body?.intake;
    const naam = typeof intake?.persoonsgegevens?.naam === 'string' ? intake.persoonsgegevens.naam.trim() : '';
    if (!naam || typeof intake?.persoonsgegevens?.gewicht !== 'number' || typeof intake?.persoonsgegevens?.vetpercentage !== 'number') {
      return sendError(res, 422, 'intake.invalid_payload', 'intake.persoonsgegevens.naam, gewicht and vetpercentage are required.');
    }
    const instellingen = (req.body?.instellingen && typeof req.body.instellingen === 'object') ? req.body.instellingen : {};

    // GDPR Art. 9: the intake holds health data (injuries, PED use, body
    // composition), so it is only stored with the prospect's explicit consent
    // — the unticked checkbox on the intake form.
    const consents = req.body?.consents;
    if (consents?.healthData !== true) {
      return sendError(res, 422, 'intake.consent_required', 'Explicit consent to process health data is required.');
    }
    const consentRecord = {
      healthData: true,
      version: typeof consents.version === 'string' ? consents.version.slice(0, 40) : null,
      at: FieldValue.serverTimestamp(),
    };

    const coachUid = await resolveFirestoreUid(INTAKE_COACH_USERNAME);
    if (!coachUid) {
      return sendError(res, 503, 'intake.coach_not_found', 'Configured intake coach account was not found.');
    }

    let calculations;
    try {
      calculations = berekenClient(intake, instellingen);
    } catch (err) {
      return sendError(res, 422, 'intake.calculation_failed', 'Could not compute results from the submitted intake.', String(err));
    }

    const leadRef = db.collection(`coaches/${coachUid}/leads`).doc();
    await leadRef.set({
      naam,
      createdAt: FieldValue.serverTimestamp(),
      status: 'new',
      intake,
      instellingen,
      calculations,
      consents: consentRecord
    });

    return sendSuccess(res, 201, { leadId: leadRef.id, calculations });
  } catch (err) {
    console.error('POST /api/intake failed:', err);
    return sendError(res, 500, 'intake.server_error', String(err));
  }
});

// GET /api/coach/leads — authenticated, coach-only. Returns every pending
// intake lead for the calling coach, newest first.
app.get('/api/coach/leads', authenticateToken, requireCoachPlan, async (req, res) => {
  if (!firebaseEnabled) return sendError(res, 503, 'coach.firebase_disabled', 'Leads require a migrated (Firebase) account.');
  try {
    const coachUid = await resolveCallerUid(req.user);
    if (!coachUid) {
      return sendError(res, 409, 'coach.not_migrated', 'Your account needs to complete migration before viewing leads. Contact support.');
    }

    const snap = await db.collection(`coaches/${coachUid}/leads`).orderBy('createdAt', 'desc').get();
    const leads = snap.docs.map(d => ({
      id: d.id,
      naam: d.get('naam') || '',
      createdAt: d.get('createdAt') || null,
      status: d.get('status') || 'new',
      intake: d.get('intake') || null,
      instellingen: d.get('instellingen') || null,
      calculations: d.get('calculations') || null
    }));

    return sendSuccess(res, 200, { leads });
  } catch (err) {
    console.error('GET /api/coach/leads failed:', err);
    return sendError(res, 500, 'coach.server_error', String(err));
  }
});

// PATCH /api/coach/leads/:id — authenticated, coach-only. body: { status }.
// Used once a lead is converted (invited as a real client via the endpoint
// below) or dismissed, so it stops showing as an open, actionable lead.
const LEAD_STATUSES = ['new', 'converted', 'dismissed'];
app.patch('/api/coach/leads/:id', authenticateToken, requireCoachPlan, async (req, res) => {
  if (!firebaseEnabled) return sendError(res, 503, 'coach.firebase_disabled', 'Leads require a migrated (Firebase) account.');
  try {
    const coachUid = await resolveCallerUid(req.user);
    if (!coachUid) {
      return sendError(res, 409, 'coach.not_migrated', 'Your account needs to complete migration before updating leads. Contact support.');
    }

    const leadId = String(req.params.id || '').trim();
    const status = typeof req.body?.status === 'string' ? req.body.status.trim() : '';
    if (!leadId || !LEAD_STATUSES.includes(status)) {
      return sendError(res, 422, 'coach.invalid_payload', `status must be one of: ${LEAD_STATUSES.join(', ')}.`);
    }

    const leadRef = db.collection(`coaches/${coachUid}/leads`).doc(leadId);
    const existing = await leadRef.get();
    if (!existing.exists) return sendError(res, 404, 'coach.lead_not_found', 'This lead does not exist.');

    await leadRef.set({ status }, { merge: true });
    return sendSuccess(res, 200, { leadId, status });
  } catch (err) {
    console.error('PATCH /api/coach/leads/:id failed:', err);
    return sendError(res, 500, 'coach.server_error', String(err));
  }
});

// POST /coach/workouts — coach logs a workout on behalf of a linked client
app.post('/coach/workouts', authenticateToken, requireCoachPlan, async (req, res) => {
  try {
    const coachUsername = req.user.username;
    const { clientUsername, clientUid: bodyClientUid, date, title, workout } = req.body || {};
    if ((!clientUsername && !bodyClientUid) || !date || !workout || typeof workout !== 'object') {
      return sendError(res, 422, 'coach.invalid_payload', 'clientUid (or clientUsername), date and workout are required.');
    }

    // The app's coach roster (GET /api/coach/clients) identifies clients by
    // uid — the coaches/{coachUid}/clients/{clientUid} link written by the
    // invite/accept flow — so that's what it sends. Verify that link rather
    // than the Airtable CoachClients table.
    if (!clientUsername) {
      if (!firebaseEnabled) return sendError(res, 503, 'coach.firebase_disabled', 'Client linking requires a migrated (Firebase) account.');
      const targetUid = safeDocId(bodyClientUid);
      if (!targetUid) return sendError(res, 422, 'coach.invalid_payload', 'Invalid clientUid.');
      const coachUid = await resolveCallerUid(req.user);
      if (!coachUid) return sendError(res, 409, 'coach.not_migrated', 'Your account needs to complete migration first. Contact support.');

      const [linkSnap, clientSnap] = await Promise.all([
        db.collection(`coaches/${coachUid}/clients`).doc(targetUid).get(),
        db.collection('users').doc(targetUid).get()
      ]);
      // Pending invites don't grant write access; the users/{uid} check also
      // rules out legacy roster rows keyed by an Airtable record id.
      if (!linkSnap.exists || (linkSnap.get('status') || 'active') !== 'active' || !clientSnap.exists) {
        return sendError(res, 403, 'coach.not_linked', 'This client is not linked to your coach account.');
      }

      const stamped = { ...workout, loggedByCoach: coachUsername };
      // The app re-posts the growing session after each exercise; keying by
      // its workout id makes those re-posts overwrite one doc. Namespaced by
      // coach so a coach can only ever overwrite their own coach-logged
      // entries, never the client's own workouts.
      const workoutId = safeDocId(workout.id);
      const workoutsCol = db.collection(`users/${targetUid}/workouts`);
      const docRef = workoutId ? workoutsCol.doc(`coach-${coachUid}-${workoutId}`) : workoutsCol.doc();
      await saveWorkoutWithTotals({
        db, FieldValue, uid: targetUid, docRef,
        data: {
          date: String(date),
          title: String(title || 'Workout (logged by coach)'),
          sessionVolume: computeSessionVolume(stamped),
          ...storedWorkoutFields(stamped)
        }
      });
      return sendSuccess(res, 200, { recordId: docRef.id });
    }

    // Link verification always goes through Airtable's CoachClients table —
    // that relationship hasn't been fully migrated bidirectionally yet
    // (PHASE2-NOTES.md gap #1), so this stays the authoritative source
    // regardless of either party's migration status.
    let linked = false;
    try {
      linked = await verifyCoachClientLink(coachUsername, clientUsername);
    } catch (err) {
      console.error('Coach-client link check failed:', err);
      return sendError(res, 500, 'coach.link_check_failed', String(err));
    }
    if (!linked) {
      return sendError(res, 403, 'coach.not_linked', 'This client is not linked to your coach account.');
    }

    // Stamp who logged it inside the workout JSON (no extra Airtable field needed)
    const stamped = { ...workout, loggedByCoach: coachUsername };
    const sessionVolume = computeSessionVolume(stamped);

    // Cross-user write: resolve the CLIENT's uid, not the coach's.
    const clientUid = await resolveFirestoreUid(clientUsername);
    if (clientUid) {
      // Always a fresh auto id here — honouring a coach-supplied id would let
      // a coach overwrite one of the client's own workouts.
      const docRef = db.collection(`users/${clientUid}/workouts`).doc();
      await saveWorkoutWithTotals({
        db, FieldValue, uid: clientUid, docRef,
        data: { date: String(date), title: String(title || 'Workout (logged by coach)'), sessionVolume, ...storedWorkoutFields(stamped) }
      });
      return sendSuccess(res, 200, { recordId: docRef.id });
    }

    if (!airtableEnabled) {
      return sendError(res, 503, 'coach.airtable_disabled', 'Airtable is not configured.');
    }

    const url = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(WORKOUTS_TABLE)}`;
    const response = await airtableFetch(url, {
      method: 'POST',
      headers: airtableHeaders(),
      body: JSON.stringify({
        records: [{
          fields: {
            [USERNAME_FIELD]: String(clientUsername),
            Date:             String(date),
            Title:            String(title || 'Workout (logged by coach)'),
            WorkoutJSON:      JSON.stringify(stamped),
            SessionVolume:    sessionVolume
          }
        }]
      })
    });

    const data = await response.json();
    if (!response.ok) {
      return sendError(res, 422, 'coach.airtable_rejected', 'Airtable rejected the request.',
        data?.error?.message || JSON.stringify(data));
    }
    return sendSuccess(res, 200, { recordId: data?.records?.[0]?.id || null });
  } catch (err) {
    return sendError(res, 500, 'coach.server_error', String(err));
  }
});

// ── Exercise technique videos (coach → clients) ─────────────────────────────
const EXERCISE_VIDEOS_TABLE = process.env.AIRTABLE_EXERCISE_VIDEOS_TABLE || 'ExerciseVideos';

// POST /coach/exercise-videos — coach attaches/updates a video for an exercise
app.post('/coach/exercise-videos', authenticateToken, requireCoachPlan, async (req, res) => {
  try {
    const coachUsername = req.user.username;
    const { exerciseName, videoUrl, notes } = req.body || {};
    if (!exerciseName || !videoUrl) {
      return sendError(res, 422, 'videos.invalid_payload', 'exerciseName and videoUrl are required.');
    }
    if (!/^https?:\/\//i.test(String(videoUrl))) {
      return sendError(res, 422, 'videos.invalid_url', 'videoUrl must be an http(s) link.');
    }

    const uid = await resolveFirestoreUid(coachUsername);
    if (uid) {
      // Firestore home: coaches/{coachUid}/exerciseVideos/{slug}, parallel to
      // the existing coaches/{uid}/clients pattern. The exercise-name slug
      // as the doc id makes upsert-by-name a plain doc().set(merge) instead
      // of a query-then-update/create round trip.
      const slug = String(exerciseName).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-');
      await db.collection(`coaches/${uid}/exerciseVideos`).doc(slug).set({
        exerciseName: String(exerciseName).trim(),
        videoUrl: String(videoUrl).trim(),
        notes: notes ? String(notes) : ''
      });
      return sendSuccess(res, 200, { id: slug });
    }

    if (!airtableEnabled) {
      return sendError(res, 503, 'videos.airtable_disabled', 'Airtable is not configured.');
    }

    const fields = {
      CoachId:      String(coachUsername),
      ExerciseName: String(exerciseName).trim(),
      VideoUrl:     String(videoUrl).trim(),
      Notes:        notes ? String(notes) : ''
    };

    // Upsert on CoachId + ExerciseName
    const safeCoach = escapeAirtableFormulaValue(coachUsername);
    const safeExercise = escapeAirtableFormulaValue(String(exerciseName).trim());
    const existing = await base(EXERCISE_VIDEOS_TABLE)
      .select({
        filterByFormula: `AND({CoachId}='${safeCoach}',LOWER({ExerciseName})=LOWER('${safeExercise}'))`,
        maxRecords: 1
      })
      .firstPage();

    let record;
    if (existing.length) {
      const updated = await base(EXERCISE_VIDEOS_TABLE).update([{ id: existing[0].id, fields }]);
      record = updated[0];
    } else {
      const created = await base(EXERCISE_VIDEOS_TABLE).create([{ fields }]);
      record = created[0];
    }
    return sendSuccess(res, 200, { id: record.id });
  } catch (err) {
    return sendError(res, 500, 'videos.server_error', String(err));
  }
});

// GET /coach/exercise-videos — coach lists their own videos
app.get('/coach/exercise-videos', authenticateToken, requireCoachPlan, async (req, res) => {
  try {
    const coachUsername = req.user.username;

    const uid = await resolveFirestoreUid(coachUsername);
    if (uid) {
      const snap = await db.collection(`coaches/${uid}/exerciseVideos`).get();
      const items = snap.docs.map(d => ({
        id: d.id,
        exerciseName: d.get('exerciseName') || '',
        videoUrl: d.get('videoUrl') || '',
        notes: d.get('notes') || ''
      }));
      return sendSuccess(res, 200, { items });
    }

    if (!airtableEnabled) return sendSuccess(res, 200, { items: [] });

    const safeCoach = escapeAirtableFormulaValue(coachUsername);
    const records = await base(EXERCISE_VIDEOS_TABLE)
      .select({ filterByFormula: `{CoachId}='${safeCoach}'`, pageSize: 100 })
      .all();

    const items = records.map(r => ({
      id:           r.id,
      exerciseName: r.get('ExerciseName') || '',
      videoUrl:     r.get('VideoUrl') || '',
      notes:        r.get('Notes') || ''
    }));
    return sendSuccess(res, 200, { items });
  } catch (err) {
    return sendError(res, 500, 'videos.server_error', String(err));
  }
});

// DELETE /coach/exercise-videos/:id — coach removes their own video
app.delete('/coach/exercise-videos/:id', authenticateToken, requireCoachPlan, async (req, res) => {
  try {
    const coachUsername = req.user.username;

    const uid = await resolveFirestoreUid(coachUsername);
    if (uid) {
      // Ownership is implicit — the doc only exists under this coach's own subcollection.
      const docRef = db.collection(`coaches/${uid}/exerciseVideos`).doc(req.params.id);
      const snap = await docRef.get();
      if (!snap.exists) return sendError(res, 404, 'videos.not_found', 'Video not found.');
      await docRef.delete();
      return sendSuccess(res, 200, { deleted: true });
    }

    if (!airtableEnabled) return sendError(res, 503, 'videos.airtable_disabled', 'Airtable is not configured.');

    const record = await base(EXERCISE_VIDEOS_TABLE).find(req.params.id);
    if (!record || record.get('CoachId') !== coachUsername) {
      return sendError(res, 403, 'videos.not_owner', 'You can only delete your own videos.');
    }
    await base(EXERCISE_VIDEOS_TABLE).destroy([req.params.id]);
    return sendSuccess(res, 200, { deleted: true });
  } catch (err) {
    return sendError(res, 500, 'videos.server_error', String(err));
  }
});

// GET /exercise-videos — client fetches videos shared by their coach(es)
app.get('/exercise-videos', authenticateToken, async (req, res) => {
  try {
    const clientUsername = req.user.username;
    const items = [];
    const seenCoachUids = new Set();

    // Coaches linked through Firestore (the invite/accept flow).
    if (firebaseEnabled) {
      const clientUid = await resolveCallerUid(req.user);
      if (clientUid) {
        const invites = await db.collection(`users/${clientUid}/coachInvites`).where('status', '==', 'active').get();
        for (const inv of invites.docs) {
          seenCoachUids.add(inv.id);
          const coachId = inv.get('coachUsername') || '';
          const snap = await db.collection(`coaches/${inv.id}/exerciseVideos`).get();
          for (const d of snap.docs) {
            items.push({ id: d.id, coachId, exerciseName: d.get('exerciseName') || '', videoUrl: d.get('videoUrl') || '', notes: d.get('notes') || '' });
          }
        }
      }
    }

    if (!airtableEnabled) return sendSuccess(res, 200, { items });

    // Legacy links in Airtable's CoachClients table.
    const safeClient = escapeAirtableFormulaValue(clientUsername);
    const links = await base(COACH_CLIENTS_TABLE)
      .select({
        filterByFormula: `OR({ClientId}='${safeClient}',{ClientName}='${safeClient}')`,
        pageSize: 10
      })
      .firstPage();

    const coachIds = [...new Set(links.map(l => l.get('CoachId')).filter(Boolean))];
    if (!coachIds.length) return sendSuccess(res, 200, { items });

    // Each coach may or may not have migrated independently of this client —
    // fetch their videos from whichever store they're actually in.
    const legacyCoachIds = [];
    for (const coachId of coachIds) {
      const coachUid = await resolveFirestoreUid(coachId);
      if (coachUid && seenCoachUids.has(coachUid)) continue;
      if (coachUid) {
        const snap = await db.collection(`coaches/${coachUid}/exerciseVideos`).get();
        for (const d of snap.docs) {
          items.push({ id: d.id, coachId, exerciseName: d.get('exerciseName') || '', videoUrl: d.get('videoUrl') || '', notes: d.get('notes') || '' });
        }
      } else {
        legacyCoachIds.push(coachId);
      }
    }

    if (legacyCoachIds.length) {
      const coachFilter = legacyCoachIds
        .map(c => `{CoachId}='${escapeAirtableFormulaValue(c)}'`)
        .join(',');
      const records = await base(EXERCISE_VIDEOS_TABLE)
        .select({
          filterByFormula: legacyCoachIds.length > 1 ? `OR(${coachFilter})` : coachFilter,
          pageSize: 100
        })
        .all();
      for (const r of records) {
        items.push({ id: r.id, coachId: r.get('CoachId') || '', exerciseName: r.get('ExerciseName') || '', videoUrl: r.get('VideoUrl') || '', notes: r.get('Notes') || '' });
      }
    }

    return sendSuccess(res, 200, { items });
  } catch (err) {
    return sendError(res, 500, 'videos.server_error', String(err));
  }
});

// PUT /api/bodybuilding/daily-mission/:userId — persist daily mission state
app.put('/api/bodybuilding/daily-mission/:userId', authenticateToken, async (req, res) => {
  try {
    const userId = req.params.userId;
    if (!userId) return sendError(res, 422, 'mission.missing_user_id', 'userId is required.');
    // The path carries a username; only the signed-in user may write their own.
    if (String(userId).trim().toLowerCase() !== String(req.user?.username || '').toLowerCase()) {
      return sendError(res, 403, 'auth.forbidden', 'You can only update your own daily mission.');
    }

    const state = req.body || {};
    const today = new Date().toISOString().slice(0, 10);

    // userId is populated with the username string (this app has no separate
    // user-id system) — same convention legacyMigration.js relies on.
    const uid = await resolveFirestoreUid(userId);
    if (uid) {
      const col = db.collection(`users/${uid}/dailyMissions`);
      const existingSnap = await col.where('date', '==', today).get();
      let recordId;
      if (existingSnap.docs.length) {
        recordId = existingSnap.docs[0].id;
        await col.doc(recordId).set({ date: today, state, updatedAt: new Date().toISOString() }, { merge: true });
      } else {
        const docRef = col.doc();
        await docRef.set({ date: today, state, updatedAt: new Date().toISOString() });
        recordId = docRef.id;
      }
      return sendSuccess(res, 200, { saved: true, recordId });
    }

    if (!airtableEnabled) return sendSuccess(res, 200, { saved: false, reason: 'airtable_disabled' });

    const safeUserId = escapeAirtableFormulaValue(userId);

    // Upsert: find existing record for this user+date, update or create
    const existing = await base(DAILY_MISSION_TABLE)
      .select({
        filterByFormula: `AND({UserId}='${safeUserId}',{Date}='${today}')`,
        maxRecords: 1
      })
      .firstPage();

    const fields = {
      UserId:      String(userId),
      Date:        today,
      StateJson:   JSON.stringify(state),
      UpdatedAt:   new Date().toISOString()
    };

    let recordId;
    if (existing.length) {
      const updated = await base(DAILY_MISSION_TABLE).update([{ id: existing[0].id, fields }]);
      recordId = updated[0]?.id;
    } else {
      const created = await base(DAILY_MISSION_TABLE).create([{ fields }]);
      recordId = created[0]?.id;
    }

    return sendSuccess(res, 200, { saved: true, recordId });
  } catch (err) {
    // Non-fatal — mission state is always stored locally too; log but don't break the app
    console.warn('PUT /api/bodybuilding/daily-mission failed:', err?.message);
    return sendSuccess(res, 200, { saved: false, reason: err?.message });
  }
});

// ── Mobility ──────────────────────────────────────────────────────────────────
const MOBILITY_ROUTINES_TABLE  = process.env.AIRTABLE_MOBILITY_ROUTINES_TABLE  || 'MobilityRoutines';
const MOBILITY_SESSIONS_TABLE  = process.env.AIRTABLE_MOBILITY_SESSIONS_TABLE  || 'MobilitySessions';

// GET /mobility/routines?username=
app.get('/mobility/routines', authenticateToken, async (req, res) => {
  try {
    const username = ownUsername(req, res);
    if (!username) return;

    const uid = await resolveFirestoreUid(username);
    if (uid) {
      // NOTE: only self-created routines — coach-assigned ones aren't
      // migrated to the athlete's subcollection yet (PHASE2-NOTES.md gap #2),
      // so unlike the Airtable path this won't surface those until that's built.
      const snap = await db.collection(`users/${uid}/mobilityRoutines`).orderBy('createdAt', 'desc').get();
      const items = snap.docs.map(d => ({
        id: d.id,
        username,
        routineId: d.get('routineId'),
        name: d.get('name'),
        type: d.get('type'),
        targetArea: d.get('targetArea'),
        frequencyPerWeek: d.get('frequencyPerWeek'),
        exercises: d.get('exercises') || [],
        assignedByCoach: d.get('assignedByCoach') || false,
        coachNotes: d.get('coachNotes') || '',
        createdAt: d.get('createdAt')
      }));
      return sendSuccess(res, 200, { items });
    }

    if (!airtableEnabled) return res.json({ success: true, items: [] });

    const safeUsername = escapeAirtableFormulaValue(username);
    const records = await base(MOBILITY_ROUTINES_TABLE)
      .select({
        filterByFormula: `OR({${USERNAME_FIELD}}='${safeUsername}',{AssignedByCoach}=1)`,
        sort: [{ field: 'CreatedAt', direction: 'desc' }],
        pageSize: 100
      })
      .all();

    const items = records.map(r => ({
      id:                 r.id,
      username:           r.get('Username'),
      routineId:          r.get('RoutineId'),
      name:               r.get('Name'),
      type:               r.get('Type'),
      targetArea:         r.get('TargetArea'),
      frequencyPerWeek:   r.get('FrequencyPerWeek'),
      exercises:          (() => { try { return JSON.parse(r.get('Exercises') || '[]'); } catch { return []; } })(),
      assignedByCoach:    r.get('AssignedByCoach') || false,
      coachNotes:         r.get('CoachNotes') || '',
      createdAt:          r.get('CreatedAt')
    }));

    return sendSuccess(res, 200, { items });
  } catch (err) {
    console.error('GET /mobility/routines failed:', err);
    return sendError(res, 500, 'mobility.server_error', String(err));
  }
});

// POST /mobility/routines — create a new mobility routine
app.post('/mobility/routines', authenticateToken, async (req, res) => {
  try {
    const username = req.user.username;
    const { routineId, name, type, targetArea, frequencyPerWeek, exercises, assignedByCoach, coachNotes } = req.body || {};
    if (!name) return sendError(res, 422, 'mobility.invalid_payload', 'name is required.');

    const uid = await resolveFirestoreUid(username);
    if (uid) {
      const docRef = db.collection(`users/${uid}/mobilityRoutines`).doc();
      await docRef.set({
        routineId: routineId ? String(routineId) : `routine_${Date.now()}`,
        name: String(name),
        type: type ? String(type) : '',
        targetArea: targetArea ? String(targetArea) : '',
        frequencyPerWeek: frequencyPerWeek != null ? Number(frequencyPerWeek) : null,
        exercises: exercises || [],
        assignedByCoach: Boolean(assignedByCoach),
        coachNotes: coachNotes ? String(coachNotes) : '',
        createdAt: new Date().toISOString()
      });
      return sendSuccess(res, 201, { recordId: docRef.id });
    }

    if (!airtableEnabled) return sendError(res, 503, 'mobility.airtable_disabled', 'Airtable is not configured.');

    const [record] = await base(MOBILITY_ROUTINES_TABLE).create([{
      fields: {
        [USERNAME_FIELD]:   String(username),
        RoutineId:          routineId ? String(routineId) : `routine_${Date.now()}`,
        Name:               String(name),
        Type:               type ? String(type) : '',
        TargetArea:         targetArea ? String(targetArea) : '',
        FrequencyPerWeek:   frequencyPerWeek != null ? Number(frequencyPerWeek) : null,
        Exercises:          exercises ? JSON.stringify(exercises) : '[]',
        AssignedByCoach:    Boolean(assignedByCoach),
        CoachNotes:         coachNotes ? String(coachNotes) : '',
        CreatedAt:          new Date().toISOString()
      }
    }]);

    return sendSuccess(res, 201, { recordId: record.id });
  } catch (err) {
    console.error('POST /mobility/routines failed:', err);
    return sendError(res, 500, 'mobility.server_error', String(err));
  }
});

// DELETE /mobility/routines/:id
app.delete('/mobility/routines/:id', authenticateToken, async (req, res) => {
  const { id } = req.params;
  if (!id) return sendError(res, 400, 'mobility.missing_id', 'Record ID is required.');

  const uid = await resolveFirestoreUid(req.user.username);
  if (uid) {
    try {
      const docRef = db.collection(`users/${uid}/mobilityRoutines`).doc(id);
      const snap = await docRef.get();
      if (!snap.exists) return sendError(res, 404, 'mobility.not_found', 'Routine not found.');
      await docRef.delete();
      return sendSuccess(res, 200, { deleted: id });
    } catch (err) {
      console.error('DELETE /mobility/routines/:id (Firestore) failed:', err);
      return sendError(res, 500, 'mobility.server_error', String(err));
    }
  }

  if (!airtableEnabled) return sendError(res, 503, 'mobility.airtable_disabled', 'Airtable is not configured.');
  try {
    await base(MOBILITY_ROUTINES_TABLE).destroy([id]);
    return sendSuccess(res, 200, { deleted: id });
  } catch (err) {
    console.error('DELETE /mobility/routines/:id failed:', err);
    return sendError(res, 500, 'mobility.server_error', String(err));
  }
});

// GET /mobility/sessions?username=
app.get('/mobility/sessions', authenticateToken, async (req, res) => {
  try {
    const username = ownUsername(req, res);
    if (!username) return;

    const uid = await resolveFirestoreUid(username);
    if (uid) {
      const snap = await db.collection(`users/${uid}/mobilitySessions`).orderBy('completedAt', 'desc').get();
      const items = snap.docs.map(d => ({
        id: d.id,
        username,
        sessionId: d.get('sessionId'),
        routineId: d.get('routineId'),
        completedAt: d.get('completedAt'),
        notes: d.get('notes') || ''
      }));
      return sendSuccess(res, 200, { items });
    }

    if (!airtableEnabled) return res.json({ success: true, items: [] });

    const safeUsername = escapeAirtableFormulaValue(username);
    const records = await base(MOBILITY_SESSIONS_TABLE)
      .select({
        filterByFormula: `{${USERNAME_FIELD}}='${safeUsername}'`,
        sort: [{ field: 'CompletedAt', direction: 'desc' }],
        pageSize: 100
      })
      .all();

    const items = records.map(r => ({
      id:           r.id,
      username:     r.get('Username'),
      sessionId:    r.get('SessionId'),
      routineId:    r.get('RoutineId'),
      completedAt:  r.get('CompletedAt'),
      notes:        r.get('Notes') || ''
    }));

    return sendSuccess(res, 200, { items });
  } catch (err) {
    console.error('GET /mobility/sessions failed:', err);
    return sendError(res, 500, 'mobility.server_error', String(err));
  }
});

// POST /mobility/sessions — log a completed mobility session
app.post('/mobility/sessions', authenticateToken, async (req, res) => {
  try {
    const username = req.user.username;
    const { sessionId, routineId, completedAt, notes } = req.body || {};
    if (!routineId) return sendError(res, 422, 'mobility.invalid_payload', 'routineId is required.');

    const uid = await resolveFirestoreUid(username);
    if (uid) {
      const docRef = db.collection(`users/${uid}/mobilitySessions`).doc();
      await docRef.set({
        sessionId: sessionId ? String(sessionId) : `session_${Date.now()}`,
        routineId: String(routineId),
        completedAt: completedAt ? String(completedAt) : new Date().toISOString(),
        notes: notes ? String(notes) : ''
      });
      return sendSuccess(res, 201, { recordId: docRef.id });
    }

    if (!airtableEnabled) return sendError(res, 503, 'mobility.airtable_disabled', 'Airtable is not configured.');

    const [record] = await base(MOBILITY_SESSIONS_TABLE).create([{
      fields: {
        [USERNAME_FIELD]: String(username),
        SessionId:        sessionId ? String(sessionId) : `session_${Date.now()}`,
        RoutineId:        String(routineId),
        CompletedAt:      completedAt ? String(completedAt) : new Date().toISOString(),
        Notes:            notes ? String(notes) : ''
      }
    }]);

    return sendSuccess(res, 201, { recordId: record.id });
  } catch (err) {
    console.error('POST /mobility/sessions failed:', err);
    return sendError(res, 500, 'mobility.server_error', String(err));
  }
});

// ── AI Chat ───────────────────────────────────────────────────────────────────

// POST /ai/chat — short general chat through the configured AI provider
// (src/coach/client.js: Anthropic, or Ollama / OpenRouter).
app.post('/ai/chat', authenticateToken, requirePaidPlan, async (req, res) => {
  const aiClient = require('./src/coach/client');
  try {
    if (!aiClient.isConfigured()) {
      return sendError(res, 503, 'ai.not_configured', 'No AI provider key is configured.');
    }

    const { messages, systemPrompt } = req.body || {};
    if (!Array.isArray(messages) || !messages.length) {
      return sendError(res, 422, 'ai.invalid_payload', 'messages array is required.');
    }

    const reply = await aiClient.createMessage('claude-haiku-4-5-20251001', {
      max_tokens: aiClient.openModels() ? 4096 : 1024,
      system:     systemPrompt || 'You are a helpful fitness coaching assistant.',
      messages:   messages.map(m => ({ role: m.role, content: String(m.content) }))
    }, { timeoutMs: aiClient.perModelTimeoutMs(30000, 30000) });

    const text = reply.content.filter(b => b.type === 'text').map(b => b.text).join('');
    return sendSuccess(res, 200, { reply: text });
  } catch (err) {
    if (err instanceof aiClient.Anthropic.APIError) {
      return sendError(res, 502, 'ai.upstream_error', 'The AI provider returned an error.', err.message);
    }
    if (err.name === 'AbortError') {
      return sendError(res, 504, 'ai.timeout', 'AI request timed out.');
    }
    console.error('POST /ai/chat failed:', err);
    return sendError(res, 500, 'ai.server_error', String(err));
  }
});

// aiRouter (src/routes/ai.js) was mounted with no auth and no rate limit at
// all — every route under it (chat, checkin-summary, coach-draft-message,
// macro-advice, generate-program, ...) calls the real Anthropic API and was
// reachable by anyone on the internet with no credentials, spending real
// money per request with no attribution. Gating the whole mount, including
// /api/ai/health, keeps this consistent with every other protected area of
// the API rather than picking routes to exempt.
const aiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: { code: 'ai.rate_limited', message: 'Too many AI requests. Try again shortly.' } }
});

// Every AI feature is Pro — see src/planAccess.js.
app.use('/api/ai', authenticateToken, aiLimiter, requirePaidPlan, aiRouter);

// Ebooks and the ready-made program library. Full content is only returned to
// Pro/Coach accounts (checked per request); free accounts get teasers.
const premiumLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: { code: 'premium.rate_limited', message: 'Too many requests. Try again shortly.' } }
});
app.use('/api/premium', authenticateToken, premiumLimiter, createPremiumRouter({ getPlanInfo: getUserPlanInfo, sendError, isAdmin: planAccess.isAdmin }));

// Public profiles (photo, display name, bio, visibility) — see
// src/routes/profiles.js. Writes and reports get a tighter limit than the
// batch lookups the feed/leaderboard make on every render.
const profileLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: { code: 'profile.rate_limited', message: 'Too many requests. Try again shortly.' } }
});
const profileWriteLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  skip: req => req.method === 'GET' || req.path === '/lookup',
  message: { success: false, error: { code: 'profile.rate_limited', message: 'Too many profile changes. Try again shortly.' } }
});
// Moderation alerts for reports and blocks (Apple requires acting on reports
// within 24 hours, so a person has to see them) — emailed via Resend, see
// src/moderationEmail.js.
const notifyModerators = createModerationNotifier({
  apiKey: process.env.RESEND_API_KEY,
  to: process.env.MODERATION_EMAIL_TO,
  from: process.env.MODERATION_EMAIL_FROM,
});

app.use('/api/profiles', authenticateToken, profileLimiter, profileWriteLimiter, createProfilesRouter({
  db, FieldValue, firebaseEnabled, sendError, sendSuccess,
  resolveUid: resolveFirestoreUid,
  adminUsernames: (process.env.PROFILE_ADMINS || '').split(','),
  objectionableTerms: OBJECTIONABLE_TERMS,
  notifyModerators,
}));

// Friend requests (send → accept/decline) — see src/routes/friends.js. The app
// polls GET /api/friends to show incoming requests, so reads get the looser
// limit and only sends/answers count against the tighter one.
const friendsLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: { code: 'friends.rate_limited', message: 'Too many requests. Try again shortly.' } }
});
const friendsWriteLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  skip: req => req.method === 'GET',
  message: { success: false, error: { code: 'friends.rate_limited', message: 'Too many friend requests. Try again shortly.' } }
});
app.use('/api/friends', authenticateToken, friendsLimiter, friendsWriteLimiter, createFriendsRouter({
  db, FieldValue, firebaseEnabled, sendError, sendSuccess,
}));
// Community groups (members, posts, shared programs, reports) — see
// src/routes/groups.js. Reads are polled when a group is open, so only
// writes count against the tighter limit.
const groupsLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: { code: 'groups.rate_limited', message: 'Too many requests. Try again shortly.' } }
});
const groupsWriteLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  skip: req => req.method === 'GET',
  message: { success: false, error: { code: 'groups.rate_limited', message: 'You’re posting too fast. Try again shortly.' } }
});
app.use('/api/groups', authenticateToken, groupsLimiter, groupsWriteLimiter, createGroupsRouter({
  db, FieldValue, firebaseEnabled, sendError, sendSuccess,
  adminUsernames: (process.env.PROFILE_ADMINS || '').split(','),
  objectionableTerms: OBJECTIONABLE_TERMS,
  notifyModerators,
}));
// Community feed (you + friends), sharing with friends, and the exercise
// leaderboard — see src/routes/feed.js, shares.js and exerciseBoard.js.
const socialLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: { code: 'social.rate_limited', message: 'Too many requests. Try again shortly.' } }
});
const socialWriteLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  skip: req => req.method === 'GET',
  message: { success: false, error: { code: 'social.rate_limited', message: 'You’re posting too fast. Try again shortly.' } }
});
app.use('/api/feed', authenticateToken, socialLimiter, socialWriteLimiter, createFeedRouter({
  db, FieldValue, firebaseEnabled, sendError, sendSuccess,
  adminUsernames: (process.env.PROFILE_ADMINS || '').split(','),
  objectionableTerms: OBJECTIONABLE_TERMS,
  notifyModerators,
}));
// Calendar sync: program days as a subscribable .ics feed — see
// src/routes/calendar.js. The feed URL itself is public (calendar apps can't
// send a login), protected by its secret token.
const calendarLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: { code: 'calendar.rate_limited', message: 'Too many requests. Try again shortly.' } }
});
const calendarFeedLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api/calendar', authenticateToken, calendarLimiter, createCalendarRouter({
  db, FieldValue, firebaseEnabled, sendError, sendSuccess,
}));
app.get('/cal/:file', calendarFeedLimiter, createCalendarFeedHandler({ db, firebaseEnabled }));
app.use('/api/shares', authenticateToken, socialLimiter, socialWriteLimiter, createSharesRouter({
  db, firebaseEnabled, sendError, sendSuccess, objectionableTerms: OBJECTIONABLE_TERMS,
}));
app.use('/api/leaderboard/exercises', authenticateToken, socialLimiter, createExerciseBoardRouter({
  db, firebaseEnabled, sendError, sendSuccess,
}));
// In-app notifications (friend requests, shares, groups, friends' posts,
// leaderboard moves) — see src/routes/notifications.js. The app polls GET.
app.use('/api/notifications', authenticateToken, socialLimiter, socialWriteLimiter, createNotificationsRouter({
  db, firebaseEnabled, sendError, sendSuccess,
}));

// Cloud sync for on-device data (see src/routes/sync.js). Generous limits:
// a first sync on a phone with years of logs pushes a few hundred batches.
const syncLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: { code: 'sync.rate_limited', message: 'Too many sync requests. Try again shortly.' } }
});
app.use('/api/sync', authenticateToken, syncLimiter, createSyncRouter({
  db, firebaseEnabled, sendError, sendSuccess,
  resolveUid: resolveFirestoreUid,
  documentId: FieldPath.documentId(),
  enabled: () => process.env.CLOUD_SYNC_ENABLED !== 'false',
}));
// A coach reading a client's food log (src/routes/coachNutrition.js). The
// link and the client's food-log sharing switch are checked on every request.
const coachNutritionLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: { code: 'coach.rate_limited', message: 'Too many requests. Try again shortly.' } }
});
app.use('/api/coach/nutrition', authenticateToken, requireCoachPlan, coachNutritionLimiter,
  (req, res, next) => (firebaseEnabled ? next() : sendError(res, 503, 'coach.firebase_disabled', 'Client linking requires a migrated (Firebase) account.')),
  createCoachNutritionRouter({ db, sendError, sendSuccess, resolveCallerUid, syncDocId }));
// Food search for the food log (src/routes/food.js): USDA FoodData Central
// with our own key plus Open Food Facts, merged and cached. Signed-in only,
// so the USDA key's quota isn't open to the whole internet.
const foodLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 90,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: { code: 'food.rate_limited', message: 'Too many food searches. Try again shortly.' } }
});
app.use('/api/food', authenticateToken, foodLimiter, createFoodRouter({ sendError, sendSuccess }));

// Coach-approved foods shared with clients (src/routes/coachFoods.js).
const foodsAvailable = (_req, res, next) => (firebaseEnabled ? next() : sendError(res, 503, 'foods.firebase_disabled', 'Coach foods require a migrated (Firebase) backend.'));
app.use('/api/coach/foods', authenticateToken, requireCoachPlan, coachNutritionLimiter, foodsAvailable,
  createCoachFoodsRouter({ db, sendError, sendSuccess, resolveCallerUid }));
// Coach meals library (src/routes/coachMeals.js); plans go out with PATCH /api/coach/clients/:id.
app.use('/api/coach/meals', authenticateToken, requireCoachPlan, coachNutritionLimiter, foodsAvailable,
  coachMeals.createCoachMealsRouter({ db, sendError, sendSuccess, resolveCallerUid }));
app.use('/api/client/coach-foods', authenticateToken, coachNutritionLimiter, foodsAvailable,
  createClientCoachFoodsRouter({ db, sendError, sendSuccess, resolveCallerUid }));

// ── Master plans (src/routes/plans.js) ───────────────────────────────────────
// A broken rules/*.json must not take the whole API down: only the plan
// routes answer 503 until it is fixed.
let planRegistry = null;
try {
  planRegistry = createRegistry();
} catch (err) {
  console.error('[plans] Rule registry failed to load — plan routes disabled:', err.message);
}
const plansAvailable = (_req, res, next) => {
  if (!firebaseEnabled) return sendError(res, 503, 'plan.firebase_disabled', 'Plans require a migrated (Firebase) backend.');
  if (!planRegistry) return sendError(res, 503, 'plan.registry_unavailable', 'The plan rules are unavailable. Try again later.');
  return next();
};
const planLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: { code: 'plan.rate_limited', message: 'Too many plan requests. Try again shortly.' } }
});
const coachPlansRouter = planRegistry && createCoachPlansRouter({
  db, FieldValue, registry: planRegistry, sendError, sendSuccess, resolveCallerUid,
  notifyPlanPublished: async ({ coachUsername, clientUid, fields, announce }) => {
    const clientUsername = await usernameForUid(clientUid);
    if (clientUsername) await coachNotifications.notifyCoachPlan(db, { coachUsername, clientUsername, fields, announce });
  },
});
const clientPlanRouter = createClientPlanRouter({ db, sendError, sendSuccess, resolveCallerUid });
app.use('/api/coach/plans', authenticateToken, requireCoachPlan, planLimiter, plansAvailable, (req, res, next) => coachPlansRouter(req, res, next));
app.use('/api/client/plan', authenticateToken, planLimiter, plansAvailable, clientPlanRouter);

// ── Coach videos (program / diet / cardio walkthroughs) ─────────────────────
// See src/routes/coachVideos.js. Links only; the app plays them inline.
const videosAvailable = (_req, res, next) => (firebaseEnabled ? next() : sendError(res, 503, 'videos.firebase_disabled', 'Coach videos require a migrated (Firebase) backend.'));
const coachVideosLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: { code: 'videos.rate_limited', message: 'Too many requests. Try again shortly.' } }
});
app.use('/api/coach/videos', authenticateToken, requireCoachPlan, coachVideosLimiter, videosAvailable, createCoachVideosRouter({
  db, sendError, sendSuccess, resolveCallerUid,
  notifyVideo: async ({ coachUsername, clients, title }) => {
    const clientUsernames = (await Promise.all(clients.map(c => c.name || usernameForUid(c.uid)))).filter(Boolean);
    if (clientUsernames.length) await coachNotifications.notifyCoachVideo(db, { coachUsername, clientUsernames, title });
  },
}));
app.use('/api/client/coach-videos', authenticateToken, coachVideosLimiter, videosAvailable, createClientCoachVideosRouter({ db, sendError, sendSuccess, resolveCallerUid }));

// ── Check-in comments (src/checkInComments.js) ───────────────────────────────
const commentsAvailable = (_req, res, next) => (firebaseEnabled ? next() : sendError(res, 503, 'comments.firebase_disabled', 'Check-in comments require a migrated (Firebase) backend.'));
const checkInCommentLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: { code: 'comments.rate_limited', message: 'Too many requests. Try again shortly.' } }
});
const checkInCommentRouters = checkInComments.createRouters({
  db, sendError, sendSuccess, resolveCallerUid, usernameForUid,
  photosFor: async clientUid => {
    const allowed = await clientPhotosAllowed(clientUid);
    return { allowed, index: allowed ? await checkInPhotos.readIndex(db, clientUid) : {} };
  },
  photoPose: (clientUid, date, i) => checkInPhotos.readPose(db, clientUid, date, i),
  notifyComment: args => coachNotifications.notifyCheckInComment(db, args),
  notifyReply: args => coachNotifications.notifyCheckInReply(db, args),
});
app.use('/api/client/checkins', authenticateToken, checkInCommentLimiter, commentsAvailable, checkInCommentRouters.client);
app.use('/api/coach/clients/:clientUid', authenticateToken, requireCoachPlan, checkInCommentLimiter, commentsAvailable, checkInCommentRouters.coach);

// ── Coach ↔ client messages and check-in requests (src/coachMessages.js) ─────
const coachMessageRouters = coachMessages.createRouters({
  db, sendError, sendSuccess, resolveCallerUid, usernameForUid,
  notifyMessage: args => coachNotifications.notifyClientMessage(db, args),
  notifyCheckInRequest: args => coachNotifications.notifyCheckInRequest(db, args),
});
app.use('/api/client/messages', authenticateToken, checkInCommentLimiter, commentsAvailable, coachMessageRouters.client);
app.use('/api/coach/clients/:clientUid', authenticateToken, requireCoachPlan, checkInCommentLimiter, commentsAvailable, coachMessageRouters.coach);

// ── Coach libraries: workouts and the vault (src/routes/coachLibrary.js) ─────
app.use('/api/coach/workouts', authenticateToken, requireCoachPlan, coachVideosLimiter, videosAvailable, coachLibrary.createCoachWorkoutsRouter({
  db, sendError, sendSuccess, resolveCallerUid, sanitizeProgram: coachShare.sanitizeCoachProgram,
}));
app.use('/api/coach/groups', authenticateToken, requireCoachPlan, coachVideosLimiter, videosAvailable, coachLibrary.createCoachGroupsRouter({
  db, sendError, sendSuccess, resolveCallerUid,
}));
// Automations (src/coachAutomations.js). The daily check-in reminder run is
// a scheduled function in functions-entry.js.
app.use('/api/coach/automations', authenticateToken, requireCoachPlan, coachVideosLimiter, videosAvailable, coachAutomations.createRouter({
  db, sendError, sendSuccess, resolveCallerUid,
}));
app.use('/api/coach/events', authenticateToken, requireCoachPlan, coachVideosLimiter, videosAvailable, coachLibrary.createCoachEventsRouter({
  db, sendError, sendSuccess, resolveCallerUid,
}));
app.use('/api/coach/vault', authenticateToken, requireCoachPlan, coachVideosLimiter, videosAvailable, coachLibrary.createCoachVaultRouter({
  db, sendError, sendSuccess, resolveCallerUid,
  notifyResource: async ({ coachUsername, clients, title }) => {
    const clientUsernames = (await Promise.all(clients.map(c => c.name || usernameForUid(c.uid)))).filter(Boolean);
    if (clientUsernames.length) await coachNotifications.notifyCoachResource(db, { coachUsername, clientUsernames, title });
  },
}));
app.use('/api/client/coach-vault', authenticateToken, coachVideosLimiter, videosAvailable, coachLibrary.createClientCoachVaultRouter({ db, sendError, sendSuccess, resolveCallerUid }));

// ── Form checks (src/formChecks.js) ──────────────────────────────────────────
const formCheckRouters = formChecks.createRouters({
  db, sendError, sendSuccess, resolveCallerUid, usernameForUid,
  notifySent: args => coachNotifications.notifyFormCheckSent(db, args),
  notifyReviewed: args => coachNotifications.notifyFormCheckReviewed(db, args),
});
app.use('/api/client/form-checks', authenticateToken, checkInCommentLimiter, commentsAvailable, formCheckRouters.client);
app.use('/api/coach/form-checks', authenticateToken, requireCoachPlan, checkInCommentLimiter, commentsAvailable, formCheckRouters.coach);

app.use('/', leaderboardRoute);

// ── Exercise library ─────────────────────────────────────────────────────────
// Greenfield collection (no Airtable equivalent) — exercises/{id}, top-level
// and global like KnowledgeBase, seeded once from a bundled public-domain
// dataset (free-exercise-db, Unlicense) rather than per-user migration.

// One-time seed: reads the bundled dataset and writes it into Firestore.
// Idempotent — the dataset's own slug ids are used as Firestore doc ids, so
// re-running just re-writes the same docs rather than duplicating them.
app.post('/admin/exercises/seed', authenticateToken, async (req, res) => {
  if (!firebaseEnabled) return sendError(res, 503, 'exercises.firebase_disabled', 'Firebase is not configured.');
  try {
    const seed = require('./data/exercises-seed.json');
    let seeded = 0;
    const BATCH_SIZE = 400; // Firestore batch write limit is 500
    for (let i = 0; i < seed.length; i += BATCH_SIZE) {
      const batch = db.batch();
      for (const e of seed.slice(i, i + BATCH_SIZE)) {
        batch.set(db.collection('exercises').doc(e.id), {
          name: e.name,
          aliases: e.aliases || [],
          muscleGroup: e.muscleGroup || 'other',
          secondaryMuscles: e.secondaryMuscles || [],
          equipment: e.equipment || null,
          category: e.category || null,
          level: e.level || null,
          mechanic: e.mechanic || null,
          force: e.force || null,
          instructions: e.instructions || [],
          archetypeRelevance: [],
          isCustom: false,
          createdBy: null,
          createdAt: FieldValue.serverTimestamp()
        });
      }
      await batch.commit();
      seeded += Math.min(BATCH_SIZE, seed.length - i);
    }
    return sendSuccess(res, 200, { total: seed.length, seeded });
  } catch (err) {
    console.error('[Exercises] Seed failed:', err);
    return sendError(res, 500, 'exercises.seed_failed', String(err));
  }
});

// GET /exercises?q=&muscleGroup=&equipment=&limit= — search/list the library.
// Firestore doesn't do substring/full-text search natively, so `q` matching
// happens in-memory against name+aliases; fine at this table's size (~900
// rows), would need a real search index (Algolia/Typesense/etc.) at scale.
app.get('/exercises', authenticateToken, async (req, res) => {
  if (!firebaseEnabled) return sendSuccess(res, 200, { items: [] });
  try {
    const q = typeof req.query.q === 'string' ? req.query.q.trim().toLowerCase() : '';
    const muscleGroup = typeof req.query.muscleGroup === 'string' ? req.query.muscleGroup.trim() : '';
    const equipment = typeof req.query.equipment === 'string' ? req.query.equipment.trim() : '';
    // Cap raised to 1000 (> the whole ~900-row dataset) so a client can fetch
    // the entire library in one call to cache locally, e.g. for an
    // autocomplete/datalist — not just paginate search results.
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 1000);

    let query = db.collection('exercises');
    if (muscleGroup) query = query.where('muscleGroup', '==', muscleGroup);
    if (equipment) query = query.where('equipment', '==', equipment);

    const snap = await query.get();
    let items = snap.docs.map(d => ({
      id: d.id,
      name: d.get('name'),
      aliases: d.get('aliases') || [],
      muscleGroup: d.get('muscleGroup'),
      secondaryMuscles: d.get('secondaryMuscles') || [],
      equipment: d.get('equipment'),
      category: d.get('category'),
      level: d.get('level'),
      mechanic: d.get('mechanic'),
      force: d.get('force'),
      instructions: d.get('instructions') || [],
      isCustom: d.get('isCustom') || false
    }));

    if (q) {
      items = items.filter(e =>
        e.name.toLowerCase().includes(q) || e.aliases.some(a => a.toLowerCase().includes(q))
      );
    }

    return sendSuccess(res, 200, { items: items.slice(0, limit), total: items.length });
  } catch (err) {
    console.error('[Exercises] Fetch failed:', err);
    return sendError(res, 500, 'exercises.fetch_failed', String(err));
  }
});

// Only bind a port when this file is run directly (`node server.js`), e.g.
// local dev or a non-serverless host. When required as a module — by
// functions/index.js, wrapping this same app in a Firebase Cloud Function —
// the platform's own runtime handles the HTTP server, so calling app.listen()
// here too would be redundant (and on Cloud Run/Functions, PORT is managed by
// the platform, not meant for the app to self-bind outside its own request
// lifecycle).
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`API listening on :${PORT}`);
    console.log('CORS allowlist:', allowed.length ? allowed : '[none → allow all]');
  });
}

module.exports = app;
