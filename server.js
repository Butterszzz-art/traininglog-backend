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
const { upload, extractKnowledgeWithClaude, saveToAirtable, getActiveModules } = require('./knowledgeBase');
const { auth: fbAuth, db, FieldValue, firebaseEnabled, projectId: firebaseProjectId, initError: firebaseInitError } = require('./firebase');
const { migrateLegacyUserData } = require('./legacyMigration');
const { berekenClient } = require('./src/intakeCalculations');

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

app.use(express.json({ limit: '256kb' }));

// ── Rate limiting ─────────────────────────────────────────────────────────────
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 min
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: { code: 'auth.rate_limited', message: 'Too many login attempts. Try again in 15 minutes.' } }
});

// ── Airtable schema check (startup only) ──────────────────────────────────────
async function verifyAirtableModelDefinitions() {
  if (!AIRTABLE_BASE_ID || !AIRTABLE_API_TOKEN) return;
  try {
    const response = await fetch(
      `https://api.airtable.com/v0/meta/bases/${AIRTABLE_BASE_ID}/tables`,
      { headers: airtableHeaders() }
    );
    if (!response.ok) return;
    const { tables = [] } = await response.json();

    for (const name of [WORKOUTS_TABLE, MACRO_TARGETS_TABLE]) {
      const table = tables.find(t => t.name === name);
      if (!table) { console.warn(`[Airtable] Missing table: ${name}`); continue; }
      const field = (table.fields || []).find(f => f.name === USERNAME_FIELD);
      if (!field) { console.warn(`[Airtable] ${name} missing ${USERNAME_FIELD} field`); continue; }
      if (field.type !== 'singleLineText')
        console.warn(`[Airtable] ${name}.${USERNAME_FIELD} should be singleLineText (got ${field.type})`);
    }
  } catch (err) {
    console.warn('[Airtable] Schema check failed:', err?.message);
  }
}

verifyAirtableModelDefinitions();

function computeSessionVolume(workout) {
  if (!workout || typeof workout !== 'object') return 0;
  const sets = Array.isArray(workout.sets)
    ? workout.sets
    : Array.isArray(workout.exercises)
      ? workout.exercises.flatMap(ex => Array.isArray(ex.sets) ? ex.sets : [])
      : [];
  return sets.reduce((total, set) => {
    const weight = Number(set?.weight || 0);
    const reps   = Number(set?.reps   || 0);
    if (!Number.isFinite(weight) || !Number.isFinite(reps)) return total;
    return total + weight * reps;
  }, 0);
}

// ── Routes ────────────────────────────────────────────────────────────────────

// Health check
app.get('/healthz', (_req, res) => res.send('ok'));
app.get('/health', async (_req, res) => {
  const hasToken  = Boolean(process.env.AIRTABLE_API_TOKEN || process.env.AIRTABLE_TOKEN);
  const hasBaseId = Boolean(process.env.AIRTABLE_BASE_ID);
  const hasJwt    = Boolean(process.env.JWT_SECRET);

  const tableChecks = {};
  // ExerciseVideos intentionally excluded: that Airtable table was never
  // actually created (confirmed via direct probe — 403
  // INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND, same signature as other
  // never-existed legacy tables found during the Phase 2 audit). The
  // feature now lives in Firestore (coaches/{uid}/exerciseVideos) since the
  // Phase 2 route cutover, so this was a permanent false alarm — every
  // /health check has been returning HTTP 503 because of it, masking any
  // real problem behind a status that's always red.
  const requiredTables = ['Users', 'Templates', 'Programs', 'Workouts', 'MacroTargets', 'DailyMacros', 'CoachClients'];
  let airtableReachable = null;
  let airtableError = null;

  if (hasToken && hasBaseId) {
    for (const tableName of requiredTables) {
      try {
        await new Promise((resolve, reject) => {
          base(tableName).select({ maxRecords: 1 }).firstPage((err) => {
            if (err) reject(err); else resolve();
          });
        });
        tableChecks[tableName] = 'OK';
        if (airtableReachable !== false) airtableReachable = true;
      } catch (e) {
        tableChecks[tableName] = `MISSING or ERROR: ${e.message || e}`;
        if (tableName === 'Users') {
          airtableReachable = false;
          airtableError = e.message || String(e);
        }
      }
    }
  }

  const missingTables = Object.entries(tableChecks).filter(([, v]) => v !== 'OK').map(([k]) => k);
  const ok = hasToken && hasBaseId && hasJwt && airtableReachable !== false;
  res.status(ok && !missingTables.length ? 200 : 503).json({
    status: ok ? (missingTables.length ? 'tables_missing' : 'ok') : 'misconfigured',
    env: {
      AIRTABLE_TOKEN:   hasToken  ? 'SET' : 'MISSING',
      AIRTABLE_BASE_ID: hasBaseId ? 'SET' : 'MISSING',
      JWT_SECRET:       hasJwt    ? 'SET' : 'MISSING',
      FIREBASE_SERVICE_ACCOUNT: process.env.FIREBASE_SERVICE_ACCOUNT ? 'SET' : 'MISSING',
    },
    firebase: {
      enabled: firebaseEnabled,
      projectId: firebaseProjectId,
      initError: firebaseInitError || null,
    },
    airtable: {
      enabled:       airtableEnabled,
      reachable:     airtableReachable,
      error:         airtableError,
      tables:        tableChecks,
      missingTables,
    },
  });
});

