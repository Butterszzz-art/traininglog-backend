// Coach meals and meal plans.
//
// A coach builds meals from foods (their own approved foods or anything from
// the food search), keeps them in a library, and sends a client a meal plan:
// for a training day and a rest day, per slot (breakfast, lunch, dinner,
// snacks) a meal plus up to three alternatives. The client's app fills each
// day's food log with that day's meals, counted; the client confirms, edits
// or swaps them and completes the day.
//
// Meals have the same shape as the app's saved meals (food-core.js
// templateFromEntries), so the app turns them into food-log entries with its
// own code:
//   { id, name, note, items: [{ food: { id, source, name, brand, basis,
//     per100, servings }, grams, amount, unit }] }
//
// Storage:
//   coaches/{coachUid}/meals/{mealId}                    the coach's library
//   users/{clientUid}/coachAssignment/{coachUid}.mealPlan  a snapshot the client follows
//     { key, note, sentAt, days: { training: { breakfast: [meal, alt…], … }, rest: {…} },
//       times?: { breakfast: 'HH:MM', … } }   when to eat each slot (optional;
//       the client's app puts timed meals in their calendar feed)
//
// Routes (mounted at /api/coach/meals, coach plan required):
//   GET    /       the coach's meals
//   PUT    /:id    create or replace one
//   DELETE /:id
// The plan is sent with PATCH /api/coach/clients/:id { mealPlan, message? }.
'use strict';

const express = require('express');
const { sanitizeCoachFood } = require('./coachFoods');

const MEAL_ID_RE = /^[A-Za-z0-9_:-]{1,64}$/;
const SLOTS = ['breakfast', 'lunch', 'dinner', 'snacks'];
const DAY_TYPES = ['training', 'rest'];
const MAX_ITEMS = 25;
const MAX_OPTIONS = 4; // a meal + up to three alternatives
const MAX_MEALS = 300;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

const text = (v, max) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');
const num = v => (v === null || v === undefined || v === '' || typeof v === 'boolean' || !Number.isFinite(Number(v)) ? null : Number(v));

function sanitizeItem(it) {
  const src = it && typeof it === 'object' ? it : {};
  const f = sanitizeCoachFood({ ...(src.food || {}), audience: 'all' });
  if (f.error) return { error: `${text(src.food && src.food.name, 60) || 'A food'}: ${f.error}` };
  const grams = num(src.grams);
  if (grams === null || grams <= 0 || grams > 5000) return { error: `${f.fields.name}: amount must be between 1 and 5000 g.` };
  const { name, brand, basis, per100, servings } = f.fields;
  const food = {
    id: text(src.food.id, 120) || null,
    source: ['coach', 'custom', 'recipe', 'off', 'usda', 'nevo'].includes(src.food.source) ? src.food.source : 'coach',
    name, brand, basis, per100, servings,
  };
  const unit = typeof src.unit === 'string' && (src.unit === basis || servings.some(s => s.label === src.unit)) ? src.unit : basis;
  const amount = num(src.amount);
  return { item: { food, grams: Math.round(grams * 10) / 10, amount: amount !== null && amount > 0 ? Math.round(amount * 100) / 100 : Math.round(grams * 10) / 10, unit } };
}

/** → { meal } or { error } */
function sanitizeMeal(body, id) {
  const b = body && typeof body === 'object' ? body : {};
  const name = text(b.name, 80);
  if (!name) return { error: 'Give the meal a name.' };
  const items = [];
  for (const it of (Array.isArray(b.items) ? b.items : []).slice(0, MAX_ITEMS)) {
    const r = sanitizeItem(it);
    if (r.error) return { error: r.error };
    items.push(r.item);
  }
  if (!items.length) return { error: 'Add at least one food to the meal.' };
  return { meal: { id: text(id || b.id, 64) || null, name, note: text(b.note, 300), items } };
}

/** Macros of a meal (rounded): { kcal, protein, carbs, fat }. */
function mealTotals(meal) {
  const t = { kcal: 0, protein: 0, carbs: 0, fat: 0 };
  (meal.items || []).forEach(it => {
    Object.keys(t).forEach(k => { t[k] += ((it.food.per100[k] || 0) * it.grams) / 100; });
  });
  return { kcal: Math.round(t.kcal), protein: Math.round(t.protein), carbs: Math.round(t.carbs), fat: Math.round(t.fat) };
}

/**
 * → { plan } or { error }. Each slot of each day type: a list of meals, the
 * first the default, the rest alternatives. A missing rest day uses the
 * training day.
 */
