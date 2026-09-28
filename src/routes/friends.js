// Friends: request → accept, instead of one-sided "add".
//
// Adding someone used to write straight into the caller's own localStorage,
// so the other person never knew. Now a friend request is stored server-side
// and the recipient sees it (with Accept / Decline) the next time the app
// polls GET /api/friends. Only accepted friendships show up as friends, and
// those are what the app offers when sharing or building a group.
//
// Storage (server-only, see firestore.rules):
//   friendships/{a__b}   { users: [a, b], names: { a: 'Alice', b: 'bob' },
//                          requester, recipient, status: 'pending'|'accepted',
//                          createdAt, respondedAt }
// a and b are lowercase usernames, sorted, so the pair has exactly one doc
// whichever side sent the request. Listing uses a single array-contains on
// `users`, which needs no composite index.
const express = require('express');
const { profileKey, isBlockedEitherWay } = require('./profiles');

const MAX_FRIENDS = 500;
const MAX_PENDING_OUT = 50;

// Firestore Timestamps serialize as { _seconds, _nanoseconds }; send ISO.
function toIso(ts) {
  return ts && typeof ts.toDate === 'function' ? ts.toDate().toISOString() : null;
}

function pairId(a, b) {
  return a < b ? `${a}__${b}` : `${b}__${a}`;
}

