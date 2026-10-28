// Coach-approved foods: a coach keeps a curated list of foods and recipes
// (checked numbers, the products they actually recommend) and shares it with
// all clients or chosen ones. In those clients' food search these rank first,
// marked "Coach". Clients can't change them (they can copy one into their own
// foods), so a coach's food never overwrites a client's own food or the
// other way round.
//
// Storage (server-only, see firestore.rules):
//   coaches/{coachUid}/foods/{foodId}
//     { name, brand, barcode?, basis, per100: {...}, servings: [...],
//       note, audience: 'all'|'selected', clientUids: [], createdAt, updatedAt }
//
// Coach routes (mounted at /api/coach/foods, coach plan required):
//   GET    /          the coach's foods
//   PUT    /:id       create or replace one ({ name, per100, ... })
//   DELETE /:id
// Client route (mounted at /api/client/coach-foods):
//   GET    /          foods from every active coach that are meant for the caller
'use strict';

const express = require('express');

const FOOD_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const UID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_FOODS = 500;
const MAX_CLIENTS = 500;
const NUTRIENT_LIMITS = {
  kcal: 950, protein: 100, carbs: 100, fat: 100, fiber: 100, sugar: 100, satFat: 100,
  sodiumMg: 50000, ironMg: 1000, calciumMg: 10000, potassiumMg: 20000, magnesiumMg: 5000, vitDUg: 2500, b12Ug: 10000,
};

const text = (v, max) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');

function num(v) {
  if (v === null || v === undefined || v === '' || typeof v === 'boolean') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// → { fields } or { error }
function sanitizeCoachFood(body) {
  const b = body && typeof body === 'object' ? body : {};
  const name = text(b.name, 120);
  if (!name) return { error: 'A name is required.' };
  const src = b.per100 && typeof b.per100 === 'object' ? b.per100 : {};
  const per100 = {};
  for (const [k, max] of Object.entries(NUTRIENT_LIMITS)) {
    const v = num(src[k]);
    if (v === null) continue;
    if (v < 0 || v > max) return { error: `${k} per 100 is out of range.` };
    per100[k] = k === 'kcal' ? Math.round(v) : Math.round(v * 10) / 10;
  }
  for (const k of ['protein', 'carbs', 'fat']) if (per100[k] === undefined) return { error: 'Protein, carbs and fat per 100 are required.' };
  if (per100.kcal === undefined) per100.kcal = Math.round(per100.protein * 4 + per100.carbs * 4 + per100.fat * 9);
  if (per100.protein + per100.carbs + per100.fat > 101) return { error: 'Protein, carbs and fat add up to more than 100 per 100.' };
  const servings = (Array.isArray(b.servings) ? b.servings : [])
    .map(s => ({ label: text(s && s.label, 60), grams: num(s && s.grams) }))
    .filter(s => s.label && s.grams > 0 && s.grams <= 5000)
    .slice(0, 10);
  const barcode = String(b.barcode || '').replace(/\D/g, '');
  const audience = b.audience === 'selected' ? 'selected' : 'all';
  const clientUids = audience === 'selected'
    ? [...new Set((Array.isArray(b.clientUids) ? b.clientUids : []).map(String).filter(u => UID_RE.test(u)))]
    : [];
  if (audience === 'selected' && !clientUids.length) return { error: 'Pick at least one client.' };
  if (clientUids.length > MAX_CLIENTS) return { error: 'Too many clients selected.' };
  return {
    fields: {
      name,
      brand: text(b.brand, 80),
      ...([8, 13, 14].includes(barcode.length) ? { barcode } : {}),
      basis: b.basis === 'ml' ? 'ml' : 'g',
      per100,
      servings,
      note: text(b.note, 300),
      audience,
      clientUids,
    },
  };
}

function isFor(food, clientUid) {
  return food.audience !== 'selected' || (Array.isArray(food.clientUids) && food.clientUids.includes(clientUid));
}

// What a client gets: the food in the app's shape, no audience details.
function forClient(id, coachUid, coachUsername, f) {
  return {
    id: `coach:${coachUid}:${id}`,
    source: 'coach',
    name: f.name,
    brand: f.brand || '',
    ...(f.barcode ? { barcode: f.barcode } : {}),
    basis: f.basis || 'g',
    per100: f.per100,
    servings: f.servings || [],
    note: f.note || '',
    coachUsername,
    updatedAt: f.updatedAt || f.createdAt || null,
  };
}

function createCoachFoodsRouter({ db, sendError, sendSuccess, resolveCallerUid, now = () => new Date() }) {
  const router = express.Router();

  async function coachUid(req, res) {
    const uid = await resolveCallerUid(req.user);
    if (!uid) sendError(res, 409, 'coach.not_migrated', 'Your account needs to complete migration first. Contact support.');
    return uid;
  }

  router.get('/', async (req, res) => {
    try {
      const uid = await coachUid(req, res);
      if (!uid) return undefined;
      const snap = await db.collection(`coaches/${uid}/foods`).get();
      const foods = snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => a.name.localeCompare(b.name));
      return sendSuccess(res, 200, { foods });
    } catch (err) {
      console.error('GET /api/coach/foods failed:', err);
      return sendError(res, 500, 'foods.server_error', 'Could not load your foods.');
    }
  });

  router.put('/:id', async (req, res) => {
    const id = String(req.params.id || '');
    if (!FOOD_ID_RE.test(id)) return sendError(res, 422, 'foods.invalid_id', 'Invalid food id.');
    const { fields, error } = sanitizeCoachFood(req.body);
    if (error) return sendError(res, 422, 'foods.invalid_payload', error);
    try {
      const uid = await coachUid(req, res);
      if (!uid) return undefined;
      const col = db.collection(`coaches/${uid}/foods`);
      const ref = col.doc(id);
      const existing = await ref.get();
      if (!existing.exists) {
        const count = (await col.get()).docs.length;
        if (count >= MAX_FOODS) return sendError(res, 409, 'foods.limit', `You can keep up to ${MAX_FOODS} foods.`);
      }
      // Only clients on the coach's roster can be picked.
      if (fields.audience === 'selected') {
        const roster = await db.collection(`coaches/${uid}/clients`).get();
        const linked = new Set(roster.docs.map(d => d.id));
        fields.clientUids = fields.clientUids.filter(u => linked.has(u));
        if (!fields.clientUids.length) return sendError(res, 422, 'foods.invalid_payload', 'Pick at least one of your clients.');
      }
      const ts = now().toISOString();
      const saved = { ...fields, createdAt: existing.exists ? existing.get('createdAt') || ts : ts, updatedAt: ts };
      await ref.set(saved);
      return sendSuccess(res, existing.exists ? 200 : 201, { food: { id, ...saved } });
    } catch (err) {
      console.error('PUT /api/coach/foods/:id failed:', err);
      return sendError(res, 500, 'foods.server_error', 'Could not save the food.');
    }
  });

  router.delete('/:id', async (req, res) => {
    const id = String(req.params.id || '');
    if (!FOOD_ID_RE.test(id)) return sendError(res, 422, 'foods.invalid_id', 'Invalid food id.');
    try {
      const uid = await coachUid(req, res);
      if (!uid) return undefined;
      await db.collection(`coaches/${uid}/foods`).doc(id).delete();
      return sendSuccess(res, 200, { deleted: true });
    } catch (err) {
      console.error('DELETE /api/coach/foods/:id failed:', err);
      return sendError(res, 500, 'foods.server_error', 'Could not delete the food.');
    }
  });

  return router;
}

