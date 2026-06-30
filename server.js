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

const app = express();

// ── Environment validation ────────────────────────────────────────────────────
// Required: AIRTABLE_TOKEN, AIRTABLE_BASE_ID, JWT_SECRET, ANTHROPIC_API_KEY
const missing = ['AIRTABLE_TOKEN', 'AIRTABLE_BASE_ID', 'JWT_SECRET']
  .filter(k => !process.env[k]);
if (missing.length) {
  console.warn(`[WARN] Missing env vars: ${missing.join(', ')}`);
}
if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET environment variable is required.');

const AIRTABLE_BASE_ID   = process.env.AIRTABLE_BASE_ID;
const AIRTABLE_API_TOKEN = process.env.AIRTABLE_API_TOKEN || process.env.AIRTABLE_TOKEN || null;
const JWT_SECRET         = process.env.JWT_SECRET;

// ── Tables ────────────────────────────────────────────────────────────────────
const TABLE_NAME          = process.env.AIRTABLE_TABLE           || 'Workouts';
const DAYS_TABLE          = process.env.AIRTABLE_DAYS_TABLE      || 'Days';
const WORKOUTS_TABLE      = 'Workouts';
const MACRO_TARGETS_TABLE = 'MacroTargets';
const DAILY_LOGS_TABLE    = process.env.AIRTABLE_DAILY_LOGS_TABLE    || 'DailyMacros';
const USERS_TABLE         = process.env.AIRTABLE_USERS_TABLE         || 'Users';
const TEMPLATES_TABLE_NAME = process.env.AIRTABLE_TEMPLATES_TABLE    || 'Templates';
const USERNAME_FIELD      = 'Username';

// ── Airtable client ───────────────────────────────────────────────────────────
const airtableEnabled = Boolean(AIRTABLE_API_TOKEN && AIRTABLE_BASE_ID);
const base = airtableEnabled
  ? new Airtable({ apiKey: AIRTABLE_API_TOKEN }).base(AIRTABLE_BASE_ID)
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
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return sendError(res, 401, 'auth.missing_token', 'Authorization token is required.');
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

// ── Field mappers ─────────────────────────────────────────────────────────────
function mapWorkoutToFields(w) {
  return {
    Name:      w.name      || 'Workout',
    CreatedAt: w.createdAt || new Date().toISOString(),
    Notes:     w.notes     || '',
    Units:     w.units     || '',
    SetsJson:  JSON.stringify(w.sets || [])
  };
}

function mapRecordToWorkout(rec) {
  const f = rec.fields || {};
  let sets = [];
  try { sets = f.SetsJson ? JSON.parse(f.SetsJson) : []; } catch {}
  return { id: rec.id, createdAt: f.CreatedAt || rec._rawJson?.createdTime, name: f.Name || 'Workout', notes: f.Notes || '', units: f.Units || '', sets };
}

function toFieldsFromDay(day) {
  const f = { Date: day.date };
  if (day.workout)    f.WorkoutJson    = JSON.stringify(day.workout);
  if (day.bodyweight) { f.BodyweightValue = day.bodyweight.value ?? null; f.BodyweightUnit = day.bodyweight.unit ?? null; }
  if (day.cardio)     f.CardioJson     = JSON.stringify(day.cardio);
  if (day.macros)     f.MacrosJson     = JSON.stringify(day.macros);
  return f;
}

function fromRecordToDay(rec) {
  const f = rec.fields || {};
  const safeParse = s => { try { return s ? JSON.parse(s) : undefined; } catch { return undefined; } };
  return {
    id:          rec.id,
    date:        f.Date,
    workout:     safeParse(f.WorkoutJson),
    bodyweight:  (f.BodyweightValue || f.BodyweightUnit) ? { value: f.BodyweightValue ?? undefined, unit: f.BodyweightUnit ?? undefined } : undefined,
    cardio:      safeParse(f.CardioJson),
    macros:      safeParse(f.MacrosJson)
  };
}

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

async function findDayRecordId(dateKey) {
  const safeDate = escapeAirtableFormulaValue(dateKey);
  const found = await base(DAYS_TABLE)
    .select({ filterByFormula: `{Date} = '${safeDate}'`, maxRecords: 1 })
    .firstPage();
  return found[0]?.id || null;
}

// ── Routes ────────────────────────────────────────────────────────────────────

