/* =============================================================
   AI coach — Anthropic client for src/routes/coach.js.

   Anthropic only: privacy.html lists Anthropic as the one AI
   processor, so no other provider may be added here without also
   updating the privacy policy. ANTHROPIC_API_KEY comes from the
   Cloud Functions secret (functions-entry.js) or a local .env.local;
   without it the coach routes answer 404 AI_NOT_CONFIGURED.
   ============================================================= */

'use strict';

const Anthropic = require('@anthropic-ai/sdk');

function isConfigured() {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

let cached = null;
function getClient() {
  if (!isConfigured()) throw new Error('AI_NOT_CONFIGURED');
  if (!cached) cached = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return cached;
}

/** A 200 reply without a Messages-shaped body. */
class MalformedReply extends Error {
  constructor(model) { super(`${model} returned a reply without content`); this.name = 'MalformedReply'; }
}

/**
 * Single-shot messages.create with a wall-clock limit. The SDK already
 * retries 408/409/429/5xx and connection errors itself.
 */
async function createMessage(model, params, { timeoutMs = 120000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const reply = await getClient().messages.create({ ...params, model }, { signal: ctrl.signal });
    if (!Array.isArray(reply && reply.content)) throw new MalformedReply(model);
    return reply;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Server-side refusal fallback: on a safety decline the API re-runs the
 * request on a fallback model inside the same call.
 */
function fallbackParams() {
  return { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' };
}

module.exports = { Anthropic, isConfigured, getClient, createMessage, fallbackParams, MalformedReply };