function createFriendsRouter({ db, FieldValue, firebaseEnabled, sendError, sendSuccess }) {
  const router = express.Router();
  const friendships = () => db.collection('friendships');

  router.use((req, res, next) => {
    if (!firebaseEnabled) return sendError(res, 503, 'friends.firebase_disabled', 'Friends are not available right now.');
    if (!profileKey(req.user?.username)) return sendError(res, 403, 'friends.no_username', 'This session has no username.');
    next();
  });

  async function listFor(me) {
    const snap = await friendships().where('users', 'array-contains', me).get();
    return snap.docs.map(d => d.data());
  }

  // The display casing of a username, from the account record when it exists.
  async function lookupAccount(key) {
    const nameSnap = await db.collection('usernames').doc(key).get();
    if (!nameSnap.exists) return null;
    const uid = nameSnap.get('uid');
    const userSnap = uid ? await db.collection('users').doc(uid).get() : null;
    return { username: (userSnap?.exists && userSnap.get('username')) || key };
  }

  function shape(me, data) {
    const other = data.users.find(u => u !== me) || me;
    return {
      username: data.names?.[other] || other,
      status: data.status,
      direction: data.requester === me ? 'outgoing' : 'incoming',
      since: toIso(data.respondedAt || data.createdAt),
    };
  }

  // GET / — { friends: [...], incoming: [...], outgoing: [...] }
  router.get('/', async (req, res) => {
    try {
      const me = profileKey(req.user.username);
      const rows = (await listFor(me)).map(d => shape(me, d));
      const byName = (x, y) => x.username.localeCompare(y.username);
      return sendSuccess(res, 200, {
        friends: rows.filter(r => r.status === 'accepted').map(({ username, since }) => ({ username, since })).sort(byName),
        incoming: rows.filter(r => r.status === 'pending' && r.direction === 'incoming').map(({ username, since }) => ({ username, sentAt: since })),
        outgoing: rows.filter(r => r.status === 'pending' && r.direction === 'outgoing').map(({ username, since }) => ({ username, sentAt: since })),
      });
    } catch (err) {
      console.error('GET /api/friends failed:', err);
      return sendError(res, 500, 'friends.server_error', 'Could not load your friends.');
    }
  });

  // POST /requests — body: { username }. Sends a request; if that person had
  // already asked you, this accepts theirs instead.
  router.post('/requests', async (req, res) => {
    try {
      const me = profileKey(req.user.username);
      const target = profileKey(req.body?.username);
      if (!target) return sendError(res, 422, 'friends.invalid_username', 'Enter a valid username.');
      if (target === me) return sendError(res, 422, 'friends.self', 'You can’t add yourself.');

      const account = await lookupAccount(target);
      // A block either way looks like "no such user" so the sender can't tell
      // they've been blocked.
      if (!account || await isBlockedEitherWay(db, me, target)) {
        return sendError(res, 404, 'friends.not_found', 'No user found with that username.');
      }

      const ref = friendships().doc(pairId(me, target));
      const snap = await ref.get();
      const existing = snap.exists ? snap.data() : null;

      if (existing?.status === 'accepted') {
        return sendError(res, 409, 'friends.already_friends', 'You’re already friends.');
      }
      if (existing?.status === 'pending' && existing.requester === me) {
        return sendSuccess(res, 200, { status: 'pending', username: account.username });
      }
      if (existing?.status === 'pending' && existing.requester === target) {
        await ref.set({ status: 'accepted', respondedAt: FieldValue.serverTimestamp() }, { merge: true });
        return sendSuccess(res, 200, { status: 'accepted', username: account.username });
      }

      const mine = await listFor(me);
      if (mine.filter(d => d.status === 'accepted').length >= MAX_FRIENDS) {
        return sendError(res, 422, 'friends.limit', 'You’ve reached the friend limit.');
      }
      if (mine.filter(d => d.status === 'pending' && d.requester === me).length >= MAX_PENDING_OUT) {
        return sendError(res, 429, 'friends.too_many_pending', 'You have too many pending requests. Wait for some to be answered.');
      }

      await ref.set({
        users: [me, target].sort(),
        names: { [me]: req.user.username, [target]: account.username },
        requester: me,
        recipient: target,
        status: 'pending',
        createdAt: FieldValue.serverTimestamp(),
        respondedAt: null,
      });
      return sendSuccess(res, 201, { status: 'pending', username: account.username });
    } catch (err) {
      console.error('POST /api/friends/requests failed:', err);
      return sendError(res, 500, 'friends.server_error', 'Could not send the friend request.');
    }
  });

  async function pendingTo(me, other) {
    const ref = friendships().doc(pairId(me, other));
    const snap = await ref.get();
    const data = snap.exists ? snap.data() : null;
    return { ref, data: data?.status === 'pending' ? data : null };
  }

  // POST /requests/:username/accept — only the recipient can accept.
  router.post('/requests/:username/accept', async (req, res) => {
    try {
      const me = profileKey(req.user.username);
      const other = profileKey(req.params.username);
      if (!other) return sendError(res, 422, 'friends.invalid_username', 'Invalid username.');
      const { ref, data } = await pendingTo(me, other);
      if (!data || data.recipient !== me) return sendError(res, 404, 'friends.no_request', 'That friend request no longer exists.');
      await ref.set({ status: 'accepted', respondedAt: FieldValue.serverTimestamp() }, { merge: true });
      return sendSuccess(res, 200, { status: 'accepted', username: data.names?.[other] || other });
    } catch (err) {
      console.error('POST /api/friends/requests/:username/accept failed:', err);
      return sendError(res, 500, 'friends.server_error', 'Could not accept the request.');
    }
  });

  // POST /requests/:username/decline — the recipient declines, or the
  // requester cancels. Either way the request is gone.
  router.post('/requests/:username/decline', async (req, res) => {
    try {
      const me = profileKey(req.user.username);
      const other = profileKey(req.params.username);
      if (!other) return sendError(res, 422, 'friends.invalid_username', 'Invalid username.');
      const { ref, data } = await pendingTo(me, other);
      if (!data) return sendError(res, 404, 'friends.no_request', 'That friend request no longer exists.');
      await ref.delete();
      return sendSuccess(res, 200, { status: 'none' });
    } catch (err) {
      console.error('POST /api/friends/requests/:username/decline failed:', err);
      return sendError(res, 500, 'friends.server_error', 'Could not decline the request.');
    }
  });

  // DELETE /:username — unfriend (or withdraw a pending request).
  router.delete('/:username', async (req, res) => {
    try {
      const me = profileKey(req.user.username);
      const other = profileKey(req.params.username);
      if (!other) return sendError(res, 422, 'friends.invalid_username', 'Invalid username.');
      await friendships().doc(pairId(me, other)).delete();
      return sendSuccess(res, 200, { status: 'none' });
    } catch (err) {
      console.error('DELETE /api/friends/:username failed:', err);
      return sendError(res, 500, 'friends.server_error', 'Could not remove that friend.');
    }
  });

  return router;
}

// Called from account deletion so a deleted user drops off everyone's list.
async function deleteFriendships(db, username) {
  const key = profileKey(username);
  if (!key) return;
  const snap = await db.collection('friendships').where('users', 'array-contains', key).get();
  await Promise.all(snap.docs.map(d => d.ref.delete()));
}

module.exports = { createFriendsRouter, deleteFriendships, pairId };
