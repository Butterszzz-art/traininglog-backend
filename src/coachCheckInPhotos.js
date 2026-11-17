// Progress photos a coach adds to a client's check-in by hand (photos sent
// by message, taken at an in-person check-in, or for a client who doesn't
// share photos from the app).
//
// They are the coach's own records, kept under the roster doc:
//   coaches/{coachUid}/clients/{clientUid}/checkInPhotos/{photoId}
//     { date, pose, mime, data (base64), bytes, createdAt }
// with an index on the roster doc, coachPhotoIndex { 'YYYY-MM-DD': [photoId] },
// so listing never reads image bytes. Unlinking deletes the roster doc
// recursively (server.js unlinkCoachClient), which removes them too. The
// client's sharing switches don't apply: the client never sent these.
//
// Photos are validated with the client-photo rules (src/checkInPhotos.js).

const { isoDate, parsePhoto } = require('./checkInPhotos');

const MAX_PER_DATE = 10;
const MAX_DATES = 104; // two years of weekly check-ins
const POSE_MAX = 60;
const ID_RE = /^[A-Za-z0-9]{8,40}$/;

function cleanPose(value) {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, POSE_MAX) : '';
}

// Body { image, pose? } → { photo: { pose, mime, data, bytes } } or
// { error: 'invalid' | 'too_large' }.
function parseUpload(body) {
  const parsed = parsePhoto(body && body.image);
  if (!parsed) return { error: 'invalid' };
  if (parsed.tooLarge) return { error: 'too_large' };
  return { photo: { pose: cleanPose(body.pose), ...parsed } };
}

function cleanIndex(value) {
  const out = {};
  if (!value || typeof value !== 'object') return out;
  for (const [date, ids] of Object.entries(value)) {
    if (!isoDate(date) || !Array.isArray(ids)) continue;
    const clean = [...new Set(ids.filter(id => typeof id === 'string' && ID_RE.test(id)))].slice(0, MAX_PER_DATE);
    if (clean.length) out[date] = clean;
  }
  return out;
}

// { date: count } for the client detail response.
function counts(index) {
  const out = {};
  for (const [date, ids] of Object.entries(cleanIndex(index))) out[date] = ids.length;
  return out;
}

// The index with `id` added on `date`, or { error: 'too_many' | 'too_many_dates' }.
// Coach records are never pruned on their own; the coach removes old ones.
function addToIndex(index, date, id) {
  const current = cleanIndex(index);
  const ids = current[date] || [];
  if (ids.length >= MAX_PER_DATE) return { error: 'too_many' };
  if (!ids.length && Object.keys(current).length >= MAX_DATES) return { error: 'too_many_dates' };
  return { index: { ...current, [date]: [...ids, id] } };
}

// The index without `id` on `date`, or null when it isn't there.
function removeFromIndex(index, date, id) {
  const current = cleanIndex(index);
  const ids = current[date] || [];
  if (!ids.includes(id)) return null;
  const next = { ...current };
  const left = ids.filter(x => x !== id);
  if (left.length) next[date] = left; else delete next[date];
  return next;
}

// ── Firestore ────────────────────────────────────────────────────────────────

const rosterRef = (db, coachUid, clientUid) => db.collection(`coaches/${coachUid}/clients`).doc(clientUid);
const photosCol = (db, coachUid, clientUid) => rosterRef(db, coachUid, clientUid).collection('checkInPhotos');

async function readIndex(db, coachUid, clientUid) {
  const snap = await rosterRef(db, coachUid, clientUid).get();
  return cleanIndex(snap.exists ? snap.get('coachPhotoIndex') : null);
}

// Adds one photo. Returns { id, count } or { error }.
async function addPhoto(db, coachUid, clientUid, date, photo) {
  const ref = rosterRef(db, coachUid, clientUid);
  const photoRef = photosCol(db, coachUid, clientUid).doc();
  return db.runTransaction(async tx => {
    const snap = await tx.get(ref);
    const next = addToIndex(snap.exists ? snap.get('coachPhotoIndex') : null, date, photoRef.id);
    if (next.error) return { error: next.error };
    tx.set(photoRef, { date, pose: photo.pose, mime: photo.mime, data: photo.data, bytes: photo.bytes, createdAt: new Date() });
    tx.set(ref, { coachPhotoIndex: next.index }, { merge: true });
    return { id: photoRef.id, count: next.index[date].length };
  });
}

// Removes one photo. Returns the remaining count on that date, or null when
// the photo wasn't found.
async function removePhoto(db, coachUid, clientUid, date, id) {
  if (!ID_RE.test(String(id || ''))) return null;
  const ref = rosterRef(db, coachUid, clientUid);
  return db.runTransaction(async tx => {
    const snap = await tx.get(ref);
    const next = removeFromIndex(snap.exists ? snap.get('coachPhotoIndex') : null, date, id);
    if (!next) return null;
    tx.delete(photosCol(db, coachUid, clientUid).doc(id));
    // Replace the whole map so a removed date doesn't linger through merge.
    tx.update(ref, { coachPhotoIndex: next });
    return (next[date] || []).length;
  });
}

// Photos for one date as [{ id, pose, image, addedBy: 'coach' }], in upload order.
async function readPhotos(db, coachUid, clientUid, date) {
  const ids = (await readIndex(db, coachUid, clientUid))[date] || [];
  if (!ids.length) return [];
  const snaps = await Promise.all(ids.map(id => photosCol(db, coachUid, clientUid).doc(id).get()));
  return snaps.filter(s => s.exists).map(s => ({
    id: s.id,
    pose: s.get('pose') || '',
    image: `data:${s.get('mime')};base64,${s.get('data')}`,
    addedBy: 'coach',
  }));
}

module.exports = {
  MAX_PER_DATE, MAX_DATES,
  parseUpload, cleanIndex, counts, addToIndex, removeFromIndex,
  readIndex, addPhoto, removePhoto, readPhotos,
};
