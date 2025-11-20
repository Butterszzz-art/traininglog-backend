const express = require('express');
const cors = require('cors');
const Airtable = require('airtable');

const app = express();

const airtableToken = process.env.AIRTABLE_TOKEN || process.env.AIRTABLE_API_KEY || null;
const savedWorkouts = [];

// Allow your GitHub Pages origin (comma-separate for more)
const defaultOrigins = 'https://butterszzz-art.github.io'; // add your frontend
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

app.post('/saveWorkout', (req, res) => {
  const { username, workout } = req.body || {};

  if (!username || !workout) {
    return res.status(400).json({ success: false, message: 'username and workout are required.' });
  }

  const entry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    username,
    workout,
    savedAt: new Date().toISOString()
  };

  savedWorkouts.push(entry);
  console.log('Workout saved:', entry);

  res.json({ success: true });
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

// Simple auth stub: create /login endpoint for demonstration
app.post('/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ success: false, message: 'Missing credentials.' });
  }
  // TODO: replace with real authentication logic
  if (password === 'demo') {
    return res.json({ success: true, username });
  }
  return res.status(401).json({ success: false, message: 'Invalid credentials.' });
});

// Keep a fake user on every request
app.use((req, _res, next) => {
  req.user = { id: 'demo-user' };
  next();
});

// Create workout (called when the Resistance Log reaches its limit)
app.post('/workouts', async (req, res) => {
  if (!airtableEnabled) {
    return res.json({ message: 'Workout saved!', data: req.body });
  }

  try {
    const workout = req.body || {};
    const fields = mapWorkoutToFields(workout);

    const created = await base(TABLE_NAME).create([{ fields }]);
    const item = mapRecordToWorkout(created[0]);
    res.status(201).json(item);
  } catch (e) {
    console.error('POST /workouts failed:', e);
    res.status(500).json({ error: 'Failed to create workout' });
  }
});

// List workouts (for Log History tab)
app.get('/workouts', async (_req, res) => {
  if (!airtableEnabled) {
    return res.json([]);
  }

  try {
    const records = await base(TABLE_NAME)
      .select({
        sort: [{ field: 'CreatedAt', direction: 'desc' }],
        pageSize: 50
      })
      .all();

    const items = records.map(mapRecordToWorkout);
    res.json(items);
  } catch (e) {
    console.error('GET /workouts failed:', e);
    res.status(500).json({ error: 'Failed to load workouts' });
  }
});

// Health check (Render)
app.get('/healthz', (_req, res) => res.send('ok'));

// GET /templates?username=29796
app.get('/templates', async (req, res) => {
  const username = (req.query.username || '').trim();
  if (!username) return res.status(400).json({ error: 'username required' });


  if (!airtableEnabled) {
    console.error('GET /templates unavailable: Airtable not configured', { username });
    return res.status(503).json({ error: 'Airtable is not configured' });
  }


  try {
    const records = await base('Templates')
      .select({
        filterByFormula: `({Username}='${username}')`,
        pageSize: 100,
        sort: [{ field: 'Name', direction: 'asc' }]
      })
      .all();

    const items = records.map(r => ({
      id: r.id,
      name: r.get('Name') || '',
      username: r.get('Username') || ''
    }));


    if (items.length === 0) {
      return res.status(404).json({ error: 'No templates found for user', username });
    }

    res.json({ items });

  } catch (e) {
    const statusCode = e?.statusCode;
    const airtableMessage = e?.message || 'Unknown Airtable error';
    console.error('GET /templates failed:', { username, airtableMessage, statusCode, error: e });

    let status = 500;
    let errorMessage = 'Failed to load templates';
    if (statusCode >= 400 && statusCode < 500) {
      status = statusCode;
      errorMessage = 'Airtable rejected the templates request';
    } else if (statusCode >= 500) {
      status = 502;
      errorMessage = 'Upstream Airtable service failed';
    }

    res.status(status).json({ error: errorMessage, detail: airtableMessage });
  }
});

async function upsertDayHandler(req, res) {
  const incoming = req.body || {};

  if (!airtableEnabled) {
    return res.status(200).json({ success: true, day: incoming });
  }

  try {
    if (!incoming.date) return res.status(400).json({ error: 'date required (YYYY-MM-DD)' });

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
    res.status(500).json({ error: 'Failed to upsert day' });
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
    res.status(500).json({ error: 'Failed to load days' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`API listening on :${PORT}`);
  console.log('CORS allowlist:', allowed.length ? allowed : '[none → allow all]');
});
