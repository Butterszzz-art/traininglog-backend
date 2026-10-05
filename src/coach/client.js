/* =============================================================
   AI provider — one place that decides which model API the AI
   routes (src/routes/coach.js, src/routes/ai.js) use.

   ANTHROPIC_API_KEY set   → Anthropic API directly, and nothing else.
   Otherwise, open models through every provider that has a key,
   tried in this order (each step is "provider::model"):
     OLLAMA_API_KEY        → Ollama Cloud's Anthropic-compatible
                             endpoint: OLLAMA_MODELS, or OLLAMA_FREE_MODELS.
                             No logging, no training, no retention;
                             no PDF input.
     GROQ_API_KEY          → Groq (src/coach/groq.js): GROQ_MODELS, or
                             GROQ_FREE_MODELS. Short text-only,
                             non-streamed calls only; see fitsGroq().
     OPENROUTER_API_KEY    → OpenRouter's Anthropic-compatible endpoint:
                             OPENROUTER_MODELS, or OPENROUTER_FREE_MODELS.
   A model that is rate-limited, out of allowance, overloaded, stalled
   or can't take the request's input is skipped for the next one.
   Neither                 → AI routes answer 404 AI_NOT_CONFIGURED.

   Callers write requests in Anthropic's shape; prepare() trims each one
   to what the provider of that step accepts. Keys are Cloud Functions
   secrets (functions-entry.js) or a local .env.local. privacy.html must
   name whichever providers are live.
   ============================================================= */

'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const { createGroqClient, fitsGroq } = require('./groq');

const BASE_URLS = {
  openrouter: 'https://openrouter.ai/api',
  ollama: 'https://ollama.com', // the SDK appends /v1/messages
};

const KEY_VARS = {
  anthropic: 'ANTHROPIC_API_KEY',
  ollama: 'OLLAMA_API_KEY',
  groq: 'GROQ_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
};

/** Providers in the order their models are tried. */
function providers() {
  if (process.env.ANTHROPIC_API_KEY) return ['anthropic'];
  return ['ollama', 'groq', 'openrouter'].filter(p => process.env[KEY_VARS[p]]);
}

/** The first provider tried, or null when none is configured. */
function provider() {
  return providers()[0] || null;
}

function isConfigured() {
  return provider() !== null;
}

/** True when requests go to open models (Ollama / OpenRouter), not the Anthropic API. */
function openModels() {
  const p = provider();
  return p !== null && p !== 'anthropic';
}

