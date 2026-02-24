const express = require('express');
const cors = require('cors');
const Airtable = require('airtable');
const fetch = require('node-fetch');
const jwt = require('jsonwebtoken');

const app = express();

// Check that required Airtable environment variables are present
if (!process.env.AIRTABLE_TOKEN || !process.env.AIRTABLE_BASE_ID) {
  console.warn(
    'Warning: AIRTABLE_TOKEN or AIRTABLE_BASE_ID is not set in environment variables. ' +
      'Ensure these are defined in your Render environment.'
  );
}

const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
const AIRTABLE_API_TOKEN = process.env.AIRTABLE_API_TOKEN || process.env.AIRTABLE_TOKEN || process.env.AIRTABLE_API_KEY || null;
const airtableToken = AIRTABLE_API_TOKEN;
const savedWorkouts = [];
const users = [{ id: 29796, username: '29796', password: 'Butters' }];
const JWT_SECRET = process.env.JWT_SECRET || 'dev-jwt-secret-change-me';

function sendError(res, status, code, message, detail) {
  const payload = {
    success: false,
    error: {
      code,
      message
    }
  };

  if (detail) payload.error.detail = detail;
  return res.status(status).json(payload);
}

function sendSuccess(res, status, data = {}) {
  return res.status(status).json({ success: true, ...data });
}

function escapeAirtableFormulaValue(value) {
  return value.replace(/'/g, "''");
}

function airtableHeaders() {
  return {
    Authorization: `Bearer ${AIRTABLE_API_TOKEN}`,
    'Content-Type': 'application/json'
  };
}

if (!process.env.JWT_SECRET) {
  console.warn('[WARN] Using fallback JWT secret. Set JWT_SECRET in production.');
}

function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    console.warn('[AUTH] Missing Authorization header');
    return sendError(res, 401, 'auth.missing_token', 'Authorization token is required. Include a Bearer token.');
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      console.warn('[AUTH] Invalid or expired token', { error: err?.message });
      return sendError(res, 403, 'auth.invalid_token', 'Token invalid or expired. Please re-authenticate.');
    }

    req.user = user;
    next();
  });
}

// Allow your GitHub Pages origin (comma-separate for more)
const defaultOrigins = 'https://butterszzz-art.github.io,http://localhost:5173'; // add your frontend
const allowed = (process.env.CORS_ORIGINS ?? defaultOrigins)
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

const allowAll = allowed.length === 0;
const allowedSet = new Set(allowed);

app.use(cors({
  origin(origin, cb) {
    // Allow curl / same-origin requests with no Origin header
    if (!origin) return cb(null, true);

    if (allowAll) return cb(null, true);

    try {
      const normalizedOrigin = new URL(origin).origin;
      if (allowedSet.has(normalizedOrigin)) return cb(null, true);

      console.warn(`Blocked CORS origin: ${origin}`);
      return cb(null, false);
    } catch (e) {
      console.warn('Failed to parse Origin header', { origin, error: e });
      return cb(null, false);
    }
  },
  credentials: true
}));

app.use(express.json());

// Minimal runtime config for the frontend
app.get('/config', (_req, res) => {
  res.json({
    airtableBaseId: process.env.AIRTABLE_BASE_ID || null,
    airtableToken
  });
});

app.get('/envcheck', (_req, res) => {
  const airtableConfigured =
    Boolean(process.env.AIRTABLE_TOKEN) && Boolean(process.env.AIRTABLE_BASE_ID);
  // Respond with a simple object; do NOT return the actual token
  res.json({ success: true, airtableConfigured });
});

app.post('/saveWorkout', (req, res) => {
  const { username, workout } = req.body || {};

  if (!username || !workout) {
    return sendError(res, 400, 'workout.validation', 'username and workout are required.');
  }

  const entry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    username,
    workout,
    savedAt: new Date().toISOString()
  };

  savedWorkouts.push(entry);
  console.log('Workout saved:', entry);

  sendSuccess(res, 200, { message: 'Workout saved' });
});

