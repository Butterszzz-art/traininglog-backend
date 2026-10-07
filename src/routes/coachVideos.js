// Coach videos: a coach shares a video link (Loom, YouTube, Vimeo, Drive or a
// plain video file) explaining the program, the diet, cardio or anything
// else, with all of their clients or with chosen ones. The app plays the
// link inline; nothing is uploaded here, only the link is stored.
//
// Separate from the per-exercise technique videos (/coach/exercise-videos in
// server.js), which stay keyed by exercise name for the Log tab's Watch hint.
//
// Storage (server-only, see firestore.rules):
//   coaches/{coachUid}/videos/{videoId}
//     { title, category, videoUrl, message, audience: 'all'|'selected',
//       clientUids: [], createdAt, updatedAt }   (ISO strings)
//
// Coach routes (mounted at /api/coach/videos, coach plan required):
//   GET    /          the coach's videos, newest first
//   POST   /          { title, category, videoUrl, message?, audience, clientUids? }
//   PATCH  /:id       same fields, all optional
//   DELETE /:id
// Client route (mounted at /api/client/coach-videos):
//   GET    /          videos from every active coach that are meant for the caller
'use strict';

const express = require('express');
const crypto = require('crypto');

const CATEGORIES = ['program', 'diet', 'cardio', 'technique', 'general'];
const TITLE_MAX = 120;
const MESSAGE_MAX = 2000;
const URL_MAX = 2000;
const MAX_VIDEOS = 300;
const MAX_CLIENTS = 500;
const VIDEO_ID_RE = /^vid_[0-9a-f]{20}$/;

function cleanUrl(v) {
  const s = typeof v === 'string' ? v.trim() : '';
  if (!s || s.length > URL_MAX) return null;
  try {
    const u = new URL(s);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : null;
  } catch { return null; }
}

// Returns { fields } or { error: message }. `partial` allows missing fields
// (PATCH); whatever is present is still validated.
function sanitizeVideo(body, { partial = false } = {}) {
  const b = body && typeof body === 'object' ? body : {};
  const fields = {};
  const has = k => b[k] !== undefined;

  if (has('title') || !partial) {
    const title = typeof b.title === 'string' ? b.title.trim().slice(0, TITLE_MAX) : '';
    if (!title) return { error: 'A title is required.' };
    fields.title = title;
  }
  if (has('category') || !partial) {
    const category = typeof b.category === 'string' ? b.category.trim().toLowerCase() : 'general';
    if (!CATEGORIES.includes(category)) return { error: `category must be one of ${CATEGORIES.join(', ')}.` };
    fields.category = category;
  }
  if (has('videoUrl') || !partial) {
    const videoUrl = cleanUrl(b.videoUrl);
    if (!videoUrl) return { error: 'videoUrl must be an http(s) link.' };
    fields.videoUrl = videoUrl;
  }
  if (has('message') || !partial) {
    fields.message = typeof b.message === 'string' ? b.message.trim().slice(0, MESSAGE_MAX) : '';
  }
  if (has('audience') || has('clientUids') || !partial) {
    const audience = b.audience === 'selected' ? 'selected' : 'all';
    const clientUids = audience === 'selected'
      ? [...new Set((Array.isArray(b.clientUids) ? b.clientUids : []).map(String).map(s => s.trim()).filter(s => s && !s.includes('/')))]
      : [];
    if (audience === 'selected' && !clientUids.length) return { error: 'Pick at least one client.' };
    if (clientUids.length > MAX_CLIENTS) return { error: 'Too many clients selected.' };
    fields.audience = audience;
    fields.clientUids = clientUids;
  }
  return { fields };
}

function isFor(video, clientUid) {
  return video.audience !== 'selected' || (Array.isArray(video.clientUids) && video.clientUids.includes(clientUid));
}

const newestFirst = (a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || ''));

