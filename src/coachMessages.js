// A two-way message thread between a coach and each client, plus the coach's
// "please check in" request.
//
// The coach's side of the thread is the existing coach notes
// (POST /api/coach/clients/:clientUid/notes in server.js, stored under
// coaches/{coachUid}/clients/{clientUid}/notes and mirrored to the client).
// This module adds the client's replies and reads both as one thread.
//
// Storage (server-only, see firestore.rules):
//   coachMessages/{id}  { coachUid, coachUsername, clientUid, author: 'client',
//                         authorName, text, createdAt }   (ISO string)
// The coach's roster doc (coaches/{coachUid}/clients/{clientUid}) keeps the
// summary the dashboard inbox is drawn from: lastMessageAt, lastMessageText
// (a short preview), lastMessageAuthor ('coach'|'client'), unreadMessages
// (client replies the coach has not opened) and checkInRequestedAt.
//
// Routes (createRouters):
//   client  GET  /api/client/messages        the caller's own replies + active coaches
//           POST /api/client/messages        { text, coachUid? }
//   coach   GET  /api/coach/clients/:clientUid/messages          whole thread; marks it read
//           POST /api/coach/clients/:clientUid/checkin-request   asks for a check-in
// Replies are deleted when the coach ↔ client link ends and with either account.
'use strict';

const express = require('express');
const { cleanComment } = require('./checkInComments');

const MESSAGES = 'coachMessages';
const MAX_THREAD = 300;
const PREVIEW = 140;
const REQUEST_GAP_MS = 12 * 60 * 60 * 1000;

function toIso(ts) {
  if (!ts) return null;
  if (typeof ts.toDate === 'function') return ts.toDate().toISOString();
  if (ts instanceof Date) return ts.toISOString();
  if (typeof ts._seconds === 'number') return new Date(ts._seconds * 1000).toISOString();
  return typeof ts === 'string' ? ts : null;
}

const preview = text => {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return s.length > PREVIEW ? `${s.slice(0, PREVIEW - 1)}…` : s;
};
const byTime = (a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || ''));

// ── Firestore ────────────────────────────────────────────────────────────────

async function listReplies(db, { clientUid, coachUids }) {
  const snap = await db.collection(MESSAGES).where('clientUid', '==', clientUid).get();
  const allow = new Set(coachUids);
  return snap.docs.filter(d => allow.has(d.get('coachUid'))).map(d => {
    const m = d.data() || {};
    return { id: d.id, author: 'client', authorName: m.authorName || '', text: m.text, createdAt: toIso(m.createdAt), coachUid: m.coachUid, coachUsername: m.coachUsername || '' };
  }).sort(byTime);
}

// The coach's notes to this client and the client's replies, oldest first.
async function listThread(db, { coachUid, clientUid }) {
  const [notes, replies] = await Promise.all([
    db.collection(`coaches/${coachUid}/clients/${clientUid}/notes`).get(),
    listReplies(db, { clientUid, coachUids: [coachUid] }),
  ]);
  const sent = notes.docs.map(d => {
    const n = d.data() || {};
    return { id: d.id, author: 'coach', authorName: n.coachUsername || n.from || '', text: String(n.text || ''), createdAt: toIso(n.createdAt), coachUid };
  });
  return [...sent, ...replies].sort(byTime).slice(-MAX_THREAD);
}

// Called by the notes route after a coach note is saved, so the inbox shows
// it as the latest message.
async function recordCoachNote(db, { coachUid, clientUid, text, now = new Date() }) {
  await db.collection(`coaches/${coachUid}/clients`).doc(clientUid).set({
    lastMessageAt: now.toISOString(), lastMessageText: preview(text), lastMessageAuthor: 'coach',
  }, { merge: true });
}

// One coach ↔ client pair (unlink), or everything for a client or for a
// coach (account deletion).
async function deleteMessages(db, { coachUid, clientUid }) {
  let docs;
  if (clientUid) {
    docs = (await db.collection(MESSAGES).where('clientUid', '==', clientUid).get()).docs;
    if (coachUid) docs = docs.filter(d => d.get('coachUid') === coachUid);
  } else if (coachUid) {
    docs = (await db.collection(MESSAGES).where('coachUid', '==', coachUid).get()).docs;
  } else return 0;
  await Promise.all(docs.map(d => d.ref.delete()));
  return docs.length;
}

// The inbox fields of a roster doc, for the coach's client list.
function rosterSummary(data = {}) {
  return {
    lastMessageAt: typeof data.lastMessageAt === 'string' ? data.lastMessageAt : null,
    lastMessageText: typeof data.lastMessageText === 'string' ? data.lastMessageText : '',
    lastMessageAuthor: data.lastMessageAuthor === 'client' ? 'client' : data.lastMessageAuthor === 'coach' ? 'coach' : null,
    unreadMessages: Number.isInteger(data.unreadMessages) && data.unreadMessages > 0 ? data.unreadMessages : 0,
    checkInRequestedAt: typeof data.checkInRequestedAt === 'string' ? data.checkInRequestedAt : null,
  };
}