// --- Airtable setup ---
if (!airtableToken || !process.env.AIRTABLE_BASE_ID) {
  console.warn('[WARN] Missing AIRTABLE token or AIRTABLE_BASE_ID env vars.');
}
const airtableEnabled = Boolean(airtableToken && process.env.AIRTABLE_BASE_ID);
const base = airtableEnabled
  ? new Airtable({ apiKey: airtableToken }).base(process.env.AIRTABLE_BASE_ID)
  : null;

const TABLE_NAME = process.env.AIRTABLE_TABLE || 'Workouts';
const DAYS_TABLE = process.env.AIRTABLE_DAYS_TABLE || 'Days';

// You can adapt field names here to your base:
function mapWorkoutToFields(w) {
  return {
    Name: w.name || 'Workout',
    CreatedAt: w.createdAt || new Date().toISOString(),
    Notes: w.notes || '',
    Units: w.units || '',
    // Store JSON for sets; or normalize if you have columns
    SetsJson: JSON.stringify(w.sets || [])
  };
}

function mapRecordToWorkout(rec) {
  const f = rec.fields || {};
  let sets = [];
  try { sets = f.SetsJson ? JSON.parse(f.SetsJson) : []; } catch {}
  return {
    id: rec.id,
    createdAt: f.CreatedAt || rec._rawJson?.createdTime,
    name: f.Name || 'Workout',
    notes: f.Notes || '',
    units: f.Units || '',
    sets
  };
}

function toFieldsFromDay(day) {
  const f = { Date: day.date };
  if (day.workout) f.WorkoutJson = JSON.stringify(day.workout);
  if (day.bodyweight) {
    f.BodyweightValue = day.bodyweight.value ?? null;
    f.BodyweightUnit = day.bodyweight.unit ?? null;
  }
  if (day.cardio) f.CardioJson = JSON.stringify(day.cardio);
  if (day.macros) f.MacrosJson = JSON.stringify(day.macros);
  return f;
}

function fromRecordToDay(rec) {
  const f = rec.fields || {};
  const safeParse = (s) => { try { return s ? JSON.parse(s) : undefined; } catch { return undefined; } };
  return {
    id: rec.id,
    date: f.Date,
    workout: safeParse(f.WorkoutJson),
    bodyweight: (f.BodyweightValue || f.BodyweightUnit) ? {
      value: f.BodyweightValue ?? undefined,
      unit: f.BodyweightUnit ?? undefined
    } : undefined,
    cardio: safeParse(f.CardioJson),
    macros: safeParse(f.MacrosJson)
  };
}

async function findDayRecordId(dateKey) {
  const formula = `{Date} = '${dateKey}'`;
  const found = await base(DAYS_TABLE).select({ filterByFormula: formula, maxRecords: 1 }).firstPage();
  return found[0]?.id || null;
}

// Simple auth stub with JWT issuance
app.post('/login', async (req, res) => {
  const { username, password } = req.body || {};

  if (!username || !password) {
    return sendError(res, 400, 'auth.missing_credentials', 'Username and password are required.');
  }

  const user = users.find(u => u.username === username && u.password === password);
  if (!user) {
    return sendError(res, 401, 'auth.invalid_credentials', 'Invalid credentials.');
  }

  try {
    const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '1h' });
    return sendSuccess(res, 200, { token });
  } catch (e) {
    console.error('Failed to sign JWT', e);
    return sendError(res, 500, 'auth.token_failure', 'Failed to create token');
  }
});

// Keep a fake user on every request
app.use((req, _res, next) => {
  if (!req.user) {
    req.user = { id: 'demo-user' };
  }
  next();
});

