const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');

const router = express.Router();
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const MODEL = 'claude-sonnet-4-6';

async function callClaude(systemPrompt, userPrompt) {
  try {
    const message = await client.messages.create({
      model:      MODEL,
      max_tokens: 1024,
      system:     systemPrompt,
      messages:   [{ role: 'user', content: userPrompt }]
    });
    const block = message.content?.[0];
    if (!block || block.type !== 'text') throw new Error('No text content in response');
    return block.text;
  } catch (err) {
    throw new Error(`Claude API error: ${err?.message || String(err)}`);
  }
}

// GET /api/ai/health — confirm the route and model are wired up
router.get('/health', (_req, res) => {
  res.json({ status: 'ok', model: MODEL });
});

// POST /api/ai/chat — general chat endpoint
// Body: { messages: [{role, content}], systemPrompt? }
router.post('/chat', async (req, res) => {
  try {
    const { messages, systemPrompt } = req.body || {};
    if (!Array.isArray(messages) || !messages.length) {
      return res.status(422).json({ success: false, error: 'messages array is required.' });
    }

    const system = systemPrompt || 'You are a helpful fitness coaching assistant.';
    const userPrompt = messages[messages.length - 1]?.content || '';
    const reply = await callClaude(system, userPrompt);
    return res.json({ success: true, reply });
  } catch (err) {
    console.error('POST /api/ai/chat failed:', err.message);
    return res.status(502).json({ success: false, error: err.message });
  }
});

module.exports = { router, callClaude };
