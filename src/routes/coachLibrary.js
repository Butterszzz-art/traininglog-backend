// Coach libraries: reusable workouts and the vault.
//
// Workouts are single training sessions a coach keeps to drop into programs
// (the dashboard's program builder inserts their rows into a day). They are
// one day of a pocketcoach.program/2 program and are validated by the same
// code as programs.
//
// The vault holds links to guides, PDFs and other resources (links only, like
// coach videos), in optional folders, shared with all clients or chosen ones.
//
// Storage (both under the coach, removed with the coach's account):
//   coaches/{coachUid}/workouts/{id}  { name, focus, notes, exercises: [...], updatedAt }
//   coaches/{coachUid}/vault/{id}     { title, url, description, folder,
//                                       audience: 'all'|'selected', clientUids: [], createdAt }
//
// Routes:
//   /api/coach/workouts   GET /, PUT /:id { name, focus?, notes?, exercises }, DELETE /:id
//   /api/coach/vault      GET /, POST / { title, url, description?, folder?, audience, clientUids? }, DELETE /:id
//   /api/client/coach-vault   GET /   items from active coaches meant for the caller
'use strict';

const express = require('express');
const crypto = require('crypto');

const ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;
const MAX_WORKOUTS = 300;
const MAX_VAULT = 300;
const MAX_CLIENTS = 500;

const line = (v, max) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');

function cleanUrl(v) {
  const s = typeof v === 'string' ? v.trim() : '';
  if (!s || s.length > 2000) return '';
  try {
    const u = new URL(s);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : '';
  } catch { return ''; }
}

// sanitizeProgram: coachShare.sanitizeCoachProgram. → { workout } or { error }
function sanitizeWorkout(body, sanitizeProgram) {
  const b = body && typeof body === 'object' ? body : {};
  const name = line(b.name, 80);
  if (!name) return { error: 'Give the workout a name.' };
  const program = sanitizeProgram({
    schema: 'pocketcoach.program/2', name,
    weeks: [{ days: [{ dayId: 'd1', weekday: null, label: name, focus: b.focus, notes: b.notes, exercises: Array.isArray(b.exercises) ? b.exercises : [] }] }],
  });
  const day = program && program.weeks && program.weeks[0] && program.weeks[0].days[0];
  if (!day || !day.exercises.length) return { error: 'Add at least one exercise to the workout.' };
  return { workout: { name, focus: day.focus || '', notes: day.notes || '', exercises: day.exercises } };
}

// → { item } or { error }
function sanitizeVaultItem(body) {
  const b = body && typeof body === 'object' ? body : {};
  const title = line(b.title, 120);
  if (!title) return { error: 'A title is required.' };
  const url = cleanUrl(b.url);
  if (!url) return { error: 'Paste the full link (starting with https://).' };
  const audience = b.audience === 'selected' ? 'selected' : 'all';
  const clientUids = audience === 'selected'
    ? [...new Set((Array.isArray(b.clientUids) ? b.clientUids : []).map(String).map(s => s.trim()).filter(s => s && !s.includes('/')))]
    : [];
  if (audience === 'selected' && !clientUids.length) return { error: 'Pick at least one client.' };
  if (clientUids.length > MAX_CLIENTS) return { error: 'Too many clients selected.' };
  return { item: { title, url, description: line(b.description, 500), folder: line(b.folder, 40), audience, clientUids } };
}

const isFor = (item, clientUid) => item.audience !== 'selected' || (Array.isArray(item.clientUids) && item.clientUids.includes(clientUid));
const byName = (a, b) => String(a.name || '').localeCompare(String(b.name || ''));
const newestFirst = (a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || ''));

function helpers({ sendError, resolveCallerUid }, code) {
  return {
    uidOf: async (req, res) => {
      const uid = await resolveCallerUid(req.user);
      if (!uid) sendError(res, 409, 'coach.not_migrated', 'Your account needs to complete migration first. Contact support.');
      return uid;
    },
    fail: (res, where, err, message) => {
      console.error(`${where} failed:`, err && err.message);
      return sendError(res, 500, `${code}.server_error`, message);
    },
  };
}

function createCoachWorkoutsRouter({ db, sendError, sendSuccess, resolveCallerUid, sanitizeProgram, now = () => new Date() }) {
  const router = express.Router();
  const { uidOf, fail } = helpers({ sendError, resolveCallerUid }, 'workouts');

  router.get('/', async (req, res) => {
    try {
      const uid = await uidOf(req, res);
      if (!uid) return undefined;
      const snap = await db.collection(`coaches/${uid}/workouts`).get();
      return sendSuccess(res, 200, { workouts: snap.docs.map(d => ({ id: d.id, ...d.data() })).sort(byName) });
    } catch (err) { return fail(res, 'GET /api/coach/workouts', err, 'Could not load your workouts.'); }
  });

  router.put('/:id', async (req, res) => {
    try {
      const id = String(req.params.id || '');
      if (!ID_RE.test(id)) return sendError(res, 422, 'workouts.invalid_id', 'Invalid workout id.');
      const r = sanitizeWorkout(req.body, sanitizeProgram);
      if (r.error) return sendError(res, 422, 'workouts.invalid', r.error);
      const uid = await uidOf(req, res);
      if (!uid) return undefined;
      const coll = db.collection(`coaches/${uid}/workouts`);
      const ref = coll.doc(id);
      if (!(await ref.get()).exists && (await coll.get()).docs.length >= MAX_WORKOUTS) {
        return sendError(res, 409, 'workouts.too_many', `You have ${MAX_WORKOUTS} workouts. Remove one first.`);
      }
      const saved = { ...r.workout, updatedAt: now().toISOString() };
      await ref.set(saved);
      return sendSuccess(res, 200, { workout: { id, ...saved } });
    } catch (err) { return fail(res, 'PUT /api/coach/workouts/:id', err, 'Could not save the workout.'); }
  });

  router.delete('/:id', async (req, res) => {
    try {
      const id = String(req.params.id || '');
      if (!ID_RE.test(id)) return sendError(res, 404, 'workouts.not_found', 'Workout not found.');
      const uid = await uidOf(req, res);
      if (!uid) return undefined;
      await db.collection(`coaches/${uid}/workouts`).doc(id).delete();
      return sendSuccess(res, 200, { deleted: id });
    } catch (err) { return fail(res, 'DELETE /api/coach/workouts/:id', err, 'Could not delete the workout.'); }
  });

  return router;
}