// Workout History (JSON blob in Airtable)
// Table: WorkoutHistory
// Fields: Username, Date, Title, WorkoutJSON
app.post('/workouts', authenticateToken, async (req, res) => {
  try {
    const { username, date, title, workout } = req.body || {};
    if (!username || !date || !workout) {
      return sendError(
        res,
        422,
        'workouts.invalid_payload',
        'username, date, and workout are required.'
      );
    }

    if (!AIRTABLE_BASE_ID || !AIRTABLE_API_TOKEN) {
      return sendError(
        res,
        503,
        'workouts.airtable_disabled',
        'Airtable is not configured for workout history storage.',
        'Set AIRTABLE_BASE_ID and AIRTABLE_API_TOKEN in environment variables.'
      );
    }

    const payload = {
      records: [
        {
          fields: {
            Username: String(username),
            Date: String(date),
            Title: String(title || 'Workout'),
            WorkoutJSON: JSON.stringify(workout)
          }
        }
      ]
    };

    const url = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/WorkoutHistory`;
    const response = await fetch(url, {
      method: 'POST',
      headers: airtableHeaders(),
      body: JSON.stringify(payload)
    });

    const data = await response.json();
    if (!response.ok) {
      return sendError(
        res,
        422,
        'workouts.airtable_rejected',
        'Airtable rejected the workouts request.',
        data?.error?.message || JSON.stringify(data)
      );
    }

    return sendSuccess(res, 200, { recordId: data?.records?.[0]?.id || null });
  } catch (err) {
    return sendError(res, 500, 'workouts.server_error', String(err));
  }
});

app.get('/workouts', authenticateToken, async (req, res) => {
  try {
    const username = req.query.username;
    if (!username) {
      return sendError(
        res,
        422,
        'workouts.missing_username',
        'username query param is required.'
      );
    }

    if (!AIRTABLE_BASE_ID || !AIRTABLE_API_TOKEN) {
      return sendError(
        res,
        503,
        'workouts.airtable_disabled',
        'Airtable is not configured for workout history retrieval.',
        'Set AIRTABLE_BASE_ID and AIRTABLE_API_TOKEN in environment variables.'
      );
    }

    const safeUsername = escapeAirtableFormulaValue(String(username));
    const filter = encodeURIComponent(`{Username}='${safeUsername}'`);
    const sort = '&sort%5B0%5D%5Bfield%5D=Date&sort%5B0%5D%5Bdirection%5D=desc';
    const url = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/WorkoutHistory?filterByFormula=${filter}${sort}`;

    const response = await fetch(url, { headers: airtableHeaders() });
    const data = await response.json();

    if (!response.ok) {
      return sendError(
        res,
        422,
        'workouts.airtable_rejected',
        'Airtable rejected the workouts request.',
        data?.error?.message || JSON.stringify(data)
      );
    }

    const items = (data.records || []).map(rec => {
      const f = rec.fields || {};
      let parsed = null;
      try {
        parsed = JSON.parse(f.WorkoutJSON || '{}');
      } catch {
        parsed = null;
      }

      return {
        id: rec.id,
        username: f.Username,
        date: f.Date,
        title: f.Title,
        workout: parsed
      };
    });

    return sendSuccess(res, 200, { items });
  } catch (err) {
    return sendError(res, 500, 'workouts.server_error', String(err));
  }
});

// Health check (Render)
app.get('/healthz', (_req, res) => res.send('ok'));

