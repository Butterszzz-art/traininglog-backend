const express = require('express');
const { providers, openModels, createMessage, streamMessage, perModelTimeoutMs, modelChain, MODELS } = require('../coach/client');
const { TRAINING_KNOWLEDGE } = require('../knowledge/training-methodology');
const { NUTRITION_KNOWLEDGE } = require('../knowledge/nutrition-methodology');
const exerciseClassify = require('../coach/exerciseClassify');
const { jsonOutput } = require('../coach/client');
const { createSearchAssist, cleanQuery: cleanFoodQuery } = require('../nutrition/searchAssist');
const { createDescribe, cleanText: cleanFoodDescription, cleanPhoto: cleanFoodPhoto } = require('../nutrition/describe');
const { getDefaultSearcher } = require('./food');

const router = express.Router();

// Conversational coach (streaming, tool use) plus /brief, /review, /body —
// see src/routes/coach.js.
router.use('/coach', require('./coach'));

// Anthropic model ids; with open models (Ollama / OpenRouter),
// src/coach/client.js maps every call onto its model chain instead.
const MODEL = MODELS.smart;
const MODEL_FAST = MODELS.fast;
// Models reason before answering (current Claude models think by default),
// and that counts against max_tokens; these floors keep short answers from
// coming back empty. The prompts themselves keep the answers short.
const OPEN_MODEL_MIN_TOKENS = 4096;
const CLAUDE_MIN_TOKENS = 2048;

const BASE_SYSTEM = `You are an expert fitness coach inside Pocket Coach. Your advice is grounded in the following evidence-based methodology. ALWAYS apply these principles — never contradict them with bro-science or outdated advice.\n\n${TRAINING_KNOWLEDGE}\n\n${NUTRITION_KNOWLEDGE}\n\n`;

async function callClaude(systemPrompt, userPrompt, maxTokens = 1024, model = MODEL) {
  try {
    const message = await createMessage(model, {
      max_tokens: Math.max(maxTokens, openModels() ? OPEN_MODEL_MIN_TOKENS : CLAUDE_MIN_TOKENS),
      // Low effort for the short one-paragraph answers, medium for analysis.
      output_config: { effort: model === MODEL_FAST ? 'low' : 'medium' },
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }]
    }, { timeoutMs: perModelTimeoutMs(45000) });
    const text = message.content.filter(b => b.type === 'text').map(b => b.text).join('').trim();
    if (!text) throw new Error('No text content in response');
    return text;
  } catch (err) {
    throw new Error(`AI API error: ${err?.message || String(err)}`);
  }
}

// GET /api/ai/health
router.get('/health', (_req, res) => {
  res.json({ status: 'ok', providers: providers(), model: modelChain(MODEL)[0] || null });
});

// POST /api/ai/chat — general chat endpoint
router.post('/chat', async (req, res) => {
  try {
    const { messages, systemPrompt } = req.body || {};
    if (!Array.isArray(messages) || !messages.length) {
      return res.status(422).json({ success: false, error: 'messages array is required.' });
    }
    const system = BASE_SYSTEM + (systemPrompt || 'Answer the user\'s fitness question using your methodology knowledge.');
    const userPrompt = messages[messages.length - 1]?.content || '';
    const reply = await callClaude(system, userPrompt);
    return res.json({ success: true, reply });
  } catch (err) {
    console.error('POST /api/ai/chat failed:', err.message);
    return res.status(502).json({ success: false, error: err.message });
  }
});

