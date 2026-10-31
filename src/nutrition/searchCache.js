// Shared cache for food search and barcode answers, in Firestore.
//
// Each server instance also keeps its own in-memory cache (routes/food.js),
// but Cloud Functions instances come and go, so on a cold start that cache
// is empty and every search went back to USDA / Open Food Facts. This one
// survives restarts and is shared by every instance.
//
//   foodSearchCache/{sha1 of the cache key}
//     { key, value: JSON text, expiresAt: Timestamp }
//
// Only search words and public food data are stored: no username, no user
// id, nothing about who searched. Expired documents are ignored on read and
// overwritten on the next miss; a Firestore TTL policy on `expiresAt`
// (set once in the console) deletes them for good.
//
// Failures never break a search: a read error counts as a miss, a write
// error is logged and dropped.
'use strict';

const crypto = require('crypto');

const COLLECTION = 'foodSearchCache';
const MAX_VALUE_BYTES = 500 * 1024; // well under Firestore's 1 MiB per document

function docId(key) {
  return crypto.createHash('sha1').update(String(key)).digest('hex');
}

function toMillis(v) {
  if (!v) return 0;
  if (typeof v.toMillis === 'function') return v.toMillis();
  if (v instanceof Date) return v.getTime();
  return Number(v) || 0;
}

// → { get(key) → value | undefined, set(key, value, ttlMs) }. `null` is a
// valid cached value (a barcode nobody has); undefined means "not cached".
function createFirestoreStore(db, { log = console, now = () => Date.now() } = {}) {
  const col = () => db.collection(COLLECTION);
  return {
    async get(key) {
      try {
        const snap = await col().doc(docId(key)).get();
        if (!snap.exists) return undefined;
        const d = snap.data();
        if (d.key !== key || toMillis(d.expiresAt) <= now()) return undefined;
        return JSON.parse(d.value);
      } catch (err) {
        log.warn(`[food] cache read failed: ${err.message}`);
        return undefined;
      }
    },
    async set(key, value, ttlMs) {
      try {
        const json = JSON.stringify(value === undefined ? null : value);
        if (Buffer.byteLength(json, 'utf8') > MAX_VALUE_BYTES) return;
        await col().doc(docId(key)).set({ key, value: json, expiresAt: new Date(now() + ttlMs) });
      } catch (err) {
        log.warn(`[food] cache write failed: ${err.message}`);
      }
    },
  };
}

module.exports = { createFirestoreStore, docId, COLLECTION };