// deps: { db, sendError, sendSuccess, resolveCallerUid, now?,
//         notifyVideo?: ({ coachUsername, clients: [{ uid, name }], title }) => Promise }
function createCoachVideosRouter({ db, sendError, sendSuccess, resolveCallerUid, notifyVideo, now = () => new Date() }) {
  const router = express.Router();

  async function coachUid(req, res) {
    const uid = await resolveCallerUid(req.user);
    if (!uid) sendError(res, 409, 'coach.not_migrated', 'Your account needs to complete migration first. Contact support.');
    return uid;
  }

  // Linked clients ({ uid: { name, status } }) — the only people a coach can
  // address a video to.
  async function roster(uid) {
    const snap = await db.collection(`coaches/${uid}/clients`).get();
    const out = {};
    snap.docs.forEach(d => { out[d.id] = { name: d.get('athleteDisplayName') || '', status: d.get('status') || '' }; });
    return out;
  }

  // Active clients the video reaches, minus `skip` (already told).
  function recipients(video, clients, skip = new Set()) {
    return Object.entries(clients)
      .filter(([cuid, c]) => c.status === 'active' && !skip.has(cuid) && isFor(video, cuid))
      .map(([cuid, c]) => ({ uid: cuid, name: c.name }));
  }

  async function tell(req, video, list) {
    if (!notifyVideo || !list.length) return;
    try {
      await notifyVideo({ coachUsername: req.user.username, clients: list, title: video.title });
    } catch (err) {
      console.error('[coachVideos] notify failed:', err.message);
    }
  }

  router.get('/', async (req, res) => {
    try {
      const uid = await coachUid(req, res);
      if (!uid) return undefined;
      const snap = await db.collection(`coaches/${uid}/videos`).get();
      const videos = snap.docs.map(d => ({ id: d.id, ...d.data() })).sort(newestFirst);
      return sendSuccess(res, 200, { videos });
    } catch (err) {
      console.error('GET /api/coach/videos failed:', err);
      return sendError(res, 500, 'videos.server_error', 'Could not load your videos.');
    }
  });

  router.post('/', async (req, res) => {
    try {
      const { fields, error } = sanitizeVideo(req.body);
      if (error) return sendError(res, 422, 'videos.invalid_payload', error);
      const uid = await coachUid(req, res);
      if (!uid) return undefined;

      const [existing, clients] = await Promise.all([db.collection(`coaches/${uid}/videos`).get(), roster(uid)]);
      if (existing.docs.length >= MAX_VIDEOS) {
        return sendError(res, 422, 'videos.limit', `You can keep up to ${MAX_VIDEOS} videos. Delete an old one first.`);
      }
      const unknown = fields.clientUids.filter(c => !clients[c]);
      if (unknown.length) return sendError(res, 422, 'videos.unknown_client', 'One of the chosen clients is not on your roster.');

      const at = now().toISOString();
      const id = `vid_${crypto.randomBytes(10).toString('hex')}`;
      const video = { ...fields, createdAt: at, updatedAt: at };
      await db.collection(`coaches/${uid}/videos`).doc(id).set(video);
      const sentTo = recipients(video, clients);
      await tell(req, video, sentTo);
      return sendSuccess(res, 201, { video: { id, ...video }, notified: sentTo.length });
    } catch (err) {
      console.error('POST /api/coach/videos failed:', err);
      return sendError(res, 500, 'videos.server_error', 'Could not save the video.');
    }
  });

  router.patch('/:id', async (req, res) => {
    try {
      const id = String(req.params.id || '');
      if (!VIDEO_ID_RE.test(id)) return sendError(res, 404, 'videos.not_found', 'Video not found.');
      const { fields, error } = sanitizeVideo(req.body, { partial: true });
      if (error) return sendError(res, 422, 'videos.invalid_payload', error);
      if (!Object.keys(fields).length) return sendError(res, 422, 'videos.invalid_payload', 'Nothing to update.');
      const uid = await coachUid(req, res);
      if (!uid) return undefined;

      const ref = db.collection(`coaches/${uid}/videos`).doc(id);
      const snap = await ref.get();
      if (!snap.exists) return sendError(res, 404, 'videos.not_found', 'Video not found.');
      const clients = await roster(uid);
      if (fields.clientUids && fields.clientUids.some(c => !clients[c])) {
        return sendError(res, 422, 'videos.unknown_client', 'One of the chosen clients is not on your roster.');
      }

      const before = snap.data();
      const video = { ...before, ...fields, updatedAt: now().toISOString() };
      await ref.set(video);
      // Only clients who couldn't see it before hear about it.
      const alreadyTold = new Set(recipients(before, clients).map(c => c.uid));
      const sentTo = recipients(video, clients, alreadyTold);
      await tell(req, video, sentTo);
      return sendSuccess(res, 200, { video: { id, ...video }, notified: sentTo.length });
    } catch (err) {
      console.error('PATCH /api/coach/videos/:id failed:', err);
      return sendError(res, 500, 'videos.server_error', 'Could not update the video.');
    }
  });

  router.delete('/:id', async (req, res) => {
    try {
      const id = String(req.params.id || '');
      if (!VIDEO_ID_RE.test(id)) return sendError(res, 404, 'videos.not_found', 'Video not found.');
      const uid = await coachUid(req, res);
      if (!uid) return undefined;
      const ref = db.collection(`coaches/${uid}/videos`).doc(id);
      if (!(await ref.get()).exists) return sendError(res, 404, 'videos.not_found', 'Video not found.');
      await ref.delete();
      return sendSuccess(res, 200, { deleted: id });
    } catch (err) {
      console.error('DELETE /api/coach/videos/:id failed:', err);
      return sendError(res, 500, 'videos.server_error', 'Could not delete the video.');
    }
  });

  return router;
}

function createClientCoachVideosRouter({ db, sendError, sendSuccess, resolveCallerUid }) {
  const router = express.Router();

  router.get('/', async (req, res) => {
    try {
      const clientUid = await resolveCallerUid(req.user);
      if (!clientUid) return sendError(res, 409, 'coach.not_migrated', 'Your account needs to complete migration first. Contact support.');
      const invites = await db.collection(`users/${clientUid}/coachInvites`).where('status', '==', 'active').get();
      const lists = await Promise.all(invites.docs.map(async inv => {
        const snap = await db.collection(`coaches/${inv.id}/videos`).get();
        const coachUsername = inv.get('coachUsername') || '';
        return snap.docs
          .map(d => ({ id: d.id, ...d.data() }))
          .filter(v => isFor(v, clientUid))
          .map(v => ({
            id: v.id, coachUid: inv.id, coachUsername,
            title: v.title, category: v.category, videoUrl: v.videoUrl, message: v.message || '',
            createdAt: v.createdAt, updatedAt: v.updatedAt,
          }));
      }));
      return sendSuccess(res, 200, { videos: lists.flat().sort(newestFirst) });
    } catch (err) {
      console.error('GET /api/client/coach-videos failed:', err);
      return sendError(res, 500, 'videos.server_error', 'Could not load your coach\'s videos.');
    }
  });

  return router;
}

module.exports = { createCoachVideosRouter, createClientCoachVideosRouter, sanitizeVideo, CATEGORIES };
