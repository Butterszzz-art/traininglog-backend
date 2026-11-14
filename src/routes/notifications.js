// In-app notifications: friend requests, shares, groups, friends' posts,
// leaderboard moves and coaching (invites, accepts, notes, plan updates, videos).
//
// Things other people did to you (sent a request, shared a template, added you
// to a group, passed you on a leaderboard) used to be visible only if you
// happened to open the right panel. Each of those routes now also writes a
// notification for the person it affects, and the app shows them behind a
// bell in the Community and Leaderboard headers.
//
// Storage (server-only, see firestore.rules):
//   notifications/{id}        { to, type, category, actor, actorName, text,
//                               data, count, read, createdAt }
//   notificationPrefs/{user}  { friends, shares, groups, feed, leaderboard, coaching }
// `to` and `actor` are lowercase usernames (profileKey). Listing needs the
// composite index (to asc, createdAt desc).
//
// Noisy kinds (group posts, feed posts, being passed on a leaderboard) pass a
// `collapseKey`: while one is unread, repeats bump its `count` instead of
// adding a row, so a busy group is one line, not fifty.
const express = require('express');
const { profileKey, blockedBy } = require('./profiles');
const push = require('../push');

const CATEGORIES = ['friends', 'shares', 'groups', 'feed', 'leaderboard', 'coaching'];
const TYPE_CATEGORY = {
  friend_request: 'friends',
  friend_accepted: 'friends',
  share_received: 'shares',
  group_added: 'groups',
  group_post: 'groups',
  feed_post: 'feed',
  exercise_passed: 'leaderboard',
  volume_passed: 'leaderboard',
  coach_invite: 'coaching',
  coach_accepted: 'coaching',
  coach_note: 'coaching',
  coach_plan: 'coaching',
  coach_video: 'coaching',
  coach_resource: 'coaching',
  coach_left: 'coaching',
  coach_checkin_comment: 'coaching',
  client_checkin_reply: 'coaching',
  client_message: 'coaching',
  coach_checkin_request: 'coaching',
  client_form_check: 'coaching',
  coach_form_check: 'coaching',
};
const PAGE = 50;
const KEEP = 100;           // older rows are pruned when the list is read
const TEXT_MAX = 160;
const BATCH_MAX = 450;

function toIso(ts) {
  if (!ts) return null;
  if (typeof ts.toDate === 'function') return ts.toDate().toISOString();
  if (ts instanceof Date) return ts.toISOString();
  return typeof ts === 'string' ? ts : null;
}

// Notification doc ids can't contain '/'.
const safeKey = s => String(s).replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 300);

// { user: data } for one doc per user in `collection` ({} when missing).
async function docsFor(db, collection, users) {
  const snaps = await db.getAll(...users.map(u => db.collection(collection).doc(u)));
  const out = {};
  snaps.forEach((s, i) => { out[users[i]] = s.exists ? s.data() : {}; });
  return out;
}

// Writes one notification per recipient. Never throws: a notification failing
// must not fail the action that caused it.
//
// opts: { to: string|string[], type, actor, actorName, text, data?, collapseKey? }
async function notify(db, opts) {
  try {
    const category = TYPE_CATEGORY[opts.type];
    const actor = profileKey(opts.actor);
    if (!category || !actor) return 0;
    const recipients = [...new Set((Array.isArray(opts.to) ? opts.to : [opts.to]).map(profileKey))]
      .filter(u => u && u !== actor);
    if (!recipients.length) return 0;

    // Muted categories are skipped, and a block either way means silence.
    const [prefs, blocks, blockedByActor] = await Promise.all([
      docsFor(db, 'notificationPrefs', recipients),
      docsFor(db, 'profileBlocks', recipients),
      blockedBy(db, actor),
    ]);
    const wanted = recipients.filter(u => prefs[u][category] !== false
      && !blockedByActor.includes(u)
      && !(blocks[u].blocked || []).includes(actor));
    if (!wanted.length) return 0;

    const col = db.collection('notifications');
    const now = new Date();
    const base = {
      type: opts.type,
      category,
      actor,
      actorName: String(opts.actorName || actor).slice(0, 40),
      text: String(opts.text || '').slice(0, TEXT_MAX),
      data: opts.data && typeof opts.data === 'object' ? opts.data : {},
    };

    if (!opts.collapseKey) {
      for (let i = 0; i < wanted.length; i += BATCH_MAX) {
        const batch = db.batch();
        wanted.slice(i, i + BATCH_MAX).forEach(to => batch.set(col.doc(), { ...base, to, count: 1, read: false, createdAt: now }));
        await batch.commit();
      }
      await pushFor(db, wanted, base, null);
      return wanted.length;
    }

    // Collapsible: one doc per recipient + key. Unread → count + 1; read (or
    // missing) → starts again at 1 as a new unread row.
    const refs = wanted.map(to => collapsedRef(db, to, opts.collapseKey));
    for (let i = 0; i < refs.length; i += BATCH_MAX) {
      const chunk = refs.slice(i, i + BATCH_MAX);
      const snaps = await db.getAll(...chunk);
      const batch = db.batch();
      snaps.forEach((snap, j) => {
        const unread = snap.exists && snap.get('read') === false;
        const count = unread ? (Number(snap.get('count')) || 1) + 1 : 1;
        batch.set(chunk[j], { ...base, to: wanted[i + j], count, read: false, createdAt: now });
      });
      await batch.commit();
    }
    await pushFor(db, wanted, base, opts.collapseKey);
    return wanted.length;
  } catch (err) {
    console.error(`[notifications] ${opts?.type} failed:`, err.message);
    return 0;
  }
}