// Health check
app.get('/healthz', (_req, res) => res.send('ok'));
app.get('/health', async (_req, res) => {
  const hasToken  = Boolean(process.env.AIRTABLE_API_TOKEN || process.env.AIRTABLE_TOKEN);
  const hasBaseId = Boolean(process.env.AIRTABLE_BASE_ID);
  const hasJwt    = Boolean(process.env.JWT_SECRET);

  let airtableReachable = null;
  let airtableError     = null;
  if (hasToken && hasBaseId) {
    try {
      await new Promise((resolve, reject) => {
        base('Users').select({ maxRecords: 1, fields: ['Username'] }).firstPage((err) => {
          if (err) reject(err); else resolve();
        });
      });
      airtableReachable = true;
    } catch (e) {
      airtableReachable = false;
      airtableError = e.message || String(e);
    }
  }

  const ok = hasToken && hasBaseId && hasJwt && airtableReachable !== false;
  res.status(ok ? 200 : 503).json({
    status: ok ? 'ok' : 'misconfigured',
    env: {
      AIRTABLE_TOKEN:   hasToken  ? 'SET' : 'MISSING',
      AIRTABLE_BASE_ID: hasBaseId ? 'SET' : 'MISSING',
      JWT_SECRET:       hasJwt    ? 'SET' : 'MISSING',
      AIRTABLE_USERS_TABLE: process.env.AIRTABLE_USERS_TABLE || '(default: Users)',
    },
    airtable: {
      enabled:   airtableEnabled,
      reachable: airtableReachable,
      error:     airtableError,
    },
  });
});

