// A coach reading a client's food log.
//
// The client's food log is their own synced data (users/{uid}/syncItems,
// store 'foodLog' — see src/routes/sync.js). Nothing is copied onto the
// coach's side: every request checks, server-side,
//   1. the coach ↔ client link is active on both sides
//      (coaches/{coachUid}/clients/{clientUid} and
//       users/{clientUid}/coachInvites/{coachUid}), and
//   2. the client has the food-log switch on right now
//      (users/{clientUid}.coachSharing.nutrition === true).
// So unlinking or switching sharing off cuts access on the next request,
// and deleting the client's account (which deletes users/{uid}) removes the
// data for everyone.
//
// Mounted at /api/coach/nutrition (coach plan required):
//   GET /:clientUid?days=28
//     → { nutrition: { today, target, days: [...], last7, last28 } }
'use strict';

const express = require('express');
const diary = require('../nutrition/diary');

const UID_RE = /^[A-Za-z0-9_-]{1,128}$/;

// → { ok: true } or { ok: false, status, code, message }
async function checkNutritionAccess(db, coachUid, clientUid) {
  const [rosterSnap, inviteSnap, userSnap] = await Promise.all([
    db.collection(`coaches/${coachUid}/clients`).doc(clientUid).get(),
    db.collection(`users/${clientUid}/coachInvites`).doc(coachUid).get(),
    db.collection('users').doc(clientUid).get(),
  ]);
  const active = snap => snap.exists && snap.get('status') === 'active';
  if (!active(rosterSnap) || !active(inviteSnap)) {
    return { ok: false, status: 404, code: 'coach.not_linked', message: 'This client is not linked to your roster.' };
  }
  const sharing = userSnap.exists ? userSnap.get('coachSharing') : null;
  if (!sharing || sharing.nutrition !== true) {
    return { ok: false, status: 403, code: 'coach.nutrition_not_shared', message: 'This client hasn’t shared their food log with you.' };
  }
  return { ok: true, roster: rosterSnap.data() || {} };
}

function parseJsonString(v) {
  if (typeof v !== 'string') return null;
  try { return JSON.parse(v); } catch { return null; }
}

// A 'value' store item holds the raw localStorage string, which is itself
// JSON for these stores.
function valueOf(snap) {
  if (!snap || !snap.exists || snap.get('deleted')) return null;
  const outer = parseJsonString(snap.get('data'));
  return typeof outer === 'string' ? parseJsonString(outer) ?? outer : outer;
}

async function loadClientNutrition({ db, syncDocId, clientUid, today, days, rosterTargets }) {
  const col = db.collection(`users/${clientUid}/syncItems`);
  const span = Math.max(days, 29);
  const dates = Array.from({ length: span }, (_, i) => diary.addDays(today, -i));
  const historyRefs = dates.map(d => col.doc(syncDocId('macroHistory', `date:${d}`)));
  const valueRefs = ['dailyMacroProgress', 'dailyMacroDate', 'macroTargets'].map(s => col.doc(syncDocId(s, 'value')));

  const [foodSnap, ...snaps] = await Promise.all([
    col.where('store', '==', 'foodLog').get(),
    ...historyRefs.map(r => r.get()),
    ...valueRefs.map(r => r.get()),
  ]);
  const historySnaps = snaps.slice(0, historyRefs.length);
  const [progressSnap, progressDateSnap, targetSnap] = snaps.slice(historyRefs.length);

  const oldest = dates[dates.length - 1];
  const entries = foodSnap.docs
    .filter(d => !d.get('deleted'))
    .map(d => diary.sanitizeEntry(parseJsonString(d.get('data'))))
    .filter(e => e && e.date >= oldest && e.date <= today);

  const totalsByDate = {};
  historySnaps.forEach((snap, i) => {
    if (!snap.exists || snap.get('deleted')) return;
    const h = parseJsonString(snap.get('data'));
    if (h && h.totals) totalsByDate[dates[i]] = h.totals;
  });
  // Today's running total lives in dailyMacroProgress until the day rolls over.
  const progressDate = valueOf(progressDateSnap);
  const progress = valueOf(progressSnap);
  if (typeof progressDate === 'string' && progressDate.slice(0, 10) === today && progress && typeof progress === 'object') {
    totalsByDate[today] = progress;
  }

  const target = diary.sanitizeTarget(valueOf(targetSnap)) || diary.sanitizeTarget(rosterTargets);
  return diary.summarize({ entries, totalsByDate, target, today, days });
}

function createCoachNutritionRouter({ db, sendError, sendSuccess, resolveCallerUid, syncDocId, now = () => new Date() }) {
  const router = express.Router();

  router.get('/:clientUid', async (req, res) => {
    const clientUid = String(req.params.clientUid || '').trim();
    if (!UID_RE.test(clientUid)) return sendError(res, 422, 'coach.invalid_client', 'Invalid client id.');
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 28, 7), diary.MAX_DAYS);
    try {
      const coachUid = await resolveCallerUid(req.user);
      if (!coachUid) return sendError(res, 409, 'coach.not_migrated', 'Your account needs to complete migration first. Contact support.');
      const access = await checkNutritionAccess(db, coachUid, clientUid);
      if (!access.ok) return sendError(res, access.status, access.code, access.message);
      const today = now().toISOString().slice(0, 10);
      const nutrition = await loadClientNutrition({
        db, syncDocId, clientUid, today, days, rosterTargets: access.roster.macroTargets,
      });
      res.set('Cache-Control', 'no-store');
      return sendSuccess(res, 200, { nutrition });
    } catch (err) {
      console.error('GET /api/coach/nutrition/:clientUid failed:', err);
      return sendError(res, 500, 'coach.server_error', 'Could not load this client’s food log.');
    }
  });

  return router;
}

module.exports = { createCoachNutritionRouter, checkNutritionAccess, loadClientNutrition };