function createClientCoachFoodsRouter({ db, sendError, sendSuccess, resolveCallerUid }) {
  const router = express.Router();

  router.get('/', async (req, res) => {
    try {
      const clientUid = await resolveCallerUid(req.user);
      if (!clientUid) return sendError(res, 409, 'coach.not_migrated', 'Your account needs to complete migration first. Contact support.');
      const invites = await db.collection(`users/${clientUid}/coachInvites`).where('status', '==', 'active').get();
      const lists = await Promise.all(invites.docs.map(async inv => {
        // Both sides of the link must be active.
        const roster = await db.collection(`coaches/${inv.id}/clients`).doc(clientUid).get();
        if (!roster.exists || roster.get('status') !== 'active') return [];
        const snap = await db.collection(`coaches/${inv.id}/foods`).get();
        const coachUsername = inv.get('coachUsername') || '';
        return snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(f => isFor(f, clientUid))
          .map(f => forClient(f.id, inv.id, coachUsername, f));
      }));
      return sendSuccess(res, 200, { foods: lists.flat().sort((a, b) => a.name.localeCompare(b.name)) });
    } catch (err) {
      console.error('GET /api/client/coach-foods failed:', err);
      return sendError(res, 500, 'foods.server_error', 'Could not load your coach\'s foods.');
    }
  });

  return router;
}

module.exports = { createCoachFoodsRouter, createClientCoachFoodsRouter, sanitizeCoachFood, isFor };