// ── User plan endpoint ───────────────────────────────────────────────────────
app.get('/api/user/plan', authenticateToken, async (req, res) => {
  try {
    const username = req.user?.username;
    if (!username) return res.json({ plan: 'free', status: 'none' });

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

app.post('/api/stripe/create-checkout-session', async (req, res) => {
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
    const user = await getUserByUsername(username);
    const credits = user ? (Number(user.fields.ReferralCredits) || 0) : 0;
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
    if (user?.fields?.StripeCustomerId) sessionParams.customer = user.fields.StripeCustomerId;

    const session = await stripe.checkout.sessions.create(sessionParams);
    return res.json({ url: session.url });
  } catch (err) {
    console.error('[Stripe checkout]', err.message);
    return res.status(500).json({ error: 'Could not create checkout session' });
  }
});

app.get('/api/stripe/portal', async (req, res) => {
  if (!stripeEnabled) return res.status(503).json({ error: 'Stripe not configured' });
  const username = req.query.username;
  if (!username) return res.status(400).json({ error: 'username required' });

  try {
    const user = await getUserByUsername(username);
    const customerId = user?.fields?.StripeCustomerId;
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
  if (!code || !airtableEnabled) return res.json({ valid: false });
  try {
    const safe = escapeAirtableFormulaValue(code);
    const records = await base(USERS_TABLE).select({ filterByFormula: `{ReferralCode}='${safe}'`, maxRecords: 1 }).firstPage();
    if (!records.length) return res.json({ valid: false });
    return res.json({ valid: true, referrerName: (records[0].fields.Username || '').slice(0, 8) });
  } catch { return res.json({ valid: false }); }
});

app.get('/api/referral/stats', async (req, res) => {
  const username = req.query.username;
  if (!username || !airtableEnabled) return res.json({ referralCode: '', referralCredits: 0, referralCount: 0 });
  try {
    const user = await getUserByUsername(username);
    if (!user) return res.json({ referralCode: '', referralCredits: 0, referralCount: 0 });
    const code = user.fields.ReferralCode || '';
    const credits = Number(user.fields.ReferralCredits) || 0;
    let count = 0;
    if (code) {
      const safe = escapeAirtableFormulaValue(code);
      const referred = await base(USERS_TABLE).select({ filterByFormula: `{ReferredBy}='${safe}'` }).firstPage();
      count = referred.length;
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

// Generate unique referral code
function generateReferralCode(username) {
  const base36 = username.replace(/[^a-zA-Z0-9]/g, '').toUpperCase().slice(0, 5);
  const rand = Math.random().toString(36).substring(2, 6).toUpperCase();
  return `${base36}-${rand}`;
}

// Register
app.post('/register', loginLimiter, async (req, res) => {
  const { username, password } = req.body || {};

  if (!username || !password) {
    return sendError(res, 400, 'auth.missing_credentials', 'Username and password are required.');
  }
  if (String(username).length < 2 || String(username).length > 64) {
    return sendError(res, 400, 'auth.invalid_username', 'Username must be between 2 and 64 characters.');
  }
  if (String(password).length < 6 || String(password).length > 128) {
    return sendError(res, 400, 'auth.weak_password', 'Password must be between 6 and 128 characters.');
  }
  if (!airtableEnabled) {
    return sendError(res, 503, 'auth.not_configured', 'User storage is not configured.');
  }

  try {
    const existing = await findUserByUsername(username);
    if (existing) {
      return sendError(res, 409, 'auth.username_taken', 'That username is already taken.');
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const referralCode = generateReferralCode(username);
    const referredBy = req.body.referredBy || '';
    const [record] = await base(USERS_TABLE).create([{
      fields: {
        Username: String(username),
        PasswordHash: passwordHash,
        CreatedAt: new Date().toISOString(),
        UserPlan: 'free',
        ReferralCode: referralCode,
        ReferredBy: referredBy || '',
        ReferralCredits: 0,
        ProgramGenCount: 0,
      }
    }]);

    const token = jwt.sign({ id: record.id, username: String(username) }, JWT_SECRET, { expiresIn: '7d' });
    return sendSuccess(res, 201, { token, username: String(username) });
  } catch (e) {
    console.error('[REGISTER] Failed:', e);
    return sendError(res, 500, 'auth.register_failed', 'Failed to create account.');
  }
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

    const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });
    console.info(`[LOGIN] Success for username: "${username}"`);
    return sendSuccess(res, 200, { token, username: user.username });
  } catch (e) {
    console.error('[LOGIN] Failed:', e);
    return sendError(res, 500, 'auth.token_failure', 'Failed to sign in.');
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
    const { username, date, title, workout } = req.body || {};
    if (!username || !date || !workout) {
      return sendError(res, 422, 'workouts.invalid_payload', 'username, date, and workout are required.');
    }
    if (!airtableEnabled) {
      return sendError(res, 503, 'workouts.airtable_disabled', 'Airtable is not configured.',
        'Set AIRTABLE_BASE_ID and AIRTABLE_API_TOKEN in environment variables.');
    }

    const sessionVolume = computeSessionVolume(workout);
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
    const username = typeof req.query.username === 'string' ? req.query.username.trim() : '';
    if (!username) return sendError(res, 422, 'workouts.missing_username', 'username query param is required.');
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
    const username = typeof req.query.username === 'string' ? req.query.username.trim() : '';
    if (!username) return sendError(res, 422, 'macrotargets.missing_username', 'username query param is required.');
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

// POST /macrotargets — save macro targets for a user
app.post('/macrotargets', authenticateToken, async (req, res) => {
  try {
    if (!airtableEnabled) {
      return sendError(res, 503, 'macrotargets.airtable_disabled', 'Airtable is not configured.');
    }
    const { username, calories, protein, fat, carbs } = req.body || {};
    if (!username) {
      return sendError(res, 422, 'macrotargets.missing_username', 'username is required.');
    }

    const url = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(MACRO_TARGETS_TABLE)}`;
    const response = await airtableFetch(url, {
      method: 'POST',
      headers: airtableHeaders(),
      body: JSON.stringify({
        records: [{
          fields: {
            [USERNAME_FIELD]: String(username),
            Calories: calories != null ? Number(calories) : null,
            Protein:  protein  != null ? Number(protein)  : null,
            Fat:      fat      != null ? Number(fat)      : null,
            Carbs:    carbs    != null ? Number(carbs)    : null
          }
        }]
      })
    });
    const data = await response.json();
    if (!response.ok) {
      return sendError(res, 422, 'macrotargets.airtable_rejected', 'Airtable rejected the request.',
        data?.error?.message || JSON.stringify(data));
    }
    return sendSuccess(res, 201, { recordId: data?.records?.[0]?.id || null });
  } catch (err) {
    return sendError(res, 500, 'macrotargets.server_error', String(err));
  }
});

// POST /dailylogs — save daily macro log
app.post('/dailylogs', authenticateToken, async (req, res) => {
  try {
    if (!airtableEnabled) {
      return sendError(res, 503, 'dailylogs.airtable_disabled', 'Airtable is not configured.');
    }

    // Support both flat body and legacy { fields: { ... } } wrapper from frontend
    const body = req.body?.fields ? req.body.fields : req.body || {};

    const date     = body.Date     || body.date;
    const username = body.Username || body.username;

    if (!date || !username) {
      return sendError(res, 422, 'dailylogs.invalid_payload', 'date and username are required.');
    }

    // Accept both naming conventions the frontend uses
    const calories     = body.CaloriesTotal ?? body.Calories     ?? body.calories     ?? null;
    const proteinGrams = body.ProteinTotal  ?? body.ProteinGrams ?? body.protein       ?? null;
    const carbGrams    = body.CarbsTotal    ?? body.CarbGrams    ?? body.carbs         ?? null;
    const fatGrams     = body.FatTotal      ?? body.FatGrams     ?? body.fat           ?? null;

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
    if (!airtableEnabled) return res.json({ records: [] });
    const username = typeof req.query.username === 'string' ? req.query.username.trim() : '';
    if (!username) return sendError(res, 422, 'dailylogs.missing_username', 'username query param is required.');

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
  const { username, templateName, templateData } = req.body || {};
  if (!username || !templateName || !templateData) {
    return sendError(res, 400, 'templates.invalid_payload', 'username, templateName, and templateData are required.');
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
  const owner = (typeof req.query.username === 'string' ? req.query.username.trim() : '') ||
                (typeof req.query.userId   === 'string' ? req.query.userId.trim()   : '');

  if (!owner) {
    return sendError(res, 422, 'templates.missing_owner', 'username or userId query param is required.');
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
    if (!airtableEnabled) return sendError(res, 503, 'bodyweight.airtable_disabled', 'Airtable is not configured.');

    const { username, periodStart, periodEnd, entries, trend } = req.body || {};
    if (!username || !Array.isArray(entries) || !entries.length) {
      return sendError(res, 422, 'bodyweight.invalid_payload', 'username and entries array are required.');
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
    if (!airtableEnabled) return res.json({ success: true, items: [] });
    const username = typeof req.query.username === 'string' ? req.query.username.trim() : '';
    if (!username) return sendError(res, 422, 'bodyweight.missing_username', 'username is required.');

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
    if (!airtableEnabled) return sendError(res, 503, 'measurements.airtable_disabled', 'Airtable is not configured.');

    const { username, entries } = req.body || {};
    if (!username || !Array.isArray(entries) || !entries.length) {
      return sendError(res, 422, 'measurements.invalid_payload', 'username and entries array are required.');
    }

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
    if (!airtableEnabled) return res.json({ success: true, items: [] });
    const username = typeof req.query.username === 'string' ? req.query.username.trim() : '';
    if (!username) return sendError(res, 422, 'measurements.missing_username', 'username is required.');

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
    if (!airtableEnabled) return sendError(res, 503, 'cardio.airtable_disabled', 'Airtable is not configured.');

    const { username, entries } = req.body || {};
    if (!username || !Array.isArray(entries) || !entries.length) {
      return sendError(res, 422, 'cardio.invalid_payload', 'username and entries array are required.');
    }

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
    if (!airtableEnabled) return res.json({ success: true, items: [] });
    const username = typeof req.query.username === 'string' ? req.query.username.trim() : '';
    if (!username) return sendError(res, 422, 'cardio.missing_username', 'username is required.');

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
    if (!airtableEnabled) return sendError(res, 503, 'crossfit.airtable_disabled', 'Airtable is not configured.');

    const { username, entries } = req.body || {};
    if (!username || !Array.isArray(entries) || !entries.length) {
      return sendError(res, 422, 'crossfit.invalid_payload', 'username and entries array are required.');
    }

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
    if (!airtableEnabled) return res.json({ success: true, items: [] });
    const username = typeof req.query.username === 'string' ? req.query.username.trim() : '';
    if (!username) return sendError(res, 422, 'crossfit.missing_username', 'username is required.');

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

// ── Programs ──────────────────────────────────────────────────────────────────
const PROGRAMS_TABLE = process.env.AIRTABLE_PROGRAMS_TABLE || 'Programs';

// POST /programs — save a new program
// POST /saveProgram — legacy alias used by ProgramTab.js
async function saveProgramHandler(req, res) {
  try {
    if (!airtableEnabled) return sendError(res, 503, 'programs.airtable_disabled', 'Airtable is not configured.');

    // Accept both { program } and { draft } shapes from the frontend
    const body = req.body || {};
    const program = body.program || body.draft || body;
    const username = program.userId || program.username || body.userId || body.username;

    if (!username) return sendError(res, 422, 'programs.missing_username', 'username / userId is required.');
    if (!program.name) return sendError(res, 422, 'programs.missing_name', 'Program name is required.');

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
    if (!airtableEnabled) return res.json({ success: true, items: [] });

    const username = typeof req.query.username === 'string' ? req.query.username.trim() : '';
    if (!username) return sendError(res, 422, 'programs.missing_username', 'username query param is required.');

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
  const username = typeof req.query.username === 'string' ? req.query.username.trim()
    : (req.body?.username || '');
  if (!id) return sendError(res, 400, 'programs.missing_id', 'Record ID is required.');
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
  if (!airtableEnabled) return sendError(res, 503, 'programs.airtable_disabled', 'Airtable is not configured.');

  try {
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
  if (!airtableEnabled) return sendError(res, 503, 'templates.airtable_disabled', 'Airtable is not configured.');

  try {
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

// POST /days/upsert + POST /days
async function upsertDayHandler(req, res) {
  const incoming = req.body || {};

  if (!airtableEnabled) {
    return sendSuccess(res, 200, { day: incoming });
  }

  try {
    if (!incoming.date) return sendError(res, 400, 'days.validation', 'date required (YYYY-MM-DD)');

    const recId = await findDayRecordId(incoming.date);
    if (recId) {
      const existingRec = await base(DAYS_TABLE).find(recId);
      const existingDay = fromRecordToDay(existingRec);
      const merged = {
        date:       incoming.date,
        workout:    incoming.workout    ?? existingDay.workout,
        bodyweight: incoming.bodyweight ?? existingDay.bodyweight,
        cardio:     incoming.cardio     ?? existingDay.cardio,
        macros:     incoming.macros     ?? existingDay.macros
      };
      const updated = await base(DAYS_TABLE).update([{ id: recId, fields: toFieldsFromDay(merged) }]);
      return res.json(fromRecordToDay(updated[0]));
    }

    const created = await base(DAYS_TABLE).create([{ fields: toFieldsFromDay(incoming) }]);
    return res.status(201).json(fromRecordToDay(created[0]));
  } catch (e) {
    console.error('POST /days/upsert failed:', e);
    return sendError(res, 500, 'days.upsert_failed', 'Failed to upsert day.', e?.message);
  }
}

app.post('/days/upsert', authenticateToken, upsertDayHandler);
app.post('/days',        authenticateToken, upsertDayHandler);

// GET /days
app.get('/days', authenticateToken, async (req, res) => {
  if (!airtableEnabled) return res.json({ items: [] });

  try {
    const from  = typeof req.query.from  === 'string' ? req.query.from.trim()  : '';
    const to    = typeof req.query.to    === 'string' ? req.query.to.trim()    : '';
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 100);

    const filter = [];
    if (from) filter.push(`{Date} >= '${escapeAirtableFormulaValue(from)}'`);
    if (to)   filter.push(`{Date} <= '${escapeAirtableFormulaValue(to)}'`);

    const records = await base(DAYS_TABLE).select({
      ...(filter.length ? { filterByFormula: filter.join(' AND ') } : {}),
      sort: [{ field: 'Date', direction: 'desc' }],
      pageSize: limit
    }).all();

    return res.json({ items: records.map(fromRecordToDay) });
  } catch (e) {
    console.error('GET /days failed:', e);
    return sendError(res, 500, 'days.fetch_failed', 'Failed to load days.', e?.message);
  }
});

// ── Coach Dashboard ───────────────────────────────────────────────────────────
const COACH_CLIENTS_TABLE      = process.env.AIRTABLE_COACH_CLIENTS_TABLE || 'CoachClients';
const DAILY_MISSION_TABLE      = process.env.AIRTABLE_DAILY_MISSION_TABLE || 'DailyMissionState';

// GET /api/coach/clients?coachId= — return all clients linked to a coach
app.get('/api/coach/clients', authenticateToken, async (req, res) => {
  try {
    const coachId = typeof req.query.coachId === 'string' ? req.query.coachId.trim() : '';
    if (!coachId) return sendError(res, 422, 'coach.missing_coach_id', 'coachId query param is required.');
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

// PUT /api/bodybuilding/daily-mission/:userId — persist daily mission state
app.put('/api/bodybuilding/daily-mission/:userId', authenticateToken, async (req, res) => {
  try {
    const userId = req.params.userId;
    if (!userId) return sendError(res, 422, 'mission.missing_user_id', 'userId is required.');
    if (!airtableEnabled) return sendSuccess(res, 200, { saved: false, reason: 'airtable_disabled' });

    const state = req.body || {};
    const today = new Date().toISOString().slice(0, 10);
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
    if (!airtableEnabled) return res.json({ success: true, items: [] });
    const username = typeof req.query.username === 'string' ? req.query.username.trim() : '';
    if (!username) return sendError(res, 422, 'mobility.missing_username', 'username is required.');

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
    if (!airtableEnabled) return sendError(res, 503, 'mobility.airtable_disabled', 'Airtable is not configured.');
    const { username, routineId, name, type, targetArea, frequencyPerWeek, exercises, assignedByCoach, coachNotes } = req.body || {};
    if (!username || !name) return sendError(res, 422, 'mobility.invalid_payload', 'username and name are required.');

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
    if (!airtableEnabled) return res.json({ success: true, items: [] });
    const username = typeof req.query.username === 'string' ? req.query.username.trim() : '';
    if (!username) return sendError(res, 422, 'mobility.missing_username', 'username is required.');

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
    if (!airtableEnabled) return sendError(res, 503, 'mobility.airtable_disabled', 'Airtable is not configured.');
    const { username, sessionId, routineId, completedAt, notes } = req.body || {};
    if (!username || !routineId) return sendError(res, 422, 'mobility.invalid_payload', 'username and routineId are required.');

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

app.post('/admin/ingest-pdf', upload.single('pdf'), async (req, res) => {
  try {
    const { moduleName, topic } = req.body;
    if (!req.file) return res.status(400).json({ error: 'No PDF file received' });
    if (!moduleName) return res.status(400).json({ error: 'moduleName is required' });
    if (!topic) return res.status(400).json({ error: 'topic is required' });
    if (!AIRTABLE_API_TOKEN || !AIRTABLE_BASE_ID) return res.status(500).json({ error: 'Airtable not configured' });

    const pdfParse = require('pdf-parse');
    const pdfData = await pdfParse(req.file.buffer);
    const text = pdfData.text;
    if (!text || text.trim().length < 100) return res.status(422).json({ error: 'PDF appears empty or unreadable' });

    const extracted = await extractKnowledgeWithClaude(text, moduleName, topic);
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

app.get('/admin/knowledge-modules', async (req, res) => {
  try {
    if (!AIRTABLE_API_TOKEN || !AIRTABLE_BASE_ID) return res.status(500).json({ error: 'Airtable not configured' });
    const modules = await getActiveModules(AIRTABLE_API_TOKEN, AIRTABLE_BASE_ID);
    res.json({ modules });
  } catch (err) {
    console.error('[KnowledgeBase] Fetch error:', err);
    res.status(500).json({ error: 'Failed to fetch modules' });
  }
});

app.get('/knowledge-context', async (req, res) => {
  try {
    if (!AIRTABLE_API_TOKEN || !AIRTABLE_BASE_ID) return res.status(500).json({ error: 'Airtable not configured' });
    const topicsParam = req.query.topics;
    const topics = topicsParam ? topicsParam.split(',').map(t => t.trim()) : null;

    let allModules = [];
    if (topics && topics.length > 0) {
      const fetches = topics.map(t => getActiveModules(AIRTABLE_API_TOKEN, AIRTABLE_BASE_ID, t));
      const results = await Promise.all(fetches);
      allModules = results.flat();
    } else {
      allModules = await getActiveModules(AIRTABLE_API_TOKEN, AIRTABLE_BASE_ID);
    }

    const context = allModules.reduce((acc, mod) => { acc[mod.moduleName] = mod.extractedJSON; return acc; }, {});
    res.json({ context, modulesLoaded: allModules.map(m => m.moduleName) });
  } catch (err) {
    console.error('[KnowledgeBase] Context error:', err);
    res.status(500).json({ error: 'Failed to build knowledge context' });
  }
});

// Keep Render free tier awake — pings itself every 14 min
setInterval(() => {
  const url = process.env.RENDER_EXTERNAL_URL || 'https://traininglog-backend.onrender.com';
  fetch(`${url}/health`).catch(() => {});
}, 14 * 60 * 1000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`API listening on :${PORT}`);
  console.log('CORS allowlist:', allowed.length ? allowed : '[none → allow all]');
});