// POST /api/ai/checkin-summary
router.post('/checkin-summary', async (req, res) => {
  const {
    sleep, energy, stress, hunger, digestion, trainingPerformance,
    bodyweightThisWeek, bodyweightLastWeek,
    compliancePercent, adjustmentNotes, goal, archetype,
  } = req.body;

  const required = { sleep, energy, stress, bodyweightThisWeek, compliancePercent, goal, archetype };
  for (const [key, val] of Object.entries(required)) {
    if (val === undefined || val === null || val === '') {
      return res.status(400).json({ error: `Missing required field: ${key}` });
    }
  }

  const delta = bodyweightLastWeek != null
    ? ((bodyweightThisWeek - bodyweightLastWeek) >= 0 ? '+' : '') + (bodyweightThisWeek - bodyweightLastWeek).toFixed(1)
    : 'no prior data';

  const parts = [
    `Summarise this week's check-in for a ${archetype} in a ${goal} phase.`,
    `Sleep: ${sleep}/10, Energy: ${energy}/10, Stress: ${stress}/10.`,
  ];
  if (hunger !== undefined && hunger !== '') parts.push(`Hunger: ${hunger}/10.`);
  if (digestion !== undefined && digestion !== '') parts.push(`Digestion: ${digestion}/10.`);
  if (trainingPerformance !== undefined && trainingPerformance !== '') parts.push(`Training performance: ${trainingPerformance}/10.`);
  parts.push(`Bodyweight: ${bodyweightThisWeek}kg (${delta}kg vs last week).`);
  parts.push(`Weekly compliance: ${compliancePercent}%.`);
  parts.push(`Adjustment notes: ${adjustmentNotes || 'None'}.`);

  const system = BASE_SYSTEM + `You write concise, direct, data-driven check-in summaries. Be factual, encouraging but honest. Never use filler phrases. Reference the specific numbers. Write in second person. Max 3 sentences.`;

  try {
    const summary = (await callClaude(system, parts.join(' '), 256, MODEL_FAST)).trim();
    return res.json({ summary });
  } catch (err) {
    console.error('[AI checkin-summary]', err.message);
    return res.status(502).json({ error: 'AI request failed', details: err.message });
  }
});

// POST /api/ai/macro-advice
const TARGET_RATES = {
  cut: { slow: -0.25, moderate: -0.5, aggressive: -0.75 },
  maintain: { slow: 0, moderate: 0, aggressive: 0 },
  bulk: { slow: 0.15, moderate: 0.25, aggressive: 0.4 },
};

router.post('/macro-advice', async (req, res) => {
  const { currentTargets, goal, ratePreference, bodyweightHistory, averageHunger, sex, archetype } = req.body;
  if (!currentTargets || !goal || !ratePreference) {
    return res.status(400).json({ error: 'Missing required fields: currentTargets, goal, ratePreference' });
  }

  let actualRateKgPerWeek = null;
  if (Array.isArray(bodyweightHistory) && bodyweightHistory.length >= 2) {
    const oldest = bodyweightHistory[0];
    const newest = bodyweightHistory[bodyweightHistory.length - 1];
    const daysDiff = (new Date(newest.date) - new Date(oldest.date)) / 86400000;
    if (daysDiff > 0) actualRateKgPerWeek = ((newest.weight - oldest.weight) / daysDiff) * 7;
  }

  const targetRate = TARGET_RATES[goal]?.[ratePreference] ?? 0;
  const { protein, carbs, fats, calories } = currentTargets;
  const parts = [
    `Advise macro adjustments for a ${sex || 'male'} ${archetype || 'bodybuilder'} in a ${goal} phase (${ratePreference} rate).`,
    `Current targets: ${protein}g protein, ${carbs}g carbs, ${fats}g fats, ${calories} kcal.`,
  ];
  if (actualRateKgPerWeek !== null) parts.push(`Actual weight change: ${actualRateKgPerWeek >= 0 ? '+' : ''}${actualRateKgPerWeek.toFixed(2)} kg/week. Target rate: ${targetRate >= 0 ? '+' : ''}${targetRate} kg/week.`);
  else parts.push(`Insufficient weight history. Target rate: ${targetRate >= 0 ? '+' : ''}${targetRate} kg/week.`);
  if (averageHunger != null) parts.push(`Average hunger: ${averageHunger}/10.`);

  const system = BASE_SYSTEM + `You are also a precision sports nutrition coach. Give specific, data-driven macro adjustment advice with exact numbers. Never give vague advice. Reference the actual trend data. Keep response to 3-4 sentences max. Write in second person. Always end with: TARGETS:{"protein":X,"carbs":X,"fats":X,"calories":X}`;

  try {
    const raw = (await callClaude(system, parts.join(' '), 400, MODEL_FAST)).trim();
    const targetsMatch = raw.match(/TARGETS:\s*(\{[^}]+\})/);
    const advice = raw.replace(/TARGETS:\s*\{[^}]+\}/, '').trim();
    let suggestedTargets = null;
    if (targetsMatch) { try { suggestedTargets = JSON.parse(targetsMatch[1]); } catch {} }
    if (!suggestedTargets) suggestedTargets = { protein, carbs, fats, calories };
    return res.json({ advice, suggestedTargets });
  } catch (err) {
    console.error('[AI macro-advice]', err.message);
    return res.status(502).json({ error: 'AI request failed', details: err.message });
  }
});

