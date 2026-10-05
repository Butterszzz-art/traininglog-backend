/* =============================================================
   AI provider — one place that decides which model API the AI
   routes (src/routes/coach.js, src/routes/ai.js) use.

   ANTHROPIC_API_KEY set   → Anthropic API directly.
   OPENROUTER_API_KEY set  → the same Anthropic SDK pointed at
                             OpenRouter's Anthropic-compatible endpoint,
                             walking a chain of models: the free ones
                             by default, or OPENROUTER_MODELS
                             (comma-separated) once the account has
                             credits.
   Neither                 → AI routes answer 404 AI_NOT_CONFIGURED.

   Keys are Cloud Functions secrets (functions-entry.js) or a local
   .env.local. privacy.html must name whichever provider is live.
   ============================================================= */

'use strict';

const Anthropic = require('@anthropic-ai/sdk');

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api';

function provider() {
  if (process.env.ANTHROPIC_API_KEY) return 'anthropic';
  if (process.env.OPENROUTER_API_KEY) return 'openrouter';
  return null;
}

function isConfigured() {
  return provider() !== null;
}

let cached = null;
function getClient() {
  const p = provider();
  if (!p) throw new Error('AI_NOT_CONFIGURED');
  if (cached && cached.provider === p) return cached.client;
  const client = p === 'openrouter'
    // maxRetries 0: on a rate limit, moving to the next model in the chain is
    // faster than backing off, and doesn't spend the free daily allowance.
    ? new Anthropic({ baseURL: OPENROUTER_BASE_URL, apiKey: null, authToken: process.env.OPENROUTER_API_KEY, maxRetries: 0 })
    : new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  cached = { provider: p, client };
  return client;
}

/**
 * Claude model id in OpenRouter's naming: "claude-haiku-4-5" →
 * "anthropic/claude-haiku-4.5". Only used when OPENROUTER_MODELS asks for
 * Claude (paid) models by their Anthropic ids.
 */
function openRouterSlug(id) {
  if (id.includes('/')) return id;
  const bare = id.replace(/-\d{8}$/, '');               // drop a date snapshot suffix
  return `anthropic/${bare.replace(/-(\d+)-(\d+)$/, '-$1.$2')}`;
}

// OpenRouter's free models (":free" — no credits needed; the account gets 50
// free requests/day, 1000/day once it has bought $10 of credits). Free
// providers rate-limit and overload often, so calls walk this list until one
// answers. All of these support tool calling. Override with OPENROUTER_MODELS
// (comma-separated), e.g. "anthropic/claude-opus-5.5" once the account has credits.
const OPENROUTER_FREE_MODELS = [
  'nex-agi/nex-n2.5-pro:free',
  'nvidia/nemotron-3-super-120b-a12b:free',
  'qwen/qwen3.8-27b:free',
  'google/gemma-4-31b-it:free',
];

let lastGood = null;
function markGood(model) { lastGood = model; }

/** Models to try, in order, for a call that would use Anthropic model `id`. */
function modelChain(id) {
  if (provider() !== 'openrouter') return [id];
  const configured = (process.env.OPENROUTER_MODELS || '').split(',').map(s => s.trim()).filter(Boolean);
  const chain = (configured.length ? configured : OPENROUTER_FREE_MODELS).map(openRouterSlug);
  // Start from whichever model answered last, so a model that's rate-limited
  // right now isn't hit first on every request.
  const i = chain.indexOf(lastGood);
  return i > 0 ? [...chain.slice(i), ...chain.slice(0, i)] : chain;
}

/** A provider answered 200 but without a usable body — try the next model. */
class MalformedReply extends Error {
  constructor(model) { super(`${model} returned a reply without content`); this.name = 'MalformedReply'; }
}

/** Worth trying the next model: rate limit, overload, upstream/server error, network. */
function isRetryable(err) {
  if (err instanceof Anthropic.APIConnectionError) return true;
  if (!(err instanceof Anthropic.APIError)) return false;
  return err.status === undefined || err.status === 429 || err.status === 408 || err.status >= 500;
}

