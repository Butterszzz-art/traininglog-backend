// Photos a client attaches to a weekly check-in for their coach (usually
// posing photos from the app's Posing tab).
//
// Stored under the client: users/{uid}/checkInPhotos/{date}_{n}
//   { date, index, pose, mime, data (base64), bytes, createdAt }
// plus an index on the user doc, users/{uid}.checkInPhotoIndex
//   { 'YYYY-MM-DD': count }
// so listing, replacing and pruning never has to read image bytes. Deleting
// the account deletes users/{uid} recursively, which removes them too.
//
// A coach can read them while linked (roster doc active) and while the
// client's check-in sharing switch is on. Turning that switch off deletes
// them. Only the newest MAX_DATES check-ins keep photos, matching the 12
// check-ins a share holds (src/coachShare.js).

const MAX_PHOTOS = 10;
const MAX_DATES = 12;
const PHOTO_MAX_BYTES = 450 * 1024;
const POSE_MAX = 60;
const MIME = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };

function isoDate(value) {
  const m = typeof value === 'string' && /^(\d{4}-\d{2}-\d{2})$/.exec(value.trim());
  if (!m) return null;
  return Number.isNaN(Date.parse(m[1] + 'T00:00:00Z')) ? null : m[1];
}

// A JPEG/PNG/WebP data URL up to PHOTO_MAX_BYTES (decoded), checked on the
// file's own signature. Returns null, { tooLarge: true } or { mime, data, bytes }.
function parsePhoto(dataUrl) {
  if (typeof dataUrl !== 'string') return null;
  const m = /^data:image\/(jpeg|jpg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl);
  if (!m) return null;
  const buf = Buffer.from(m[2], 'base64');
  if (!buf.length) return null;
  if (buf.length > PHOTO_MAX_BYTES) return { tooLarge: true };
  let kind = null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) kind = 'jpeg';
  else if (buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) kind = 'png';
  else if (buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP') kind = 'webp';
  if (!kind) return null;
  return { mime: MIME[kind], data: buf.toString('base64'), bytes: buf.length };
}

function cleanPose(value) {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, POSE_MAX) : '';
}

// Body { photos: [{ image, pose? }] } → { photos: [{ pose, mime, data, bytes }] }
// or { error: 'missing' | 'too_many' | 'too_large' | 'invalid' }.
function parsePhotoList(body) {
  const list = body && Array.isArray(body.photos) ? body.photos : null;
  if (!list || !list.length) return { error: 'missing' };
  if (list.length > MAX_PHOTOS) return { error: 'too_many' };
  const photos = [];
  for (const raw of list) {
    const parsed = parsePhoto(raw && raw.image);
    if (!parsed) return { error: 'invalid' };
    if (parsed.tooLarge) return { error: 'too_large' };
    photos.push({ pose: cleanPose(raw.pose), ...parsed });
  }
  return { photos };
}

function cleanIndex(value) {
  const out = {};
  if (!value || typeof value !== 'object') return out;
  for (const [date, count] of Object.entries(value)) {
    const n = Math.round(Number(count));
    if (isoDate(date) && n > 0) out[date] = Math.min(n, MAX_PHOTOS);
  }
  return out;
}

// The index after setting `date` to `count` photos (0 removes it), keeping
// only the newest MAX_DATES dates. `dropped` lists dates whose photos must
// be deleted, with their old counts.
function nextIndex(index, date, count) {
  const current = cleanIndex(index);
  const next = { ...current };
  if (count > 0) next[date] = count; else delete next[date];
  const keep = new Set(Object.keys(next).sort().reverse().slice(0, MAX_DATES));
  const out = {};
  for (const d of Object.keys(next)) if (keep.has(d)) out[d] = next[d];
  const dropped = Object.entries(current).filter(([d]) => !(d in out) || d === date).map(([d, n]) => ({ date: d, count: n }));
  return { index: out, dropped };
}

const photoId = (date, i) => `${date}_${i}`;
const photoIds = (date, count) => Array.from({ length: count }, (_v, i) => photoId(date, i));

// ── Firestore ────────────────────────────────────────────────────────────────

const photosCol = (db, uid) => db.collection(`users/${uid}/checkInPhotos`);

async function readIndex(db, uid) {
  const snap = await db.collection('users').doc(uid).get();
  return cleanIndex(snap.exists ? snap.get('checkInPhotoIndex') : null);
}

// Replaces the photos for one check-in date and prunes old dates. Returns
// null (and changes nothing) when the date is older than every kept one.
async function savePhotos(db, uid, date, photos) {
  const { index, dropped } = nextIndex(await readIndex(db, uid), date, photos.length);
  if (!index[date]) return null;
  const batch = db.batch();
  for (const d of dropped) for (const id of photoIds(d.date, d.count)) batch.delete(photosCol(db, uid).doc(id));
  await batch.commit();
  const write = db.batch();
  photos.forEach((p, i) => write.set(photosCol(db, uid).doc(photoId(date, i)), {
    date, index: i, pose: p.pose, mime: p.mime, data: p.data, bytes: p.bytes, createdAt: new Date(),
  }));
  write.set(db.collection('users').doc(uid), { checkInPhotoIndex: index }, { merge: true });
  await write.commit();
  return index;
}

async function deletePhotos(db, uid, date) {
  const { index, dropped } = nextIndex(await readIndex(db, uid), date, 0);
  const batch = db.batch();
  for (const d of dropped) for (const id of photoIds(d.date, d.count)) batch.delete(photosCol(db, uid).doc(id));
  batch.set(db.collection('users').doc(uid), { checkInPhotoIndex: index }, { merge: true });
  await batch.commit();
  return index;
}

// Check-in sharing switched off: every photo goes.
async function deleteAllPhotos(db, uid) {
  const index = await readIndex(db, uid);
  const batch = db.batch();
  for (const [date, count] of Object.entries(index)) for (const id of photoIds(date, count)) batch.delete(photosCol(db, uid).doc(id));
  batch.set(db.collection('users').doc(uid), { checkInPhotoIndex: {} }, { merge: true });
  await batch.commit();
}

// The pose label of one photo (no image bytes), for a comment pinned to it.
async function readPose(db, uid, date, i) {
  const snap = await photosCol(db, uid).doc(photoId(date, i)).get();
  return snap.exists ? snap.get('pose') || '' : '';
}

// Photos for one date as [{ index, pose, image }] (data URLs), in order.
async function readPhotos(db, uid, date) {
  const count = (await readIndex(db, uid))[date] || 0;
  if (!count) return [];
  const snaps = await Promise.all(photoIds(date, count).map(id => photosCol(db, uid).doc(id).get()));
  return snaps.filter(s => s.exists).map(s => ({
    index: s.get('index'),
    pose: s.get('pose') || '',
    image: `data:${s.get('mime')};base64,${s.get('data')}`,
  })).sort((a, b) => a.index - b.index);
}

module.exports = {
  MAX_PHOTOS, MAX_DATES, PHOTO_MAX_BYTES,
  isoDate, parsePhoto, parsePhotoList, cleanIndex, nextIndex, photoIds,
  readIndex, savePhotos, deletePhotos, deleteAllPhotos, readPhotos, readPose,
};
