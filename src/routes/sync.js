// Cloud sync for the app's on-device data (everything except workouts, which
// have their own route because coaches and the leaderboards read them).
//
// The app keeps its data in localStorage. Each store (bodyMeasurements,
// macroTargets, sleepLog, ...) is split into items — one per log entry, or
// one for a whole settings-style value — and each item syncs on its own, so
// two devices editing different entries never overwrite each other.
//
// Storage (server-only, see firestore.rules):
//   users/{uid}/syncItems/{docId} {
//     store, itemId,         // which store and which entry in it
//     data,                  // the entry as a JSON string (null when deleted)
//     deleted,               // tombstone, so other devices remove it too
//     updatedAt,             // client clock (ms) when the entry last changed
//     seq                    // server clock (ms) when it was written; pull cursor
//   }
//
// Conflicts: last write wins by `updatedAt`. A push older than what the
// server has is not applied; the server's copy comes back instead.
//
// Kill switch: CLOUD_SYNC_ENABLED=false makes every route answer 503
// `sync.disabled`; the app then stops syncing until the next launch.
const crypto = require('crypto');
const express = require('express');

const STORE_RE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const ITEM_ID_MAX = 200;
const ITEM_MAX_BYTES = 200 * 1024;
const PUSH_MAX_ITEMS = 100;
const PULL_PAGE = 200;
const CLOCK_SKEW_MS = 5 * 60 * 1000; // reject updatedAt this far in the future

function syncDocId(store, itemId) {
  return crypto.createHash('sha1').update(`${store}\n${itemId}`).digest('hex');
}

function encodeCursor(seq, id) {
  return `${seq}_${id}`;
}

function decodeCursor(raw) {
  const m = /^(\d{1,16})_([a-f0-9]{40})$/.exec(String(raw || ''));
  return m ? { seq: Number(m[1]), id: m[2] } : null;
}

function shapeOut(doc) {
  const d = doc.data();
  let data = null;
  if (!d.deleted && typeof d.data === 'string') {
    try { data = JSON.parse(d.data); } catch { data = null; }
  }
  return { store: d.store, id: d.itemId, data, deleted: !!d.deleted, updatedAt: d.updatedAt };
}

// Validates one pushed item; returns { item } or { error }.
function parseItem(raw, now) {
  if (!raw || typeof raw !== 'object') return { error: 'invalid_item' };
  const store = typeof raw.store === 'string' && STORE_RE.test(raw.store) ? raw.store : null;
  if (!store) return { error: 'invalid_store' };
  const itemId = typeof raw.id === 'string' || typeof raw.id === 'number' ? String(raw.id) : '';
  if (!itemId || itemId.length > ITEM_ID_MAX) return { error: 'invalid_id' };
  const updatedAt = Number(raw.updatedAt);
  if (!Number.isFinite(updatedAt) || updatedAt <= 0 || updatedAt > now + CLOCK_SKEW_MS) return { error: 'invalid_updated_at' };
  const deleted = raw.deleted === true;
  let data = null;
  if (!deleted) {
    if (raw.data === undefined) return { error: 'missing_data' };
    data = JSON.stringify(raw.data);
    if (Buffer.byteLength(data, 'utf8') > ITEM_MAX_BYTES) return { error: 'too_large' };
  }
  return { item: { store, itemId, data, deleted, updatedAt: Math.round(updatedAt) } };
}

function createSyncRouter({ db, firebaseEnabled, sendError, sendSuccess, resolveUid, documentId = '__name__', enabled = () => true, now = () => Date.now() }) {
  const router = express.Router();

  router.use(async (req, res, next) => {
    if (!enabled()) return sendError(res, 503, 'sync.disabled', 'Cloud sync is switched off right now.');
    if (!firebaseEnabled) return sendError(res, 503, 'sync.firebase_disabled', 'Cloud sync is not available right now.');
    const uid = await resolveUid(req.user?.username);
    // Legacy (pre-Firebase) accounts have nowhere to store synced data.
    if (!uid) return sendError(res, 409, 'sync.not_migrated', 'This account can’t use cloud sync yet.');
    req.syncCol = db.collection(`users/${uid}/syncItems`);
    next();
  });

  // GET /status — lets the app check the switch before doing any work.
  router.get('/status', (_req, res) => sendSuccess(res, 200, { enabled: true }));

  // POST /push — body: { items: [{ store, id, data, deleted, updatedAt }] }
  // → { applied: n, rejected: [{ store, id, reason }], newer: [server items] }
  router.post('/push', async (req, res) => {
    const raw = Array.isArray(req.body?.items) ? req.body.items : null;
    if (!raw) return sendError(res, 422, 'sync.invalid_payload', 'items array is required.');
    if (raw.length > PUSH_MAX_ITEMS) return sendError(res, 413, 'sync.too_many', `Send at most ${PUSH_MAX_ITEMS} items at once.`);

    const t = now();
    const rejected = [];
    const byDoc = new Map(); // last copy of each item wins within one push
    raw.forEach(r => {
      const { item, error } = parseItem(r, t);
      if (error) rejected.push({ store: r?.store ?? null, id: r?.id ?? null, reason: error });
      else byDoc.set(syncDocId(item.store, item.itemId), item);
    });

    try {
      const newer = [];
      let applied = 0;
      if (byDoc.size) {
        await db.runTransaction(async tx => {
          newer.length = 0;
          applied = 0;
          const refs = [...byDoc.keys()].map(id => req.syncCol.doc(id));
          const snaps = await Promise.all(refs.map(ref => tx.get(ref)));
          const seq = now();
          snaps.forEach((snap, i) => {
            const item = byDoc.get(refs[i].id);
            if (snap.exists && Number(snap.get('updatedAt')) > item.updatedAt) {
              newer.push(shapeOut(snap));
              return;
            }
            tx.set(refs[i], { ...item, seq });
            applied++;
          });
        });
      }
      return sendSuccess(res, 200, { applied, rejected, newer });
    } catch (err) {
      console.error('POST /api/sync/push failed:', err);
      return sendError(res, 500, 'sync.server_error', 'Could not save your changes.');
    }
  });

  // GET /pull?cursor=<seq_id>&limit=n — everything written after the cursor,
  // oldest first. No cursor = everything. → { items, cursor, hasMore }
  router.get('/pull', async (req, res) => {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || PULL_PAGE, 1), PULL_PAGE);
    const cursor = decodeCursor(req.query.cursor);
    if (req.query.cursor && !cursor) return sendError(res, 422, 'sync.invalid_cursor', 'Invalid cursor.');
    try {
      let q = req.syncCol.orderBy('seq').orderBy(documentId);
      if (cursor) q = q.startAfter(cursor.seq, cursor.id);
      const snap = await q.limit(limit + 1).get();
      const docs = snap.docs.slice(0, limit);
      const last = docs[docs.length - 1];
      return sendSuccess(res, 200, {
        items: docs.map(shapeOut),
        cursor: last ? encodeCursor(last.get('seq'), last.id) : (cursor ? encodeCursor(cursor.seq, cursor.id) : null),
        hasMore: snap.docs.length > limit,
      });
    } catch (err) {
      console.error('GET /api/sync/pull failed:', err);
      return sendError(res, 500, 'sync.server_error', 'Could not load your synced data.');
    }
  });

  return router;
}

module.exports = { createSyncRouter, syncDocId, encodeCursor, decodeCursor, parseItem, ITEM_MAX_BYTES, PUSH_MAX_ITEMS };