// notifyResource({ coachUsername, clients: [{ uid, name }], title })
function createCoachVaultRouter({ db, sendError, sendSuccess, resolveCallerUid, notifyResource, now = () => new Date() }) {
  const router = express.Router();
  const { uidOf, fail } = helpers({ sendError, resolveCallerUid }, 'vault');

  router.get('/', async (req, res) => {
    try {
      const uid = await uidOf(req, res);
      if (!uid) return undefined;
      const snap = await db.collection(`coaches/${uid}/vault`).get();
      return sendSuccess(res, 200, { items: snap.docs.map(d => ({ id: d.id, ...d.data() })).sort(newestFirst) });
    } catch (err) { return fail(res, 'GET /api/coach/vault', err, 'Could not load your vault.'); }
  });

  router.post('/', async (req, res) => {
    try {
      const r = sanitizeVaultItem(req.body);
      if (r.error) return sendError(res, 422, 'vault.invalid', r.error);
      const uid = await uidOf(req, res);
      if (!uid) return undefined;
      const coll = db.collection(`coaches/${uid}/vault`);
      if ((await coll.get()).docs.length >= MAX_VAULT) return sendError(res, 409, 'vault.too_many', `Your vault holds ${MAX_VAULT} items. Remove one first.`);
      const roster = await db.collection(`coaches/${uid}/clients`).get();
      const active = roster.docs.filter(d => (d.get('status') || '') === 'active');
      if (r.item.audience === 'selected') {
        const known = new Set(active.map(d => d.id));
        r.item.clientUids = r.item.clientUids.filter(c => known.has(c));
        if (!r.item.clientUids.length) return sendError(res, 422, 'vault.invalid', 'Pick at least one active client.');
      }
      const id = `res_${crypto.randomBytes(10).toString('hex')}`;
      const saved = { ...r.item, createdAt: now().toISOString() };
      await coll.doc(id).set(saved);
      const clients = active.filter(d => isFor(saved, d.id)).map(d => ({ uid: d.id, name: d.get('athleteDisplayName') || '' }));
      if (notifyResource && clients.length) {
        try { await notifyResource({ coachUsername: req.user.username, clients, title: saved.title }); } catch (err) { console.error('[coachVault] notify failed:', err.message); }
      }
      return sendSuccess(res, 201, { item: { id, ...saved } });
    } catch (err) { return fail(res, 'POST /api/coach/vault', err, 'Could not save it.'); }
  });

  router.delete('/:id', async (req, res) => {
    try {
      const id = String(req.params.id || '');
      if (!ID_RE.test(id)) return sendError(res, 404, 'vault.not_found', 'Item not found.');
      const uid = await uidOf(req, res);
      if (!uid) return undefined;
      await db.collection(`coaches/${uid}/vault`).doc(id).delete();
      return sendSuccess(res, 200, { deleted: id });
    } catch (err) { return fail(res, 'DELETE /api/coach/vault/:id', err, 'Could not remove it.'); }
  });

  return router;
}

function createClientCoachVaultRouter({ db, sendError, sendSuccess, resolveCallerUid }) {
  const router = express.Router();
  const { uidOf, fail } = helpers({ sendError, resolveCallerUid }, 'vault');

  router.get('/', async (req, res) => {
    try {
      const clientUid = await uidOf(req, res);
      if (!clientUid) return undefined;
      const invites = await db.collection(`users/${clientUid}/coachInvites`).where('status', '==', 'active').get();
      const lists = await Promise.all(invites.docs.map(async inv => {
        const snap = await db.collection(`coaches/${inv.id}/vault`).get();
        return snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(x => isFor(x, clientUid)).map(x => ({
          id: x.id, coachUid: inv.id, coachUsername: inv.get('coachUsername') || '',
          title: x.title, url: x.url, description: x.description || '', folder: x.folder || '', createdAt: x.createdAt,
        }));
      }));
      return sendSuccess(res, 200, { items: lists.flat().sort(newestFirst) });
    } catch (err) { return fail(res, 'GET /api/client/coach-vault', err, 'Could not load your coach\'s resources.'); }
  });

  return router;
}

module.exports = {
  sanitizeWorkout, sanitizeVaultItem, MAX_WORKOUTS, MAX_VAULT,
  createCoachWorkoutsRouter, createCoachVaultRouter, createClientCoachVaultRouter,
};
