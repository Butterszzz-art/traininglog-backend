// Community feed: posts (updates, PRs, workouts) from you and your friends.
//
// The app's Feed used to keep posts in the device's localStorage, so only the
// author ever saw them. Posts are now stored server-side and shown to the
// author's accepted friends.
//
// Storage (server-only, see firestore.rules):
//   feedPosts/{id}   { author, authorName, type, text, workout?, createdAt }
//   feedReports/{…}  { postId, target, reporter, reason, note, status, createdAt }
// Listing needs the composite index (author asc, createdAt desc) in
// firestore.indexes.json: friends are read in chunks of 30 with `in`.
//
// Guideline 1.2: word filter on post text, reports email a moderator,
// blocked users' posts are hidden, moderators (PROFILE_ADMINS) can delete.
const express = require('express');
const { profileKey, cleanText, containsObjectionable, blockedBy } = require('./profiles');
const { cleanPostText } = require('./groups');

const POST_TYPES = new Set(['update', 'pr', 'workout']);
const REPORT_REASONS = new Set(['inappropriate', 'harassment', 'spam', 'other']);
const PAGE = 50;
const IN_CHUNK = 30;
const REPORT_NOTE_MAX = 300;

function toIso(ts) {
  if (!ts) return null;
  if (typeof ts.toDate === 'function') return ts.toDate().toISOString();
  if (ts instanceof Date) return ts.toISOString();
  return typeof ts === 'string' ? ts : null;
}

const num = (v, max) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.min(Math.round(n * 10) / 10, max) : 0;
};

// The workout card the app attaches to a "Workout" post (see
// summariseWorkout in the app's community-feed.js). Numbers only, bounded.
function cleanWorkoutSummary(w) {
  if (!w || typeof w !== 'object') return null;
  const names = (Array.isArray(w.names) ? w.names : [])
    .map(n => cleanText(String(n ?? ''), 60)).filter(Boolean).slice(0, 12);
  const top = w.top && typeof w.top === 'object' && cleanText(String(w.top.name ?? ''), 60)
    ? { name: cleanText(String(w.top.name), 60), kg: num(w.top.kg, 2000), reps: Math.round(num(w.top.reps, 1000)) }
    : null;
  return {
    title: cleanText(String(w.title ?? ''), 60) || 'Workout',
    volume: Math.round(num(w.volume, 1e7)),
    exercises: Math.round(num(w.exercises, 200)),
    sets: Math.round(num(w.sets, 2000)),
    names,
    top,
  };
}

