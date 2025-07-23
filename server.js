// server.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const Airtable = require('airtable');

const app = express();

// parse JSON bodies
app.use(express.json());

// Example CORS setup allowing origins specified in the CORS_ORIGINS env var
// const allowedOrigins = (process.env.CORS_ORIGINS || '').split(',');
// app.use(cors({ origin: allowedOrigins }));
// … the rest of your middleware/routes …

// enable CORS for the frontend application
// allow additional origins via the CORS_ORIGINS env var
const defaultOrigins = ['https://butterszzz-art.github.io'];
const envOrigins = process.env.CORS_ORIGINS?.split(',').map(o => o.trim()).filter(Boolean) || [];
const allowedOrigins = [...new Set([...defaultOrigins, ...envOrigins])];

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      console.warn('Blocked CORS origin:', origin);
      callback(new Error('Not allowed by CORS'));
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    credentials: true
  })
);

const PORT = process.env.PORT || 3000;
const airtableToken = process.env.AIRTABLE_TOKEN?.trim();
// Guard against undefined AIRTABLE_BASE_ID to avoid runtime errors
const airtableBaseId = process.env.AIRTABLE_BASE_ID?.trim() || '';
if (!airtableToken || !airtableBaseId) {
  console.warn('Missing Airtable environment variables – disabling Airtable routes');
}
let airtableBase;
let base;
if (airtableToken && airtableBaseId) {
  airtableBase = new Airtable({ apiKey: airtableToken }).base(airtableBaseId);
  base = airtableBase;
}
const usersTableName = 'Users';

async function findUser(username) {
  const url = `https://api.airtable.com/v0/${airtableBaseId}/${usersTableName}?filterByFormula={Username}='${username}'`;
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${airtableToken}` }
  });

  if (!response.ok) {
    const errText = await response.text();
    console.error('Airtable API error:', errText);
    throw new Error('Airtable request failed');
  }

  const data = await response.json();
  if (!data.records || data.records.length === 0) return null;
  return data.records[0];
}

async function createUser(username, password) {
  const url = `https://api.airtable.com/v0/${airtableBaseId}/${usersTableName}`;
  await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${airtableToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ fields: { Username: username, Password: password } })
  });
}

const groups = {};
const groupPosts = {};
const sharedPrograms = {};

// Sample data used when Airtable is not configured
const sampleUserProfile = {
  name: 'Sample User',
  bio: 'Demo profile'
};

const sampleWorkouts = [
  {
    date: '2023-01-01',
    exercises: [
      { name: 'Bench Press', sets: [ { reps: 5, weight: 100 }, { reps: 5, weight: 100 } ] },
      { name: 'Squat', sets: [ { reps: 5, weight: 150 } ] }
    ]
  },
  {
    date: '2023-01-03',
    exercises: [
      { name: 'Bench Press', sets: [ { reps: 5, weight: 105 }, { reps: 5, weight: 105 } ] },
      { name: 'Deadlift', sets: [ { reps: 5, weight: 180 } ] }
    ]
  }
];

// Build index for sample workouts to allow efficient filtering
const sampleWorkoutIndex = buildWorkoutIndex(sampleWorkouts);

function buildWorkoutIndex(workouts) {
  const byDate = new Map();
  const byExercise = new Map();
  for (const w of workouts) {
    if (w.date) {
      if (!byDate.has(w.date)) byDate.set(w.date, []);
      byDate.get(w.date).push(w);
    }
    for (const ex of w.exercises || []) {
      const id = ex.name || 'Unknown';
      if (!byExercise.has(id)) byExercise.set(id, []);
      byExercise.get(id).push(w);
    }
  }
  return { byDate, byExercise };
}

function filterIndexedWorkouts(index, start, end) {
  const out = [];
  for (const [date, wos] of index.byDate.entries()) {
    if ((!start || date >= start) && (!end || date <= end)) {
      out.push(...wos);
    }
  }
  return out;
}

function parseTimeframe(tf) {
  if (!tf) return {};
  const now = new Date();
  let start;
  switch (tf) {
    case 'weekly':
      start = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      break;
    case 'monthly':
      start = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      break;
    case 'all-time':
      return {};
    default:
      return null;
  }
  const s = start.toISOString().slice(0, 10);
  const e = now.toISOString().slice(0, 10);
  return { start: s, end: e };
}

const sampleGroup = {
  id: 'sample',
  name: 'Sample Group',
  description: 'Example training group',
  members: ['demoUserA', 'demoUserB']
};

