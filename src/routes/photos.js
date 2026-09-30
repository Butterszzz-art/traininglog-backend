// Progress photos, one per doc, so they can follow an account to every
// device without living in the app's small localStorage.
//
// The app shrinks each photo to a JPEG of about 180 KB before uploading
// (src/js/progress-photos.js) and keeps a local copy in IndexedDB. Which
// photos exist (id, slot, date) syncs through /api/sync like other data;
// this route only holds the image itself.
//
// Storage (server-only, see firestore.rules):
//   users/{uid}/photos/{id} { slot, date, data, createdAt }
// Account deletion removes them with the rest of users/{uid}.
const express = require('express');

const ID_RE = /^ph_[A-Za-z0-9_-]{4,60}$/;
const SLOTS = new Set(['front', 'side', 'back']);
const DATA_RE = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/;
const DATA_MAX_BYTES = 240 * 1024; // global JSON body limit is 256 KB

function createPhotosRouter({ db, FieldValue, firebaseEnabled, sendError, sendSuccess, resolveUid }) {
  const router = express.Router();

  router.use(async (req, res, next) => {
    if (!firebaseEnabled) return sendError(res, 503, 'photos.firebase_disabled', 'Photos are not available right now.');
    const uid = await resolveUid(req.user?.username);
    if (!uid) return sendError(res, 409, 'photos.not_migrated', 'This account can’t store photos yet.');
    req.photos = db.collection(`users/${uid}/photos`);
    next();
  });

  const idOf = req => (ID_RE.test(String(req.params.id || '')) ? req.params.id : null);

  // PUT /:id — body: { slot, date, data }. Re-sending the same id overwrites.
  router.put('/:id', async (req, res) => {
    const id = idOf(req);
    if (!id) return sendError(res, 422, 'photos.invalid_id', 'Invalid photo id.');
    const slot = SLOTS.has(req.body?.slot) ? req.body.slot : null;
    if (!slot) return sendError(res, 422, 'photos.invalid_slot', 'Slot must be front, side or back.');
    const date = /^\d{4}-\d{2}-\d{2}$/.test(String(req.body?.date || '')) ? req.body.date : null;
    if (!date) return sendError(res, 422, 'photos.invalid_date', 'Date must be YYYY-MM-DD.');
    const data = typeof req.body?.data === 'string' ? req.body.data : '';
    if (!DATA_RE.test(data)) return sendError(res, 422, 'photos.invalid_data', 'Photo must be a JPEG, PNG or WebP image.');
    if (Buffer.byteLength(data, 'utf8') > DATA_MAX_BYTES) return sendError(res, 413, 'photos.too_large', 'Photo is too large.');
    try {
      await req.photos.doc(id).set({ slot, date, data, createdAt: FieldValue.serverTimestamp() });
      return sendSuccess(res, 200, { id });
    } catch (err) {
      console.error('PUT /api/photos failed:', err);
      return sendError(res, 500, 'photos.server_error', 'Could not save the photo.');
    }
  });

  // GET /:id — { photo: { id, slot, date, data } }
  router.get('/:id', async (req, res) => {
    const id = idOf(req);
    if (!id) return sendError(res, 422, 'photos.invalid_id', 'Invalid photo id.');
    try {
      const snap = await req.photos.doc(id).get();
      if (!snap.exists) return sendError(res, 404, 'photos.not_found', 'Photo not found.');
      res.set('Cache-Control', 'private, no-store');
      return sendSuccess(res, 200, { photo: { id, slot: snap.get('slot'), date: snap.get('date'), data: snap.get('data') } });
    } catch (err) {
      console.error('GET /api/photos failed:', err);
      return sendError(res, 500, 'photos.server_error', 'Could not load the photo.');
    }
  });

  // DELETE /:id — removing a missing photo is fine.
  router.delete('/:id', async (req, res) => {
    const id = idOf(req);
    if (!id) return sendError(res, 422, 'photos.invalid_id', 'Invalid photo id.');
    try {
      await req.photos.doc(id).delete();
      return sendSuccess(res, 200, { deleted: true });
    } catch (err) {
      console.error('DELETE /api/photos failed:', err);
      return sendError(res, 500, 'photos.server_error', 'Could not delete the photo.');
    }
  });

  return router;
}

module.exports = { createPhotosRouter, DATA_MAX_BYTES };