// ── User plan endpoint ───────────────────────────────────────────────────────
app.get('/api/user/plan', authenticateToken, async (req, res) => {
  try {
    const username = req.user?.username;
    if (!username) return res.json({ plan: 'free', status: 'none' });

    const uid = await resolveFirestoreUid(username);
    if (uid) {
      const snap = await db.collection('users').doc(uid).get();
      const u = snap.exists ? snap.data() : {};
      return res.json({
        plan: u.userPlan || 'free',
        status: u.subStatus || 'none',
        periodEnd: u.subCurrentPeriodEnd || '',
        billingCycle: u.billingCycle || '',
        referralCode: u.referralCode || '',
        referralCredits: Number(u.referralCredits) || 0,
      });
    }

    const user = await getUserByUsername(username);
    if (!user) return res.json({ plan: 'free', status: 'none' });

    const f = user.fields;
    return res.json({
      plan: f.UserPlan || 'free',
      status: f.SubStatus || 'none',
      periodEnd: f.SubCurrentPeriodEnd || '',
      billingCycle: f.BillingCycle || '',
      referralCode: f.ReferralCode || '',
      referralCredits: Number(f.ReferralCredits) || 0,
    });
  } catch (err) {
    console.error('[GET /api/user/plan]', err.message);
    return res.json({ plan: 'free', status: 'none' });
  }
});

// ── Stripe checkout (requires STRIPE_SECRET_KEY) ─────────────────────────────
const stripeEnabled = Boolean(process.env.STRIPE_SECRET_KEY);
let stripe = null;
if (stripeEnabled) {
  const Stripe = require('stripe');
  stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
}