// POST /api/ai/program-analysis
function parseProgramAnalysis(text) {
  const verdict = (text.match(/VERDICT:\s*(.+?)(?:\n|$)/i)?.[1] || '').trim();
  const issuesRaw = text.match(/ISSUES:\s*([\s\S]+?)(?=SUGGESTIONS:|$)/i)?.[1] || '';
  const suggestionsRaw = text.match(/SUGGESTIONS:\s*([\s\S]+?)$/i)?.[1] || '';
  function bullets(raw) {
    return raw.split('\n').map(l => l.replace(/^[\s•\-*\d.]+/, '').trim()).filter(l => l.length > 0 && !/^none\s+identified$/i.test(l));
  }
  return { verdict, issues: bullets(issuesRaw), suggestions: bullets(suggestionsRaw) };
}

router.post('/program-analysis', async (req, res) => {
  const { program, trainingMode, experienceLevel, goal, daysPerWeek } = req.body;
  if (!program || !Array.isArray(program.days)) return res.status(400).json({ error: 'Missing program.days' });

  const programText = program.days.map((day, i) => {
    const dayLabel = `Day ${i + 1}${day.name ? ` - ${day.name}` : ''}`;
    const exList = (day.exercises || []).map(ex => {
      const p = [ex.name || 'Unknown'];
      if (ex.sets) p.push(`${ex.sets}×${ex.reps || '?'}`);
      if (ex.restSeconds) p.push(`${ex.restSeconds}s rest`);
      return p.join(' ');
    });
    return `${dayLabel}: ${exList.join(', ') || 'No exercises'}`;
  }).join('\n');

  const system = BASE_SYSTEM + `Review this training program. Identify specific structural issues based on the methodology above: exercise selection criteria violations, volume imbalances, recovery gaps, and progression problems. Be direct. Format: VERDICT: one sentence\nISSUES: bullet list 2-4\nSUGGESTIONS: bullet list 2-4`;

  try {
    const raw = (await callClaude(system, `Analyse this ${trainingMode || 'general'} program for a ${experienceLevel || 'intermediate'} athlete targeting ${goal || 'general fitness'}, ${daysPerWeek || program.days.length} days/week:\n\n${programText}`, 512, MODEL_FAST)).trim();
    return res.json(parseProgramAnalysis(raw));
  } catch (err) {
    console.error('[AI program-analysis]', err.message);
    return res.status(502).json({ error: 'AI request failed', details: err.message });
  }
});