// The phone push for a notification just written (see src/push.js). The text
// reads as a sentence after the name ("Sam sent you a friend request"), and a
// collapsible kind replaces its earlier banner instead of stacking up.
async function pushFor(db, users, base, collapseKey) {
  const body = base.text ? `${base.actorName} ${base.text}` : '';
  await push.getSender().sendToUsers(db, users, {
    body,
    threadId: base.category,
    collapseId: collapseKey ? safeKey(collapseKey) : undefined,
    data: { type: base.type, category: base.category },
  });
}

// Volume leaderboard (users/{uid}.totalVolume, top 100 — see leaderboard.js):
// after a save raises someone's total, tell the people they just passed. Only
// while the lifter is on the visible board, and at most the closest 20.
const VOLUME_BOARD_SIZE = 100;
async function notifyVolumePasses(db, { uid, username, prevTotal, nextTotal }) {
  try {
    if (!(nextTotal > prevTotal)) return 0;
    const users = db.collection('users');
    if (typeof users.where('totalVolume', '>', nextTotal).count === 'function') {
      const above = await users.where('totalVolume', '>', nextTotal).count().get();
      if (above.data().count >= VOLUME_BOARD_SIZE) return 0;
    }
    const snap = await users
      .where('totalVolume', '>=', prevTotal)
      .where('totalVolume', '<', nextTotal)
      .orderBy('totalVolume', 'desc')
      .limit(21)
      .get();
    const passed = snap.docs.filter(d => d.id !== uid).map(d => d.get('username')).filter(Boolean).slice(0, 20);
    return notify(db, {
      to: passed, type: 'volume_passed', actor: username, actorName: username,
      text: 'passed you on the volume leaderboard', data: {},
      collapseKey: `volume_passed__${profileKey(username)}`,
    });
  } catch (err) {
    console.error('[notifications] volume passes failed:', err.message);
    return 0;
  }
}

// The doc a collapsible notification lives in, so a caller can update or
// remove it later (e.g. a coach invite once it's answered or cancelled).
function collapsedRef(db, to, collapseKey) {
  return db.collection('notifications').doc(safeKey(`${profileKey(to)}__${collapseKey}`));
}

function shape(doc) {
  const d = doc.data();
  return {
    id: doc.id,
    type: d.type,
    category: d.category,
    actor: d.actorName || d.actor,
    text: d.text || '',
    data: d.data || {},
    count: Number(d.count) || 1,
    read: d.read === true,
    createdAt: toIso(d.createdAt),
  };
}