/**
 * How long one model may take before the next in the chain is tried. Free
 * OpenRouter models can sit in a queue for minutes; the Anthropic API gets
 * `anthropicMs` (a generous ceiling) instead.
 */
function perModelTimeoutMs(openRouterMs, anthropicMs = 120000) {
  return provider() === 'openrouter' ? openRouterMs : anthropicMs;
}

const pause = ms => new Promise(r => setTimeout(r, ms));

/**
 * messages.create across the model chain. `base` is the Anthropic model id
 * the call would use on the Anthropic API. A model that errors retryably or
 * takes longer than `timeoutMs` is skipped. Free models are often
 * rate-limited for a few seconds, so after the whole chain fails it pauses
 * and goes round once more. Throws the last error if every model fails.
 */
async function createMessage(base, params, { timeoutMs = 120000, retryPauseMs = 5000 } = {}) {
  const chain = modelChain(base);
  const attempts = provider() === 'openrouter' && retryPauseMs > 0 ? [...chain, null, ...chain] : chain;
  let lastErr;
  for (const model of attempts) {
    if (model === null) { await pause(retryPauseMs); continue; }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const reply = await getClient().messages.create({ ...params, model }, { signal: ctrl.signal });
      if (!Array.isArray(reply && reply.content)) throw new MalformedReply(model);
      markGood(model);
      return reply;
    } catch (err) {
      lastErr = err;
      if (!ctrl.signal.aborted && !isRetryable(err) && !(err instanceof MalformedReply)) throw err;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

/**
 * Streamed beta.messages call across the model chain, for long outputs.
 * A model is abandoned when it goes quiet for `idleMs`, errors retryably
 * (or with any status in `skipStatuses`, e.g. a model that can't take
 * images), or its reply fails `accept(reply)`. Stops trying new models
 * once `deadlineMs` has passed. Resolves { reply, model }.
 */
async function streamMessage(base, params, { idleMs = 120000, deadlineMs = 240000, accept = () => true, skipStatuses = [], signal } = {}) {
  const started = Date.now();
  const chain = modelChain(base);
  let lastErr = new Error('No model answered.');
  for (const model of chain) {
    if (Date.now() - started > deadlineMs || (signal && signal.aborted)) break;
    const stream = getClient().beta.messages.stream({ ...params, model });
    let stalled = false;
    let idleTimer = null;
    const arm = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => { stalled = true; stream.abort(); }, Math.min(idleMs, Math.max(1000, deadlineMs - (Date.now() - started))));
    };
    const onAbort = () => stream.abort();
    if (signal) signal.addEventListener('abort', onAbort);
    if (typeof stream.on === 'function') stream.on('streamEvent', arm);
    arm();
    try {
      const reply = await stream.finalMessage();
      if (!Array.isArray(reply && reply.content) || !accept(reply)) throw new MalformedReply(model);
      markGood(model);
      return { reply, model };
    } catch (err) {
      lastErr = stalled ? new Error(`${model} stopped responding.`) : err;
      if (signal && signal.aborted) throw err;
      const skip = stalled || err instanceof MalformedReply || isRetryable(err)
        || (err instanceof Anthropic.APIError && skipStatuses.includes(err.status));
      if (!skip) throw err;
    } finally {
      clearTimeout(idleTimer);
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  }
  throw lastErr;
}

/**
 * Request fields only the Anthropic API itself accepts: server-side refusal
 * fallbacks (on a safety decline the API re-runs the request on a fallback
 * model inside the same call). OpenRouter does its own routing.
 */
function fallbackParams() {
  if (provider() !== 'anthropic') return {};
  return { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' };
}

/**
 * output_config for a reply that must match `schema`. Structured outputs are
 * guaranteed on the Anthropic API; through OpenRouter the instructions carry
 * the shape and callers parse the reply defensively.
 */
function jsonOutput(schema, effort) {
  return provider() === 'anthropic' ? { effort, format: { type: 'json_schema', schema } } : { effort };
}

module.exports = {
  Anthropic, provider, isConfigured, getClient, modelChain, markGood, isRetryable, perModelTimeoutMs,
  createMessage, streamMessage, fallbackParams, jsonOutput, MalformedReply, OPENROUTER_FREE_MODELS,
};