function sanitizeMealPlan(body, { now = new Date() } = {}) {
  const b = body && typeof body === 'object' ? body : {};
  const src = b.days && typeof b.days === 'object' ? b.days : {};
  const days = {};
  for (const dt of DAY_TYPES) {
    const d = src[dt] && typeof src[dt] === 'object' ? src[dt] : null;
    if (!d) continue;
    const day = {};
    for (const slot of SLOTS) {
      const options = [];
      for (const [i, m] of (Array.isArray(d[slot]) ? d[slot] : []).slice(0, MAX_OPTIONS).entries()) {
        const r = sanitizeMeal(m, (m && m.id) || `${dt}-${slot}-${i + 1}`);
        if (r.error) return { error: `${dt === 'training' ? 'Training' : 'Rest'} day, ${slot}: ${r.error}` };
        options.push(r.meal);
      }
      if (options.length) day[slot] = options;
    }
    if (Object.keys(day).length) days[dt] = day;
  }
  if (!days.training && !days.rest) return { error: 'Add at least one meal to the plan.' };
  if (!days.training) days.training = days.rest;
  if (!days.rest) days.rest = days.training;
  // Meal times: per slot, 'HH:MM' (24h). Anything else is dropped.
  const times = {};
  const srcTimes = b.times && typeof b.times === 'object' ? b.times : {};
  for (const slot of SLOTS) {
    const t = typeof srcTimes[slot] === 'string' ? srcTimes[slot].trim() : '';
    const m = /^(\d{1,2}):(\d{2})$/.exec(t);
    const norm = m ? `${m[1].padStart(2, '0')}:${m[2]}` : '';
    if (TIME_RE.test(norm)) times[slot] = norm;
  }
  const summary = DAY_TYPES.map(dt => {
    const kcal = SLOTS.reduce((n, s) => n + (days[dt][s] ? mealTotals(days[dt][s][0]).kcal : 0), 0);
    return `${dt === 'training' ? 'Training' : 'Rest'} day ${kcal} kcal`;
  }).join(' · ');
  const plan = { key: `meals:${now.getTime().toString(36)}`, note: text(b.note, 500), sentAt: now.toISOString(), days };
  if (Object.keys(times).length) plan.times = times;
  return { plan, summary };
}

function createCoachMealsRouter({ db, sendError, sendSuccess, resolveCallerUid }) {
  const router = express.Router();
  const coachUidOr409 = async (req, res) => {
    const uid = await resolveCallerUid(req.user);
    if (!uid) sendError(res, 409, 'coach.not_migrated', 'Your account needs to complete migration first. Contact support.');
    return uid;
  };

  router.get('/', async (req, res) => {
    try {
      const uid = await coachUidOr409(req, res);
      if (!uid) return;
      const snap = await db.collection(`coaches/${uid}/meals`).get();
      const meals = snap.docs.map(d => ({ ...d.data(), id: d.id })).map(m => ({ ...m, totals: mealTotals(m) }))
        .sort((a, b) => String(a.name).localeCompare(String(b.name)));
      return sendSuccess(res, 200, { meals });
    } catch (err) {
      console.error('GET /api/coach/meals failed:', err);
      return sendError(res, 500, 'meals.server_error', 'Could not load your meals.');
    }
  });

  router.put('/:id', async (req, res) => {
    try {
      const uid = await coachUidOr409(req, res);
      if (!uid) return;
      const id = String(req.params.id || '');
      if (!MEAL_ID_RE.test(id)) return sendError(res, 422, 'meals.invalid_id', 'Invalid meal id.');
      const r = sanitizeMeal(req.body, id);
      if (r.error) return sendError(res, 422, 'meals.invalid', r.error);
      const ref = db.collection(`coaches/${uid}/meals`).doc(id);
      if (!(await ref.get()).exists) {
        const count = (await db.collection(`coaches/${uid}/meals`).get()).docs.length;
        if (count >= MAX_MEALS) return sendError(res, 422, 'meals.too_many', `You can keep up to ${MAX_MEALS} meals.`);
      }
      const meal = { ...r.meal, id, updatedAt: new Date().toISOString() };
      await ref.set(meal);
      return sendSuccess(res, 200, { meal: { ...meal, totals: mealTotals(meal) } });
    } catch (err) {
      console.error('PUT /api/coach/meals/:id failed:', err);
      return sendError(res, 500, 'meals.server_error', 'Could not save the meal.');
    }
  });

  router.delete('/:id', async (req, res) => {
    try {
      const uid = await coachUidOr409(req, res);
      if (!uid) return;
      const ref = db.collection(`coaches/${uid}/meals`).doc(String(req.params.id || ''));
      if (!(await ref.get()).exists) return sendError(res, 404, 'meals.not_found', 'Meal not found.');
      await ref.delete();
      return sendSuccess(res, 200, { deleted: req.params.id });
    } catch (err) {
      console.error('DELETE /api/coach/meals/:id failed:', err);
      return sendError(res, 500, 'meals.server_error', 'Could not delete the meal.');
    }
  });

  return router;
}

module.exports = { createCoachMealsRouter, sanitizeMeal, sanitizeMealPlan, mealTotals, SLOTS, DAY_TYPES };