// ────────────────────────────────
// Helper functions for leaderboard

async function fetchRecords(table, formula) {
  const params = new URLSearchParams();
  if (formula) params.append('filterByFormula', formula);
  const url = `https://api.airtable.com/v0/${airtableBaseId}/${table}?${params.toString()}`;
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${airtableToken}` } });
  if (!resp.ok) {
    const text = await resp.text();
    console.error('Airtable error:', text);
    throw new Error('Airtable request failed');
  }
  const data = await resp.json();
  return data.records || [];
}

async function fetchUserWorkouts(username, start, end) {
  if (!airtableToken || !airtableBaseId) return [];
  let formula = `{Username}='${username}'`;
  if (start && end) {
    formula = `AND({Username}='${username}', IS_AFTER({Date}, '${start}'), IS_BEFORE({Date}, '${end}'))`;
  } else if (start) {
    formula = `AND({Username}='${username}', IS_AFTER({Date}, '${start}'))`;
  } else if (end) {
    formula = `AND({Username}='${username}', IS_BEFORE({Date}, '${end}'))`;
  }
  const records = await fetchRecords('Workouts', formula);
  return records.map(r => {
    try { return JSON.parse(r.fields.WorkoutData); } catch { return {}; }
  });
}

async function fetchUserStudy(username, start, end) {
  if (!airtableToken || !airtableBaseId) return [];
  let formula = `{Username}='${username}'`;
  if (start && end) {
    formula = `AND({Username}='${username}', IS_AFTER({Date}, '${start}'), IS_BEFORE({Date}, '${end}'))`;
  }
  const records = await fetchRecords('StudySessions', formula);
  return records.map(r => ({ hours: Number(r.fields.Hours) || 0, date: r.fields.Date }));
}

async function fetchUserActivity(username, start, end) {
  if (!airtableToken || !airtableBaseId) return [];
  let formula = `{Username}='${username}'`;
  if (start && end) {
    formula = `AND({Username}='${username}', IS_AFTER({Date}, '${start}'), IS_BEFORE({Date}, '${end}'))`;
  }
  const records = await fetchRecords('ActivityLogs', formula);
  return records.map(r => ({ steps: Number(r.fields.Steps) || 0, date: r.fields.Date }));
}

function workoutVolume(workout) {
  if (!workout || !Array.isArray(workout.exercises)) return 0;
  let total = 0;
  for (const ex of workout.exercises) {
    const sets = ex.sets || [];
    for (const s of sets) {
      total += (Number(s.reps) || 0) * (Number(s.weight) || 0);
    }
  }
  return total;
}

function buildExerciseSummary(workouts) {
  const summary = {};
  for (const w of workouts) {
    for (const ex of w.exercises || []) {
      const name = ex.name || 'Unknown';
      if (!summary[name]) summary[name] = { sets: 0, reps: 0, volume: 0 };
      for (const s of ex.sets || []) {
        const reps = Number(s.reps) || 0;
        const weight = Number(s.weight) || 0;
        summary[name].sets += 1;
        summary[name].reps += reps;
        summary[name].volume += reps * weight;
      }
    }
  }
  return summary;
}

function sampleWeeklyVolume(workouts) {
  const map = {};
  for (const w of workouts) {
    if (!w.date) continue;
    const wk = weekStart(w.date);
    map[wk] = (map[wk] || 0) + workoutVolume(w);
  }
  return Object.entries(map)
    .sort(([a], [b]) => new Date(a) - new Date(b))
    .map(([week, volume]) => ({ week, volume }));
}

function weekStart(date) {
  const d = new Date(date);
  const day = d.getUTCDay();
  const diff = d.getUTCDate() - day + (day === 0 ? -6 : 1);
  d.setUTCDate(diff);
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString().slice(0, 10);
}

async function getUserStats(username, start, end) {
  const workouts = await fetchUserWorkouts(username, start, end);
  const study = await fetchUserStudy(username, start, end);
  const activity = await fetchUserActivity(username, start, end);

  let volume = 0;
  let sets = 0;
  let reps = 0;
  for (const w of workouts) {
    volume += workoutVolume(w);
    for (const ex of w.exercises || []) {
      sets += (ex.sets || []).length;
      for (const s of ex.sets || []) {
        reps += Number(s.reps) || 0;
      }
    }
  }

  const hours = study.reduce((sum, s) => sum + s.hours, 0);
  const steps = activity.reduce((sum, a) => sum + a.steps, 0);

  return {
    username,
    workouts: workouts.length,
    studyHours: hours,
    activity: steps,
    volume,
    sets,
    reps
  };
}

async function getWeeklyVolume(username, start, end) {
  const workouts = await fetchUserWorkouts(username, start, end);
  const map = {};
  for (const w of workouts) {
    if (!w.date) continue;
    const wk = weekStart(w.date);
    map[wk] = (map[wk] || 0) + workoutVolume(w);
  }
  return Object.entries(map)
    .sort(([a], [b]) => new Date(a) - new Date(b))
    .map(([week, volume]) => ({ week, volume }));
}


function authenticate(req, res, next) {
  if (!req.headers.authorization) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ⚙️ Log critical startup config
console.log('PORT=', PORT);
console.log('AIRTABLE_TOKEN set?', !!airtableToken);
console.log('AIRTABLE_BASE_ID=', airtableBaseId);
console.log('CORS allowed origins:', allowedOrigins);

// ---- Routes ----
app.get('/config', (req, res) => {
  res.json({ airtableToken, airtableBaseId });
});

app.post('/signup', async (req, res, next) => {
  if (!airtableToken || !airtableBaseId) {
    return res.status(503).json({ error: 'Airtable unavailable' });
  }
  try {
    const { username, password } = req.body;
    console.log('Signup attempt:', username);
    const exists = await findUser(username);
    if (exists) return res.status(400).json({ success: false, message: 'User exists' });
    await createUser(username, password);
    console.log('Signup success:', username);
    res.json({ success: true });
  } catch(err) {
    next(err);
  }
});

app.post('/login', async (req, res, next) => {
  if (!airtableToken || !airtableBaseId) {
    return res.status(503).json({ error: 'Airtable unavailable' });
  }
  try {
    const { username, password } = req.body;
    console.log('Login attempt:', username);
    const user = await findUser(username);
    if (!user) return res.status(404).json({ success: false, message: 'Not found' });
    if (user.fields.Password !== password) {
      console.warn('Wrong password for', username);
      return res.status(401).json({ success: false, message: 'Wrong password' });
    }
    console.log('Login success for', username);
    res.json({ success: true });
  } catch(err) {
    next(err);
  }
});

app.post('/saveTemplate', async (req, res) => {
  if (!airtableToken || !airtableBaseId) {
    return res.status(503).json({ error: 'Airtable unavailable' });
  }
  const { username, templateName, templateData } = req.body;
  try {
    await airtableBase('Templates').create({
      fields: {
        Username: username,
        TemplateName: templateName,
        TemplateData: JSON.stringify(templateData)
      }
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get('/getTemplates', async (req, res) => {
  if (!airtableToken || !airtableBaseId) {
    return res.status(503).json({ error: 'Airtable unavailable' });
  }
  const username = req.query.username;
  try {
    const records = await airtableBase('Templates').select({
      filterByFormula: `{Username} = '${username}'`
    }).all();

    const templates = records.map(record => ({
      id: record.id,
      templateName: record.fields.TemplateName,
      templateData: JSON.parse(record.fields.TemplateData)
    }));
    res.json({ success: true, templates });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/saveWorkout', async (req, res) => {
  if (!airtableToken || !airtableBaseId) {
    return res.status(503).json({ error: 'Airtable unavailable' });
  }
  const { username, workout } = req.body;
  if (!username || !workout) return res.status(400).json({ error: 'Missing fields' });
  try {
    await base('Workouts').create({
      fields: {
        Username: username,
        WorkoutData: JSON.stringify(workout)
      }
    });
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error saving workout' });
  }
});

app.get('/getWorkouts', async (req, res) => {
  if (!airtableToken || !airtableBaseId) {
    return res.status(503).json({ error: 'Airtable unavailable' });
  }
  const { username } = req.query;
  try {
    const records = await base('Workouts')
      .select({ filterByFormula: `{Username}='${username}'` })
      .all();

    const workouts = records.map(r => JSON.parse(r.fields.WorkoutData));
    res.json({ workouts });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error fetching workouts' });
  }
});

app.post('/saveMacros', async (req, res) => {
  if (!airtableToken || !airtableBaseId) {
    return res.status(503).json({ error: 'Airtable unavailable' });
  }
  const { username, targets } = req.body;
  try {
    await fetch('https://api.airtable.com/v0/appmjr4IgnEH72K1b/MacroTargets', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${airtableToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        fields: {
          Username: username,
          Calories: targets.calories,
          Protein: targets.protein,
          Carbs: targets.carbs,
          Fat: targets.fat
        }
      })
    });
    res.json({ success: true });
  } catch (err) {
    console.error('Failed to save macros:', err);
    res.status(500).json({ success: false });
  }
});

app.get('/getMacros', async (req, res) => {
  if (!airtableToken || !airtableBaseId) {
    return res.status(503).json({ error: 'Airtable unavailable' });
  }
  const username = req.query.username;
  try {
    const response = await fetch(
      `https://api.airtable.com/v0/appmjr4IgnEH72K1b/MacroTargets?filterByFormula={Username}='${username}'`,
      {
        headers: { Authorization: `Bearer ${airtableToken}` }
      }
    );
    const data = await response.json();
    if (data.records.length > 0) {
      const latest = data.records[data.records.length - 1].fields;
      res.json({ targets: latest });
    } else {
      res.json({ targets: null });
    }
  } catch (err) {
    console.error('Failed to fetch macros:', err);
    res.status(500).json({ error: true });
  }
});