function createFeedRouter({
  db, FieldValue, firebaseEnabled, sendError, sendSuccess, adminUsernames = [],
  objectionableTerms = [], notifyModerators = async () => {},
}) {
  const router = express.Router();
  const admins = new Set(adminUsernames.map(u => String(u).trim().toLowerCase()).filter(Boolean));
  const terms = objectionableTerms.map(t => String(t).trim().toLowerCase()).filter(Boolean);
  const posts = () => db.collection('feedPosts');

  router.use((req, res, next) => {
    if (!firebaseEnabled) return sendError(res, 503, 'feed.firebase_disabled', 'The feed is not available right now.');
    if (!profileKey(req.user?.username)) return sendError(res, 403, 'feed.no_username', 'This session has no username.');
    req.me = profileKey(req.user.username);
    req.isAdmin = admins.has(req.me);
    next();
  });

  function shape(doc, me, isAdmin) {
    const d = doc.data();
    return {
      id: doc.id,
      author: d.authorName || d.author,
      type: d.type || 'update',
      text: d.text || '',
      workout: d.workout || null,
      date: toIso(d.createdAt),
      mine: d.author === me,
      canDelete: d.author === me || isAdmin,
    };
  }

  async function friendKeys(me) {
    const snap = await db.collection('friendships').where('users', 'array-contains', me).get();
    return snap.docs
      .map(d => d.data())
      .filter(d => d.status === 'accepted')
      .map(d => d.users.find(u => u !== me))
      .filter(Boolean);
  }

  // GET / — posts by you and your friends, newest first. ?before=<ISO> pages.
  router.get('/', async (req, res) => {
    try {
      const me = req.me;
      const [friends, blocked] = await Promise.all([friendKeys(me), blockedBy(db, me)]);
      const authors = [me, ...friends.filter(f => !blocked.includes(f))];
      const before = req.query.before ? new Date(String(req.query.before)) : null;
      const chunks = [];
      for (let i = 0; i < authors.length; i += IN_CHUNK) chunks.push(authors.slice(i, i + IN_CHUNK));
      const snaps = await Promise.all(chunks.map(chunk => {
        let q = posts().where('author', 'in', chunk).orderBy('createdAt', 'desc');
        if (before && !Number.isNaN(before.getTime())) q = q.startAfter(before);
        return q.limit(PAGE).get();
      }));
      const all = snaps.flatMap(s => s.docs)
        .sort((a, b) => new Date(toIso(b.get('createdAt'))) - new Date(toIso(a.get('createdAt'))));
      const page = all.slice(0, PAGE).map(d => shape(d, me, req.isAdmin));
      return sendSuccess(res, 200, { posts: page, hasMore: all.length > PAGE || snaps.some(s => s.size === PAGE) });
    } catch (err) {
      console.error('GET /api/feed failed:', err);
      return sendError(res, 500, 'feed.server_error', 'Could not load the feed.');
    }
  });

  // POST / — body: { type, text, workout? }. Visible to you and your friends.
  router.post('/', async (req, res) => {
    try {
      const type = POST_TYPES.has(req.body?.type) ? req.body.type : 'update';
      const text = cleanPostText(req.body?.text);
      const workout = type === 'workout' ? cleanWorkoutSummary(req.body?.workout) : null;
      if (!text && !workout) return sendError(res, 422, 'feed.empty_post', 'Write something first.');
      const names = workout ? [workout.title, ...workout.names, workout.top?.name || ''].join(' ') : '';
      if (containsObjectionable(text, terms) || containsObjectionable(names, terms)) {
        return sendError(res, 422, 'feed.objectionable', 'Your post contains language that isn’t allowed. Please edit it.');
      }
      const data = {
        author: req.me,
        authorName: req.user.username,
        type,
        text,
        createdAt: new Date(),
      };
      if (workout) data.workout = workout;
      const ref = await posts().add(data);
      return sendSuccess(res, 201, { post: shape({ id: ref.id, data: () => data }, req.me, req.isAdmin) });
    } catch (err) {
      console.error('POST /api/feed failed:', err);
      return sendError(res, 500, 'feed.server_error', 'Could not post.');
    }
  });

  // DELETE /:id — the author or a moderator.
  router.delete('/:id', async (req, res) => {
    try {
      const ref = posts().doc(String(req.params.id));
      const snap = await ref.get();
      if (!snap.exists) return sendSuccess(res, 200, { deleted: true });
      if (snap.get('author') !== req.me && !req.isAdmin) {
        return sendError(res, 403, 'feed.forbidden', 'You can only delete your own posts.');
      }
      await ref.delete();
      return sendSuccess(res, 200, { deleted: true });
    } catch (err) {
      console.error('DELETE /api/feed/:id failed:', err);
      return sendError(res, 500, 'feed.server_error', 'Could not delete the post.');
    }
  });

  // POST /:id/report — body: { reason, note? }
  router.post('/:id/report', async (req, res) => {
    try {
      const reason = REPORT_REASONS.has(req.body?.reason) ? req.body.reason : null;
      if (!reason) return sendError(res, 422, 'feed.invalid_reason', 'Pick a reason for the report.');
      const snap = await posts().doc(String(req.params.id)).get();
      if (!snap.exists) return sendError(res, 404, 'feed.not_found', 'That post no longer exists.');
      const target = snap.get('author');
      if (target === req.me) return sendError(res, 422, 'feed.cannot_report_self', 'You can’t report your own post.');
      await db.collection('feedReports').doc(`${snap.id}__${req.me}`).set({
        postId: snap.id,
        target,
        reporter: req.me,
        reason,
        note: cleanText(req.body?.note, REPORT_NOTE_MAX, { multiline: true }),
        status: 'open',
        createdAt: FieldValue.serverTimestamp(),
      });
      Promise.resolve()
        .then(() => notifyModerators(`Feed report (${reason}): a post by @${target} (feedPosts/${snap.id}) reported by @${req.me}. Review within 24 hours.`))
        .catch(err => console.error('[moderation] notify failed:', err.message));
      return sendSuccess(res, 201, { reported: true });
    } catch (err) {
      console.error('POST /api/feed/:id/report failed:', err);
      return sendError(res, 500, 'feed.server_error', 'Could not send the report.');
    }
  });

  return router;
}

// Account deletion: remove the user's feed posts.
async function deleteFeedPosts(db, username) {
  const key = profileKey(username);
  if (!key) return;
  const snap = await db.collection('feedPosts').where('author', '==', key).get();
  await Promise.all(snap.docs.map(d => d.ref.delete()));
}

module.exports = { createFeedRouter, deleteFeedPosts, cleanWorkoutSummary };
