// server.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const Airtable = require('airtable');

const app = express();

// parse JSON bodies
app.use(express.json());

// enable CORS for the frontend application
app.use(
  cors({
    origin: ['https://butterszzz-art.github.io'],
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    credentials: true
  })
);

const PORT = process.env.PORT || 3000;
const airtableToken = process.env.AIRTABLE_TOKEN?.trim();
const airtableBaseId = process.env.AIRTABLE_BASE_ID?.trim();
let airtableBase;
let base;
if (airtableToken && airtableBaseId) {
  airtableBase = new Airtable({ apiKey: airtableToken }).base(airtableBaseId);
  base = airtableBase;
} else {
  console.warn('Missing Airtable environment variables, Airtable features disabled');
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

// ---- Routes ----
app.get('/config', (req, res) => {
  res.json({ airtableToken, airtableBaseId });
});

app.post('/signup', async (req, res, next) => {
  try {
    const { username, password } = req.body;
    const exists = await findUser(username);
    if (exists) return res.status(400).json({ success: false, message: 'User exists' });
    await createUser(username, password);
    res.json({ success: true });
  } catch(err) {
    next(err);
  }
});

app.post('/login', async (req, res, next) => {
  try {
    const { username, password } = req.body;
    const user = await findUser(username);
    if (!user) return res.status(404).json({ success: false, message: 'Not found' });
    if (user.fields.Password !== password) {
      return res.status(401).json({ success: false, message: 'Wrong password' });
    }
    res.json({ success: true });
  } catch(err) {
    next(err);
  }
});

app.post('/saveTemplate', async (req, res) => {
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

app.post('/community/groups/:groupId/invite', authenticate, async (req, res) => {
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

app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Server running on port ${PORT}`);
});

// ────────────────────────────────────────────────────
// Global error handler (catch unhandled exceptions)
app.use((err, req, res, next) => {
  console.error('💥 Uncaught server error:', err);
  res.status(500).json({ error: 'Internal server error' });
});