// ────────────────────────────────
// Leaderboard endpoints

app.get('/leaderboard/stats', async (req, res) => {
  if (!airtableToken || !airtableBaseId) {
    return res.status(503).json({ error: 'Airtable unavailable' });
  }
  const { username, groupId, start, end, timeframe, sortBy } = req.query;
  let range = { start, end };
  if (timeframe) {
    const tf = parseTimeframe(timeframe);
    if (!tf) {
      return res.status(400).json({ error: 'Invalid timeframe' });
    }
    range = tf;
  }
  try {
    if (!username && !groupId) {
      return res.status(400).json({ error: 'username or groupId required' });
    }
    const allowedSort = ['volume', 'sets', 'reps'];
    const sortField = sortBy && allowedSort.includes(sortBy) ? sortBy : 'volume';
    if (sortBy && !allowedSort.includes(sortBy)) {
      return res.status(400).json({ error: 'Invalid sortBy value' });
    }
    if (groupId) {
      const group = groups[groupId];
      if (!group) return res.status(404).json({ error: 'Group not found' });
      const results = await Promise.all(
        (group.members || []).map(u => getUserStats(u, range.start, range.end))
      );
      results.sort((a, b) => b[sortField] - a[sortField]);
      return res.json({ groupId, stats: results });
    }
    const stats = await getUserStats(username, range.start, range.end);
    res.json({ stats });
  } catch (err) {
    console.error('Failed to build leaderboard stats:', err);
    res.status(500).json({ error: 'Failed to build leaderboard stats' });
  }
});

