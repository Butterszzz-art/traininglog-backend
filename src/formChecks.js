// Form checks: a client sends their coach a video of a lift (a link, like
// coach videos: Loom, YouTube, Drive or a video file), and the coach answers
// with comments, each optionally pinned to a moment in the video. The client
// can write back under it.
//
// Storage (server-only, see firestore.rules):
//   formChecks/{id}  { coachUid, coachUsername, clientUid, clientName, exercise,
//                      videoUrl, note, status: 'pending'|'reviewed', createdAt,
//                      comments: [{ author: 'coach'|'client', text, atSeconds?, createdAt }] }
//
// Routes (createRouters):
//   client  GET    /api/client/form-checks
//           POST   /api/client/form-checks                { exercise, videoUrl, note?, coachUid? }
//           POST   /api/client/form-checks/:id/comments   { text }
//           DELETE /api/client/form-checks/:id
//   coach   GET    /api/coach/form-checks                 every client's, waiting ones first
//           POST   /api/coach/form-checks/:id/comments    { text, atSeconds? }  (marks it reviewed)
// Form checks are deleted when the coach ↔ client link ends and with either account.
'use strict';

const express = require('express');
const { cleanComment } = require('./checkInComments');

const FORM_CHECKS = 'formChecks';
const MAX_PER_CLIENT = 30;
const MAX_COMMENTS = 50;
const EXERCISE_MAX = 80;
const NOTE_MAX = 500;
const URL_MAX = 2000;
const MAX_SECONDS = 4 * 60 * 60;

const line = (value, max) => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '');

function cleanUrl(value) {
  const s = typeof value === 'string' ? value.trim() : '';
  if (!s || s.length > URL_MAX) return '';
  try {
    const u = new URL(s);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : '';
  } catch { return ''; }
}

// Whole seconds into the video, or null. Accepts a number or "m:ss".
function cleanSeconds(value) {
  if (value === undefined || value === null || value === '') return null;
  let n = Number(value);
  const m = typeof value === 'string' && /^(\d{1,3}):([0-5]\d)$/.exec(value.trim());
  if (m) n = Number(m[1]) * 60 + Number(m[2]);
  return Number.isFinite(n) && n >= 0 && n <= MAX_SECONDS ? Math.floor(n) : undefined;
}

function out(id, d) {
  return {
    id, coachUid: d.coachUid, coachUsername: d.coachUsername || '', clientUid: d.clientUid, clientName: d.clientName || '',
    exercise: d.exercise, videoUrl: d.videoUrl, note: d.note || '', status: d.status === 'reviewed' ? 'reviewed' : 'pending',
    createdAt: d.createdAt, comments: Array.isArray(d.comments) ? d.comments : [],
  };
}

const newestFirst = (a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || ''));

// One coach ↔ client pair (unlink), or everything for a client or for a
// coach (account deletion).
async function deleteFormChecks(db, { coachUid, clientUid }) {
  let docs;
  if (clientUid) {
    docs = (await db.collection(FORM_CHECKS).where('clientUid', '==', clientUid).get()).docs;
    if (coachUid) docs = docs.filter(d => d.get('coachUid') === coachUid);
  } else if (coachUid) {
    docs = (await db.collection(FORM_CHECKS).where('coachUid', '==', coachUid).get()).docs;
  } else return 0;
  await Promise.all(docs.map(d => d.ref.delete()));
  return docs.length;
}

