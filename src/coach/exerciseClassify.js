/* =============================================================
   Exercise classification — POST /api/ai/classify-exercises

   The app places exercise names on muscle groups itself (catalog,
   abbreviations, typo correction, keyword rules — exerciseMuscleMap.js
   in TrainingLog-mobile). Names it still can't place ("Larsen press",
   "Spoto press", a coach's house name) come here in one batch. The
   model may only answer with a group from MUSCLE_GROUPS; anything else,
   or a name the model wasn't asked about, is dropped, so whatever a
   user typed into a name can't steer the answer outside that list.
   The app saves each answer once and never asks about the name again.
   ============================================================= */

const { createMessage, jsonOutput, perModelTimeoutMs, MODELS } = require('./client');

// Must match CUSTOM_MUSCLE_GROUPS in the app's src/js/customExercises.js.
const MUSCLE_GROUPS = [
  'chest', 'back', 'shoulders', 'traps', 'biceps', 'triceps', 'forearms',
  'quads', 'hamstrings', 'glutes', 'calves', 'abductors', 'adductors', 'abs',
];
const MAX_NAMES = 40;
const MAX_NAME_LENGTH = 80;
const MODEL = MODELS.fast;

const SYSTEM = `You classify gym exercise names by the muscle group they train most.
Names come from lifters' logs and coaches' programs: they may be abbreviated, misspelled, in another language, or a named variation (e.g. "Larsen press", "Spoto press", "JM press", "Meadows row").
For each name, pick the ONE primary group from this list and nothing else:
${MUSCLE_GROUPS.join(', ')}
Rules:
- Compound lifts go to the prime mover: squats and leg presses → quads, hinges like RDLs and good mornings → hamstrings, deadlifts and rows → back, presses → chest or shoulders by angle.
- If a name is not a resistance exercise (cardio, stretching, a sport) or you cannot tell what it is, give muscleGroup null.
- confidence is 0–1: how sure you are this is a real exercise AND the group is right.
- canonicalName is the standard English name of the exercise in Title Case, or null if unknown.
Respond ONLY with JSON: {"results":[{"name":string,"muscleGroup":string|null,"confidence":number,"canonicalName":string|null}]}, one entry per input name, name copied exactly.`;

const SCHEMA = {
  type: 'object',
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          muscleGroup: { anyOf: [{ type: 'string', enum: MUSCLE_GROUPS }, { type: 'null' }] },
          confidence: { type: 'number' },
          canonicalName: { anyOf: [{ type: 'string' }, { type: 'null' }] },
        },
        required: ['name', 'muscleGroup', 'confidence', 'canonicalName'],
        additionalProperties: false,
      },
    },
  },
  required: ['results'],
  additionalProperties: false,
};

/** Trimmed, de-duplicated (case-insensitively) names, or an error string. */
function cleanNames(input) {
  if (!Array.isArray(input) || !input.length) return { error: 'names must be a non-empty array.' };
  const seen = new Set();
  const names = [];
  input.forEach((n) => {
    if (typeof n !== 'string') return;
    const name = n.trim().replace(/\s+/g, ' ').slice(0, MAX_NAME_LENGTH);
    const key = name.toLowerCase();
    if (!name || seen.has(key)) return;
    seen.add(key);
    names.push(name);
  });
  if (!names.length) return { error: 'names must contain at least one exercise name.' };
  if (names.length > MAX_NAMES) return { error: `At most ${MAX_NAMES} names per request.` };
  return { names };
}

/**
 * The model's reply → one result per requested name, in request order.
 * Groups outside MUSCLE_GROUPS become null; names the model invented or
 * skipped come back as unclassified rather than missing.
 */
function parseReply(text, names) {
  let parsed = null;
  try {
    const json = String(text || '').replace(/^[\s\S]*?(\{)/, '$1').replace(/\}[^}]*$/, '}');
    parsed = JSON.parse(json);
  } catch { /* unreadable → everything unclassified */ }
  const byName = new Map();
  (Array.isArray(parsed && parsed.results) ? parsed.results : []).forEach((r) => {
    if (r && typeof r.name === 'string') byName.set(r.name.trim().toLowerCase(), r);
  });
  return names.map((name) => {
    const r = byName.get(name.toLowerCase()) || {};
    const group = typeof r.muscleGroup === 'string' ? r.muscleGroup.trim().toLowerCase() : null;
    const muscleGroup = MUSCLE_GROUPS.includes(group) ? group : null;
    const conf = Number(r.confidence);
    const confidence = muscleGroup && Number.isFinite(conf) ? Math.min(1, Math.max(0, conf)) : 0;
    const canonicalName = muscleGroup && typeof r.canonicalName === 'string' && r.canonicalName.trim()
      ? r.canonicalName.trim().slice(0, MAX_NAME_LENGTH)
      : null;
    return { name, muscleGroup, confidence, canonicalName };
  });
}

async function classifyExercises(names) {
  const reply = await createMessage(MODEL, {
    // Room for reasoning models to think before the JSON; still inside
    // Groq's short-call budget (see groq.js).
    max_tokens: 2000,
    system: SYSTEM,
    output_config: jsonOutput(SCHEMA, 'low'),
    messages: [{ role: 'user', content: JSON.stringify({ names }) }],
  }, { timeoutMs: perModelTimeoutMs(30000, 30000) });
  const text = reply.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  return parseReply(text, names);
}

module.exports = { MUSCLE_GROUPS, MAX_NAMES, cleanNames, parseReply, classifyExercises };
