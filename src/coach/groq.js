/* =============================================================
   Groq — a small Anthropic-shaped client over Groq's OpenAI-
   compatible Chat Completions API, so src/coach/client.js can put
   Groq in the same model chain as Ollama and OpenRouter.

   Only what the short AI calls need: text-only system/messages in,
   text out, through messages.create(). No streaming, tools, images or
   documents — client.js's prepare() keeps those requests away from
   Groq, along with anything too big for the free tier's per-minute
   token limit (see fitsGroq()).
   ============================================================= */

'use strict';

const Anthropic = require('@anthropic-ai/sdk');

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';

// Free tier: about 8K tokens per minute per model, and Groq counts the
// requested output against it. Keep each request well under that.
const GROQ_MAX_REQUEST_TOKENS = Number(process.env.GROQ_MAX_REQUEST_TOKENS) || 7000;
const GROQ_MAX_OUTPUT_TOKENS = 2500;

const textOf = content => (typeof content === 'string'
  ? content
  : (content || []).filter(b => b && b.type === 'text').map(b => b.text).join('\n\n'));

/** True when every block is plain text (Groq gets no images, documents or tools here). */
function textOnly(body) {
  const blocksOk = content => typeof content === 'string' || (Array.isArray(content) && content.every(b => b && b.type === 'text'));
  return !body.tools && blocksOk(body.system || '') && (body.messages || []).every(m => blocksOk(m.content));
}

// ~3 characters per token: a deliberately high estimate for English + JSON.
const estimateTokens = body => Math.ceil((textOf(body.system) + (body.messages || []).map(m => textOf(m.content)).join('')).length / 3);

const outputTokens = body => Math.min(Number(body.max_tokens) || GROQ_MAX_OUTPUT_TOKENS, GROQ_MAX_OUTPUT_TOKENS);

/** Whether a request fits Groq's free per-minute token budget. */
function fitsGroq(body) {
  return textOnly(body) && estimateTokens(body) + outputTokens(body) <= GROQ_MAX_REQUEST_TOKENS;
}

/** Anthropic Messages request → OpenAI Chat Completions request. */
function toChatRequest(body) {
  const messages = [];
  const system = textOf(body.system);
  if (system) messages.push({ role: 'system', content: system });
  (body.messages || []).forEach(m => messages.push({ role: m.role, content: textOf(m.content) }));
  const req = { model: body.model, messages, max_completion_tokens: outputTokens(body) };
  // gpt-oss reasons before answering; keep that short so the answer fits.
  if (/gpt-oss/.test(body.model)) req.reasoning_effort = 'low';
  return req;
}

/** OpenAI Chat Completions response → Anthropic Message. */
function toMessage(json, model) {
  const choice = json && Array.isArray(json.choices) ? json.choices[0] : null;
  if (!choice || !choice.message) return { model, content: null };
  return {
    id: json.id,
    type: 'message',
    role: 'assistant',
    model,
    content: [{ type: 'text', text: typeof choice.message.content === 'string' ? choice.message.content : '' }],
    stop_reason: choice.finish_reason === 'length' ? 'max_tokens' : 'end_turn',
    usage: {
      input_tokens: (json.usage && json.usage.prompt_tokens) || 0,
      output_tokens: (json.usage && json.usage.completion_tokens) || 0,
    },
  };
}

/** A client with the one method client.js's createMessage() calls. */
function createGroqClient(apiKey, fetchImpl = (...a) => fetch(...a)) {
  return {
    messages: {
      async create(body, { signal } = {}) {
        let res;
        try {
          res = await fetchImpl(GROQ_URL, {
            method: 'POST',
            headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(toChatRequest(body)),
            signal,
          });
        } catch (err) {
          if (signal && signal.aborted) throw err;
          throw new Anthropic.APIConnectionError({ message: `Groq: ${err.message}`, cause: err });
        }
        const json = await res.json().catch(() => null);
        if (!res.ok) {
          const message = (json && json.error && json.error.message) || `Groq returned ${res.status}`;
          throw Anthropic.APIError.generate(res.status, json, message, res.headers);
        }
        return toMessage(json, body.model);
      },
    },
  };
}

module.exports = { createGroqClient, fitsGroq, toChatRequest, toMessage, estimateTokens, GROQ_MAX_REQUEST_TOKENS };
