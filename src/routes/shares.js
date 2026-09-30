// Sharing a program or template with a friend.
//
// The app used to "send" by writing into the recipient's localStorage key on
// the sender's own device (and calling /shareProgram and /shared-inbox,
// which never existed), so nothing ever arrived. Shares are now stored
// server-side; the recipient sees them in their inbox, saves or dismisses
// them, and the share is deleted.
//
// Storage (server-only, see firestore.rules):
//   shares/{id} { from, fromName, to, toName, type, name, data, note, createdAt }
// Only accepted friends (and not blocked either way) can share.
const express = require('express');
const { profileKey, cleanText, containsObjectionable, isBlockedEitherWay } = require('./profiles');
const { pairId } = require('./friends');
const { notify } = require('./notifications');

const TYPES = new Set(['program', 'template']);
const DATA_MAX_BYTES = 60 * 1024;
const INBOX_MAX = 100;
const NOTE_MAX = 200;

function toIso(ts) {
  if (!ts) return null;
  if (typeof ts.toDate === 'function') return ts.toDate().toISOString();
  if (ts instanceof Date) return ts.toISOString();
  return typeof ts === 'string' ? ts : null;
}

function createSharesRouter({ db, firebaseEnabled, sendError, sendSuccess, objectionableTerms = [] }) {
  const router = express.Router();
  const terms = objectionableTerms.map(t => String(t).trim().toLowerCase()).filter(Boolean);
  const shares = () => db.collection('shares');

  router.use((req, res, next) => {
    if (!firebaseEnabled) return sendError(res, 503, 'shares.firebase_disabled', 'Sharing is not available right now.');
    if (!profileKey(req.user?.username)) return sendError(res, 403, 'shares.no_username', 'This session has no username.');
    req.me = profileKey(req.user.username);
    next();
  });

  function shapeIn(doc) {
    const d = doc.data();
    return { id: doc.id, from: d.fromName || d.from, type: d.type, name: d.name, data: d.data, note: d.note || '', sentAt: toIso(d.createdAt) };
  }
  function shapeOut(doc) {
    const d = doc.data();
    return { id: doc.id, to: d.toName || d.to, type: d.type, name: d.name, note: d.note || '', sentAt: toIso(d.createdAt) };
  }
  const newestFirst = (a, b) => String(b.sentAt).localeCompare(String(a.sentAt));

  // GET / — { inbox: [...], sent: [...] } (sent = not yet saved/dismissed)
  router.get('/', async (req, res) => {
    try {
      const [inSnap, outSnap] = await Promise.all([
        shares().where('to', '==', req.me).get(),
        shares().where('from', '==', req.me).get(),
      ]);
      return sendSuccess(res, 200, {
        inbox: inSnap.docs.map(shapeIn).sort(newestFirst),
        sent: outSnap.docs.map(shapeOut).sort(newestFirst),
      });
    } catch (err) {
      console.error('GET /api/shares failed:', err);
      return sendError(res, 500, 'shares.server_error', 'Could not load shared items.');
    }
  });

  // POST / — body: { to, type, name, data, note? }
  router.post('/', async (req, res) => {
    try {
      const me = req.me;
      const to = profileKey(req.body?.to);
      if (!to) return sendError(res, 422, 'shares.invalid_username', 'Enter a friend’s username.');
      if (to === me) return sendError(res, 422, 'shares.self', 'You can’t share with yourself.');
      const type = TYPES.has(req.body?.type) ? req.body.type : null;
      if (!type) return sendError(res, 422, 'shares.invalid_type', 'Only programs and templates can be shared.');
      const data = req.body?.data && typeof req.body.data === 'object' ? req.body.data : null;
      if (!data) return sendError(res, 422, 'shares.invalid_data', 'That item can’t be shared.');
      const json = JSON.stringify(data);
      if (Buffer.byteLength(json, 'utf8') > DATA_MAX_BYTES) return sendError(res, 413, 'shares.too_large', 'That item is too large to share.');
      const name = cleanText(req.body?.name, 60) || 'Untitled';
      const note = cleanText(req.body?.note, NOTE_MAX, { multiline: true });
      if (containsObjectionable(`${name} ${note}`, terms)) {
        return sendError(res, 422, 'shares.objectionable', 'That name or note contains language that isn’t allowed.');
      }

      const friendship = await db.collection('friendships').doc(pairId(me, to)).get();
      if (!friendship.exists || friendship.get('status') !== 'accepted' || await isBlockedEitherWay(db, me, to)) {
        return sendError(res, 422, 'shares.not_friends', 'You can only share with friends. Send them a friend request first.');
      }
      const inbox = await shares().where('to', '==', to).get();
      if (inbox.size >= INBOX_MAX) return sendError(res, 422, 'shares.inbox_full', 'Their inbox is full right now.');

      const doc = {
        from: me,
        fromName: req.user.username,
        to,
        toName: friendship.get('names')?.[to] || to,
        type,
        name,
        data: JSON.parse(json),
        note,
        createdAt: new Date(),
      };
      const ref = await shares().add(doc);
      await notify(db, {
        to, type: 'share_received', actor: me, actorName: req.user.username,
        text: `sent you a ${type}: ${name}`, data: { shareId: ref.id, kind: type, name },
      });
      return sendSuccess(res, 201, { share: shapeOut({ id: ref.id, data: () => doc }) });
    } catch (err) {
      console.error('POST /api/shares failed:', err);
      return sendError(res, 500, 'shares.server_error', 'Could not share that item.');
    }
  });

  // DELETE /:id — recipient saves/dismisses it, or the sender unsends it.
  router.delete('/:id', async (req, res) => {
    try {
      const ref = shares().doc(String(req.params.id));
      const snap = await ref.get();
      if (!snap.exists) return sendSuccess(res, 200, { deleted: true });
      if (snap.get('to') !== req.me && snap.get('from') !== req.me) {
        return sendError(res, 403, 'shares.forbidden', 'That item isn’t yours.');
      }
      await ref.delete();
      return sendSuccess(res, 200, { deleted: true });
    } catch (err) {
      console.error('DELETE /api/shares/:id failed:', err);
      return sendError(res, 500, 'shares.server_error', 'Could not remove that item.');
    }
  });

  return router;
}

// Account deletion: drop shares sent to or by the user.
async function deleteShares(db, username) {
  const key = profileKey(username);
  if (!key) return;
  const [a, b] = await Promise.all([
    db.collection('shares').where('to', '==', key).get(),
    db.collection('shares').where('from', '==', key).get(),
  ]);
  await Promise.all([...a.docs, ...b.docs].map(d => d.ref.delete()));
}

module.exports = { createSharesRouter, deleteShares };
