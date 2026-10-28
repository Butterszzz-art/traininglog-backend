/* =============================================================
   Weekly "Nutrition and performance" review —
   POST /api/ai/coach/nutrition-review (Pro, via /api/ai)

   The app computes the facts itself (TrainingLog-mobile
   src/js/nutrition-insights.js): week averages, real maintenance from
   intake and weight trend, training volume on high- vs low-carb days,
   protein per meal, 7-day micro averages, and supplement candidates —
   each candidate tied to something in the data. It also sends its own
   rules-based review, which is what the athlete sees without AI and the
   fallback here.

   The model only rewrites that into a short coaching review. Guardrails:
   - supplements: only ids from SUPPLEMENTS that the app listed as a
     candidate for this athlete; anything else is dropped. No doses.
   - lines are length-capped; kinds are an enum.
   ============================================================= */
'use strict';

const SUPPLEMENTS = {
  vitamin_d: 'Vitamin D',
  creatine: 'Creatine monohydrate',
  protein_powder: 'Protein powder',
  omega_3: 'Omega-3 (fish or algae oil)',
  iron: 'Iron',
  vitamin_b12: 'Vitamin B12',
};
const KINDS = ['work_on', 'keeps_working', 'think_about'];
const MAX_ITEMS = 5;
const MAX_TEXT = 220;
const MAX_FACTS_BYTES = 20000;

const INSTRUCTIONS = `You write the "Nutrition and performance" section of the weekly review in Pocket Coach, a training and physique-coaching app used mostly in the Netherlands. You get a JSON object of facts computed from the athlete's food log, daily macros, bodyweight and training, plus a rules-based draft.

Write:
- headline: one sentence (max 140 characters), the single most useful takeaway for next week. Cite a number from the facts.
- items: 3-5 points, each { kind, text }:
  • "work_on": something to change, concrete and doable (e.g. "Add a 30 g protein breakfast: skyr with oats"). Max 2.
  • "keeps_working": something going well that they should keep doing. Max 2.
  • "think_about": context that matters for decisions, e.g. real maintenance vs the target, weight trend vs their goal.
  Each text max 200 characters, cites numbers from the facts, Dutch supermarket foods are fine as examples.
- supplements: 0-3 entries { id, why }, ONLY ids from facts.supplementCandidates, with a one-sentence reason based on the facts. Never give doses, brands or medical claims. Never suggest anything not in that list.

Rules: only use numbers that are in the facts; if a fact is missing, don't guess it. If maintenance is a "rough" estimate, say so. No calorie advice below ~1,500 kcal or faster loss than ~1% bodyweight per week. No greetings, no emoji. This is coaching, not medical advice.

Reply with only a JSON object:
{"headline": string, "items": [{"kind": "work_on"|"keeps_working"|"think_about", "text": string}], "supplements": [{"id": string, "why": string}]}`;

const SCHEMA = {
  type: 'object',
  properties: {
    headline: { type: 'string' },
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: { kind: { type: 'string', enum: KINDS }, text: { type: 'string' } },
        required: ['kind', 'text'],
        additionalProperties: false,
      },
    },
    supplements: {
      type: 'array',
      items: {
        type: 'object',
        properties: { id: { type: 'string', enum: Object.keys(SUPPLEMENTS) }, why: { type: 'string' } },
        required: ['id', 'why'],
        additionalProperties: false,
      },
    },
  },
  required: ['headline', 'items', 'supplements'],
  additionalProperties: false,
};

const clean = (v, max) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');

// → { facts } or { error }
function checkFacts(facts) {
  if (!facts || typeof facts !== 'object' || Array.isArray(facts)) return { error: 'facts are required' };
  if (JSON.stringify(facts).length > MAX_FACTS_BYTES) return { error: 'facts are too large' };
  return { facts };
}

// The ids the app listed for this athlete, limited to the known ones.
function allowedSupplements(facts) {
  const list = Array.isArray(facts && facts.supplementCandidates) ? facts.supplementCandidates : [];
  return new Set(list.map(s => s && s.id).filter(id => Object.prototype.hasOwnProperty.call(SUPPLEMENTS, id)));
}

// The app's rules-based draft, cleaned the same way (the fallback).
function cleanRules(rules, facts) {
  const r = rules && typeof rules === 'object' ? rules : {};
  const allowed = allowedSupplements(facts);
  return {
    headline: clean(r.headline, 160),
    items: (Array.isArray(r.items) ? r.items : [])
      .filter(i => i && KINDS.includes(i.kind) && clean(i.text, MAX_TEXT))
      .slice(0, MAX_ITEMS)
      .map(i => ({ kind: i.kind, text: clean(i.text, MAX_TEXT) })),
    supplements: (Array.isArray(r.supplements) ? r.supplements : [])
      .filter(s => s && allowed.has(s.id))
      .slice(0, 3)
      .map(s => ({ id: s.id, name: SUPPLEMENTS[s.id], why: clean(s.why, 160) })),
  };
}

// The model's JSON → a safe review, or null when unusable.
function parseReview(obj, facts) {
  if (!obj || typeof obj !== 'object') return null;
  const headline = clean(obj.headline, 160);
  const items = (Array.isArray(obj.items) ? obj.items : [])
    .filter(i => i && KINDS.includes(i.kind) && clean(i.text, MAX_TEXT));
  // At most 2 of each of work_on / keeps_working, then the rest.
  const counts = {};
  const kept = items.filter(i => {
    counts[i.kind] = (counts[i.kind] || 0) + 1;
    return i.kind === 'think_about' || counts[i.kind] <= 2;
  }).slice(0, MAX_ITEMS).map(i => ({ kind: i.kind, text: clean(i.text, MAX_TEXT) }));
  if (!headline || !kept.length) return null;
  const allowed = allowedSupplements(facts);
  const seen = new Set();
  const supplements = (Array.isArray(obj.supplements) ? obj.supplements : [])
    .filter(s => s && allowed.has(s.id) && !seen.has(s.id) && seen.add(s.id))
    .slice(0, 3)
    .map(s => ({ id: s.id, name: SUPPLEMENTS[s.id], why: clean(s.why, 160) || '' }));
  return { headline, items: kept, supplements };
}

module.exports = { SUPPLEMENTS, KINDS, INSTRUCTIONS, SCHEMA, checkFacts, cleanRules, parseReview, allowedSupplements };