app.get('/leaderboard/weeklyVolume', async (req, res) => {
  if (!airtableToken || !airtableBaseId) {
    return res.status(503).json({ error: 'Airtable unavailable' });
  }
  const { username, groupId, start, end, timeframe } = req.query;
  let range = { start, end };
  if (timeframe) {
    const tf = parseTimeframe(timeframe);
    if (!tf) {
      return res.status(400).json({ error: 'Invalid timeframe' });
    }
    range = tf;
  }
  try {
    if (!username && !groupId) {
      return res.status(400).json({ error: 'username or groupId required' });
    }
    if (groupId) {
      const group = groups[groupId];
      if (!group) return res.status(404).json({ error: 'Group not found' });
      const out = {};
      for (const u of group.members || []) {
        out[u] = await getWeeklyVolume(u, range.start, range.end);
      }
      return res.json({ groupId, volume: out });
    }
    const volume = await getWeeklyVolume(username, range.start, range.end);
    res.json({ username, volume });
  } catch (err) {
    console.error('Failed to compute weekly volume:', err);
    res.status(500).json({ error: 'Failed to compute weekly volume' });
  }
});

// ────────────────────────────────
// Detailed stats endpoints

app.get('/stats/user/:username', async (req, res) => {
  const { username } = req.params;
  const { start, end, timeframe } = req.query;
  let range = { start, end };
  if (timeframe) {
    const tf = parseTimeframe(timeframe);
    if (!tf) {
      return res.status(400).json({ error: 'Invalid timeframe' });
    }
    range = tf;
  }
  try {
    let profile = {};
    let workouts = [];
    let weeklyVolume = [];
    if (airtableToken && airtableBaseId) {
      const userRec = await findUser(username);
      profile = userRec?.fields || { Username: username };
      workouts = await fetchUserWorkouts(username, range.start, range.end);
      weeklyVolume = await getWeeklyVolume(username, range.start, range.end);
    } else {
      profile = { ...sampleUserProfile, username };
      workouts = filterIndexedWorkouts(sampleWorkoutIndex, range.start, range.end);
      weeklyVolume = sampleWeeklyVolume(workouts);
    }
    const exerciseSummary = buildExerciseSummary(workouts);
    res.json({ profile, workouts, exerciseSummary, weeklyVolume });
  } catch (err) {
    console.error('Failed to build user stats:', err);
    res.status(500).json({ error: 'Failed to build user stats' });
  }
});

