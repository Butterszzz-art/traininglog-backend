// Public profiles: profile photo, display name, short bio and who may see them.
//
// Everything else in this backend is private to the account owner; this is
// the one piece of a user that other people see (community feed, leaderboard,
// friends, a coach's client list). It is keyed by lowercase username because
// that is the identity every one of those screens already has in hand.
//
// Storage (all server-only, see firestore.rules):
//   profiles/{usernameLower}        { username, uid, displayName, bio,
//                                     visibility, avatarVersion, updatedAt }
//   profileAvatars/{usernameLower}  { data (base64), mime, version, bytes }
//   profileReports/{autoId}         { target, reporter, reason, note, status }
//   profileBlocks/{usernameLower}   { blocked: [usernameLower, ...], updatedAt }
//
// Moderation (App Store Guideline 1.2 — apps with user content must filter
// objectionable material, let users report it and block abusive users, and
// act on reports within 24 hours):
//   - reports and blocks call notifyModerators() so a person sees them
//     (emailed to MODERATION_EMAIL_TO, see src/moderationEmail.js)
//   - a block hides the blocked user's photo/name/bio from the blocker, ends
//     any friendship between them and stops new friend requests either way
//   - names and bios containing any OBJECTIONABLE_TERMS are rejected
//
// Photos live in Firestore rather than Cloud Storage: the app shrinks them to
// a small square JPEG (~10-30 KB) before upload, which is well under the 1 MB
// document limit, and it keeps every read behind this API's auth + visibility
// check instead of handing out public bucket URLs. The avatar sits in its own
// collection so lookups that only need names/bios never pull image bytes, and
// clients send back the version they already cache so unchanged photos are
// never re-sent.
//
// Visibility:
//   everyone — any signed-in user sees photo, name and bio
//   coach    — only the owner's linked coach / clients (active link)
//   private  — nobody but the owner; others just see the username + initials
const express = require('express');

const VISIBILITIES = new Set(['everyone', 'coach', 'private']);
const REPORT_REASONS = new Set(['inappropriate', 'impersonation', 'spam', 'other']);
const USERNAME_RE = /^[a-zA-Z0-9_.-]{2,64}$/;
const DISPLAY_NAME_MAX = 40;
const BIO_MAX = 160;
const REPORT_NOTE_MAX = 300;
const AVATAR_MAX_BYTES = 150 * 1024;
const LOOKUP_MAX = 100;
const AVATAR_MIME = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };

function profileKey(username) {
  const s = String(username || '');
  // "." and ".." are valid usernames under USERNAME_RE but not valid doc ids.
  if (!USERNAME_RE.test(s) || /^\.+$/.test(s)) return null;
  return s.toLowerCase();
}

// Strips control characters and collapses whitespace; profile text is shown
// in other people's apps, so it is kept to a single short plain-text line
// (the bio keeps line breaks, capped at 3).
function cleanText(value, max, { multiline = false } = {}) {
  if (typeof value !== 'string') return '';
  let s = value.replace(/[\u0000-\u0009\u000B-\u001F\u007F​-‏‪-‮⁦-⁩]/g, '');
  if (multiline) {
    s = s.split('\n').map(l => l.replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, 3).join('\n');
  } else {
    s = s.replace(/\s+/g, ' ').trim();
  }
  return Array.from(s).slice(0, max).join('');
}

// Accepts a data URL and returns { mime, data, bytes } only if the decoded
// bytes really are a JPEG/PNG/WebP (the declared type alone is not trusted).
function parseAvatar(dataUrl) {
  if (typeof dataUrl !== 'string') return null;
  const m = /^data:image\/(jpeg|jpg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl);
  if (!m) return null;
  const buf = Buffer.from(m[2], 'base64');
  if (!buf.length || buf.length > AVATAR_MAX_BYTES) return { tooLarge: buf.length > AVATAR_MAX_BYTES };
  let kind = null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) kind = 'jpeg';
  else if (buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) kind = 'png';
  else if (buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP') kind = 'webp';
  if (!kind) return null;
  return { mime: AVATAR_MIME[kind], data: buf.toString('base64'), bytes: buf.length };
}

