// A two-way comment thread under each check-in, between a client and their
// coach. The coach can comment on the check-in or pin a comment to one of its
// photos (src/checkInPhotos.js); the client is notified and can reply, and the
// coach is notified of replies.
//
// Storage (server-only, see firestore.rules):
//   checkInComments/{id}  { coachUid, clientUid, checkInDate, author: 'coach'|'client',
//                           authorName, text, createdAt, photoIndex?, photoLabel? }
// The coach's roster doc (coaches/{coachUid}/clients/{clientUid}) keeps two
// small summaries the dashboard flags from: coachCommentDates (dates the
// coach has commented on) and awaitingReplyDates (the client wrote last).
//
// Routes (createRouters):
//   client  GET  /api/client/checkins/comments            every thread, one request
//           GET  /api/client/checkins/:date/comments
//           POST /api/client/checkins/:date/comments      { text, coachUid? }
//   coach   GET  /api/coach/clients/:clientUid/checkins/:date/comments
//           POST /api/coach/clients/:clientUid/checkins/:date/comments  { text, photoIndex? }
// Comments are deleted when the coach ↔ client link ends and with either account.
'use strict';

const express = require('express');

const COMMENTS = 'checkInComments';
const MAX_COMMENT = 1000;
const MAX_THREAD = 200;
const MAX_ALL = 600;

function isoDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const t = Date.parse(value + 'T00:00:00Z');
  return Number.isNaN(t) || new Date(t).toISOString().slice(0, 10) !== value ? null : value;
}

// Plain text up to 1000 characters; line breaks kept (at most two in a row).
function cleanComment(value) {
  if (typeof value !== 'string') return '';
  const s = value.replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0009\u000B-\u001F\u007F​-‏‪-‮⁦-⁩]/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return Array.from(s).slice(0, MAX_COMMENT).join('');
}

function toIso(ts) {
  if (!ts) return null;
  if (typeof ts.toDate === 'function') return ts.toDate().toISOString();
  if (ts instanceof Date) return ts.toISOString();
  return typeof ts === 'string' ? ts : null;
}

function commentOut(id, d) {
  const out = {
    id, checkInDate: d.checkInDate, author: d.author, authorName: d.authorName || '',
    text: d.text, createdAt: toIso(d.createdAt), coachUid: d.coachUid,
  };
  if (Number.isInteger(d.photoIndex)) {
    out.photoIndex = d.photoIndex;
    if (d.photoLabel) out.photoLabel = d.photoLabel;
  }
  return out;
}

const byTime = (a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || ''));

// Roster summaries: newest first, deduped, capped.
function withDate(list, date, cap = 24) {
  return [...new Set([date, ...(Array.isArray(list) ? list : [])])].filter(isoDate).sort().reverse().slice(0, cap);
}
const withoutDate = (list, date) => (Array.isArray(list) ? list : []).filter(d => d !== date);

// ── Firestore ────────────────────────────────────────────────────────────────

async function listComments(db, { clientUid, coachUids, checkInDate }) {
  let q = db.collection(COMMENTS).where('clientUid', '==', clientUid);
  if (checkInDate) q = q.where('checkInDate', '==', checkInDate);
  const snap = await q.get();
  const allow = new Set(coachUids);
  return snap.docs.filter(d => allow.has(d.get('coachUid')))
    .map(d => commentOut(d.id, d.data() || {})).sort(byTime)
    .slice(checkInDate ? -MAX_THREAD : -MAX_ALL);
}

async function addComment(db, fields) {
  const ref = db.collection(COMMENTS).doc();
  const doc = {
    coachUid: fields.coachUid, clientUid: fields.clientUid, checkInDate: fields.checkInDate,
    author: fields.author, authorName: String(fields.authorName || '').slice(0, 40),
    text: fields.text, createdAt: (fields.now || new Date()).toISOString(),
  };
  if (Number.isInteger(fields.photoIndex)) {
    doc.photoIndex = fields.photoIndex;
    if (fields.photoLabel) doc.photoLabel = String(fields.photoLabel).slice(0, 60);
  }
  await ref.set(doc);
  return commentOut(ref.id, doc);
}

