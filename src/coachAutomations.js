// Coach automations: a small set of rules a coach switches on, run by the
// server so they work while the coach is away.
//
//   checkInReminder  when a client is `graceDays` past their check-in
//                    frequency, they get the same "asked you for a check-in"
//                    notification as the coach's Request check-in button.
//                    Once per missed check-in: nothing more is sent until
//                    they check in again.
//   welcome          when a client accepts the coach's invite (or links with
//                    a coach code), they get the coach's welcome message as
//                    a normal coach note. Once per client.
//
// Storage (server-only): coaches/{coachUid}/settings/automations
//   { checkInReminder: { enabled, graceDays }, welcome: { enabled, text }, updatedAt }
// The roster doc records checkInRequestedAt (shared with the manual button)
// and welcomeSentAt.
//
// Routes (createRouter, mounted at /api/coach/automations): GET /, PUT /
// runCheckInReminders is called daily by a scheduled function
// (functions-entry.js).
'use strict';

const express = require('express');

const WELCOME_MAX = 1000;
const MAX_GRACE_DAYS = 14;
const DAY_MS = 86400000;

const DEFAULTS = Object.freeze({
  checkInReminder: { enabled: false, graceDays: 1 },
  welcome: { enabled: false, text: '' },
});

function sanitizeAutomations(value) {
  const v = value && typeof value === 'object' ? value : {};
  const r = v.checkInReminder && typeof v.checkInReminder === 'object' ? v.checkInReminder : {};
  const w = v.welcome && typeof v.welcome === 'object' ? v.welcome : {};
  const grace = Number(r.graceDays);
  const text = typeof w.text === 'string' ? w.text.replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, WELCOME_MAX) : '';
  return {
    checkInReminder: { enabled: r.enabled === true, graceDays: Number.isInteger(grace) && grace >= 0 && grace <= MAX_GRACE_DAYS ? grace : DEFAULTS.checkInReminder.graceDays },
    // A welcome with no text can't be sent, so it can't be on.
    welcome: { enabled: w.enabled === true && !!text, text },
  };
}

const settingsRef = (db, coachUid) => db.collection(`coaches/${coachUid}/settings`).doc('automations');

async function readAutomations(db, coachUid) {
  const snap = await settingsRef(db, coachUid).get();
  return sanitizeAutomations(snap.exists ? snap.data() : null);
}

function everyDays(roster) {
  const n = Number(roster && roster.checkInSettings && roster.checkInSettings.everyDays);
  return Number.isInteger(n) && n >= 1 && n <= 28 ? n : 7;
}

// True when this client should be reminded now: they have checked in before,
// are `graceDays` past their frequency, and have not been asked since that
// last check-in.
function reminderDue(roster, graceDays, now) {
  if (!roster || (roster.status || 'active') !== 'active') return false;
  const last = Date.parse(`${String(roster.lastCheckInAt || '').slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(last)) return false;
  if (now.getTime() < last + (everyDays(roster) + graceDays) * DAY_MS) return false;
  const asked = Date.parse(roster.checkInRequestedAt || '');
  return !Number.isFinite(asked) || asked < last;
}

// → { coaches, reminded }. notify({ coachUsername, clientUsername }) sends the
// check-in request notification.
async function runCheckInReminders(db, { now = new Date(), notify = async () => {} } = {}) {
  let coaches = 0;
  let reminded = 0;
  // listDocuments() also returns coach docs that only exist as a parent of
  // subcollections.
  for (const coachRef of await db.collection('coaches').listDocuments()) {
    const settings = await readAutomations(db, coachRef.id);
    if (!settings.checkInReminder.enabled) continue;
    coaches++;
    const clients = await coachRef.collection('clients').get();
    for (const doc of clients.docs) {
      const roster = doc.data() || {};
      if (!reminderDue(roster, settings.checkInReminder.graceDays, now)) continue;
      const invite = await db.collection(`users/${doc.id}/coachInvites`).doc(coachRef.id).get();
      const coachUsername = invite.exists ? invite.get('coachUsername') || '' : '';
      await doc.ref.set({ checkInRequestedAt: now.toISOString(), checkInRequestedBy: 'automation' }, { merge: true });
      reminded++;
      if (coachUsername && roster.athleteDisplayName) {
        try { await notify({ coachUsername, clientUsername: roster.athleteDisplayName }); } catch (err) { console.error('[automations] reminder notify failed:', err.message); }
      }
    }
  }
  return { coaches, reminded };
}

// Sends the coach's welcome message to a client who just became active.
// → true when a message was sent. Never throws: a welcome must not fail the
// accept itself.
async function sendWelcome(db, { coachUid, coachUsername, clientUid, clientUsername, now = new Date(), onSent = async () => {} }) {
  try {
    const settings = await readAutomations(db, coachUid);
    if (!settings.welcome.enabled) return false;
    const rosterRef = db.collection(`coaches/${coachUid}/clients`).doc(clientUid);
    const roster = await rosterRef.get();
    if (!roster.exists || roster.get('welcomeSentAt')) return false;
    const note = { text: settings.welcome.text, from: coachUsername, coachUsername, createdAt: now, automated: true };
    const noteRef = db.collection(`coaches/${coachUid}/clients/${clientUid}/notes`).doc();
    await noteRef.set(note);
    await db.collection(`users/${clientUid}/coachNotes`).doc(noteRef.id).set(note);
    await rosterRef.set({ welcomeSentAt: now.toISOString() }, { merge: true });
    await onSent({ coachUid, clientUid, coachUsername, clientUsername, text: settings.welcome.text });
    return true;
  } catch (err) {
    console.error('[automations] welcome failed:', err && err.message);
    return false;
  }
}

function createRouter({ db, sendError, sendSuccess, resolveCallerUid, now = () => new Date() }) {
  const router = express.Router();
  const uidOf = async (req, res) => {
    const uid = await resolveCallerUid(req.user);
    if (!uid) sendError(res, 409, 'coach.not_migrated', 'Your account needs to complete migration first. Contact support.');
    return uid;
  };

  router.get('/', async (req, res) => {
    try {
      const uid = await uidOf(req, res);
      if (!uid) return undefined;
      return sendSuccess(res, 200, { automations: await readAutomations(db, uid) });
    } catch (err) {
      console.error('GET /api/coach/automations failed:', err && err.message);
      return sendError(res, 500, 'automations.server_error', 'Could not load your automations.');
    }
  });

  router.put('/', async (req, res) => {
    try {
      const b = req.body || {};
      if (b.welcome && b.welcome.enabled === true && !(typeof b.welcome.text === 'string' && b.welcome.text.trim())) {
        return sendError(res, 422, 'automations.invalid', 'Write the welcome message before switching it on.');
      }
      const uid = await uidOf(req, res);
      if (!uid) return undefined;
      const automations = sanitizeAutomations(b);
      await settingsRef(db, uid).set({ ...automations, updatedAt: now().toISOString() });
      return sendSuccess(res, 200, { automations });
    } catch (err) {
      console.error('PUT /api/coach/automations failed:', err && err.message);
      return sendError(res, 500, 'automations.server_error', 'Could not save your automations.');
    }
  });

  return router;
}

module.exports = { DEFAULTS, MAX_GRACE_DAYS, sanitizeAutomations, readAutomations, reminderDue, runCheckInReminders, sendWelcome, createRouter };