// ── Routes ───────────────────────────────────────────────────────────────────

function createRouters({
  db, sendError, sendSuccess, resolveCallerUid,
  usernameForUid = async () => '',
  notifyMessage = async () => {}, notifyCheckInRequest = async () => {},
  now = () => new Date(),
}) {
  const roster = (coachUid, clientUid) => db.collection(`coaches/${coachUid}/clients`).doc(clientUid);
  const fail = (res, where, err, message) => {
    console.error(`${where} failed:`, err && err.message);
    return sendError(res, 500, 'messages.server_error', message);
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

  // ── Client (mounted at /api/client/messages) ──
  const client = express.Router();

  client.get('/', async (req, res) => {
    try {
      const uid = await callerUid(req, res);
      if (!uid) return;
      const coaches = await activeCoaches(uid);
      const messages = coaches.length ? await listReplies(db, { clientUid: uid, coachUids: coaches.map(c => c.uid) }) : [];
      return sendSuccess(res, 200, { messages, coaches });
    } catch (err) { return fail(res, 'GET /api/client/messages', err, 'Could not load your messages.'); }
  });

  client.post('/', async (req, res) => {
    try {
      const uid = await callerUid(req, res);
      if (!uid) return;
      const text = cleanComment(req.body && req.body.text);
      if (!text) return sendError(res, 422, 'messages.empty', 'Write a message first.');
      const coaches = await activeCoaches(uid);
      if (!coaches.length) return sendError(res, 409, 'messages.no_coach', 'You are not linked to a coach.');
      const wanted = req.body && typeof req.body.coachUid === 'string' ? req.body.coachUid : '';
      const coach = wanted ? coaches.find(c => c.uid === wanted) : coaches.length === 1 ? coaches[0] : null;
      if (!coach) return sendError(res, 422, 'messages.pick_coach', 'Choose which coach to write to.');
      const coachUsername = coach.username || await usernameForUid(coach.uid);
      const at = now().toISOString();
      const ref = db.collection(MESSAGES).doc();
      const doc = {
        coachUid: coach.uid, coachUsername, clientUid: uid, author: 'client',
        authorName: String(req.user.username || '').slice(0, 40), text, createdAt: at,
      };
      await ref.set(doc);
      const rosterRef = roster(coach.uid, uid);
      const snap = await rosterRef.get();
      if (snap.exists) {
        await rosterRef.set({
          lastMessageAt: at, lastMessageText: preview(text), lastMessageAuthor: 'client',
          unreadMessages: rosterSummary(snap.data()).unreadMessages + 1,
        }, { merge: true });
      }
      await notifyMessage({ coachUsername, clientUsername: req.user.username, clientUid: uid });
      return sendSuccess(res, 201, { message: { id: ref.id, author: 'client', authorName: doc.authorName, text, createdAt: at, coachUid: coach.uid, coachUsername } });
    } catch (err) { return fail(res, 'POST /api/client/messages', err, 'Could not send your message.'); }
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

  coach.get('/messages', async (req, res) => {
    try {
      const l = await linked(req, res);
      if (!l) return;
      const messages = await listThread(db, l);
      if (rosterSummary(l.snap.data()).unreadMessages) await l.ref.set({ unreadMessages: 0 }, { merge: true });
      return sendSuccess(res, 200, { messages });
    } catch (err) { return fail(res, 'GET /api/coach/clients/:id/messages', err, 'Could not load the messages.'); }
  });

  coach.post('/checkin-request', async (req, res) => {
    try {
      const l = await linked(req, res);
      if (!l) return;
      const last = Date.parse(l.snap.get('checkInRequestedAt') || '');
      const at = now();
      if (Number.isFinite(last) && at.getTime() - last < REQUEST_GAP_MS) {
        return sendError(res, 409, 'messages.already_requested', 'You already asked for a check-in in the last 12 hours.');
      }
      await l.ref.set({ checkInRequestedAt: at.toISOString() }, { merge: true });
      await notifyCheckInRequest({
        coachUsername: req.user.username,
        clientUsername: l.snap.get('athleteDisplayName') || await usernameForUid(l.clientUid),
      });
      return sendSuccess(res, 201, { checkInRequestedAt: at.toISOString() });
    } catch (err) { return fail(res, 'POST /api/coach/clients/:id/checkin-request', err, 'Could not send the request.'); }
  });

  return { client, coach };
}

module.exports = {
  MESSAGES, REQUEST_GAP_MS, preview, rosterSummary,
  listReplies, listThread, recordCoachNote, deleteMessages, createRouters,
};