app.post('/api/stripe/create-checkout-session', authenticateToken, async (req, res) => {
  if (!stripeEnabled) return res.status(503).json({ error: 'Stripe not configured' });
  const { username, plan, billing } = req.body;
  if (!username || !plan) return res.status(400).json({ error: 'username and plan required' });

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
      subscription_data: { trial_period_days: trialDays, metadata: { username, plan, billing: billing || 'monthly' } },
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
  const username = req.query.username;
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

app.get('/api/referral/stats', async (req, res) => {
  const username = req.query.username;
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

// ── User lookup helper ────────────────────────────────────────────────────────
async function findUserByUsername(username) {
  if (!airtableEnabled) return null;
  const safe = escapeAirtableFormulaValue(username);
  const records = await base(USERS_TABLE)
    .select({ filterByFormula: `{Username}='${safe}'`, maxRecords: 1 })
    .firstPage();
  if (!records.length) {
    console.warn(`[AUTH] No user found for username: "${username}"`);
    return null;
  }
  const f = records[0].fields;
  // Support both 'PasswordHash' and 'Password' field names in Airtable
  const passwordHash = f.PasswordHash || f.Password || null;
  if (!passwordHash) {
    console.error(`[AUTH] User "${username}" found but has no PasswordHash/Password field. Check Airtable field names.`);
  }
  return { id: records[0].id, username: f.Username, passwordHash, fields: f };
}

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
async function resolveFirestoreUid(username) {
  if (!firebaseEnabled || !username) return null;
  try {
    const snap = await db.collection('usernames').doc(String(username).toLowerCase()).get();
    return snap.exists ? (snap.get('uid') || null) : null;
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

// Sync the tier custom claim after a plan change. The Stripe webhook handler
// (PAY-2) must call this alongside updateUserPlan — claims are what gate the
// routes for Firebase-auth'd users, and they only refresh on the next ID-token
// refresh (client forces it with getIdToken(true) after checkout).
async function syncTierClaim(username, tier) {
  if (!firebaseEnabled || !username) return false;
  try {
    const snap = await db.collection('usernames').doc(String(username).toLowerCase()).get();
    if (!snap.exists) return false; // legacy user, no Firebase account yet
    const uid = snap.get('uid');
    const { customClaims = {} } = await fbAuth.getUser(uid);
    await fbAuth.setCustomUserClaims(uid, { ...customClaims, tier });
    await db.collection('users').doc(uid).set({ userPlan: tier }, { merge: true });
    return true;
  } catch (err) {
    console.error('[syncTierClaim] Failed:', err.message);
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

// Login
app.post('/login', loginLimiter, async (req, res) => {
  const { username, password } = req.body || {};

  if (!username || !password) {
    return sendError(res, 400, 'auth.missing_credentials', 'Username and password are required.');
  }
  if (!airtableEnabled) {
    return sendError(res, 503, 'auth.not_configured', 'User storage is not configured.');
  }

  try {
    const user = await findUserByUsername(username);

    // If user found but has no hash — misconfigured Airtable field name
    if (user && !user.passwordHash) {
      console.error(`[LOGIN] User "${username}" has no password hash stored. Airtable Users table may be missing the PasswordHash field.`);
      return sendError(res, 500, 'auth.config_error', 'Account configuration error. Please contact support.');
    }

    const DUMMY_HASH = '$2a$12$KIXBMmh9YkCHEffMFBkJXOyAMFuaUCsqMomSAZqYvVPNTsGzHEAuO';
    const storedHash = user?.passwordHash || DUMMY_HASH;
    const isBcrypt = storedHash.startsWith('$2a$') || storedHash.startsWith('$2b$');

    let passwordMatch = false;
    if (isBcrypt) {
      // Properly hashed — compare normally
      passwordMatch = await bcrypt.compare(password, storedHash);
    } else {
      // Legacy plaintext password — direct compare, then migrate to bcrypt
      passwordMatch = (password === storedHash);
      if (passwordMatch && user) {
        console.info(`[LOGIN] Migrating plaintext password to bcrypt for user "${username}"`);
        try {
          const newHash = await bcrypt.hash(password, 12);
          await base(USERS_TABLE).update([{ id: user.id, fields: { PasswordHash: newHash } }]);
        } catch (migrateErr) {
          // Non-fatal — user can still log in, just not migrated yet
          console.error(`[LOGIN] Failed to migrate password for "${username}":`, migrateErr?.message);
        }
      }
    }

    if (!user || !passwordMatch) {
      console.warn(`[LOGIN] Failed login for "${username}" — user found: ${!!user}, bcrypt: ${isBcrypt}`);
      return sendError(res, 401, 'auth.invalid_credentials', 'Invalid credentials.');
    }

    // Hard cutover: credentials are verified against the Airtable record (so
    // wrong-password guesses still get generic invalid_credentials above,
    // same as before), but no legacy JWT is issued anymore. The verified
    // owner must reclaim via Firebase signup + legacyPassword, which is what
    // migrates their data into Firestore (see /auth/signup-complete).
    console.info(`[LOGIN] Verified legacy credentials for "${username}" — migration required`);
    return sendError(res, 409, 'auth.legacy_migration_required',
      'This account hasn’t been migrated yet. Use Sign Up with this username and your existing password to continue.');
  } catch (e) {
    console.error('[LOGIN] Failed:', e);
    return sendError(res, 500, 'auth.token_failure', 'Failed to sign in.');
  }
});

// ── Firebase Auth endpoints (Phase 1 migration) ───────────────────────────────
const USERNAME_RE = /^[a-zA-Z0-9_.-]{2,64}$/;

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
  if (!USERNAME_RE.test(username)) {
    return sendError(res, 400, 'auth.invalid_username',
      'Username must be 2-64 characters: letters, numbers, dot, dash, underscore.');
  }
  try {
    const snap = await db.collection('usernames').doc(username.toLowerCase()).get();
    if (snap.exists) {
      // Already claimed on Firestore — genuinely taken, no reclaim possible.
      return sendSuccess(res, 200, { username, available: false, reclaimable: false });
    }
    let reclaimable = false;
    if (airtableEnabled) {
      // Legacy Airtable-only usernames aren't available for a fresh signup,
      // but the true owner can reclaim them via signup-complete + legacyPassword.
      const legacy = await findUserByUsername(username);
      reclaimable = Boolean(legacy);
    }
    return sendSuccess(res, 200, { username, available: !reclaimable, reclaimable });
  } catch (err) {
    console.error('[AUTH] username-available failed:', err.message);
    return sendError(res, 500, 'auth.server_error', 'Could not check username.');
  }
});

// POST /auth/signup-complete — body { username, referredBy?, legacyPassword? },
// Bearer = fresh Firebase ID token. Runs after createUserWithEmailAndPassword:
//  1. if `username` matches an existing Airtable Users row, require and verify
//     legacyPassword against its bcrypt hash (Phase 2: this is how a beta
//     tester reclaims their old account instead of it staying reserved forever)
//  2. claims usernames/{username} + creates users/{uid} in one transaction,
//     carrying over the legacy plan/referral fields when this is a reclaim
//  3. sets custom claims (username, tier, isCoach)
//  4. on a verified reclaim, migrates that user's Airtable data into Firestore
//     (legacyMigration.js) — brand-new signups get a plain Airtable row instead,
//     matching Phase 1 behavior, so existing Stripe/data routes keep working
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
  const legacyPassword = typeof req.body?.legacyPassword === 'string' ? req.body.legacyPassword : '';
  if (!USERNAME_RE.test(username)) {
    return sendError(res, 400, 'auth.invalid_username',
      'Username must be 2-64 characters: letters, numbers, dot, dash, underscore.');
  }

  try {
    // A username matching an existing Airtable row can only be claimed by
    // proving ownership of the old password — otherwise it stays reserved.
    let legacy = null;
    if (airtableEnabled) {
      legacy = await findUserByUsername(username);
      if (legacy) {
        if (!legacy.passwordHash) {
          return sendError(res, 500, 'auth.config_error', 'Legacy account configuration error. Please contact support.');
        }
        if (!legacyPassword) {
          return sendError(res, 409, 'auth.legacy_verification_required',
            'This username belongs to an existing account. Enter its password to reclaim it.');
        }
        const matches = await bcrypt.compare(legacyPassword, legacy.passwordHash);
        if (!matches) {
          return sendError(res, 401, 'auth.legacy_password_invalid', 'That password doesn’t match the existing account.');
        }
      }
    }
    const isLegacyClaim = Boolean(legacy);

    const usernameRef = db.collection('usernames').doc(username.toLowerCase());
    const userRef = db.collection('users').doc(fbUser.uid);
    // Reclaims keep their old referral code/credits so existing shared links
    // and any accrued credit keep working; brand-new signups get a fresh code.
    const referralCode = (isLegacyClaim && legacy.fields.ReferralCode) || generateReferralCode(username);
    const tier = (isLegacyClaim && legacy.fields.UserPlan) || 'free';

    // Resolve referral code → referrer uid where possible (schema doc: transform, not copy)
    let referredByUid = null;
    const referredByCodeFinal = (isLegacyClaim && legacy.fields.ReferredBy) || referredByCode || null;
    if (referredByCodeFinal) {
      const referrer = await db.collection('users')
        .where('referralCode', '==', referredByCodeFinal).limit(1).get();
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
        subStatus: (isLegacyClaim && legacy.fields.SubStatus) || 'none',
        subCurrentPeriodEnd: (isLegacyClaim && legacy.fields.SubCurrentPeriodEnd) || null,
        billingCycle: (isLegacyClaim && legacy.fields.BillingCycle) || null,
        stripeCustomerId: (isLegacyClaim && legacy.fields.StripeCustomerId) || null,
        referralCode,
        referralCredits: (isLegacyClaim && Number(legacy.fields.ReferralCredits)) || 0,
        referredByCode: referredByCodeFinal,
        referredByUid,
        isCoach: false // corrected below if the migration finds a coach roster
      }, { merge: true });
    });

    await fbAuth.setCustomUserClaims(fbUser.uid, {
      username,
      tier,
      isCoach: false
    });

    if (isLegacyClaim) {
      // Reclaiming an existing account — migrate its Airtable data into
      // Firestore. The legacy Airtable row is left untouched (still usable by
      // /login for anyone who hasn't switched yet); no new row is created for
      // it, which would otherwise duplicate the username and break the
      // maxRecords:1 lookup every legacy route relies on.
      const { counts, errors, isCoach } = await migrateLegacyUserData({
        username, uid: fbUser.uid, base, db, FieldValue, escapeAirtableFormulaValue
      });
      console.info(`[AUTH] Legacy migration for "${username}" (uid ${fbUser.uid}):`, counts,
        Object.keys(errors).length ? { errors } : '');
      if (isCoach) {
        await db.collection('users').doc(fbUser.uid).set({ isCoach: true }, { merge: true });
        await fbAuth.setCustomUserClaims(fbUser.uid, { username, tier, isCoach: true });
      }
    } else if (airtableEnabled) {
      // Brand-new signup — best-effort Airtable row so plan/Stripe flows keep
      // working until those routes move to Firestore.
      const fields = { Username: username, CreatedAt: new Date().toISOString() };
      const optionalFields = {
        UserPlan: 'free',
        ReferralCode: referralCode,
        ReferredBy: referredByCode || '',
        ReferralCredits: 0,
        ProgramGenCount: 0,
      };
      try {
        await base(USERS_TABLE).create([{ fields: { ...fields, ...optionalFields } }]);
      } catch (e1) {
        try {
          await base(USERS_TABLE).create([{ fields }]);
        } catch (e2) {
          console.error(`[AUTH] Airtable Users row failed for "${username}":`, e2.message);
        }
      }
    }

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

// Save workout (in-memory — kept for backwards compat)
const savedWorkouts = [];
app.post('/saveWorkout', authenticateToken, (req, res) => {
  const { username, workout } = req.body || {};
  if (!username || !workout) {
    return sendError(res, 400, 'workout.validation', 'username and workout are required.');
  }
  savedWorkouts.push({
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    username,
    workout,
    savedAt: new Date().toISOString()
  });
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
      // return it byte-for-byte — that's the API's existing contract. A
      // `sets` subcollection is also populated for future analytics, mirroring
      // legacyMigration.js's design, but GET doesn't reconstruct from it.
      const docRef = db.collection(`users/${uid}/workouts`).doc();
      await docRef.set({
        date: String(date),
        title: String(title || 'Workout'),
        sessionVolume,
        workout
      });
      const sets = Array.isArray(workout.sets)
        ? workout.sets
        : Array.isArray(workout.exercises)
          ? workout.exercises.flatMap(ex => Array.isArray(ex.sets) ? ex.sets.map(s => ({ ...s, exerciseName: s.exerciseName || ex.exercise || ex.name })) : [])
          : [];
      await Promise.all(sets.map((s, i) =>
        docRef.collection('sets').doc(String(i)).set({
          exerciseName: s.exerciseName || s.exercise || null,
          weight: s.weight ?? null,
          reps: s.reps ?? null,
          rpe: s.rpe ?? null,
          setNumber: s.setNumber ?? i + 1
        })
      ));
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
      const snap = await db.collection(`users/${uid}/workouts`).orderBy('date', 'desc').get();
      const items = snap.docs.map(d => ({
        id: d.id, username, date: d.get('date'), title: d.get('title'), workout: d.get('workout') ?? null
      }));
      return sendSuccess(res, 200, { items });
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
      const docRef = db.collection(`users/${uid}/dailyMacros`).doc();
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
    const username = typeof req.query.username === 'string' ? req.query.username.trim() : '';
    if (!username) return sendError(res, 422, 'dailylogs.missing_username', 'username query param is required.');

    const uid = await resolveFirestoreUid(username);
    if (uid) {
      const snap = await db.collection(`users/${uid}/dailyMacros`).orderBy('date', 'desc').get();
      const records = snap.docs.map(d => ({
        id: d.id,
        Date: d.get('date'),
        Calories: d.get('calories'),
        ProteinGrams: d.get('proteinGrams'),
        CarbGrams: d.get('carbGrams'),
        FatGrams: d.get('fatGrams'),
        ...(d.get('type') ? { Type: d.get('type') } : {}),
        ...(d.get('logData') != null ? { LogData: JSON.stringify(d.get('logData')) } : {})
      }));
      return res.json({ success: true, records });
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
      const docRef = db.collection(`users/${uid}/bodyweightArchives`).doc();
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
    const username = typeof req.query.username === 'string' ? req.query.username.trim() : '';
    if (!username) return sendError(res, 422, 'bodyweight.missing_username', 'username is required.');

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
      const recordIds = await Promise.all(entries.map(async e => {
        const docRef = col.doc();
        await docRef.set({
          date: String(e.date || ''),
          neck: e.neck != null ? Number(e.neck) : null,
          shoulders: e.shoulders != null ? Number(e.shoulders) : null,
          chest: e.chest != null ? Number(e.chest) : null,
          waist: e.waist != null ? Number(e.waist) : null,
          hips: e.hips != null ? Number(e.hips) : null,
          arm: e.arm != null ? Number(e.arm) : null,
          thigh: e.thigh != null ? Number(e.thigh) : null,
          syncedAt: new Date().toISOString()
        });
        return docRef.id;
      }));
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
    const username = typeof req.query.username === 'string' ? req.query.username.trim() : '';
    if (!username) return sendError(res, 422, 'measurements.missing_username', 'username is required.');

    const uid = await resolveFirestoreUid(username);
    if (uid) {
      const snap = await db.collection(`users/${uid}/measurements`).orderBy('date', 'desc').get();
      const items = snap.docs.map(d => ({
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
      return sendSuccess(res, 200, { items });
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
      const recordIds = await Promise.all(entries.map(async e => {
        const docRef = col.doc();
        await docRef.set({
          date: String(e.date || ''),
          type: String(e.type || ''),
          duration: e.duration != null ? Number(e.duration) : null,
          distance: e.distance != null ? Number(e.distance) : null,
          calories: e.calories != null ? Number(e.calories) : null,
          estimatedCalories: e.estimatedCalories != null ? Number(e.estimatedCalories) : null,
          met: e.met != null ? Number(e.met) : null,
          notes: e.notes ? String(e.notes) : '',
          syncedAt: new Date().toISOString()
        });
        return docRef.id;
      }));
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
    const username = typeof req.query.username === 'string' ? req.query.username.trim() : '';
    if (!username) return sendError(res, 422, 'cardio.missing_username', 'username is required.');

    const uid = await resolveFirestoreUid(username);
    if (uid) {
      const snap = await db.collection(`users/${uid}/cardioLogs`).orderBy('date', 'desc').get();
      const items = snap.docs.map(d => ({
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
      return sendSuccess(res, 200, { items });
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
      const recordIds = await Promise.all(entries.map(async e => {
        const docRef = col.doc();
        await docRef.set({
          date: String(e.date || ''),
          workoutName: String(e.name || e.workoutName || ''),
          minutes: e.minutes != null ? Number(e.minutes) : null,
          seconds: e.seconds != null ? Number(e.seconds) : null,
          rounds: e.rounds != null ? Number(e.rounds) : null,
          notes: e.notes ? String(e.notes) : '',
          exercises: e.exercises || [],
          syncedAt: new Date().toISOString()
        });
        return docRef.id;
      }));
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
    const username = typeof req.query.username === 'string' ? req.query.username.trim() : '';
    if (!username) return sendError(res, 422, 'crossfit.missing_username', 'username is required.');

    const uid = await resolveFirestoreUid(username);
    if (uid) {
      const snap = await db.collection(`users/${uid}/crossfitLogs`).orderBy('date', 'desc').get();
      const items = snap.docs.map(d => ({
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
      return sendSuccess(res, 200, { items });
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

// ── Fitbit ────────────────────────────────────────────────────────────────────
// OAuth 2.0 Authorization Code flow (steps/activity only for now). Tokens live
// in their own top-level collection (fitbitTokens/{uid}) rather than on the
// user doc so they're never exposed if the client SDK ever reads users/{uid}
// directly — that collection is server-only, see firestore.rules.
const FITBIT_CLIENT_ID     = process.env.FITBIT_CLIENT_ID || null;
const FITBIT_CLIENT_SECRET = process.env.FITBIT_CLIENT_SECRET || null;
const FITBIT_REDIRECT_URI  = process.env.FITBIT_REDIRECT_URI || null;
const fitbitEnabled = Boolean(FITBIT_CLIENT_ID && FITBIT_CLIENT_SECRET && FITBIT_REDIRECT_URI);
if (!fitbitEnabled) console.warn('[WARN] Fitbit disabled — FITBIT_CLIENT_ID/FITBIT_CLIENT_SECRET/FITBIT_REDIRECT_URI not set.');

const FITBIT_APP_URL = process.env.APP_URL || 'https://pocketcoachcoms.org';

function fitbitBasicAuthHeader() {
  return 'Basic ' + Buffer.from(`${FITBIT_CLIENT_ID}:${FITBIT_CLIENT_SECRET}`).toString('base64');
}

async function requestFitbitToken(bodyParams) {
  const response = await fetch('https://api.fitbit.com/oauth2/token', {
    method: 'POST',
    headers: {
      Authorization: fitbitBasicAuthHeader(),
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams(bodyParams)
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data?.errors?.[0]?.message || 'Fitbit token request failed');
  return data;
}

async function saveFitbitTokens(uid, tokenResponse) {
  await db.collection('fitbitTokens').doc(uid).set({
    accessToken: tokenResponse.access_token,
    refreshToken: tokenResponse.refresh_token,
    expiresAt: Date.now() + (Number(tokenResponse.expires_in) || 0) * 1000,
    fitbitUserId: tokenResponse.user_id || null,
    scope: tokenResponse.scope || '',
    updatedAt: new Date().toISOString()
  }, { merge: true });
}

// Returns a valid access token for uid, refreshing it if expired, or null if
// not connected / the refresh token was revoked on Fitbit's side.
async function getValidFitbitAccessToken(uid) {
  const ref = db.collection('fitbitTokens').doc(uid);
  const snap = await ref.get();
  if (!snap.exists) return null;

  const token = snap.data();
  if (token.expiresAt > Date.now() + 60000) return token.accessToken;

  try {
    const refreshed = await requestFitbitToken({ grant_type: 'refresh_token', refresh_token: token.refreshToken });
    await saveFitbitTokens(uid, refreshed);
    return refreshed.access_token;
  } catch (err) {
    console.error('[Fitbit] token refresh failed, clearing stored token:', err.message);
    await ref.delete().catch(() => {});
    return null;
  }
}

// GET /api/fitbit/status
app.get('/api/fitbit/status', authenticateToken, async (req, res) => {
  if (!fitbitEnabled) return sendError(res, 503, 'fitbit.disabled', 'Fitbit integration is not configured.');
  if (!req.user.uid) return sendSuccess(res, 200, { connected: false });
  try {
    const snap = await db.collection('fitbitTokens').doc(req.user.uid).get();
    return sendSuccess(res, 200, { connected: snap.exists });
  } catch (err) {
    console.error('GET /api/fitbit/status failed:', err);
    return sendError(res, 500, 'fitbit.server_error', String(err));
  }
});

// GET /api/fitbit/connect — returns the Fitbit consent-screen URL for the frontend to redirect to
app.get('/api/fitbit/connect', authenticateToken, (req, res) => {
  if (!fitbitEnabled) return sendError(res, 503, 'fitbit.disabled', 'Fitbit integration is not configured.');
  if (!req.user.uid) {
    return sendError(res, 403, 'fitbit.requires_firebase_auth', 'Please sign in again before connecting Fitbit.');
  }
  // Fitbit's redirect back to /callback carries no Authorization header, so the
  // uid rides in a short-lived signed state param instead (CSRF protection too).
  const state = jwt.sign({ uid: req.user.uid }, JWT_SECRET, { expiresIn: '10m' });
  const url = 'https://www.fitbit.com/oauth2/authorize?' + new URLSearchParams({
    response_type: 'code',
    client_id: FITBIT_CLIENT_ID,
    redirect_uri: FITBIT_REDIRECT_URI,
    scope: 'activity',
    state
  });
  return sendSuccess(res, 200, { url });
});

// GET /api/fitbit/callback — Fitbit redirects the user's browser here after
// consent; not authenticateToken since it's a direct browser navigation, not
// a fetch call from the frontend.
app.get('/api/fitbit/callback', async (req, res) => {
  const { code, state, error } = req.query;
  if (error || !code || !state) {
    return res.redirect(`${FITBIT_APP_URL}/?fitbit=error`);
  }

  let uid;
  try {
    ({ uid } = jwt.verify(String(state), JWT_SECRET));
  } catch {
    return res.redirect(`${FITBIT_APP_URL}/?fitbit=error`);
  }

  try {
    const tokenResponse = await requestFitbitToken({
      grant_type: 'authorization_code',
      code: String(code),
      redirect_uri: FITBIT_REDIRECT_URI,
      client_id: FITBIT_CLIENT_ID
    });
    await saveFitbitTokens(uid, tokenResponse);
    return res.redirect(`${FITBIT_APP_URL}/?fitbit=connected`);
  } catch (err) {
    console.error('GET /api/fitbit/callback failed:', err.message);
    return res.redirect(`${FITBIT_APP_URL}/?fitbit=error`);
  }
});

// POST /api/fitbit/disconnect
app.post('/api/fitbit/disconnect', authenticateToken, async (req, res) => {
  if (!req.user.uid) return sendSuccess(res, 200, {});
  const ref = db.collection('fitbitTokens').doc(req.user.uid);
  try {
    const snap = await ref.get();
    if (snap.exists) {
      const { accessToken } = snap.data();
      await fetch('https://api.fitbit.com/oauth2/revoke', {
        method: 'POST',
        headers: {
          Authorization: fitbitBasicAuthHeader(),
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: new URLSearchParams({ token: accessToken })
      }).catch(err => console.warn('[Fitbit] revoke call failed (non-fatal):', err.message));
    }
    await ref.delete();
    return sendSuccess(res, 200, {});
  } catch (err) {
    console.error('POST /api/fitbit/disconnect failed:', err);
    return sendError(res, 500, 'fitbit.server_error', String(err));
  }
});

// GET /api/fitbit/activity?date=YYYY-MM-DD — steps/activity summary for one
// day (defaults to today). Fetched live from Fitbit and cached in Firestore.
app.get('/api/fitbit/activity', authenticateToken, async (req, res) => {
  if (!fitbitEnabled) return sendError(res, 503, 'fitbit.disabled', 'Fitbit integration is not configured.');
  if (!req.user.uid) {
    return sendError(res, 403, 'fitbit.requires_firebase_auth', 'Please sign in again before syncing Fitbit.');
  }

  const date = typeof req.query.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date)
    ? req.query.date
    : new Date().toISOString().slice(0, 10);

  try {
    const accessToken = await getValidFitbitAccessToken(req.user.uid);
    if (!accessToken) return sendError(res, 409, 'fitbit.not_connected', 'Fitbit is not connected.');

    const response = await fetch(`https://api.fitbit.com/1/user/-/activities/date/${date}.json`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Accept-Language': 'en_GB' // forces metric units regardless of the Fitbit account's own locale
      }
    });
    const data = await response.json();
    if (!response.ok) {
      return sendError(res, 502, 'fitbit.api_error', 'Fitbit API request failed.',
        data?.errors?.[0]?.message || JSON.stringify(data));
    }

    const summary = data.summary || {};
    const activity = {
      date,
      steps:            Number(summary.steps) || 0,
      distanceKm:       Number(summary.distances?.find(d => d.activity === 'total')?.distance) || 0,
      caloriesOut:      Number(summary.caloriesOut) || 0,
      activeMinutes:    (Number(summary.fairlyActiveMinutes) || 0) + (Number(summary.veryActiveMinutes) || 0),
      sedentaryMinutes: Number(summary.sedentaryMinutes) || 0,
      syncedAt: new Date().toISOString()
    };

    await db.collection(`users/${req.user.uid}/fitbitActivity`).doc(date).set(activity, { merge: true });

    return sendSuccess(res, 200, { activity });
  } catch (err) {
    console.error('GET /api/fitbit/activity failed:', err);
    return sendError(res, 500, 'fitbit.server_error', String(err));
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
app.get('/api/coach/clients', authenticateToken, async (req, res) => {
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
      const clients = snap.docs.map(d => ({
        id: d.id,
        clientId: d.id,
        clientName: d.get('athleteDisplayName') || '',
        email: d.get('email') || '',
        status: d.get('status') || 'active',
        trainingMode: d.get('trainingMode') || '',
        currentProgram: d.get('currentProgram') || '',
        lastCheckIn: d.get('lastCheckInAt') || null,
        alertStatus: d.get('alertStatus') || 'ok',
        currentNutritionSummary: d.get('nutritionSummary') || '',
        latestCheckInData: d.get('latestCheckInJson') ?? null
      }));
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

// Verify a coach-client relationship exists in the CoachClients table.
async function verifyCoachClientLink(coachUsername, clientUsername) {
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

// POST /api/coach/clients/invite — body: { clientUsername }
// Coach invites an existing athlete account to link as a client.
app.post('/api/coach/clients/invite', authenticateToken, coachInviteLimiter, async (req, res) => {
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

    const now = FieldValue.serverTimestamp();
    const batch = db.batch();
    batch.set(inviteRef, { status: 'active', acceptedAt: now }, { merge: true });
    batch.set(clientDocRef, { status: 'active', acceptedAt: now }, { merge: true });
    await batch.commit();

    return sendSuccess(res, 200, { coachUsername, status: 'active' });
  } catch (err) {
    console.error('POST /api/coach/clients/accept failed:', err);
    return sendError(res, 500, 'coach.server_error', String(err));
  }
});

// DELETE /api/coach/clients/:clientUid — coach removes (or cancels a pending
// invite to) a client. Client-initiated unlink is a natural follow-up to add
// once the mobile app actually surfaces this relationship, not built yet.
app.delete('/api/coach/clients/:clientUid', authenticateToken, async (req, res) => {
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

    const inviteRef = db.collection(`users/${clientUid}/coachInvites`).doc(coachUid);
    const batch = db.batch();
    batch.delete(clientDocRef);
    batch.delete(inviteRef);
    await batch.commit();

    return sendSuccess(res, 200, { clientUid, removed: true });
  } catch (err) {
    console.error('DELETE /api/coach/clients/:clientUid failed:', err);
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
      calculations
    });

    return sendSuccess(res, 201, { leadId: leadRef.id, calculations });
  } catch (err) {
    console.error('POST /api/intake failed:', err);
    return sendError(res, 500, 'intake.server_error', String(err));
  }
});

// GET /api/coach/leads — authenticated, coach-only. Returns every pending
// intake lead for the calling coach, newest first.
app.get('/api/coach/leads', authenticateToken, async (req, res) => {
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
app.patch('/api/coach/leads/:id', authenticateToken, async (req, res) => {
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
app.post('/coach/workouts', authenticateToken, async (req, res) => {
  try {
    const coachUsername = req.user.username;
    const { clientUsername, date, title, workout } = req.body || {};
    if (!clientUsername || !date || !workout) {
      return sendError(res, 422, 'coach.invalid_payload', 'clientUsername, date and workout are required.');
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
      const docRef = db.collection(`users/${clientUid}/workouts`).doc();
      await docRef.set({
        date: String(date),
        title: String(title || 'Workout (logged by coach)'),
        sessionVolume,
        workout: stamped
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
app.post('/coach/exercise-videos', authenticateToken, async (req, res) => {
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
app.get('/coach/exercise-videos', authenticateToken, async (req, res) => {
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
app.delete('/coach/exercise-videos/:id', authenticateToken, async (req, res) => {
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
    if (!airtableEnabled) return sendSuccess(res, 200, { items: [] });

    // Find this user's coach(es) via the CoachClients table — that
    // relationship isn't migrated bidirectionally yet (PHASE2-NOTES.md gap
    // #1), so this lookup always goes through Airtable regardless of either
    // party's migration status. Only the video STORAGE is per-coach-migrated.
    const safeClient = escapeAirtableFormulaValue(clientUsername);
    const links = await base(COACH_CLIENTS_TABLE)
      .select({
        filterByFormula: `OR({ClientId}='${safeClient}',{ClientName}='${safeClient}')`,
        pageSize: 10
      })
      .firstPage();

    const coachIds = [...new Set(links.map(l => l.get('CoachId')).filter(Boolean))];
    if (!coachIds.length) return sendSuccess(res, 200, { items: [] });

    // Each coach may or may not have migrated independently of this client —
    // fetch their videos from whichever store they're actually in.
    const items = [];
    const legacyCoachIds = [];
    for (const coachId of coachIds) {
      const coachUid = await resolveFirestoreUid(coachId);
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
    const username = typeof req.query.username === 'string' ? req.query.username.trim() : '';
    if (!username) return sendError(res, 422, 'mobility.missing_username', 'username is required.');

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
    const username = typeof req.query.username === 'string' ? req.query.username.trim() : '';
    if (!username) return sendError(res, 422, 'mobility.missing_username', 'username is required.');

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

// POST /ai/chat — proxy to Anthropic claude-haiku-4-5
app.post('/ai/chat', authenticateToken, async (req, res) => {
  try {
    const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
    if (!ANTHROPIC_API_KEY) {
      return sendError(res, 503, 'ai.not_configured', 'Anthropic API key is not configured.');
    }

    const { messages, systemPrompt } = req.body || {};
    if (!Array.isArray(messages) || !messages.length) {
      return sendError(res, 422, 'ai.invalid_payload', 'messages array is required.');
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000); // 30s timeout for AI

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'x-api-key':         ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type':      'application/json'
      },
      body: JSON.stringify({
        model:      'claude-haiku-4-5-20251001',
        max_tokens: 1024,
        system:     systemPrompt || 'You are a helpful fitness coaching assistant.',
        messages:   messages.map(m => ({ role: m.role, content: String(m.content) }))
      })
    }).finally(() => clearTimeout(timer));

    const data = await response.json();
    if (!response.ok) {
      return sendError(res, 502, 'ai.upstream_error', 'Anthropic API returned an error.',
        data?.error?.message || JSON.stringify(data));
    }

    const reply = data?.content?.[0]?.text || '';
    return sendSuccess(res, 200, { reply });
  } catch (err) {
    if (err.name === 'AbortError') {
      return sendError(res, 504, 'ai.timeout', 'AI request timed out.');
    }
    console.error('POST /ai/chat failed:', err);
    return sendError(res, 500, 'ai.server_error', String(err));
  }
});

app.use('/api/ai', aiRouter);
app.use('/', leaderboardRoute);

// ── Knowledge Base routes ────────────────────────────────────────────────────
// KnowledgeBase is global/shared AI-coaching content, not per-user data — it
// doesn't get copied at signup like the tables in legacyMigration.js. Instead,
// POST /admin/knowledgebase/migrate does a one-time copy from Airtable, and
// these routes treat Firestore as authoritative once it actually has modules
// in it (a real migration marker, not a per-user resolveFirestoreUid check).

async function knowledgeBaseUsesFirestore() {
  if (!firebaseEnabled) return false;
  try {
    const snap = await db.collection('knowledgeBase').limit(1).get();
    return !snap.empty;
  } catch {
    return false;
  }
}

async function getActiveModulesFirestore(topic = null) {
  let query = db.collection('knowledgeBase').where('isActive', '==', true);
  if (topic) query = query.where('topic', '==', topic);
  const snap = await query.get();
  return snap.docs.map(d => ({ id: d.id, moduleName: d.get('moduleName'), topic: d.get('topic'), extractedJSON: d.get('extractedJSON') || {} }));
}

// One-time migration: copies every Airtable KnowledgeBase record into
// Firestore's knowledgeBase collection (additive — doesn't touch Airtable).
// Idempotent: uses the Airtable record id as the Firestore doc id, so
// re-running just re-writes the same docs rather than duplicating them.
app.post('/admin/knowledgebase/migrate', authenticateToken, async (req, res) => {
  if (!firebaseEnabled) return sendError(res, 503, 'kb.firebase_disabled', 'Firebase is not configured.');
  if (!AIRTABLE_API_TOKEN || !AIRTABLE_BASE_ID) return sendError(res, 503, 'kb.airtable_disabled', 'Airtable is not configured.');
  try {
    const url = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/KnowledgeBase`;
    const response = await airtableFetch(url, { headers: airtableHeaders() });
    const data = await response.json();
    if (!response.ok) return sendError(res, 502, 'kb.airtable_rejected', 'Airtable rejected the request.', JSON.stringify(data));

    const records = data.records || [];
    let migrated = 0, skipped = 0;
    for (const r of records) {
      const f = r.fields || {};
      if (!f.ModuleName) { skipped++; continue; }
      await db.collection('knowledgeBase').doc(r.id).set({
        moduleName: f.ModuleName,
        topic: f.Topic || null,
        version: f.Version ?? 1,
        sourceFileName: f.SourceFile || null,
        extractedJSON: safeJsonParse(f.ExtractedJSON, f.ExtractedJSON || null),
        isActive: f.IsActive !== false,
        ingestedAt: f.ProcessedAt || null,
        migratedFrom: r.id
      });
      migrated++;
    }
    return sendSuccess(res, 200, { total: records.length, migrated, skipped });
  } catch (err) {
    console.error('[KnowledgeBase] Migration failed:', err);
    return sendError(res, 500, 'kb.migration_failed', String(err));
  }
});

app.post('/admin/ingest-pdf', authenticateToken, upload.single('pdf'), async (req, res) => {
  try {
    const { moduleName, topic } = req.body;
    if (!req.file) return res.status(400).json({ error: 'No PDF file received' });
    if (!moduleName) return res.status(400).json({ error: 'moduleName is required' });
    if (!topic) return res.status(400).json({ error: 'topic is required' });

    const pdfParse = require('pdf-parse');
    const pdfData = await pdfParse(req.file.buffer);
    const text = pdfData.text;
    if (!text || text.trim().length < 100) return res.status(422).json({ error: 'PDF appears empty or unreadable' });

    const extracted = await extractKnowledgeWithClaude(text, moduleName, topic);

    if (await knowledgeBaseUsesFirestore()) {
      const docRef = db.collection('knowledgeBase').doc();
      await docRef.set({
        moduleName, topic, sourceFileName: req.file.originalname,
        extractedJSON: extracted, version: 1,
        isActive: true, ingestedAt: new Date().toISOString().slice(0, 10)
      });
      return res.json({
        success: true, recordId: docRef.id, moduleName, topic,
        fieldsExtracted: Object.keys(extracted).filter(k => Array.isArray(extracted[k]) ? extracted[k].length > 0 : !!extracted[k])
      });
    }

    if (!AIRTABLE_API_TOKEN || !AIRTABLE_BASE_ID) return res.status(500).json({ error: 'Airtable not configured' });
    const record = await saveToAirtable(AIRTABLE_API_TOKEN, AIRTABLE_BASE_ID, {
      ModuleName: moduleName, Topic: topic, SourceFile: req.file.originalname,
      ExtractedJSON: JSON.stringify(extracted), Version: 1,
      ProcessedAt: new Date().toISOString().slice(0, 10), IsActive: true
    });

    res.json({
      success: true, recordId: record.id, moduleName, topic,
      fieldsExtracted: Object.keys(extracted).filter(k => Array.isArray(extracted[k]) ? extracted[k].length > 0 : !!extracted[k])
    });
  } catch (err) {
    console.error('[KnowledgeBase] Ingest error:', err);
    res.status(500).json({ error: 'Ingestion failed', details: err.message });
  }
});

app.get('/admin/knowledge-modules', authenticateToken, async (req, res) => {
  try {
    if (await knowledgeBaseUsesFirestore()) {
      const modules = await getActiveModulesFirestore();
      return res.json({ modules });
    }
    if (!AIRTABLE_API_TOKEN || !AIRTABLE_BASE_ID) return res.status(500).json({ error: 'Airtable not configured' });
    const modules = await getActiveModules(AIRTABLE_API_TOKEN, AIRTABLE_BASE_ID);
    res.json({ modules });
  } catch (err) {
    console.error('[KnowledgeBase] Fetch error:', err);
    res.status(500).json({ error: 'Failed to fetch modules' });
  }
});

app.get('/knowledge-context', authenticateToken, async (req, res) => {
  try {
    const topicsParam = req.query.topics;
    const topics = topicsParam ? topicsParam.split(',').map(t => t.trim()) : null;
    const usesFirestore = await knowledgeBaseUsesFirestore();

    let allModules = [];
    if (usesFirestore) {
      allModules = topics && topics.length > 0
        ? (await Promise.all(topics.map(t => getActiveModulesFirestore(t)))).flat()
        : await getActiveModulesFirestore();
    } else {
      if (!AIRTABLE_API_TOKEN || !AIRTABLE_BASE_ID) return res.status(500).json({ error: 'Airtable not configured' });
      allModules = topics && topics.length > 0
        ? (await Promise.all(topics.map(t => getActiveModules(AIRTABLE_API_TOKEN, AIRTABLE_BASE_ID, t)))).flat()
        : await getActiveModules(AIRTABLE_API_TOKEN, AIRTABLE_BASE_ID);
    }

    const context = allModules.reduce((acc, mod) => { acc[mod.moduleName] = mod.extractedJSON; return acc; }, {});
    res.json({ context, modulesLoaded: allModules.map(m => m.moduleName) });
  } catch (err) {
    console.error('[KnowledgeBase] Context error:', err);
    res.status(500).json({ error: 'Failed to build knowledge context' });
  }
});

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