function createRouters({
  db, sendError, sendSuccess, resolveCallerUid,
  usernameForUid = async () => '',
  notifySent = async () => {}, notifyReviewed = async () => {},
  now = () => new Date(),
}) {
  const fail = (res, where, err, message) => {
    console.error(`${where} failed:`, err && err.message);
    return sendError(res, 500, 'formchecks.server_error', message);
  };
  const callerUid = async (req, res) => {
    const uid = await resolveCallerUid(req.user);
    if (!uid) sendError(res, 409, 'coach.not_migrated', 'Your account needs to complete migration first. Contact support.');
    return uid;
  };
  const activeCoaches = async clientUid => {
    const snap = await db.collection(`users/${clientUid}/coachInvites`).where('status', '==', 'active').get();
    return snap.docs.map(d => ({ uid: d.id, username: d.get('coachUsername') || '' }));
  };
  // The form check, if it belongs to the caller on the given side.
  const owned = async (req, res, side, uid) => {
    const id = String(req.params.id || '').trim();
    const ref = id && !id.includes('/') ? db.collection(FORM_CHECKS).doc(id) : null;
    const snap = ref ? await ref.get() : null;
    if (!snap || !snap.exists || snap.get(side) !== uid) { sendError(res, 404, 'formchecks.not_found', 'That form check was not found.'); return null; }
    return { ref, data: snap.data() || {} };
  };
  const addComment = async (found, comment) => {
    const comments = [...(Array.isArray(found.data.comments) ? found.data.comments : []), comment].slice(-MAX_COMMENTS);
    const status = comment.author === 'coach' ? 'reviewed' : found.data.status === 'reviewed' ? 'reviewed' : 'pending';
    await found.ref.set({ comments, status }, { merge: true });
    return out(found.ref.id, { ...found.data, comments, status });
  };

  // ── Client (mounted at /api/client/form-checks) ──
  const client = express.Router();

  client.get('/', async (req, res) => {
    try {
      const uid = await callerUid(req, res);
      if (!uid) return;
      const coaches = await activeCoaches(uid);
      const allow = new Set(coaches.map(c => c.uid));
      const snap = await db.collection(FORM_CHECKS).where('clientUid', '==', uid).get();
      const formChecks = snap.docs.filter(d => allow.has(d.get('coachUid'))).map(d => out(d.id, d.data() || {})).sort(newestFirst);
      return sendSuccess(res, 200, { formChecks, coaches });
    } catch (err) { return fail(res, 'GET /api/client/form-checks', err, 'Could not load your form checks.'); }
  });

  client.post('/', async (req, res) => {
    try {
      const uid = await callerUid(req, res);
      if (!uid) return;
      const b = req.body || {};
      const exercise = line(b.exercise, EXERCISE_MAX);
      if (!exercise) return sendError(res, 422, 'formchecks.missing_exercise', 'Say which exercise this is.');
      const videoUrl = cleanUrl(b.videoUrl);
      if (!videoUrl) return sendError(res, 422, 'formchecks.invalid_url', 'Paste the full video link (starting with https://).');
      const coaches = await activeCoaches(uid);
      if (!coaches.length) return sendError(res, 409, 'formchecks.no_coach', 'You are not linked to a coach.');
      const wanted = typeof b.coachUid === 'string' ? b.coachUid : '';
      const coach = wanted ? coaches.find(c => c.uid === wanted) : coaches.length === 1 ? coaches[0] : null;
      if (!coach) return sendError(res, 422, 'formchecks.pick_coach', 'Choose which coach to send it to.');
      const mine = (await db.collection(FORM_CHECKS).where('clientUid', '==', uid).get()).docs;
      if (mine.length >= MAX_PER_CLIENT) return sendError(res, 409, 'formchecks.too_many', `You have ${MAX_PER_CLIENT} form checks. Remove an old one first.`);
      const coachUsername = coach.username || await usernameForUid(coach.uid);
      const ref = db.collection(FORM_CHECKS).doc();
      const doc = {
        coachUid: coach.uid, coachUsername, clientUid: uid, clientName: String(req.user.username || '').slice(0, 40),
        exercise, videoUrl, note: cleanComment(b.note).slice(0, NOTE_MAX), status: 'pending',
        createdAt: now().toISOString(), comments: [],
      };
      await ref.set(doc);
      await notifySent({ coachUsername, clientUsername: req.user.username, clientUid: uid, exercise });
      return sendSuccess(res, 201, { formCheck: out(ref.id, doc) });
    } catch (err) { return fail(res, 'POST /api/client/form-checks', err, 'Could not send your form check.'); }
  });

  client.post('/:id/comments', async (req, res) => {
    try {
      const uid = await callerUid(req, res);
      if (!uid) return;
      const found = await owned(req, res, 'clientUid', uid);
      if (!found) return;
      const text = cleanComment(req.body && req.body.text);
      if (!text) return sendError(res, 422, 'formchecks.empty', 'Write a reply first.');
      const formCheck = await addComment(found, { author: 'client', text, createdAt: now().toISOString() });
      return sendSuccess(res, 201, { formCheck });
    } catch (err) { return fail(res, 'POST /api/client/form-checks/:id/comments', err, 'Could not send your reply.'); }
  });

  client.delete('/:id', async (req, res) => {
    try {
      const uid = await callerUid(req, res);
      if (!uid) return;
      const found = await owned(req, res, 'clientUid', uid);
      if (!found) return;
      await found.ref.delete();
      return sendSuccess(res, 200, {});
    } catch (err) { return fail(res, 'DELETE /api/client/form-checks/:id', err, 'Could not remove it.'); }
  });

  // ── Coach (mounted at /api/coach/form-checks) ──
  const coach = express.Router();

  coach.get('/', async (req, res) => {
    try {
      const uid = await callerUid(req, res);
      if (!uid) return;
      const snap = await db.collection(FORM_CHECKS).where('coachUid', '==', uid).get();
      const formChecks = snap.docs.map(d => out(d.id, d.data() || {}))
        .sort((a, b) => (a.status === b.status ? newestFirst(a, b) : a.status === 'pending' ? -1 : 1));
      return sendSuccess(res, 200, { formChecks });
    } catch (err) { return fail(res, 'GET /api/coach/form-checks', err, 'Could not load the form checks.'); }
  });

  coach.post('/:id/comments', async (req, res) => {
    try {
      const uid = await callerUid(req, res);
      if (!uid) return;
      const found = await owned(req, res, 'coachUid', uid);
      if (!found) return;
      const text = cleanComment(req.body && req.body.text);
      if (!text) return sendError(res, 422, 'formchecks.empty', 'Write a comment first.');
      const atSeconds = cleanSeconds(req.body && req.body.atSeconds);
      if (atSeconds === undefined) return sendError(res, 422, 'formchecks.invalid_time', 'Give the moment as seconds or m:ss.');
      const comment = { author: 'coach', text, createdAt: now().toISOString() };
      if (atSeconds !== null) comment.atSeconds = atSeconds;
      const formCheck = await addComment(found, comment);
      await notifyReviewed({
        coachUsername: req.user.username,
        clientUsername: found.data.clientName || await usernameForUid(found.data.clientUid),
        exercise: found.data.exercise,
      });
      return sendSuccess(res, 201, { formCheck });
    } catch (err) { return fail(res, 'POST /api/coach/form-checks/:id/comments', err, 'Could not send the comment.'); }
  });

  return { client, coach };
}

module.exports = { FORM_CHECKS, MAX_PER_CLIENT, cleanUrl, cleanSeconds, deleteFormChecks, createRouters };