const clients = {};
function getClient(name = provider()) {
  if (!name || !process.env[KEY_VARS[name]]) throw new Error('AI_NOT_CONFIGURED');
  const key = process.env[KEY_VARS[name]];
  if (clients[name] && clients[name].key === key) return clients[name].client;
  let client;
  if (name === 'anthropic') client = new Anthropic({ apiKey: key });
  else if (name === 'groq') client = createGroqClient(key);
  // maxRetries 0: on a rate limit, moving to the next model in the chain is
  // faster than backing off, and doesn't spend the free allowance. Both
  // hosts take the key as a Bearer token.
  else client = new Anthropic({ baseURL: BASE_URLS[name], apiKey: null, authToken: key, maxRetries: 0 });
  clients[name] = { key, client };
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
// providers rate-limit and overload often. All of these support tool calling.
const OPENROUTER_FREE_MODELS = [
  'nex-agi/nex-n2.5-pro:free',
  'nvidia/nemotron-3-super-120b-a12b:free',
  'qwen/qwen3.8-27b:free',
  'google/gemma-4-31b-it:free',
];

// Ollama Cloud models for the free plan's monthly starter allowance.
// Gemma 4 takes images and tools. Override with OLLAMA_MODELS.
const OLLAMA_FREE_MODELS = ['gemma4:31b'];

// Groq free tier (about 30 requests/min, 1,000/day, 8K tokens/min each).
// Override with GROQ_MODELS.
const GROQ_FREE_MODELS = ['openai/gpt-oss-120b', 'openai/gpt-oss-20b'];

const listFromEnv = name => (process.env[name] || '').split(',').map(s => s.trim()).filter(Boolean);

const SEP = '::';
const ref = (p, model) => `${p}${SEP}${model}`;
/** "ollama::gemma4:31b" → { provider: 'ollama', model: 'gemma4:31b' } */
function parseRef(r) {
  const i = String(r).indexOf(SEP);
  return i === -1 ? { provider: provider(), model: String(r) } : { provider: r.slice(0, i), model: r.slice(i + SEP.length) };
}

// Per provider, the model that answered last goes first next time, so a
// model that is rate-limited right now isn't hit first on every request.
// Providers keep their order: Ollama before OpenRouter.
const lastGood = {};
function markGood(r) {
  if (r === null) { Object.keys(lastGood).forEach(k => delete lastGood[k]); return; }
  const { provider: p } = parseRef(r);
  lastGood[p] = r;
}

/** Steps to try, in order, for a call that would use Anthropic model `id`. */
function modelChain(id) {
  const out = [];
  providers().forEach(p => {
    let models;
    if (p === 'anthropic') models = [id];
    else if (p === 'ollama') models = listFromEnv('OLLAMA_MODELS').length ? listFromEnv('OLLAMA_MODELS') : OLLAMA_FREE_MODELS;
    else if (p === 'groq') models = listFromEnv('GROQ_MODELS').length ? listFromEnv('GROQ_MODELS') : GROQ_FREE_MODELS;
    else models = (listFromEnv('OPENROUTER_MODELS').length ? listFromEnv('OPENROUTER_MODELS') : OPENROUTER_FREE_MODELS).map(openRouterSlug);
    const refs = models.map(m => ref(p, m));
    const i = refs.indexOf(lastGood[p]);
    out.push(...(i > 0 ? [...refs.slice(i), ...refs.slice(0, i)] : refs));
  });
  return out;
}

const hasDocument = messages => (messages || []).some(m => Array.isArray(m.content) && m.content.some(b => b && b.type === 'document'));

/**
 * The client and request body for one chain step, trimmed to what that
 * provider accepts — or null when it can't take this request at all
 * (Ollama has no PDF input; Groq only takes short, text-only, non-streamed
 * calls). Pass { stream: true } for streamed calls.
 */
function prepare(r, params, { stream = false } = {}) {
  const { provider: p, model } = parseRef(r);
  const body = { ...params, model };
  if (p !== 'anthropic') {
    // Claude-API-only: refusal fallbacks and guaranteed JSON. Callers put the
    // JSON shape in the instructions as well and parse replies defensively.
    delete body.betas;
    delete body.fallbacks;
    if (body.output_config) {
      const { format, ...rest } = body.output_config;
      body.output_config = rest;
    }
  }
  if (p !== 'openrouter') delete body.plugins;
  if (p === 'ollama') {
    if (hasDocument(body.messages)) return null;
    delete body.cache_control; // prompt caching isn't supported
    if (Array.isArray(body.tools)) body.tools = body.tools.map(({ eager_input_streaming, ...t }) => t);
  }
  if (p === 'groq') {
    if (stream || !fitsGroq(body)) return null;
    delete body.cache_control;
  }
  return { client: getClient(p), body };
}

/** A provider answered 200 but without a usable body — try the next model. */
class MalformedReply extends Error {
  constructor(model) { super(`${model} returned a reply without content`); this.name = 'MalformedReply'; }
}

/**
 * Worth trying the next model: rate limit, overload, upstream/server error,
 * network. With open models also a provider that refuses this account
 * (bad key, free allowance used up) or this request's size, since the next
 * step may be another provider.
 */
function isRetryable(err) {
  if (err instanceof Anthropic.APIConnectionError) return true;
  if (!(err instanceof Anthropic.APIError)) return false;
  if (openModels() && [401, 402, 403, 413].includes(err.status)) return true;
  return err.status === undefined || err.status === 429 || err.status === 408 || err.status >= 500;
}

/**
 * How long one model may take before the next in the chain is tried. Free
 * models can sit in a queue for minutes; the Anthropic API gets
 * `anthropicMs` (a generous ceiling) instead.
 */
function perModelTimeoutMs(openMs, anthropicMs = 120000) {
  return openModels() ? openMs : anthropicMs;
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
  const attempts = openModels() && retryPauseMs > 0 ? [...chain, null, ...chain] : chain;
  let lastErr = new Error('No AI model can take this request.');
  for (const r of attempts) {
    if (r === null) { await pause(retryPauseMs); continue; }
    const prepared = prepare(r, params);
    if (!prepared) continue;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const reply = await prepared.client.messages.create(prepared.body, { signal: ctrl.signal });
      if (!Array.isArray(reply && reply.content)) throw new MalformedReply(r);
      markGood(r);
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
  let lastErr = new Error('No AI model can take this request.');
  for (const r of modelChain(base)) {
    if (Date.now() - started > deadlineMs || (signal && signal.aborted)) break;
    const prepared = prepare(r, params, { stream: true });
    if (!prepared) continue;
    const stream = prepared.client.beta.messages.stream(prepared.body);
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
      if (!Array.isArray(reply && reply.content) || !accept(reply)) throw new MalformedReply(r);
      markGood(r);
      return { reply, model: r };
    } catch (err) {
      lastErr = stalled ? new Error(`${r} stopped responding.`) : err;
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
 * Server-side refusal fallbacks (on a safety decline the Claude API re-runs
 * the request on a fallback model inside the same call). prepare() drops
 * them for other providers.
 */
function fallbackParams() {
  if (provider() !== 'anthropic') return {};
  return { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' };
}

/**
 * output_config for a reply that must match `schema`. Structured outputs are
 * guaranteed on the Anthropic API; open models get the shape from the
 * instructions and callers parse the reply defensively.
 */
function jsonOutput(schema, effort) {
  return provider() === 'anthropic' ? { effort, format: { type: 'json_schema', schema } } : { effort };
}

module.exports = {
  Anthropic, provider, providers, openModels, isConfigured, getClient, prepare, parseRef,
  modelChain, markGood, isRetryable, perModelTimeoutMs,
  createMessage, streamMessage, fallbackParams, jsonOutput, MalformedReply,
  OPENROUTER_FREE_MODELS, OLLAMA_FREE_MODELS, GROQ_FREE_MODELS,
};