// POST /api/ai/generate-program
router.post('/generate-program', async (req, res) => {
  const { goal, daysPerWeek, sessionLengthMinutes, equipment, trainingMode, experienceLevel, focusAreas, currentMaxes } = req.body;
  if (!goal || !daysPerWeek) return res.status(400).json({ error: 'Missing: goal, daysPerWeek' });

  const parts = [`Goal: ${goal}`, `Days/week: ${daysPerWeek}`, `Session: ${sessionLengthMinutes || 60} min`, `Mode: ${trainingMode || 'general'}`, `Level: ${experienceLevel || 'intermediate'}`, `Equipment: ${Array.isArray(equipment) && equipment.length ? equipment.join(', ') : 'full gym'}`];
  if (focusAreas) parts.push(`Focus: ${focusAreas}`);
  if (currentMaxes) {
    const m = [];
    if (currentMaxes.squat) m.push(`squat ${currentMaxes.squat}kg`);
    if (currentMaxes.bench) m.push(`bench ${currentMaxes.bench}kg`);
    if (currentMaxes.deadlift) m.push(`deadlift ${currentMaxes.deadlift}kg`);
    if (m.length) parts.push(`1RMs: ${m.join(', ')}`);
  }
  parts.push(`Generate exactly ${daysPerWeek} training days.`);

  const system = BASE_SYSTEM + `Generate a program following the exercise selection criteria, volume/frequency guidelines, and training structure principles from the methodology above. Apply proper exercise order (priority → compound → heavy first → antagonistic supersets → combo sets). Respond ONLY with valid JSON: {"name":string,"daysPerWeek":number,"days":[{"name":string,"focus":string,"exercises":[{"name":string,"sets":number,"reps":string,"restSeconds":number,"notes":string}]}],"progressionNotes":string,"deloadRecommendation":string}`;

  try {
    const raw = (await callClaude(system, parts.join('\n'), 2048, MODEL_FAST)).trim();
    const jsonStr = raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
    let prog;
    try { prog = JSON.parse(jsonStr); } catch { return res.status(502).json({ error: 'AI returned invalid JSON' }); }
    if (!prog.name || !Array.isArray(prog.days) || !prog.days.length) return res.status(502).json({ error: 'Incomplete program' });

    prog.days = prog.days.map((day, i) => ({
      name: String(day.name || `Day ${i + 1}`),
      focus: String(day.focus || ''),
      exercises: Array.isArray(day.exercises) ? day.exercises.map(ex => ({
        name: String(ex.name || 'Exercise'), sets: Math.max(1, Number(ex.sets) || 3),
        reps: String(ex.reps || '8-12'), restSeconds: Math.max(30, Number(ex.restSeconds) || 90),
        notes: String(ex.notes || ''),
      })) : [],
    }));

    return res.json({ name: String(prog.name), daysPerWeek: Number(prog.daysPerWeek) || daysPerWeek, days: prog.days, progressionNotes: String(prog.progressionNotes || ''), deloadRecommendation: String(prog.deloadRecommendation || '') });
  } catch (err) {
    console.error('[AI generate-program]', err.message);
    return res.status(502).json({ error: 'AI request failed', details: err.message });
  }
});

// POST /api/ai/plateau-check
router.post('/plateau-check', async (req, res) => {
  const { recentLogs, bodyweightHistory, trainingMode, recentPerformanceScores } = req.body;
  if (!Array.isArray(recentLogs) && !Array.isArray(bodyweightHistory)) return res.status(400).json({ error: 'Missing training data' });

  const logText = Array.isArray(recentLogs) && recentLogs.length ? recentLogs.map(s => `${s.date}:\n${(s.exercises || []).map(ex => `  ${ex.name}: ${ex.sets}×${ex.reps} @ ${ex.weightKg}kg`).join('\n') || '  (none)'}`).join('\n\n') : 'No workout data.';
  const bwText = Array.isArray(bodyweightHistory) && bodyweightHistory.length ? bodyweightHistory.map(e => `${e.date}: ${e.weight}kg`).join(', ') : 'No bodyweight data.';
  const perfText = Array.isArray(recentPerformanceScores) && recentPerformanceScores.length ? `Performance scores: ${recentPerformanceScores.join(', ')}/10` : '';

  const system = `You are analysing training data to detect plateaus. Look for: no weight/volume increase over 4+ weeks, bodyweight stalling, declining performance. Only report if clear evidence. Respond ONLY with valid JSON: {"plateauDetected":boolean,"stall":string|null,"duration":string|null,"suggestion":string|null}`;

  try {
    const raw = (await callClaude(system, `Mode: ${trainingMode || 'general'}\n\nWORKOUTS:\n${logText}\n\nBODYWEIGHT: ${bwText}\n\n${perfText}`, 256, MODEL_FAST)).trim();
    const jsonStr = raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
    let result;
    try { result = JSON.parse(jsonStr); } catch { return res.json({ plateauDetected: false, stall: null, duration: null, suggestion: null }); }
    return res.json({ plateauDetected: Boolean(result.plateauDetected), stall: result.stall || null, duration: result.duration || null, suggestion: result.suggestion || null });
  } catch (err) {
    console.error('[AI plateau-check]', err.message);
    return res.status(502).json({ error: 'AI request failed', details: err.message });
  }
});