function createNotificationsRouter({ db, firebaseEnabled, sendError, sendSuccess }) {
  const router = express.Router();
  const col = () => db.collection('notifications');

  router.use((req, res, next) => {
    if (!firebaseEnabled) return sendError(res, 503, 'notifications.firebase_disabled', 'Notifications are not available right now.');
    if (!profileKey(req.user?.username)) return sendError(res, 403, 'notifications.no_username', 'This session has no username.');
    req.me = profileKey(req.user.username);
    next();
  });

  // GET / — { items: [...newest first], unread }
  router.get('/', async (req, res) => {
    try {
      const snap = await col().where('to', '==', req.me).orderBy('createdAt', 'desc').limit(KEEP + 20).get();
      const docs = snap.docs;
      if (docs.length > KEEP) {
        await Promise.all(docs.slice(KEEP).map(d => d.ref.delete())).catch(() => {});
      }
      const items = docs.slice(0, PAGE).map(shape);
      return sendSuccess(res, 200, { items, unread: items.filter(i => !i.read).length });
    } catch (err) {
      console.error('GET /api/notifications failed:', err);
      return sendError(res, 500, 'notifications.server_error', 'Could not load notifications.');
    }
  });

  // POST /read — body: { ids?: string[] }. No ids = mark everything read.
  router.post('/read', async (req, res) => {
    try {
      const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String).slice(0, PAGE) : null;
      let docs;
      if (ids) {
        const snaps = ids.length ? await db.getAll(...ids.map(id => col().doc(id))) : [];
        docs = snaps.filter(s => s.exists && s.get('to') === req.me);
      } else {
        docs = (await col().where('to', '==', req.me).where('read', '==', false).get()).docs;
      }
      if (docs.length) {
        const batch = db.batch();
        docs.forEach(d => batch.update(d.ref, { read: true }));
        await batch.commit();
      }
      return sendSuccess(res, 200, { updated: docs.length });
    } catch (err) {
      console.error('POST /api/notifications/read failed:', err);
      return sendError(res, 500, 'notifications.server_error', 'Could not update notifications.');
    }
  });

  // POST /push-token — body: { token, platform: 'ios' }. The app sends its
  // APNs device token after the user allows notifications, and on each launch.
  router.post('/push-token', async (req, res) => {
    try {
      const token = String(req.body?.token || '').trim();
      const platform = String(req.body?.platform || 'ios');
      if (platform !== 'ios') return sendError(res, 400, 'notifications.bad_platform', 'Only iOS push is supported.');
      if (!push.isValidToken(token)) return sendError(res, 400, 'notifications.bad_token', 'That push token is not valid.');
      await push.saveToken(db, req.me, token, platform);
      return sendSuccess(res, 200, { saved: true, pushEnabled: push.getSender().enabled });
    } catch (err) {
      console.error('POST /api/notifications/push-token failed:', err);
      return sendError(res, 500, 'notifications.server_error', 'Could not save the push token.');
    }
  });

  // DELETE /push-token — body: { token }. Sent on sign-out so this phone stops
  // getting the account's pushes.
  router.delete('/push-token', async (req, res) => {
    try {
      const token = String(req.body?.token || '').trim();
      if (push.isValidToken(token)) await push.removeToken(db, req.me, token);
      return sendSuccess(res, 200, { removed: true });
    } catch (err) {
      console.error('DELETE /api/notifications/push-token failed:', err);
      return sendError(res, 500, 'notifications.server_error', 'Could not remove the push token.');
    }
  });

  // DELETE /:id — dismiss one.
  router.delete('/:id', async (req, res) => {
    try {
      const ref = col().doc(String(req.params.id));
      const snap = await ref.get();
      if (snap.exists && snap.get('to') === req.me) await ref.delete();
      return sendSuccess(res, 200, { deleted: true });
    } catch (err) {
      console.error('DELETE /api/notifications/:id failed:', err);
      return sendError(res, 500, 'notifications.server_error', 'Could not remove that notification.');
    }
  });

  // GET /prefs, PUT /prefs — { friends, shares, groups, feed, leaderboard } (all default on)
  const fullPrefs = data => Object.fromEntries(CATEGORIES.map(c => [c, data?.[c] !== false]));
  router.get('/prefs', async (req, res) => {
    try {
      const snap = await db.collection('notificationPrefs').doc(req.me).get();
      return sendSuccess(res, 200, { prefs: fullPrefs(snap.exists ? snap.data() : {}) });
    } catch (err) {
      console.error('GET /api/notifications/prefs failed:', err);
      return sendError(res, 500, 'notifications.server_error', 'Could not load your settings.');
    }
  });
  router.put('/prefs', async (req, res) => {
    try {
      const patch = {};
      CATEGORIES.forEach(c => { if (typeof req.body?.[c] === 'boolean') patch[c] = req.body[c]; });
      const ref = db.collection('notificationPrefs').doc(req.me);
      await ref.set(patch, { merge: true });
      const snap = await ref.get();
      return sendSuccess(res, 200, { prefs: fullPrefs(snap.data()) });
    } catch (err) {
      console.error('PUT /api/notifications/prefs failed:', err);
      return sendError(res, 500, 'notifications.server_error', 'Could not save your settings.');
    }
  });

  return router;
}

// Account deletion: notifications to the user, and their prefs. Rows they
// caused for others stay (they only carry the display name) until pruned.
async function deleteNotifications(db, username) {
  const key = profileKey(username);
  if (!key) return;
  const snap = await db.collection('notifications').where('to', '==', key).get();
  await Promise.all(snap.docs.map(d => d.ref.delete()));
  await db.collection('notificationPrefs').doc(key).delete();
  await push.deleteTokensFor(db, key);
}

module.exports = { createNotificationsRouter, notify, notifyVolumePasses, collapsedRef, deleteNotifications, CATEGORIES, TYPE_CATEGORY };
