/* =============================================================
   AI food search assist — POST /api/ai/food-search-assist (Pro)

   The app's normal food search (GET /api/food/search) is fast but
   literal: a typo ("yoghurd"), a Dutch word the US database doesn't
   know ("kippendijen"), or a mix of brand and product can come back
   empty or wrong. When that happens, the app asks here. The model
   only rewrites the search words — it never gives nutrition numbers —
   and the foods still come from Open Food Facts and USDA:

     1. the model returns { corrected, english, brand, alternatives }
     2. we search Open Food Facts with `corrected` and USDA with
        `english`, and rank the merged list against `corrected`.

   Only the search words go to the model, nothing about the user. The
   rewrite is cached per query for everyone (30 days), so a repeated
   search doesn't call the model again.
   ============================================================= */
'use strict';

const foods = require('./foods');
const { createCache } = require('../routes/food');

const MODEL = 'claude-haiku-4-5-20251001';
const MAX_QUERY = 80;
const MAX_TERM = 60;
const REWRITE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const SYSTEM = `You help a food-logging app used mostly in the Netherlands search two food databases: Open Food Facts (supermarket products, Dutch and English names, brands like Albert Heijn/AH, Jumbo, Lidl, Melkunie, Optimel, Alpro, Arla) and USDA FoodData Central (generic foods, English names only).
The user typed a search that found nothing useful. It may contain typos, Dutch words, a brand or supermarket name, or a description.
Return ONLY JSON:
{"corrected": string, "english": string, "brand": string|null, "alternatives": string[]}
- corrected: what they most likely meant, as a short search in the language they typed, typos fixed, brand kept (e.g. "yoghurd griekse 0%" → "griekse yoghurt 0%").
- english: a short generic English description for USDA (e.g. "greek yogurt nonfat"). No brand.
- brand: the brand or supermarket if one is named, else null.
- alternatives: up to 3 other short searches they might mean (Dutch or English), different from corrected.
Keep every string under 60 characters. Never include nutrition numbers or anything that isn't a search phrase.`;

const SCHEMA = {
  type: 'object',
  properties: {
    corrected: { type: 'string' },
    english: { type: 'string' },
    brand: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    alternatives: { type: 'array', items: { type: 'string' } },
  },
  required: ['corrected', 'english', 'brand', 'alternatives'],
  additionalProperties: false,
};

function cleanQuery(q) {
  const s = foods.normalizeQuery(q).slice(0, MAX_QUERY);
  return s.length >= 2 ? s : null;
}

// A search phrase: letters (any language), digits, spaces and a few marks.
function cleanTerm(v) {
  if (typeof v !== 'string') return '';
  return v.normalize('NFC').replace(/[^\p{L}\p{N}\s%&.,'’\-]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_TERM);
}

// The model's reply → a safe rewrite, or null when it's unusable.
function parseReply(text, query) {
  let parsed = null;
  try {
    const json = String(text || '').replace(/^[\s\S]*?(\{)/, '$1').replace(/\}[^}]*$/, '}');
    parsed = JSON.parse(json);
  } catch { return null; }
  if (!parsed || typeof parsed !== 'object') return null;
  const corrected = cleanTerm(parsed.corrected);
  const english = cleanTerm(parsed.english);
  if (corrected.length < 2 && english.length < 2) return null;
  const brand = cleanTerm(parsed.brand) || null;
  const seen = new Set([corrected.toLowerCase(), query.toLowerCase()]);
  const alternatives = (Array.isArray(parsed.alternatives) ? parsed.alternatives : [])
    .map(cleanTerm)
    .filter(a => a.length >= 2 && !seen.has(a.toLowerCase()) && seen.add(a.toLowerCase()))
    .slice(0, 3);
  return { corrected: corrected.length >= 2 ? corrected : query, english, brand, alternatives };
}

function createSearchAssist({ searcher, createMessageFn, jsonOutputFn, timeoutMs = 20000, cache = createCache(2000), log = console } = {}) {
  async function rewrite(query) {
    const hit = cache.get(`r:${query}`);
    if (hit) return { ...hit, cached: true };
    const reply = await createMessageFn(MODEL, {
      max_tokens: 600,
      system: SYSTEM,
      output_config: jsonOutputFn ? jsonOutputFn(SCHEMA) : { format: { type: 'json_schema', schema: SCHEMA } },
      messages: [{ role: 'user', content: JSON.stringify({ search: query }) }],
    }, { timeoutMs });
    const text = (reply.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
    const r = parseReply(text, query);
    if (r) cache.set(`r:${query}`, r, REWRITE_TTL_MS);
    return r;
  }

  // → { rewrite, foods, sources } (rewrite null when the model gave nothing usable)
  async function assist(query) {
    const r = await rewrite(query);
    if (!r) return { rewrite: null, foods: [], sources: {} };
    const [off, usda] = await Promise.all([
      searcher.search(r.corrected, { sources: 'off' }).catch(err => { log.warn(`[food-assist] off: ${err.message}`); return { foods: [], sources: { off: 'error' } }; }),
      r.english.length >= 2
        ? searcher.search(r.english, { sources: 'usda' }).catch(err => { log.warn(`[food-assist] usda: ${err.message}`); return { foods: [], sources: { usda: 'error' } }; })
        : Promise.resolve({ foods: [], sources: {} }),
    ]);
    // Rank USDA's English names against the English words, then merge the
    // two lists so each keeps its own order (Dutch products first).
    const offRanked = foods.rankFoods(r.corrected, [off.foods], 20);
    const usdaRanked = foods.rankFoods(r.english || r.corrected, [usda.foods], 10);
    const merged = [];
    const seen = new Set();
    for (const f of [...offRanked.slice(0, 12), ...usdaRanked.slice(0, 6), ...offRanked.slice(12)]) {
      const key = f.barcode ? `bc:${f.barcode}` : f.id;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(f);
    }
    return {
      rewrite: { corrected: r.corrected, english: r.english, brand: r.brand, alternatives: r.alternatives },
      foods: merged.slice(0, 25),
      sources: { ...off.sources, ...usda.sources },
    };
  }

  return { assist, rewrite };
}

module.exports = { SYSTEM, SCHEMA, MODEL, cleanQuery, cleanTerm, parseReply, createSearchAssist };
