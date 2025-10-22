const express = require('express');
const cors = require('cors');
const Airtable = require('airtable');

const app = express();
app.use(express.json());

// Allow your GitHub Pages origin (comma-separate for more)
const allowed = (process.env.CORS_ORIGINS ?? '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

app.use(cors({
  origin(origin, cb) {
    if (!origin) return cb(null, true);          // same-origin / curl
    if (allowed.length === 0) return cb(null, true); // dev: allow all if not configured
    return cb(null, allowed.includes(origin));
  },
  credentials: true
}));

// Minimal runtime config for the frontend (no secrets!)
app.get('/config', (_req, res) => {
  res.set('Cache-Control', 'public, max-age=300'); // 5 min cache
  res.json({
    serverUrl: process.env.PUBLIC_SERVER_URL || 'https://traininglog-backend.onrender.com',
    airtable: {
      baseId: process.env.AIRTABLE_BASE_ID || null, // not secret
      table: process.env.AIRTABLE_TABLE || 'Workouts',
      tokenProvided: Boolean(process.env.AIRTABLE_API_KEY) // never return the token itself
    }
  });
});

// --- Airtable setup ---
if (!process.env.AIRTABLE_API_KEY || !process.env.AIRTABLE_BASE_ID) {
  console.warn('[WARN] Missing AIRTABLE_API_KEY or AIRTABLE_BASE_ID env vars.');
}
const airtableEnabled = Boolean(process.env.AIRTABLE_API_KEY && process.env.AIRTABLE_BASE_ID);
const base = airtableEnabled
  ? new Airtable({ apiKey: process.env.AIRTABLE_API_KEY }).base(process.env.AIRTABLE_BASE_ID)
  : null;

const TABLE_NAME = process.env.AIRTABLE_TABLE || 'Workouts';

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

// Fake auth stub (replace with real auth later)
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
  try {
    const username = req.query.username || '';
    if (!username) return res.status(400).json({ error: 'username required' });

    if (!airtableEnabled) {
      return res.json({ items: [] });
    }

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

    res.json({ items });
  } catch (e) {
    console.error('GET /templates failed:', e);
    res.status(500).json({ error: 'Failed to load templates' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`API listening on :${PORT}`);
  console.log('CORS allowlist:', allowed.length ? allowed : '[none → allow all]');
});