// One coach ↔ client pair (unlink), or everything for a client or for a
// coach (account deletion).
async function deleteComments(db, { coachUid, clientUid }) {
  let docs;
  if (clientUid) {
    docs = (await db.collection(COMMENTS).where('clientUid', '==', clientUid).get()).docs;
    if (coachUid) docs = docs.filter(d => d.get('coachUid') === coachUid);
  } else if (coachUid) {
    docs = (await db.collection(COMMENTS).where('coachUid', '==', coachUid).get()).docs;
  } else return 0;
  await Promise.all(docs.map(d => d.ref.delete()));
  return docs.length;
}

// ── Routes ───────────────────────────────────────────────────────────────────
// deps.photosFor(clientUid) → { allowed, index } where index is the client's
// { 'YYYY-MM-DD': photoCount } (only meaningful when allowed).
// deps.photoPose(clientUid, date, i) → the pose label of one photo.

function createRouters({
  db, sendError, sendSuccess, resolveCallerUid,
  photosFor = async () => ({ allowed: false, index: {} }),
  photoPose = async () => '',
  usernameForUid = async () => '',
  notifyComment = async () => {}, notifyReply = async () => {},
  now = () => new Date(),
}) {
  const roster = (coachUid, clientUid) => db.collection(`coaches/${coachUid}/clients`).doc(clientUid);
  const fail = (res, where, err, message) => {
    console.error(`${where} failed:`, err && err.message);
    return sendError(res, 500, 'comments.server_error', message);
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
  const dateOr422 = (req, res) => {
    const date = isoDate(req.params.date);
    if (!date) sendError(res, 422, 'comments.invalid_date', 'Date must be YYYY-MM-DD.');
    return date;
  };

  // ── Client ──
  const client = express.Router();

  client.get('/comments', async (req, res) => {
    try {
      const uid = await callerUid(req, res);
      if (!uid) return;
      const coaches = await activeCoaches(uid);
      if (!coaches.length) return sendSuccess(res, 200, { comments: [], coaches, photoDates: [] });
      const [comments, photos] = await Promise.all([
        listComments(db, { clientUid: uid, coachUids: coaches.map(c => c.uid) }),
        photosFor(uid),
      ]);
      return sendSuccess(res, 200, { comments, coaches, photoDates: photos.allowed ? Object.keys(photos.index).sort().reverse() : [] });
    } catch (err) { return fail(res, 'GET /api/client/checkins/comments', err, 'Could not load the comments.'); }
  });

  client.get('/:date/comments', async (req, res) => {
    try {
      const uid = await callerUid(req, res);
      if (!uid) return;
      const date = dateOr422(req, res);
      if (!date) return;
      const coaches = await activeCoaches(uid);
      const comments = coaches.length ? await listComments(db, { clientUid: uid, coachUids: coaches.map(c => c.uid), checkInDate: date }) : [];
      return sendSuccess(res, 200, { comments, coaches });
    } catch (err) { return fail(res, 'GET /api/client/checkins/:date/comments', err, 'Could not load the comments.'); }
  });

  client.post('/:date/comments', async (req, res) => {
    try {
      const uid = await callerUid(req, res);
      if (!uid) return;
      const date = dateOr422(req, res);
      if (!date) return;
      const text = cleanComment(req.body && req.body.text);
      if (!text) return sendError(res, 422, 'comments.empty', 'Write a reply first.');
      const coaches = await activeCoaches(uid);
      if (!coaches.length) return sendError(res, 409, 'comments.no_coach', 'You are not linked to a coach.');
      const wanted = req.body && typeof req.body.coachUid === 'string' ? req.body.coachUid : '';
      const coach = wanted ? coaches.find(c => c.uid === wanted) : coaches.length === 1 ? coaches[0] : null;
      if (!coach) return sendError(res, 422, 'comments.pick_coach', 'Choose which coach to reply to.');
      const comment = await addComment(db, {
        coachUid: coach.uid, clientUid: uid, checkInDate: date, author: 'client', authorName: req.user.username, text, now: now(),
      });
      const ref = roster(coach.uid, uid);
      const snap = await ref.get();
      if (snap.exists) await ref.set({ awaitingReplyDates: withDate(snap.get('awaitingReplyDates'), date) }, { merge: true });
      await notifyReply({ coachUsername: coach.username || await usernameForUid(coach.uid), clientUsername: req.user.username, clientUid: uid, date });
      return sendSuccess(res, 201, { comment });
    } catch (err) { return fail(res, 'POST /api/client/checkins/:date/comments', err, 'Could not send your reply.'); }
  });

  // ── Coach (mounted at /api/coach/clients/:clientUid) ──
  const coach = express.Router({ mergeParams: true });

  const linked = async (req, res) => {
    const coachUid = await callerUid(req, res);
    if (!coachUid) return null;
    const clientUid = String(req.params.clientUid || '').trim();
    if (!clientUid || clientUid.includes('/')) { sendError(res, 422, 'coach.missing_client_id', 'clientUid is required.'); return null; }
    const ref = roster(coachUid, clientUid);
    const snap = await ref.get();
    if (!snap.exists || (snap.get('status') || 'active') !== 'active') { sendError(res, 404, 'coach.not_linked', 'This client is not linked to your roster.'); return null; }
    return { coachUid, clientUid, ref, snap };
  };

  coach.get('/checkins/:date/comments', async (req, res) => {
    try {
      const l = await linked(req, res);
      if (!l) return;
      const date = dateOr422(req, res);
      if (!date) return;
      return sendSuccess(res, 200, { comments: await listComments(db, { clientUid: l.clientUid, coachUids: [l.coachUid], checkInDate: date }) });
    } catch (err) { return fail(res, 'GET /api/coach/clients/:id/checkins/:date/comments', err, 'Could not load the comments.'); }
  });

  coach.post('/checkins/:date/comments', async (req, res) => {
    try {
      const l = await linked(req, res);
      if (!l) return;
      const date = dateOr422(req, res);
      if (!date) return;
      const text = cleanComment(req.body && req.body.text);
      if (!text) return sendError(res, 422, 'comments.empty', 'Write a comment first.');
      let photoIndex = null;
      let photoLabel = '';
      const rawIndex = req.body ? req.body.photoIndex : undefined;
      if (rawIndex !== undefined && rawIndex !== null && rawIndex !== '') {
        const i = Number(rawIndex);
        const photos = await photosFor(l.clientUid);
        if (!Number.isInteger(i) || i < 0 || !photos.allowed || i >= (photos.index[date] || 0)) {
          return sendError(res, 422, 'comments.invalid_photo', 'That photo is not part of this check-in.');
        }
        photoIndex = i;
        photoLabel = await photoPose(l.clientUid, date, i);
      }
      const comment = await addComment(db, {
        coachUid: l.coachUid, clientUid: l.clientUid, checkInDate: date, photoIndex, photoLabel,
        author: 'coach', authorName: req.user.username, text, now: now(),
      });
      await l.ref.set({
        coachCommentDates: withDate(l.snap.get('coachCommentDates'), date),
        awaitingReplyDates: withoutDate(l.snap.get('awaitingReplyDates'), date),
      }, { merge: true });
      await notifyComment({
        coachUsername: req.user.username, clientUsername: l.snap.get('athleteDisplayName') || await usernameForUid(l.clientUid),
        date, onPhoto: photoIndex !== null,
      });
      return sendSuccess(res, 201, { comment });
    } catch (err) { return fail(res, 'POST /api/coach/clients/:id/checkins/:date/comments', err, 'Could not send the comment.'); }
  });

  return { client, coach };
}

module.exports = {
  COMMENTS, MAX_COMMENT, isoDate, cleanComment, withDate, withoutDate,
  listComments, addComment, deleteComments, createRouters,
};