// POST /api/ai/coach-draft-message
router.post('/coach-draft-message', async (req, res) => {
  const { clientName, archetype, currentPhase, compliancePercent, checkIn, bodyweightChange, alerts, currentProgramSummary, currentNutritionSummary, coachNotes } = req.body;
  if (!clientName) return res.status(400).json({ error: 'Missing: clientName' });

  const firstName = clientName.split(' ')[0];
  const parts = [`Draft a check-in response for ${firstName}, a ${archetype || 'athlete'} in a ${currentPhase || 'general'} phase.`, `Compliance: ${compliancePercent ?? '?'}%.`];
  if (checkIn) {
    const m = [];
    if (checkIn.sleep != null) m.push(`sleep ${checkIn.sleep}/10`);
    if (checkIn.energy != null) m.push(`energy ${checkIn.energy}/10`);
    if (checkIn.stress != null) m.push(`stress ${checkIn.stress}/10`);
    if (checkIn.hunger != null) m.push(`hunger ${checkIn.hunger}/10`);
    if (checkIn.trainingPerformance != null) m.push(`training ${checkIn.trainingPerformance}/10`);
    if (m.length) parts.push(`Metrics: ${m.join(', ')}.`);
  }
  if (bodyweightChange != null) parts.push(`BW change: ${Number(bodyweightChange) >= 0 ? '+' : ''}${Number(bodyweightChange).toFixed(1)} kg.`);
  if (Array.isArray(alerts) && alerts.length) parts.push(`Alerts: ${alerts.map(a => `${a.label} (${a.reason})`).join('; ')}.`);
  if (currentProgramSummary) parts.push(`Program: ${currentProgramSummary}.`);
  if (currentNutritionSummary) parts.push(`Nutrition: ${currentNutritionSummary}.`);
  if (coachNotes) parts.push(`Coach notes: ${coachNotes}.`);

  const system = `You are drafting a weekly check-in response on behalf of a fitness coach. Write in a professional but warm tone. Be specific, reference actual numbers. No generic encouragement. Under 150 words. Natural prose. Start with the athlete's first name.`;

  try {
    const draft = (await callClaude(system, parts.join(' '), 300, MODEL_FAST)).trim();
    return res.json({ draft });
  } catch (err) {
    console.error('[AI coach-draft-message]', err.message);
    return res.status(502).json({ error: 'AI request failed', details: err.message });
  }
});

// POST /api/ai/profile-summary
router.post('/profile-summary', async (req, res) => {
  const { archetype, experienceLevel, goal, daysPerWeek, sex, bodyweight, unit } = req.body;
  if (!archetype) return res.status(400).json({ error: 'Missing: archetype' });

  const parts = [`Generate a personalized training profile summary for:`, `Archetype: ${archetype}`, `Experience: ${experienceLevel || 'intermediate'}`, `Goal: ${goal || 'general fitness'}`];
  if (daysPerWeek) parts.push(`Days: ${daysPerWeek}/week`);
  if (sex) parts.push(`Sex: ${sex}`);
  if (bodyweight && unit) parts.push(`BW: ${bodyweight}${unit}`);

  const system = BASE_SYSTEM + `Create a personalized profile summary based on the methodology above. Respond ONLY with valid JSON: {"philosophy":string,"splitRecommendation":string,"weeklyStructure":string,"keyFocusAreas":[string],"estimatedSessionLength":string,"coachNote":string}`;

  try {
    const raw = (await callClaude(system, parts.join('\n'), 512, MODEL_FAST)).trim();
    const jsonStr = raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
    let profile;
    try { profile = JSON.parse(jsonStr); } catch { return res.status(502).json({ error: 'AI returned invalid JSON' }); }
    return res.json({ philosophy: String(profile.philosophy || ''), splitRecommendation: String(profile.splitRecommendation || ''), weeklyStructure: String(profile.weeklyStructure || ''), keyFocusAreas: Array.isArray(profile.keyFocusAreas) ? profile.keyFocusAreas.map(String) : [], estimatedSessionLength: String(profile.estimatedSessionLength || ''), coachNote: String(profile.coachNote || '') });
  } catch (err) {
    console.error('[AI profile-summary]', err.message);
    return res.status(502).json({ error: 'AI request failed', details: err.message });
  }
});

