require('dotenv').config();

const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3000;

const airtableToken = process.env.AIRTABLE_TOKEN?.trim();
const airtableBaseId = process.env.BASE_ID?.trim();
const usersTableName = 'Users';

console.log("AIRTABLE_TOKEN:", airtableToken);
console.log("BASE_ID:", airtableBaseId);


// your signup/login endpoints...

app.use(cors());
app.use(bodyParser.json());

app.post('/signup', async (req, res) => {
  const { username, password } = req.body;
  const exists = await findUser(username);
  if (exists) return res.status(400).json({ success: false, message: 'User exists' });
  await createUser(username, password);
  res.json({ success: true });
});

app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  const user = await findUser(username);
  if (!user) return res.status(404).json({ success: false, message: 'Not found' });
  if (user.fields.Password !== password)
    return res.status(401).json({ success: false, message: 'Wrong password' });
  res.json({ success: true });
});

async function findUser(username) {
  const url = `https://api.airtable.com/v0/${airtableBaseId}/${usersTableName}?filterByFormula={Username}='${username}'`;

  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${airtableToken}` }
  });

  if (!response.ok) {
    const errText = await response.text();
    console.error("Airtable API error:", errText);
    throw new Error("Airtable request failed");
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

app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
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

});
