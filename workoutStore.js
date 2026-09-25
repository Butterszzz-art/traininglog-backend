// Shared Firestore write/read helpers for per-user history collections.
//
// Workouts: every write goes through saveWorkoutWithTotals() so the owner's
// users/{uid} doc carries running `totalVolume` / `workoutCount` counters.
// GET /leaderboard reads those counters (one doc per user, top-N) instead of
// scanning every workout of every user on each request.
//
// The counter update runs in the same transaction as the workout write and is
// computed as a delta against any existing doc with the same id — so retrying
// a save with the same id (client-supplied id, or a re-run migration) never
// double-counts.
'use strict';

const crypto = require('crypto');

// Firestore doc ids can't contain '/', be '.'/'..', or match __.*__. Keep to a
// conservative charset rather than trying to mirror every rule exactly.
const SAFE_DOC_ID = /^[A-Za-z0-9_-]{1,128}$/;

function safeDocId(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const id = String(value);
  return SAFE_DOC_ID.test(id) ? id : null;
}

// Deterministic id for sync entries that carry no id of their own: the same
// entry re-sent (timeout + retry, or an overlapping sync window) maps to the
// same doc instead of creating a duplicate.
function contentDocId(entry) {
  return crypto.createHash('sha1').update(JSON.stringify(entry ?? null)).digest('hex').slice(0, 24);
}

function syncEntryDocId(entry) {
  return safeDocId(entry?.id) || contentDocId(entry);
}

// Natural-key doc id from date-like parts, e.g. ('2026-07-01', 'Macros') ->
// '2026-07-01_Macros'. Returns null when a part is missing so callers can
// fall back to an auto id.
function naturalDocId(...parts) {
  if (parts.some(p => p == null || String(p).trim() === '')) return null;
  return safeDocId(parts.map(p => String(p).trim().replace(/[^A-Za-z0-9_-]/g, '-')).join('_'));
}

async function saveWorkoutWithTotals({ db, FieldValue, uid, docRef, data, merge = false }) {
  const userRef = db.collection('users').doc(uid);
  await db.runTransaction(async tx => {
    const prev = await tx.get(docRef);
    const prevVolume = prev.exists ? (Number(prev.get('sessionVolume')) || 0) : 0;
    const nextVolume = Number(data.sessionVolume) || 0;
    tx.set(docRef, data, merge ? { merge: true } : undefined);
    tx.set(userRef, {
      totalVolume: FieldValue.increment(nextVolume - prevVolume),
      workoutCount: FieldValue.increment(prev.exists ? 0 : 1)
    }, { merge: true });
  });
}

// Firestore batches cap at 500 writes.
async function batchSetAll(db, writes) {
  for (let i = 0; i < writes.length; i += 500) {
    const batch = db.batch();
    for (const { ref, data } of writes.slice(i, i + 500)) batch.set(ref, data);
    await batch.commit();
  }
}

// Opt-in pagination for history GETs. Without ?limit the whole collection is
// returned (existing contract — the app uses these for all-time stats). With
// ?limit=N (max 500) returns N docs plus `nextCursor` (a doc id) to pass back
// as ?cursor= for the next page.
const MAX_PAGE_SIZE = 500;

async function queryHistoryPage(colRef, orderField, query = {}) {
  const limit = parseInt(query.limit, 10);
  let q = colRef.orderBy(orderField, 'desc');
  if (!Number.isFinite(limit) || limit <= 0) {
    const snap = await q.get();
    return { docs: snap.docs, nextCursor: null };
  }
  const pageSize = Math.min(limit, MAX_PAGE_SIZE);
  const cursor = safeDocId(query.cursor);
  if (cursor) {
    const cursorSnap = await colRef.doc(cursor).get();
    if (cursorSnap.exists) q = q.startAfter(cursorSnap);
  }
  const snap = await q.limit(pageSize + 1).get();
  const docs = snap.docs.slice(0, pageSize);
  return { docs, nextCursor: snap.docs.length > pageSize ? docs[docs.length - 1].id : null };
}

module.exports = { safeDocId, naturalDocId, syncEntryDocId, saveWorkoutWithTotals, batchSetAll, queryHistoryPage };
