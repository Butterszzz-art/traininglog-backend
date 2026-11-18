/* =============================================================
   Describe-to-log — POST /api/ai/food-describe (Pro)

   The user types (or says) what they ate in plain words: "2 eggs, toast
   with butter and a flat white" or "bakje kwark met een banaan". The
   model only splits that into foods and amounts — it never gives
   nutrition numbers — and each food is then looked up in Open Food Facts
   and USDA like a normal search:

     1. the model returns items: { text, search, english, amount, unit, grams }
     2. per item we search OFF with `search` and USDA with `english`, rank
        the merged list, and return the best few to pick from.

   The app shows every item with its best match and amount, the user
   checks or changes them, and only then are they logged.

   Only the description goes to the model, nothing about the user. The
   split is cached per description (7 days), so the same words don't call
   the model again.

   Photo — POST /api/ai/food-photo (Pro): the same, from a photo of the
   meal (and an optional note, "fried in olive oil"). A model that can see
   images names the foods and estimates the amounts; the lookup and the
   check-before-logging are the same. Photos aren't cached or stored.
   ============================================================= */
'use strict';

const foods = require('./foods');
const { createCache } = require('../routes/food');
const { cleanTerm } = require('./searchAssist');

const { MODELS } = require('../coach/client');

// Typed meals: Haiku. Photos: Sonnet, which reads portions and mixed plates
// more reliably.
const MODEL = MODELS.fast;
const PHOTO_MODEL = MODELS.smart;
const MAX_TEXT = 400;
const MAX_ITEMS = 10;
const CANDIDATES = 5;
const PARSE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const UNITS = ['g', 'ml', 'piece', 'slice', 'cup', 'tbsp', 'tsp', 'serving'];
const SERVING_UNITS = new Set(['piece', 'slice', 'cup', 'tbsp', 'tsp']);

const SYSTEM = `You help a food-logging app used mostly in the Netherlands. The user describes what they ate in plain words, in Dutch or English. Split it into separate foods so each can be looked up in two databases: Open Food Facts (supermarket products, Dutch and English names, brands like Albert Heijn/AH, Jumbo, Lidl, Melkunie, Alpro, Arla) and USDA FoodData Central (generic foods, English names only).
Return ONLY JSON:
{"items": [{"text": string, "search": string, "english": string, "amount": number|null, "unit": "g"|"ml"|"piece"|"slice"|"cup"|"tbsp"|"tsp"|"serving"|null, "grams": number|null}]}
- One item per food. "toast with butter" is two items (bread, butter). A ready-made product or dish that's sold or eaten as one thing ("lasagne", "big mac", "Optimel drinkyoghurt") stays one item.
- text: the words for this food as the user wrote them (short).
- search: a short search in the language they used, typos fixed, brand kept (e.g. "magere kwark", "AH volkoren brood").
- english: a short generic English description for USDA (e.g. "quark nonfat", "whole wheat bread"). No brand.
- amount + unit: the amount they said ("2 eggs" → 2, "piece"; "200g rice" → 200, "g"; "a glass of milk" → 1, "cup"). null if they gave none.
- grams: your best estimate of the total weight in grams (ml for drinks) of this item as eaten, using typical portions when they gave no amount (an egg ≈ 50, a slice of bread ≈ 35, butter on toast ≈ 5, a banana ≈ 120, a flat white ≈ 180). Say cooked or dry the way they described it.
- At most ${MAX_ITEMS} items. Ignore words that aren't food or drink. Water, black coffee and tea without anything count as foods only if mentioned.
Keep every string under 60 characters. Never include calories, macros or any other nutrition numbers.`;