// POST /api/ai/sleep-insight
router.post('/sleep-insight', async (req, res) => {
  const { sleepLog, archetype } = req.body;
  if (!Array.isArray(sleepLog) || sleepLog.length < 3) return res.status(400).json({ error: 'Need at least 3 sleep entries' });

  const avgDuration = sleepLog.reduce((s, e) => s + (e.duration || 0), 0) / sleepLog.length;
  const avgQuality = sleepLog.reduce((s, e) => s + (e.quality || 3), 0) / sleepLog.length;
  const allTags = sleepLog.flatMap(e => e.tags || []);
  const tagCounts = {};
  allTags.forEach(t => { tagCounts[t] = (tagCounts[t] || 0) + 1; });
  const topTags = Object.entries(tagCounts).sort((a, b) => b[1] - a[1]).slice(0, 3);
  const entries = sleepLog.slice(0, 10).map(e => `${e.date}: ${e.duration?.toFixed(1)}h, quality ${e.quality}/5${e.tags?.length ? ` [${e.tags.join(', ')}]` : ''}`).join('\n');

  const prompt = [`Analyse sleep data for a ${archetype || 'hybrid'} athlete.`, `Avg duration: ${avgDuration.toFixed(1)}h. Avg quality: ${avgQuality.toFixed(1)}/5.`, topTags.length ? `Common factors: ${topTags.map(([t, c]) => `${t} (${c}x)`).join(', ')}.` : '', '', 'Recent entries:', entries].join('\n');
  const system = BASE_SYSTEM + `Analyse sleep data and provide one actionable insight. Reference specific numbers. Relate sleep to training recovery based on the methodology above and the athlete's archetype. 2-3 sentences max. Second person.`;

  try {
    const insight = (await callClaude(system, prompt, 200, MODEL_FAST)).trim();
    return res.json({ insight });
  } catch (err) {
    console.error('[AI sleep-insight]', err.message);
    return res.status(502).json({ error: 'AI request failed', details: err.message });
  }
});

// POST /api/ai/classify-exercises — { names: string[] } →
// { results: [{ name, muscleGroup|null, confidence, canonicalName|null }] }.
// The app's fallback for exercise names it can't place on a muscle group
// itself; see src/coach/exerciseClassify.js.
router.post('/classify-exercises', async (req, res) => {
  const { names, error } = exerciseClassify.cleanNames((req.body || {}).names);
  if (error) return res.status(422).json({ success: false, error });
  try {
    const results = await exerciseClassify.classifyExercises(names);
    return res.json({ success: true, results });
  } catch (err) {
    console.error('[AI classify-exercises]', err.message);
    return res.status(502).json({ success: false, error: 'AI request failed', details: err.message });
  }
});

// POST /api/ai/food-search-assist — { q } → { rewrite: { corrected, english,
// brand, alternatives } | null, foods, sources }. The app calls this when the
// normal food search finds nothing good; see src/nutrition/searchAssist.js.
let foodSearchAssist = null;
router.post('/food-search-assist', async (req, res) => {
  const q = cleanFoodQuery((req.body || {}).q);
  if (!q) return res.status(422).json({ success: false, error: 'Type at least 2 characters.' });
  try {
    if (!foodSearchAssist) {
      foodSearchAssist = createSearchAssist({
        searcher: getDefaultSearcher(), createMessageFn: createMessage, jsonOutputFn: jsonOutput,
        timeoutMs: perModelTimeoutMs(8000, 15000),
      });
    }
    const out = await foodSearchAssist.assist(q);
    return res.json({ success: true, ...out });
  } catch (err) {
    console.error('[AI food-search-assist]', err.message);
    return res.status(502).json({ success: false, error: 'AI search is unavailable right now.' });
  }
});