// POST /templates
app.post('/templates', authenticateToken, async (req, res) => {
  const { username, templateName, templateData } = req.body || {};

  if (!username || !templateName || !templateData) {
    return res.status(400).json({ success: false, message: 'Missing required fields' });
  }

  const apiKey = process.env.AIRTABLE_TOKEN || process.env.AIRTABLE_API_KEY;
  const baseId = process.env.AIRTABLE_BASE_ID;
  const tableName = process.env.AIRTABLE_TEMPLATES_TABLE || 'Templates';

  if (!apiKey || !baseId) {
    return res.status(500).json({ success: false, message: 'Airtable not configured' });
  }

  try {
    const url = `https://api.airtable.com/v0/${baseId}/${tableName}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        fields: {
          Username: username,
          TemplateName: templateName,
          TemplateData: JSON.stringify(templateData)
        }
      })
    });

    if (!response.ok) {
      const text = await response.text();
      return res.status(response.status).json({ success: false, message: text });
    }

    const result = await response.json();
    return res.json({ success: true, record: result });
  } catch (err) {
    console.error('POST /templates failed:', err);
    return res.status(500).json({ success: false, message: 'Server error saving template' });
  }
});

// GET /templates?username=29796 or /templates?userId=29796
app.get('/templates', authenticateToken, async (req, res) => {
  const usernameParam = typeof req.query.username === 'string' ? req.query.username.trim() : '';
  const userIdParam = typeof req.query.userId === 'string' ? req.query.userId.trim() : '';
  const owner = usernameParam || userIdParam || '';

  if (!owner) {
    console.warn('GET /templates missing username/userId', { query: req.query });
    return res.status(422).json({
      success: false,
      error: {
        code: 'templates.missing_owner',
        message: 'Missing username or userId'
      }
    });
  }

  if (!airtableEnabled) {
    console.error('GET /templates unavailable: Airtable not configured', { owner });
    return sendError(
      res,
      503,
      'templates.airtable_disabled',
      'Airtable is not configured for template retrieval.',
      'Set AIRTABLE_TOKEN (or AIRTABLE_API_KEY) and AIRTABLE_BASE_ID environment variables.'
    );
  }

  try {
    const safeOwner = escapeAirtableFormulaValue(owner);
    const records = await base('Templates')
      .select({
        filterByFormula: `({Username}='${safeOwner}')`,
        pageSize: 100,
        sort: [{ field: 'TemplateName', direction: 'asc' }]
      })
      .all();

    const items = records.map(r => ({
      id: r.id,
      name: r.get('TemplateName') || r.get('Name') || 'Untitled Template',
      username: r.get('Username') || '',
      data: r.get('TemplateData') // include the template data
    }));

    if (items.length === 0) {
      console.info('GET /templates returned no rows', { owner });
    }

    sendSuccess(res, 200, { items, owner });
  } catch (e) {
    const statusCode = e?.statusCode;
    const airtableMessage = e?.message || 'Unknown Airtable error';
    console.error('GET /templates failed:', { owner, airtableMessage, statusCode, error: e });

    let status = 500;
    let errorMessage = 'Failed to load templates';
    let code = 'templates.fetch_failed';

    if (statusCode >= 400 && statusCode < 500) {
      status = statusCode === 403 ? 401 : statusCode; // present as unauthorized when Airtable rejects creds
      code = statusCode === 403 ? 'templates.airtable_forbidden' : 'templates.airtable_rejected';
      errorMessage = statusCode === 403
        ? 'Airtable credentials were rejected. Confirm AIRTABLE_TOKEN/API_KEY and AIRTABLE_BASE_ID.'
        : 'Airtable rejected the templates request.';
    } else if (statusCode >= 500) {
      status = 502;
      code = 'templates.airtable_unavailable';
      errorMessage = 'Upstream Airtable service failed.';
    }

    sendError(res, status, code, errorMessage, airtableMessage);
  }
});

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
        date: incoming.date,
        workout: incoming.workout ?? existingDay.workout,
        bodyweight: incoming.bodyweight ?? existingDay.bodyweight,
        cardio: incoming.cardio ?? existingDay.cardio,
        macros: incoming.macros ?? existingDay.macros
      };

      const updated = await base(DAYS_TABLE).update([
        { id: recId, fields: toFieldsFromDay(merged) }
      ]);
      return res.json(fromRecordToDay(updated[0]));
    }

    const created = await base(DAYS_TABLE).create([{ fields: toFieldsFromDay(incoming) }]);
    return res.status(201).json(fromRecordToDay(created[0]));
  } catch (e) {
    console.error('POST /days/upsert failed:', e);
    sendError(res, 500, 'days.upsert_failed', 'Failed to upsert day', e?.message);
  }
}

app.post('/days/upsert', upsertDayHandler);
app.post('/days', upsertDayHandler);

app.get('/days', async (req, res) => {
  if (!airtableEnabled) {
    return res.json({ items: [] });
  }

  try {
    const { from, to, limit } = req.query;
    const filter = [];
    if (from) filter.push(`{Date} >= '${from}'`);
    if (to) filter.push(`{Date} <= '${to}'`);
    const filterByFormula = filter.length ? filter.join(' AND ') : undefined;

    const records = await base(DAYS_TABLE).select({
      ...(filterByFormula ? { filterByFormula } : {}),
      sort: [{ field: 'Date', direction: 'desc' }],
      pageSize: Math.min(Number(limit || 50), 100)
    }).all();

    res.json({ items: records.map(fromRecordToDay) });
  } catch (e) {
    console.error('GET /days failed:', e);
    sendError(res, 500, 'days.fetch_failed', 'Failed to load days', e?.message);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`API listening on :${PORT}`);
  console.log('CORS allowlist:', allowed.length ? allowed : '[none → allow all]');
});