const BLOCKS_MAX = 500;

// True if `text` contains any of `terms` as a whole word (so a term like
// "ass" doesn't reject "class"). Terms are matched case-insensitively.
function containsObjectionable(text, terms) {
  const s = String(text || '').toLowerCase();
  if (!s || !terms?.length) return false;
  return terms.some(term => {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}($|[^\\p{L}\\p{N}])`, 'u').test(s);
  });
}

function parseTerms(value) {
  return String(value || '').split(',').map(t => t.trim().toLowerCase()).filter(Boolean);
}

// Usernames (lowercase) that `blocker` has blocked.
async function blockedBy(db, blocker) {
  const key = profileKey(blocker);
  if (!key) return [];
  const snap = await db.collection('profileBlocks').doc(key).get();
  return snap.exists ? (snap.get('blocked') || []) : [];
}

// True if either user has blocked the other.
async function isBlockedEitherWay(db, a, b) {
  const [ka, kb] = [profileKey(a), profileKey(b)];
  if (!ka || !kb) return false;
  const [aBlocks, bBlocks] = await Promise.all([blockedBy(db, ka), blockedBy(db, kb)]);
  return aBlocks.includes(kb) || bBlocks.includes(ka);
}

function newVersion() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function createProfilesRouter({
  db, FieldValue, firebaseEnabled, resolveUid, sendError, sendSuccess, adminUsernames = [],
  objectionableTerms = [], notifyModerators = async () => {},
}) {
  const router = express.Router();
  const admins = new Set(adminUsernames.map(u => String(u).trim().toLowerCase()).filter(Boolean));
  const terms = objectionableTerms.map(t => String(t).trim().toLowerCase()).filter(Boolean);

  // A failed alert must never fail the user's request — the report/block is
  // already saved and can be found in Firestore.
  function alertModerators(message) {
    Promise.resolve()
      .then(() => notifyModerators(message))
      .catch(err => console.error('[moderation] notify failed:', err.message));
  }

  const profiles = () => db.collection('profiles');
  const avatars = () => db.collection('profileAvatars');

  router.use((req, res, next) => {
    if (!firebaseEnabled) return sendError(res, 503, 'profile.firebase_disabled', 'Profiles are not available right now.');
    if (!profileKey(req.user?.username)) return sendError(res, 403, 'profile.no_username', 'This session has no username.');
    next();
  });

  async function callerUid(user) {
    return user.uid || (await resolveUid(user.username)) || null;
  }

  function publicShape(key, data) {
    return {
      username: data?.username || key,
      displayName: data?.displayName || '',
      bio: data?.bio || '',
      avatarVersion: data?.avatarVersion || null,
    };
  }

  async function hasActiveCoachLink(uidA, uidB) {
    if (!uidA || !uidB || uidA === uidB) return false;
    const [ab, ba] = await Promise.all([
      db.collection(`coaches/${uidA}/clients`).doc(uidB).get(),
      db.collection(`coaches/${uidB}/clients`).doc(uidA).get(),
    ]);
    return (ab.exists && ab.get('status') === 'active') || (ba.exists && ba.get('status') === 'active');
  }

  async function canView(viewer, viewerUid, key, data) {
    if (key === viewer) return true;
    const visibility = data?.visibility || 'everyone';
    if (visibility === 'everyone') return true;
    if (visibility === 'coach') return hasActiveCoachLink(viewerUid, data?.uid);
    return false;
  }

  async function readAvatar(key) {
    const snap = await avatars().doc(key).get();
    if (!snap.exists) return null;
    return `data:${snap.get('mime') || 'image/jpeg'};base64,${snap.get('data')}`;
  }

  // GET /me — the caller's own profile, including the photo itself.
  router.get('/me', async (req, res) => {
    try {
      const key = profileKey(req.user.username);
      const snap = await profiles().doc(key).get();
      const data = snap.exists ? snap.data() : null;
      const avatar = data?.avatarVersion ? await readAvatar(key) : null;
      return sendSuccess(res, 200, {
        profile: { ...publicShape(key, { username: req.user.username, ...data }), visibility: data?.visibility || 'everyone', avatar },
      });
    } catch (err) {
      console.error('GET /api/profiles/me failed:', err);
      return sendError(res, 500, 'profile.server_error', 'Could not load your profile.');
    }
  });

  // PUT /me — body: { displayName?, bio?, visibility? }. Omitted fields keep
  // their current value.
  router.put('/me', async (req, res) => {
    try {
      const body = req.body || {};
      const update = {};
      if ('displayName' in body) update.displayName = cleanText(body.displayName, DISPLAY_NAME_MAX);
      if ('bio' in body) update.bio = cleanText(body.bio, BIO_MAX, { multiline: true });
      if ('visibility' in body) {
        if (!VISIBILITIES.has(body.visibility)) {
          return sendError(res, 422, 'profile.invalid_visibility', 'Visibility must be everyone, coach or private.');
        }
        update.visibility = body.visibility;
      }
      if (containsObjectionable(update.displayName, terms) || containsObjectionable(update.bio, terms)) {
        return sendError(res, 422, 'profile.objectionable', 'That name or bio breaks our community rules. Please change it.');
      }

      const key = profileKey(req.user.username);
      update.username = req.user.username;
      update.uid = await callerUid(req.user);
      update.updatedAt = FieldValue.serverTimestamp();
      await profiles().doc(key).set(update, { merge: true });

      const snap = await profiles().doc(key).get();
      const data = snap.data();
      return sendSuccess(res, 200, { profile: { ...publicShape(key, data), visibility: data.visibility || 'everyone' } });
    } catch (err) {
      console.error('PUT /api/profiles/me failed:', err);
      return sendError(res, 500, 'profile.server_error', 'Could not save your profile.');
    }
  });

  // PUT /me/avatar — body: { image: "data:image/jpeg;base64,..." }. The app
  // resizes to a small square first; this only validates and stores it.
  router.put('/me/avatar', async (req, res) => {
    try {
      const parsed = parseAvatar(req.body?.image);
      if (!parsed || parsed.tooLarge) {
        return sendError(res, parsed?.tooLarge ? 413 : 422, parsed?.tooLarge ? 'profile.avatar_too_large' : 'profile.invalid_avatar',
          parsed?.tooLarge ? 'That photo is too large. Try a different one.' : 'Upload a JPEG, PNG or WebP image.');
      }
      const key = profileKey(req.user.username);
      const version = newVersion();
      const batch = db.batch();
      batch.set(avatars().doc(key), { ...parsed, version, updatedAt: FieldValue.serverTimestamp() });
      batch.set(profiles().doc(key), {
        username: req.user.username,
        uid: await callerUid(req.user),
        avatarVersion: version,
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
      await batch.commit();
      return sendSuccess(res, 200, { avatarVersion: version });
    } catch (err) {
      console.error('PUT /api/profiles/me/avatar failed:', err);
      return sendError(res, 500, 'profile.server_error', 'Could not save your photo.');
    }
  });

  // DELETE /me/avatar — back to initials.
  router.delete('/me/avatar', async (req, res) => {
    try {
      const key = profileKey(req.user.username);
      const batch = db.batch();
      batch.delete(avatars().doc(key));
      batch.set(profiles().doc(key), { avatarVersion: null, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
      await batch.commit();
      return sendSuccess(res, 200, { avatarVersion: null });
    } catch (err) {
      console.error('DELETE /api/profiles/me/avatar failed:', err);
      return sendError(res, 500, 'profile.server_error', 'Could not remove your photo.');
    }
  });

  // POST /lookup — body: { usernames: [...], have: { username: avatarVersion } }
  // Batch fetch for list screens. Returns every requested username that exists
  // or not; a hidden or missing profile comes back as { username, hidden: true }
  // so the app keeps showing initials. `avatar` (a data URL) is only included
  // when the caller's cached version is stale.
  router.post('/lookup', async (req, res) => {
    try {
      const requested = Array.isArray(req.body?.usernames) ? req.body.usernames : [];
      const have = req.body?.have && typeof req.body.have === 'object' ? req.body.have : {};
      const keys = [...new Set(requested.map(profileKey).filter(Boolean))].slice(0, LOOKUP_MAX);
      if (!keys.length) return sendSuccess(res, 200, { profiles: {} });

      const viewer = profileKey(req.user.username);
      const [snaps, blocked] = await Promise.all([
        Promise.all(keys.map(k => profiles().doc(k).get())),
        blockedBy(db, viewer),
      ]);
      const needsUid = snaps.some(s => s.exists && s.get('visibility') === 'coach');
      const viewerUid = needsUid ? await callerUid(req.user) : null;
      const out = {};
      await Promise.all(snaps.map(async (snap, i) => {
        const key = keys[i];
        const data = snap.exists ? snap.data() : null;
        if (blocked.includes(key)) {
          out[key] = { username: data?.username || key, hidden: true, blocked: true };
          return;
        }
        if (!data || !(await canView(viewer, viewerUid, key, data))) {
          out[key] = { username: data?.username || key, hidden: true };
          return;
        }
        const entry = publicShape(key, data);
        const cached = have[key] ?? have[entry.username];
        if (entry.avatarVersion && cached !== entry.avatarVersion) entry.avatar = await readAvatar(key);
        out[key] = entry;
      }));
      return sendSuccess(res, 200, { profiles: out });
    } catch (err) {
      console.error('POST /api/profiles/lookup failed:', err);
      return sendError(res, 500, 'profile.server_error', 'Could not load profiles.');
    }
  });

  // POST /:username/report — body: { reason, note? }. Queues the profile for
  // review; one open report per reporter per profile.
  router.post('/:username/report', async (req, res) => {
    try {
      const target = profileKey(req.params.username);
      const reporter = profileKey(req.user.username);
      if (!target) return sendError(res, 422, 'profile.invalid_username', 'Invalid username.');
      if (target === reporter) return sendError(res, 422, 'profile.cannot_report_self', 'You can’t report your own profile.');
      const reason = REPORT_REASONS.has(req.body?.reason) ? req.body.reason : null;
      if (!reason) return sendError(res, 422, 'profile.invalid_reason', 'Pick a reason for the report.');

      const snap = await profiles().doc(target).get();
      if (!snap.exists) return sendError(res, 404, 'profile.not_found', 'No profile found for that user.');

      await db.collection('profileReports').doc(`${target}__${reporter}`).set({
        target,
        reporter,
        reason,
        note: cleanText(req.body?.note, REPORT_NOTE_MAX, { multiline: true }),
        avatarVersion: snap.get('avatarVersion') || null,
        status: 'open',
        createdAt: FieldValue.serverTimestamp(),
      });
      alertModerators(`Profile report (${reason}): @${target} reported by @${reporter}. Review within 24 hours.`);
      return sendSuccess(res, 201, { reported: true });
    } catch (err) {
      console.error('POST /api/profiles/:username/report failed:', err);
      return sendError(res, 500, 'profile.server_error', 'Could not send the report.');
    }
  });

  // GET /blocks — { blocked: [username, ...] } for the caller, so the app can
  // hide those users in the feed and leaderboard too.
  router.get('/blocks', async (req, res) => {
    try {
      return sendSuccess(res, 200, { blocked: await blockedBy(db, req.user.username) });
    } catch (err) {
      console.error('GET /api/profiles/blocks failed:', err);
      return sendError(res, 500, 'profile.server_error', 'Could not load blocked users.');
    }
  });

  // POST /:username/block — hides that user from the caller and ends any
  // friendship or pending request between them.
  router.post('/:username/block', async (req, res) => {
    try {
      const target = profileKey(req.params.username);
      const me = profileKey(req.user.username);
      if (!target) return sendError(res, 422, 'profile.invalid_username', 'Invalid username.');
      if (target === me) return sendError(res, 422, 'profile.cannot_block_self', 'You can’t block yourself.');

      const current = await blockedBy(db, me);
      if (!current.includes(target)) {
        if (current.length >= BLOCKS_MAX) {
          return sendError(res, 422, 'profile.block_limit', 'You’ve reached the limit of blocked users.');
        }
        await db.collection('profileBlocks').doc(me).set({
          blocked: [...current, target],
          updatedAt: FieldValue.serverTimestamp(),
        });
        // Required lazily: friends.js requires this module at load time.
        const { pairId } = require('./friends');
        await db.collection('friendships').doc(pairId(me, target)).delete();
        alertModerators(`Block: @${me} blocked @${target}. Check whether @${target} needs moderating.`);
      }
      return sendSuccess(res, 200, { blocked: true });
    } catch (err) {
      console.error('POST /api/profiles/:username/block failed:', err);
      return sendError(res, 500, 'profile.server_error', 'Could not block that user.');
    }
  });

  // DELETE /:username/block — unblock.
  router.delete('/:username/block', async (req, res) => {
    try {
      const target = profileKey(req.params.username);
      const me = profileKey(req.user.username);
      if (!target) return sendError(res, 422, 'profile.invalid_username', 'Invalid username.');
      const current = await blockedBy(db, me);
      if (current.includes(target)) {
        await db.collection('profileBlocks').doc(me).set({
          blocked: current.filter(u => u !== target),
          updatedAt: FieldValue.serverTimestamp(),
        });
      }
      return sendSuccess(res, 200, { blocked: false });
    } catch (err) {
      console.error('DELETE /api/profiles/:username/block failed:', err);
      return sendError(res, 500, 'profile.server_error', 'Could not unblock that user.');
    }
  });

  // DELETE /:username/avatar — moderator removes someone's photo (and clears
  // their bio). Moderators are listed in the PROFILE_ADMINS env var.
  router.delete('/:username/avatar', async (req, res) => {
    try {
      if (!admins.has(profileKey(req.user.username))) {
        return sendError(res, 403, 'profile.forbidden', 'Only moderators can remove another user’s photo.');
      }
      const target = profileKey(req.params.username);
      if (!target) return sendError(res, 422, 'profile.invalid_username', 'Invalid username.');
      const batch = db.batch();
      batch.delete(avatars().doc(target));
      batch.set(profiles().doc(target), {
        avatarVersion: null,
        bio: '',
        moderatedAt: FieldValue.serverTimestamp(),
        moderatedBy: req.user.username,
      }, { merge: true });
      await batch.commit();
      return sendSuccess(res, 200, { removed: true });
    } catch (err) {
      console.error('DELETE /api/profiles/:username/avatar failed:', err);
      return sendError(res, 500, 'profile.server_error', 'Could not remove the photo.');
    }
  });

  return router;
}

// Called from account deletion so a deleted user's photo does not linger.
async function deleteProfile(db, username) {
  const key = profileKey(username);
  if (!key) return;
  await Promise.all([
    db.collection('profiles').doc(key).delete(),
    db.collection('profileAvatars').doc(key).delete(),
    db.collection('profileBlocks').doc(key).delete(),
  ]);
}

module.exports = {
  createProfilesRouter, deleteProfile, parseAvatar, cleanText, profileKey,
  containsObjectionable, parseTerms, blockedBy, isBlockedEitherWay,
};