// POST /api/ai/food-describe — { text } → { items: [{ text, search, english,
// amount, unit, grams, count?, servingHint?, ml?, foods }] }. "What did you
// eat" in plain words → foods to confirm; see src/nutrition/describe.js.
let foodDescribe = null;
function getFoodDescribe() {
  if (!foodDescribe) {
    foodDescribe = createDescribe({
      searcher: getDefaultSearcher(), createMessageFn: createMessage, streamMessageFn: streamMessage,
      jsonOutputFn: jsonOutput, openModels,
      timeoutMs: perModelTimeoutMs(10000, 20000),
      photoTimeoutMs: perModelTimeoutMs(60000, 60000),
    });
  }
  return foodDescribe;
}
router.post('/food-describe', async (req, res) => {
  const text = cleanFoodDescription((req.body || {}).text);
  if (!text) return res.status(422).json({ success: false, error: 'Describe what you ate.' });
  try {
    const out = await getFoodDescribe().describe(text);
    if (!out.items) return res.status(502).json({ success: false, error: 'Could not read that. Try listing the foods, e.g. "2 eggs, 1 slice of toast".' });
    return res.json({ success: true, items: out.items });
  } catch (err) {
    console.error('[AI food-describe]', err.message);
    return res.status(502).json({ success: false, error: 'AI logging is unavailable right now.' });
  }
});

// POST /api/ai/food-photo — { image (JPEG/PNG/WebP data URL, ≤ 3 MB), note? }
// → same as food-describe. A photo of the meal → foods to confirm. The photo
// is only passed to the model, never stored.
router.post('/food-photo', async (req, res) => {
  const body = req.body || {};
  const photo = cleanFoodPhoto(body.image);
  if (!photo) return res.status(422).json({ success: false, error: 'That photo can’t be used. Try a JPEG or PNG under 3 MB.' });
  try {
    const out = await getFoodDescribe().describePhoto(photo, body.note);
    if (!out.items) return res.status(502).json({ success: false, error: 'Couldn’t read the photo. Try another one, or describe the meal in words.' });
    return res.json({ success: true, items: out.items });
  } catch (err) {
    console.error('[AI food-photo]', err.message);
    return res.status(502).json({ success: false, error: 'Photo logging is unavailable right now. Try again, or describe the meal in words.' });
  }
});

// POST /api/ai/rehab-plan
router.post('/rehab-plan', async (req, res) => {
  const { bodyPart, injuryType, severity, daysSinceInjury, status, archetype } = req.body;
  if (!bodyPart || !injuryType) return res.status(400).json({ error: 'Missing: bodyPart, injuryType' });

  const prompt = `Generate a rehab plan for a ${archetype || 'hybrid'} athlete with a ${injuryType} in their ${bodyPart}. Severity: ${severity || 3}/5. Days since injury: ${daysSinceInjury || 'unknown'}. Status: ${status || 'active'}. Provide phase-appropriate exercises and progression criteria.`;
  const system = BASE_SYSTEM + `Generate a concise rehab recommendation grounded in the methodology above. Include: (1) phase assessment, (2) 3-4 exercises with sets/reps/hold times, (3) what to avoid, (4) when to progress. Tailor to athlete's archetype. Under 200 words. Second person.`;

  try {
    const plan = (await callClaude(system, prompt, 350, MODEL_FAST)).trim();
    return res.json({ plan });
  } catch (err) {
    console.error('[AI rehab-plan]', err.message);
    return res.status(502).json({ error: 'AI request failed', details: err.message });
  }
});

module.exports = { router, callClaude };
