const multer = require('multer');
const pdfParse = require('pdf-parse');
const Anthropic = require('@anthropic-ai/sdk');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf') cb(null, true);
    else cb(new Error('Only PDF files are accepted'));
  }
});

async function extractKnowledgeWithClaude(text, moduleName, topic) {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const prompt = `You are extracting structured knowledge from a personal trainer's methodology document.

Module name: "${moduleName}"
Topic category: "${topic}"

Extract all relevant knowledge from this document and return ONLY a valid JSON object — no preamble, no markdown, no backticks. Use this exact structure, filling in as much detail as possible from the document:

{
  "principles": [],
  "methods": [],
  "progressionModel": "",
  "exerciseCues": {},
  "nutritionGuidelines": {},
  "recoveryProtocols": [],
  "coachingNotes": [],
  "keyTerms": {},
  "warningsAndContraindications": []
}

Only include fields that have actual content from the document. Leave arrays empty and strings blank if not covered. Do not invent information.

Document text:
${text.slice(0, 120000)}`;

  const message = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4000,
    messages: [{ role: 'user', content: prompt }]
  });

  const raw = message.content?.[0]?.text || '';
  const clean = raw.replace(/```json|```/g, '').trim();
  return JSON.parse(clean);
}

async function saveToAirtable(airtableToken, airtableBaseId, fields) {
  const fetch = require('node-fetch');
  const url = `https://api.airtable.com/v0/${airtableBaseId}/KnowledgeBase`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${airtableToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ fields })
  });

  if (!response.ok) {
    const err = await response.json();
    throw new Error(`Airtable save failed: ${JSON.stringify(err)}`);
  }

  return await response.json();
}

async function getActiveModules(airtableToken, airtableBaseId, topic = null) {
  const fetch = require('node-fetch');
  let formula = '{IsActive}=1';
  if (topic) formula = `AND({IsActive}=1, {Topic}='${topic}')`;

  const params = new URLSearchParams({ filterByFormula: formula });
  const url = `https://api.airtable.com/v0/${airtableBaseId}/KnowledgeBase?${params}`;

  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${airtableToken}` }
  });

  if (!response.ok) throw new Error('Failed to fetch knowledge modules');

  const data = await response.json();
  return (data.records || []).map(r => ({
    id: r.id,
    moduleName: r.fields.ModuleName,
    topic: r.fields.Topic,
    extractedJSON: r.fields.ExtractedJSON ? JSON.parse(r.fields.ExtractedJSON) : {}
  }));
}

module.exports = { upload, extractKnowledgeWithClaude, saveToAirtable, getActiveModules };