const PHOTO_SYSTEM = `You help a food-logging app used mostly in the Netherlands. You get a photo of what someone is about to eat or just ate, sometimes with a note from them. Name each separate food or drink you can see so it can be looked up in two databases: Open Food Facts (supermarket products, Dutch and English names, brands like Albert Heijn/AH, Jumbo, Lidl) and USDA FoodData Central (generic foods, English names only), and estimate how much of it there is.
Return ONLY JSON:
{"items": [{"text": string, "search": string, "english": string, "amount": number|null, "unit": "g"|"ml"|"piece"|"slice"|"cup"|"tbsp"|"tsp"|"serving"|null, "grams": number|null}]}
- One item per food you can see ("rice, chicken, broccoli" = three items). A packaged product with a readable brand or name: use that name. Sauces, oil or butter only if you can see them or the note mentions them.
- text: a short description of what you see ("grilled chicken breast").
- search: a short search in Dutch if the note is Dutch, else English, with the brand if one is readable.
- english: a short generic English description for USDA. No brand.
- amount + unit: only for things you can count ("2 eggs" → 2, "piece"; "3 slices of bread" → 3, "slice"), else null.
- grams: your best estimate of the weight in grams (ml for drinks) of that food on the plate, as served (cooked rice, not dry). Use the plate, cutlery and hands for scale.
- Use the note for things a photo can't show (what's in it, how it was cooked, how much was eaten).
- At most ${MAX_ITEMS} items. If there is no food or drink in the photo, return {"items": []}.
Keep every string under 60 characters. Never include calories, macros or any other nutrition numbers.`;

const MAX_PHOTO_BYTES = 3 * 1024 * 1024;
const MAX_NOTE = 200;

// A photo from the app (a data URL or bare base64) → { mediaType, data }, or
// null when it isn't a JPEG / PNG / WebP image of a sensible size.
function cleanPhoto(v) {
  if (typeof v !== 'string' || v.length < 100) return null;
  const m = /^data:(image\/[a-z+]+);base64,/i.exec(v);
  const data = (m ? v.slice(m[0].length) : v).replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]+=*$/.test(data) || data.length > Math.ceil(MAX_PHOTO_BYTES / 3) * 4) return null;
  const buf = Buffer.from(data, 'base64');
  let mediaType = null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) mediaType = 'image/jpeg';
  else if (buf[0] === 0x89 && buf.subarray(1, 4).toString('latin1') === 'PNG') mediaType = 'image/png';
  else if (buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') mediaType = 'image/webp';
  if (!mediaType || buf.length > MAX_PHOTO_BYTES) return null;
  return { mediaType, data };
}

function cleanNote(v) {
  if (typeof v !== 'string') return '';
  return v.normalize('NFC').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_NOTE);
}

const SCHEMA = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          search: { type: 'string' },
          english: { type: 'string' },
          amount: { anyOf: [{ type: 'number' }, { type: 'null' }] },
          unit: { anyOf: [{ type: 'string', enum: UNITS }, { type: 'null' }] },
          grams: { anyOf: [{ type: 'number' }, { type: 'null' }] },
        },
        required: ['text', 'search', 'english', 'amount', 'unit', 'grams'],
        additionalProperties: false,
      },
    },
  },
  required: ['items'],
  additionalProperties: false,
};

// The description as sent: one line, trimmed, at most MAX_TEXT characters.
function cleanText(v) {
  if (typeof v !== 'string') return null;
  const s = v.normalize('NFC').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);
  return s.length >= 2 ? s : null;
}

const num = (v, min, max) => (typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? Math.round(v * 10) / 10 : null);

// One item from the model → a safe item, or null.
function cleanItem(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const search = cleanTerm(raw.search);
  const english = cleanTerm(raw.english);
  if (search.length < 2 && english.length < 2) return null;
  const unit = UNITS.includes(raw.unit) ? raw.unit : null;
  const amount = num(raw.amount, 0.1, 5000);
  const est = num(raw.grams, 1, 3000);
  const out = {
    text: cleanTerm(raw.text) || search || english,
    search: search.length >= 2 ? search : english,
    english,
    amount: amount !== null && unit ? amount : null,
    unit: amount !== null ? unit : null,
  };
  // Grams to start from: what they said in g/ml, else the estimate.
  if ((out.unit === 'g' || out.unit === 'ml') && out.amount !== null) out.grams = out.amount;
  else if (est !== null) out.grams = est;
  else out.grams = null;
  // Same shape as the app's parseFoodQuery, so it can pick a matching
  // serving ("2 slices" → the food's slice serving × 2).
  if (out.unit === 'ml') out.ml = out.amount;
  if (out.unit && out.unit !== 'g' && out.unit !== 'ml' && out.amount !== null && out.amount <= 50) {
    out.count = out.amount;
    if (SERVING_UNITS.has(out.unit)) out.servingHint = out.unit;
  }
  return out;
}

