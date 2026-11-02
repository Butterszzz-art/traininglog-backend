// Coach meals and meal plans (src/routes/coachMeals.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { createCoachMealsRouter, sanitizeMeal, sanitizeMealPlan, mealTotals } = require('../src/routes/coachMeals');

const oats = { id: 'oats', source: 'coach', name: 'Oats', basis: 'g', per100: { kcal: 370, protein: 13, carbs: 60, fat: 7 }, servings: [{ label: 'cup', grams: 80 }] };
const whey = { id: 'whey', source: 'off', name: 'Whey isolate', brand: 'X', basis: 'g', per100: { kcal: 370, protein: 90, carbs: 2, fat: 1 }, servings: [] };
const breakfast = { name: 'Oats & whey', items: [{ food: oats, grams: 80, amount: 1, unit: 'cup' }, { food: whey, grams: 30 }] };

test('a meal: foods with grams, totals, units kept only when the food has them', () => {
  const r = sanitizeMeal(breakfast, 'm1');
  assert.equal(r.meal.name, 'Oats & whey');
  assert.deepEqual(r.meal.items.map(i => [i.food.name, i.grams, i.amount, i.unit]), [['Oats', 80, 1, 'cup'], ['Whey isolate', 30, 30, 'g']]);
  assert.deepEqual(mealTotals(r.meal), { kcal: 407, protein: 37, carbs: 49, fat: 6 });
  assert.equal(sanitizeMeal({ ...breakfast, items: [{ food: oats, grams: 80, unit: 'scoop' }] }).meal.items[0].unit, 'g');
});

test('a meal needs a name, foods, sane amounts and real macros', () => {
  assert.match(sanitizeMeal({ items: breakfast.items }).error, /name/);
  assert.match(sanitizeMeal({ name: 'x', items: [] }).error, /at least one food/);
  assert.match(sanitizeMeal({ name: 'x', items: [{ food: oats, grams: 0 }] }).error, /Oats: amount/);
  assert.match(sanitizeMeal({ name: 'x', items: [{ food: { name: 'Bad', per100: { kcal: 100 } }, grams: 50 }] }).error, /Bad: Protein, carbs and fat/);
});

test('a plan: options per slot, a missing day type uses the other, a summary for the coach', () => {
  const lunch = { name: 'Chicken & rice', items: [{ food: { name: 'Chicken', per100: { protein: 31, carbs: 0, fat: 3.6 } }, grams: 200 }] };
  const r = sanitizeMealPlan({ days: { training: { breakfast: [breakfast, { ...breakfast, name: 'Eggs instead' }], lunch: [lunch] } }, note: 'Swap breakfast if you like' }, { now: new Date('2026-11-02T08:00:00Z') });
  assert.equal(r.plan.days.training.breakfast.length, 2);
  assert.equal(r.plan.days.training.breakfast[1].name, 'Eggs instead');
  assert.equal(r.plan.days.rest, r.plan.days.training);
  assert.equal(r.plan.note, 'Swap breakfast if you like');
  assert.match(r.plan.key, /^meals:/);
  assert.equal(r.summary, 'Training day 719 kcal · Rest day 719 kcal');
  assert.match(sanitizeMealPlan({ days: {} }).error, /at least one meal/);
  assert.match(sanitizeMealPlan({ days: { rest: { lunch: [{ name: '', items: [] }] } } }).error, /^Rest day, lunch: Give the meal a name/);
  const many = sanitizeMealPlan({ days: { training: { dinner: Array(6).fill(lunch) } } });
  assert.equal(many.plan.days.training.dinner.length, 4, 'a meal + up to three alternatives');
});

test('library routes: save, list with totals, delete', async () => {
  const docs = new Map();
  const ref = p => ({ get: async () => ({ exists: docs.has(p), data: () => docs.get(p) }), set: async d => { docs.set(p, d); }, delete: async () => { docs.delete(p); } });
  const db = { collection: p => ({ doc: id => ref(`${p}/${id}`), get: async () => ({ docs: [...docs.entries()].filter(([k]) => k.startsWith(`${p}/`)).map(([k, d]) => ({ id: k.split('/').pop(), data: () => d })) }) }) };
  const app = express();
  app.use(express.json());
  app.use((req, _r, next) => { req.user = { uid: 'c1' }; next(); });
  app.use('/api/coach/meals', createCoachMealsRouter({
    db, resolveCallerUid: async u => u.uid,
    sendError: (res, s, code, message) => res.status(s).json({ success: false, error: { code, message } }),
    sendSuccess: (res, s, d = {}) => res.status(s).json({ success: true, ...d }),
  }));
  const srv = app.listen(0);
  const call = async (method, url, body) => { const r = await fetch(`http://127.0.0.1:${srv.address().port}${url}`, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json() }; };
  try {
    let r = await call('PUT', '/api/coach/meals/oats-whey', breakfast);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.meal.totals, { kcal: 407, protein: 37, carbs: 49, fat: 6 });
    assert.equal((await call('PUT', '/api/coach/meals/bad id', breakfast)).status, 422);
    assert.equal((await call('PUT', '/api/coach/meals/x', { name: 'x', items: [] })).status, 422);
    r = await call('GET', '/api/coach/meals');
    assert.deepEqual(r.body.meals.map(m => [m.id, m.name, m.totals.kcal]), [['oats-whey', 'Oats & whey', 407]]);
    assert.equal((await call('DELETE', '/api/coach/meals/oats-whey')).status, 200);
    assert.equal((await call('DELETE', '/api/coach/meals/oats-whey')).status, 404);
  } finally {
    srv.close();
  }
});
