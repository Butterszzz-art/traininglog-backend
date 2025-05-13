require('dotenv').config();

const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3000;

const airtableToken = process.env.AIRTABLE_TOKEN;
const airtableBaseId = process.env.BASE_ID;
const usersTableName = 'Users'; // ✅ This must be defined BEFORE using it

console.log("AIRTABLE_TOKEN:", airtableToken);
console.log("BASE_ID:", airtableBaseId);

app.use(cors());
app.use(bodyParser.json());

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