// The model's reply → items (may be empty), or null when it's unusable.
function parseReply(text) {
  let parsed = null;
  try {
    const json = String(text || '').replace(/^[\s\S]*?(\{)/, '$1').replace(/\}[^}]*$/, '}');
    parsed = JSON.parse(json);
  } catch { return null; }
  if (!parsed || !Array.isArray(parsed.items)) return null;
  return parsed.items.map(cleanItem).filter(Boolean).slice(0, MAX_ITEMS);
}

function createDescribe({ searcher, createMessageFn, streamMessageFn, jsonOutputFn, openModels = () => false, timeoutMs = 20000, photoTimeoutMs = 60000, cache = createCache(2000), log = console } = {}) {
  async function split(text) {
    const key = `d:${text.toLowerCase()}`;
    const hit = cache.get(key);
    if (hit) return hit;
    const reply = await createMessageFn(MODEL, {
      max_tokens: 1200,
      system: SYSTEM,
      output_config: jsonOutputFn ? jsonOutputFn(SCHEMA, 'low') : { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
      messages: [{ role: 'user', content: JSON.stringify({ ate: text }) }],
    }, { timeoutMs });
    const out = parseReply((reply.content || []).filter(b => b.type === 'text').map(b => b.text).join(''));
    if (out && out.length) cache.set(key, out, PARSE_TTL_MS);
    return out;
  }

  async function lookUp(item) {
    const [off, usda] = await Promise.all([
      searcher.search(item.search, { sources: 'off' }).catch(err => { log.warn(`[food-describe] off: ${err.message}`); return { foods: [] }; }),
      item.english.length >= 2
        ? searcher.search(item.english, { sources: 'usda' }).catch(err => { log.warn(`[food-describe] usda: ${err.message}`); return { foods: [] }; })
        : Promise.resolve({ foods: [] }),
    ]);
    const list = foods.rankFoods(item.search, [off.foods, usda.foods], CANDIDATES, item.english);
    return { ...item, foods: list };
  }

  // → { items: [{ text, search, english, amount, unit, grams, count?, servingHint?, ml?, foods }] }
  //   items is empty when the model found no food in the words, and null
  //   when its reply was unusable.
  async function describe(text) {
    const items = await split(text);
    if (!items) return { items: null };
    return { items: await Promise.all(items.map(lookUp)) };
  }

  // Photo → items. Streamed across the model chain so a model that can't
  // take images (or answers without JSON) is skipped for the next one.
  async function splitPhoto(photo, note) {
    const open = openModels();
    const params = {
      max_tokens: open ? 1200 : 4000,
      system: open ? `${PHOTO_SYSTEM}\n\nReply with only the JSON object, no other text.` : PHOTO_SYSTEM,
      output_config: jsonOutputFn ? jsonOutputFn(SCHEMA, 'medium') : { effort: 'medium', format: { type: 'json_schema', schema: SCHEMA } },
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: photo.mediaType, data: photo.data } },
          { type: 'text', text: note ? JSON.stringify({ note }) : 'What food is in this photo?' },
        ],
      }],
    };
    const { reply } = await streamMessageFn(PHOTO_MODEL, params, {
      deadlineMs: photoTimeoutMs,
      idleMs: Math.min(photoTimeoutMs, 45000),
      accept: r => parseReply((r.content || []).filter(b => b.type === 'text').map(b => b.text).join('')) !== null,
      skipStatuses: open ? [400, 404, 413, 415, 422] : [],
    });
    return parseReply((reply.content || []).filter(b => b.type === 'text').map(b => b.text).join(''));
  }

  // → same as describe(); items null when no model gave a usable answer.
  async function describePhoto(photo, note) {
    const items = await splitPhoto(photo, cleanNote(note));
    if (!items) return { items: null };
    return { items: await Promise.all(items.map(lookUp)) };
  }

  return { describe, split, describePhoto };
}

module.exports = { SYSTEM, PHOTO_SYSTEM, SCHEMA, MODEL, PHOTO_MODEL, UNITS, MAX_ITEMS, MAX_PHOTO_BYTES, cleanText, cleanItem, cleanPhoto, cleanNote, parseReply, createDescribe };