app.get('/stats/group/:groupId', async (req, res) => {
  const { groupId } = req.params;
  const { start, end, timeframe } = req.query;
  let range = { start, end };
  if (timeframe) {
    const tf = parseTimeframe(timeframe);
    if (!tf) {
      return res.status(400).json({ error: 'Invalid timeframe' });
    }
    range = tf;
  }
  try {
    let group = groups[groupId];
    if (!group) {
      if (airtableToken && airtableBaseId) {
        return res.status(404).json({ error: 'Group not found' });
      }
      group = sampleGroup;
    }
    const members = group.members || [];
    const allWorkouts = [];
    const contributorMap = {};
    for (const u of members) {
      let ws = [];
      if (airtableToken && airtableBaseId) {
        ws = await fetchUserWorkouts(u, range.start, range.end);
      } else {
        ws = filterIndexedWorkouts(sampleWorkoutIndex, range.start, range.end);
      }
      allWorkouts.push(...ws);
      contributorMap[u] = (contributorMap[u] || 0) + ws.reduce((t, w) => t + workoutVolume(w), 0);
    }
    const exerciseSummary = buildExerciseSummary(allWorkouts);
    const weeklyVolume = sampleWeeklyVolume(allWorkouts);
    const topContributors = Object.entries(contributorMap)
      .sort((a, b) => b[1] - a[1])
      .map(([user, volume]) => ({ user, volume }));
    res.json({ group: { id: groupId, name: group.name, description: group.description }, topContributors, exerciseSummary, weeklyVolume });
  } catch (err) {
    console.error('Failed to build group stats:', err);
    res.status(500).json({ error: 'Failed to build group stats' });
  }
});

app.post('/community/groups/:groupId/invite', authenticate, async (req, res) => {
  if (!airtableToken || !airtableBaseId) {
    return res.status(503).json({ error: 'Airtable unavailable' });
  }
  const { groupId } = req.params;
  const { invitedUserId } = req.body || {};
  if (!invitedUserId) {
    return res.status(400).json({ error: 'invitedUserId required' });
  }
  const group = groups[groupId];
  if (!group) {
    return res.status(404).json({ error: 'Group not found' });
  }
  try {
    const user = await findUser(invitedUserId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    if (!group.members.includes(invitedUserId)) {
      group.members.push(invitedUserId);
    }
    res.json({ success: true, group });
  } catch (err) {
    res.status(500).json({ error: 'Failed to invite user' });
  }
});

app.post('/community/groups/:groupId/share', authenticate, (req, res) => {
  const { groupId } = req.params;
  const { senderId, programData } = req.body || {};
  if (!senderId || !programData) {
    return res.status(400).json({ error: 'senderId and programData required' });
  }
  const group = groups[groupId];
  if (!group) {
    return res.status(404).json({ error: 'Group not found' });
  }
  if (!group.members.includes(senderId)) {
    return res.status(403).json({ error: 'Sender not a group member' });
  }
  if (!sharedPrograms[groupId]) {
    sharedPrograms[groupId] = [];
  }
  sharedPrograms[groupId].push({ senderId, programData });
  res.json({ success: true });
});

app.get('/community/groups/:groupId/posts', authenticate, (req, res) => {
  const { groupId } = req.params;
  try {
    const group = groups[groupId];
    if (!group) {
      return res.status(404).json({ error: 'Group not found' });
    }
    const posts = groupPosts[groupId];
    if (!posts || posts.length === 0) {
      return res.status(404).json({ error: 'No posts found' });
    }
    res.json({ posts });
  } catch (err) {
    console.error('Failed to fetch posts for group', groupId, err);
    res.status(500).json({ error: 'Failed to retrieve posts' });
  }
});

// healthcheck / root route
app.get('/', (req, res) => {
  res.status(200).send('🟢 TrainingLog backend is up and running');
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Server running on port ${PORT}`);
});

// ────────────────────────────────────────────────────
// Global error handler (catch unhandled exceptions)
app.use((err, req, res, next) => {
  console.error('💥 Uncaught server error:', err);
  res.status(500).json({ error: 'Internal server error' });
});
