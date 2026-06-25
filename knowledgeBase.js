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
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY not configured');
  }

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  // Truncate to 30k chars — keeps Claude response time under 25s
  const truncated = text.slice(0, 30000);
  console.log(`[KnowledgeBase] Sending ${truncated.length} chars to Claude for "${moduleName}" (${topic})`);

  const prompt = `You are extracting structured knowledge from a personal trainer's methodology document.

Module name: "${moduleName}"
Topic category: "${topic}"

Extract all relevant knowledge and return ONLY valid JSON — no preamble, no markdown fences. Structure:

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

Only include fields with actual content. Do not invent information.

Document text:
${truncated}`;

  try {
    console.log('[KnowledgeBase] Calling Claude API...');
    const message = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 4000,
      messages: [{ role: 'user', content: prompt }]
    });

    const raw = message.content?.[0]?.text || '';
    console.log(`[KnowledgeBase] Claude responded with ${raw.length} chars`);
    const clean = raw.replace(/```json|```/g, '').trim();

    try {
      return JSON.parse(clean);
    } catch (parseErr) {
      console.error('[KnowledgeBase] JSON parse failed. First 500 chars:', clean.slice(0, 500));
      throw new Error('Claude returned invalid JSON: ' + parseErr.message);
    }
  } catch (err) {
    console.error(`[KnowledgeBase] Claude API failed:`, err.message);
    throw err;
  }
}

async function saveToAirtable(airtableToken, airtableBaseId, fields) {
  const fetch = require('node-fetch');
  const url = `https://api.airtable.com/v0/${airtableBaseId}/KnowledgeBase`;

  if (fields.ExtractedJSON && fields.ExtractedJSON.length > 95000) {
    console.warn('[KnowledgeBase] ExtractedJSON too large, truncating');
    fields.ExtractedJSON = fields.ExtractedJSON.slice(0, 95000);
  }

  console.log(`[KnowledgeBase] Saving to Airtable (${fields.ModuleName}, JSON size: ${(fields.ExtractedJSON || '').length})`);

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
    console.error('[KnowledgeBase] Airtable error:', JSON.stringify(err));
    throw new Error(`Airtable save failed: ${JSON.stringify(err)}`);
  }

  console.log('[KnowledgeBase] Saved to Airtable successfully');
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
