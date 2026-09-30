// Community groups: create, join, post, share programs, report.
//
// Groups used to live only in each device's localStorage (the app called
// /community/groups routes that never existed), so nobody else ever saw a
// group or its posts. Now they are stored server-side and every member sees
// the same group.
//
// Storage (server-only, see firestore.rules):
//   groups/{id}      { name, nameLower, goal, tags[], owner, members[],
//                      memberNames{}, recentPostTimes[], createdAt,
//                      lastActivityAt }
//   groupPosts/{id}  { groupId, author, authorName, text, share?, createdAt }
//   groupReports/{…} { kind: 'post'|'group', groupId, postId?, target,
//                      reporter, reason, note, status, createdAt }
// `members`, `owner` and `author` are lowercase usernames (profileKey), so
// "my groups" is one array-contains query. Listing a group's posts needs the
// composite index (groupId asc, createdAt desc) in firestore.indexes.json.
//
// Apple Guideline 1.2 (user-generated content): text is run through the same
// word filter as profiles, posts and groups can be reported (moderators get
// an email), blocked users' posts are hidden, and moderators (PROFILE_ADMINS)
// can remove any post or group.
const express = require('express');
const { profileKey, cleanText, containsObjectionable, blockedBy, isBlockedEitherWay } = require('./profiles');
const { pairId } = require('./friends');
const { notify } = require('./notifications');

const NAME_MAX = 60;
const GOAL_MAX = 80;
const TAG_MAX = 24;
const TAGS_MAX = 5;
const POST_MAX = 1000;
const REPORT_NOTE_MAX = 300;
const MEMBERS_MAX = 200;
const OWNED_MAX = 10;
const DISCOVER_LIMIT = 50;
const POSTS_PAGE = 50;
const RECENT_TIMES_MAX = 30;
const SHARE_MAX_BYTES = 60 * 1024;
const SHARE_TYPES = new Set(['program', 'template']);
const REPORT_REASONS = new Set(['inappropriate', 'harassment', 'spam', 'other']);

function toIso(ts) {
  if (!ts) return null;
  if (typeof ts.toDate === 'function') return ts.toDate().toISOString();
  if (ts instanceof Date) return ts.toISOString();
  return typeof ts === 'string' ? ts : null;
}

function cleanTags(value) {
  const list = Array.isArray(value) ? value : [];
  const out = [];
  list.forEach(t => {
    const tag = cleanText(String(t ?? ''), TAG_MAX).toLowerCase();
    if (tag && !out.includes(tag) && out.length < TAGS_MAX) out.push(tag);
  });
  return out;
}

// Multi-line post text: keeps up to 20 lines, collapses runs of spaces.
function cleanPostText(value) {
  if (typeof value !== 'string') return '';
  const s = value
    .replace(/[\u0000-\u0009\u000B-\u001F\u007F​-‏‪-‮⁦-⁩]/g, '')
    .split('\n').map(l => l.replace(/[ \t]+/g, ' ').trim())
    .join('\n').replace(/\n{3,}/g, '\n\n').trim()
    .split('\n').slice(0, 20).join('\n');
  return Array.from(s).slice(0, POST_MAX).join('');
}

function cleanShare(value) {
  if (!value || typeof value !== 'object') return null;
  if (!SHARE_TYPES.has(value.type)) return null;
  const name = cleanText(String(value.name ?? ''), NAME_MAX) || 'Untitled';
  const data = value.data && typeof value.data === 'object' ? value.data : null;
  if (!data) return null;
  let json;
  try { json = JSON.stringify(data); } catch { return null; }
  if (Buffer.byteLength(json, 'utf8') > SHARE_MAX_BYTES) return { tooLarge: true };
  return { type: value.type, name, data: JSON.parse(json) };
}

function createGroupsRouter({
  db, FieldValue, firebaseEnabled, sendError, sendSuccess, adminUsernames = [],
  objectionableTerms = [], notifyModerators = async () => {},
}) {
  const router = express.Router();
  const admins = new Set(adminUsernames.map(u => String(u).trim().toLowerCase()).filter(Boolean));
  const terms = objectionableTerms.map(t => String(t).trim().toLowerCase()).filter(Boolean);
  const groups = () => db.collection('groups');
  const posts = () => db.collection('groupPosts');

  function alertModerators(message) {
    Promise.resolve()
      .then(() => notifyModerators(message))
      .catch(err => console.error('[moderation] notify failed:', err.message));
  }

  router.use((req, res, next) => {
    if (!firebaseEnabled) return sendError(res, 503, 'groups.firebase_disabled', 'Groups are not available right now.');
    if (!profileKey(req.user?.username)) return sendError(res, 403, 'groups.no_username', 'This session has no username.');
    req.me = profileKey(req.user.username);
    req.isAdmin = admins.has(req.me);
    next();
  });

  function shapeGroup(id, data, me) {
    const members = Array.isArray(data.members) ? data.members : [];
    const names = data.memberNames || {};
    return {
      id,
      name: data.name || '',
      goal: data.goal || '',
      tags: data.tags || [],
      owner: names[data.owner] || data.owner || '',
      members: members.map(k => ({ userId: names[k] || k })),
      memberCount: members.length,
      isMember: members.includes(me),
      isOwner: data.owner === me,
      recentPostTimes: data.recentPostTimes || [],
      createdAt: toIso(data.createdAt),
      lastActivityAt: toIso(data.lastActivityAt),
    };
  }

  function shapePost(id, data, me, group, isAdmin) {
    return {
      id,
      author: data.authorName || data.author,
      text: data.text || '',
      share: data.share || null,
      date: toIso(data.createdAt),
      mine: data.author === me,
      canDelete: data.author === me || group.owner === me || isAdmin,
    };
  }

  async function loadGroup(id) {
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) return null;
    const snap = await groups().doc(id).get();
    return snap.exists ? { ref: snap.ref, data: snap.data() } : null;
  }

  // Display casing of each friend username, or an error message for the
  // first one that can't be added. Only accepted friends can be added, so
  // nobody lands in a stranger's group.
  async function resolveInvitees(me, usernames) {
    const out = {};
    for (const raw of usernames) {
      const key = profileKey(raw);
      if (!key || key === me || out[key]) continue;
      const snap = await db.collection('friendships').doc(pairId(me, key)).get();
      if (!snap.exists || snap.get('status') !== 'accepted' || await isBlockedEitherWay(db, me, key)) {
        return { error: `You can only add friends. @${String(raw).slice(0, 64)} isn’t on your friends list.` };
      }
      out[key] = snap.get('names')?.[key] || String(raw);
    }
    return { names: out };
  }

  function objectionable(...texts) {
    return texts.some(t => containsObjectionable(t, terms));
  }

  // GET / — { groups: [...] }: every group you're in plus the most recently
  // active public ones. Groups owned by someone you blocked are left out.
  router.get('/', async (req, res) => {
    try {
      const me = req.me;
      const [mineSnap, recentSnap, blocked] = await Promise.all([
        groups().where('members', 'array-contains', me).get(),
        groups().orderBy('lastActivityAt', 'desc').limit(DISCOVER_LIMIT).get(),
        blockedBy(db, me),
      ]);
      const seen = new Set();
      const list = [];
      [...mineSnap.docs, ...recentSnap.docs].forEach(doc => {
        if (seen.has(doc.id)) return;
        seen.add(doc.id);
        const data = doc.data();
        if (data.owner !== me && blocked.includes(data.owner)) return;
        list.push(shapeGroup(doc.id, data, me));
      });
      return sendSuccess(res, 200, { groups: list });
    } catch (err) {
      console.error('GET /api/groups failed:', err);
      return sendError(res, 500, 'groups.server_error', 'Could not load groups.');
    }
  });

  // POST / — body: { name, goal?, tags?, members?: [username] }. Members must
  // be accepted friends of the creator.
  router.post('/', async (req, res) => {
    try {
      const me = req.me;
      const name = cleanText(req.body?.name, NAME_MAX);
      const goal = cleanText(req.body?.goal, GOAL_MAX);
      const tags = cleanTags(req.body?.tags);
      if (!name) return sendError(res, 422, 'groups.invalid_name', 'Give the group a name.');
      if (objectionable(name, goal, tags.join(' '))) {
        return sendError(res, 422, 'groups.objectionable', 'That name, goal or tag isn’t allowed. Please choose something else.');
      }
      const owned = await groups().where('owner', '==', me).get();
      if (owned.size >= OWNED_MAX) {
        return sendError(res, 422, 'groups.limit', `You can run up to ${OWNED_MAX} groups. Delete one to start another.`);
      }
      const requested = Array.isArray(req.body?.members) ? req.body.members.slice(0, MEMBERS_MAX) : [];
      const invitees = await resolveInvitees(me, requested);
      if (invitees.error) return sendError(res, 422, 'groups.not_friends', invitees.error);

      const memberNames = { [me]: req.user.username, ...invitees.names };
      const data = {
        name,
        nameLower: name.toLowerCase(),
        goal,
        tags,
        owner: me,
        members: Object.keys(memberNames),
        memberNames,
        recentPostTimes: [],
        createdAt: FieldValue.serverTimestamp(),
        lastActivityAt: FieldValue.serverTimestamp(),
      };
      const ref = await groups().add(data);
      const now = new Date();
      await notify(db, {
        to: Object.keys(invitees.names), type: 'group_added', actor: me, actorName: req.user.username,
        text: `added you to ${name}`, data: { groupId: ref.id, name },
      });
      return sendSuccess(res, 201, { group: shapeGroup(ref.id, { ...data, createdAt: now, lastActivityAt: now }, me) });
    } catch (err) {
      console.error('POST /api/groups failed:', err);
      return sendError(res, 500, 'groups.server_error', 'Could not create the group.');
    }
  });

  // POST /:id/join
  router.post('/:id/join', async (req, res) => {
    try {
      const me = req.me;
      const group = await loadGroup(req.params.id);
      if (!group) return sendError(res, 404, 'groups.not_found', 'That group no longer exists.');
      if (me !== group.data.owner && await isBlockedEitherWay(db, me, group.data.owner)) {
        return sendError(res, 404, 'groups.not_found', 'That group no longer exists.');
      }
      const result = await db.runTransaction(async tx => {
        const snap = await tx.get(group.ref);
        if (!snap.exists) return { status: 404 };
        const data = snap.data();
        if ((data.members || []).includes(me)) return { data };
        if ((data.members || []).length >= MEMBERS_MAX) return { status: 422 };
        const next = {
          ...data,
          members: [...(data.members || []), me],
          memberNames: { ...(data.memberNames || {}), [me]: req.user.username },
        };
        tx.update(group.ref, { members: next.members, memberNames: next.memberNames });
        return { data: next };
      });
      if (result.status === 404) return sendError(res, 404, 'groups.not_found', 'That group no longer exists.');
      if (result.status === 422) return sendError(res, 422, 'groups.full', 'This group is full.');
      return sendSuccess(res, 200, { group: shapeGroup(group.ref.id, result.data, me) });
    } catch (err) {
      console.error('POST /api/groups/:id/join failed:', err);
      return sendError(res, 500, 'groups.server_error', 'Could not join the group.');
    }
  });

  // POST /:id/leave — if the owner leaves, the longest-standing member takes
  // over; the last member leaving deletes the group.
  router.post('/:id/leave', async (req, res) => {
    try {
      const me = req.me;
      const group = await loadGroup(req.params.id);
      if (!group) return sendSuccess(res, 200, { left: true });
      const deleted = await db.runTransaction(async tx => {
        const snap = await tx.get(group.ref);
        if (!snap.exists) return false;
        const data = snap.data();
        const members = (data.members || []).filter(m => m !== me);
        if (!members.length) { tx.delete(group.ref); return true; }
        const memberNames = { ...(data.memberNames || {}) };
        delete memberNames[me];
        tx.update(group.ref, {
          members,
          memberNames,
          owner: data.owner === me ? members[0] : data.owner,
        });
        return false;
      });
      if (deleted) await deleteGroupPosts(db, group.ref.id);
      return sendSuccess(res, 200, { left: true });
    } catch (err) {
      console.error('POST /api/groups/:id/leave failed:', err);
      return sendError(res, 500, 'groups.server_error', 'Could not leave the group.');
    }
  });

  // POST /:id/invite — body: { username }. Any member can add one of their
  // friends.
  router.post('/:id/invite', async (req, res) => {
    try {
      const me = req.me;
      const group = await loadGroup(req.params.id);
      if (!group) return sendError(res, 404, 'groups.not_found', 'That group no longer exists.');
      if (!(group.data.members || []).includes(me)) {
        return sendError(res, 403, 'groups.not_member', 'Join the group to add people.');
      }
      const target = profileKey(req.body?.username);
      if (!target) return sendError(res, 422, 'groups.invalid_username', 'Enter a friend’s username.');
      if ((group.data.members || []).includes(target)) {
        return sendError(res, 409, 'groups.already_member', 'They’re already in this group.');
      }
      const invitees = await resolveInvitees(me, [req.body.username]);
      if (invitees.error) return sendError(res, 422, 'groups.not_friends', invitees.error);
      if ((group.data.members || []).length >= MEMBERS_MAX) {
        return sendError(res, 422, 'groups.full', 'This group is full.');
      }
      const display = invitees.names[target];
      await group.ref.update({
        members: FieldValue.arrayUnion(target),
        [`memberNames.${target}`]: display,
      });
      await notify(db, {
        to: target, type: 'group_added', actor: me, actorName: req.user.username,
        text: `added you to ${group.data.name || 'a group'}`, data: { groupId: group.ref.id, name: group.data.name || '' },
      });
      return sendSuccess(res, 200, { username: display });
    } catch (err) {
      console.error('POST /api/groups/:id/invite failed:', err);
      return sendError(res, 500, 'groups.server_error', 'Could not add them to the group.');
    }
  });

  // DELETE /:id — the owner (or a moderator) deletes the group and its posts.
  router.delete('/:id', async (req, res) => {
    try {
      const group = await loadGroup(req.params.id);
      if (!group) return sendSuccess(res, 200, { deleted: true });
      if (group.data.owner !== req.me && !req.isAdmin) {
        return sendError(res, 403, 'groups.forbidden', 'Only the group’s owner can delete it.');
      }
      await group.ref.delete();
      await deleteGroupPosts(db, group.ref.id);
      return sendSuccess(res, 200, { deleted: true });
    } catch (err) {
      console.error('DELETE /api/groups/:id failed:', err);
      return sendError(res, 500, 'groups.server_error', 'Could not delete the group.');
    }
  });

  // GET /:id/posts — members only, newest first; ?before=<ISO date> pages
  // back. Posts by people you blocked are left out.
  router.get('/:id/posts', async (req, res) => {
    try {
      const me = req.me;
      const group = await loadGroup(req.params.id);
      if (!group) return sendError(res, 404, 'groups.not_found', 'That group no longer exists.');
      if (!(group.data.members || []).includes(me) && !req.isAdmin) {
        return sendError(res, 403, 'groups.not_member', 'Join the group to see its posts.');
      }
      let query = posts().where('groupId', '==', group.ref.id).orderBy('createdAt', 'desc');
      const before = req.query.before ? new Date(String(req.query.before)) : null;
      if (before && !Number.isNaN(before.getTime())) query = query.startAfter(before);
      const [snap, blocked] = await Promise.all([query.limit(POSTS_PAGE).get(), blockedBy(db, me)]);
      const list = snap.docs
        .filter(d => !blocked.includes(d.get('author')))
        .map(d => shapePost(d.id, d.data(), me, group.data, req.isAdmin));
      return sendSuccess(res, 200, { posts: list, hasMore: snap.size === POSTS_PAGE });
    } catch (err) {
      console.error('GET /api/groups/:id/posts failed:', err);
      return sendError(res, 500, 'groups.server_error', 'Could not load posts.');
    }
  });

  // POST /:id/posts — body: { text, share?: { type, name, data } }. Members
  // only. `share` attaches a program or template other members can save.
  router.post('/:id/posts', async (req, res) => {
    try {
      const me = req.me;
      const group = await loadGroup(req.params.id);
      if (!group) return sendError(res, 404, 'groups.not_found', 'That group no longer exists.');
      if (!(group.data.members || []).includes(me)) {
        return sendError(res, 403, 'groups.not_member', 'Join the group to post.');
      }
      const text = cleanPostText(req.body?.text);
      const share = req.body?.share ? cleanShare(req.body.share) : null;
      if (req.body?.share && !share) return sendError(res, 422, 'groups.invalid_share', 'That item can’t be shared.');
      if (share?.tooLarge) return sendError(res, 413, 'groups.share_too_large', 'That item is too large to share.');
      if (!text && !share) return sendError(res, 422, 'groups.empty_post', 'Write something first.');
      if (objectionable(text, share?.name)) {
        return sendError(res, 422, 'groups.objectionable', 'Your post contains language that isn’t allowed. Please edit it.');
      }
      const now = new Date();
      const data = {
        groupId: group.ref.id,
        author: me,
        authorName: req.user.username,
        text,
        createdAt: now,
      };
      if (share) data.share = share;
      const ref = await posts().add(data);
      const recent = [now.toISOString(), ...(group.data.recentPostTimes || [])].slice(0, RECENT_TIMES_MAX);
      await group.ref.update({ recentPostTimes: recent, lastActivityAt: now });
      await notify(db, {
        to: group.data.members || [], type: 'group_post', actor: me, actorName: req.user.username,
        text: `posted in ${group.data.name || 'your group'}`, data: { groupId: group.ref.id, name: group.data.name || '' },
        collapseKey: `group_post__${group.ref.id}`,
      });
      return sendSuccess(res, 201, { post: shapePost(ref.id, data, me, group.data, req.isAdmin) });
    } catch (err) {
      console.error('POST /api/groups/:id/posts failed:', err);
      return sendError(res, 500, 'groups.server_error', 'Could not post.');
    }
  });

  // DELETE /:id/posts/:postId — the author, the group owner or a moderator.
  router.delete('/:id/posts/:postId', async (req, res) => {
    try {
      const group = await loadGroup(req.params.id);
      if (!group) return sendSuccess(res, 200, { deleted: true });
      const ref = posts().doc(String(req.params.postId));
      const snap = await ref.get();
      if (!snap.exists || snap.get('groupId') !== group.ref.id) return sendSuccess(res, 200, { deleted: true });
      if (snap.get('author') !== req.me && group.data.owner !== req.me && !req.isAdmin) {
        return sendError(res, 403, 'groups.forbidden', 'You can only delete your own posts.');
      }
      await ref.delete();
      return sendSuccess(res, 200, { deleted: true });
    } catch (err) {
      console.error('DELETE /api/groups/:id/posts/:postId failed:', err);
      return sendError(res, 500, 'groups.server_error', 'Could not delete the post.');
    }
  });

  async function saveReport(req, res, { kind, group, postId = null, target }) {
    const reason = REPORT_REASONS.has(req.body?.reason) ? req.body.reason : null;
    if (!reason) return sendError(res, 422, 'groups.invalid_reason', 'Pick a reason for the report.');
    const reporter = req.me;
    const docId = [kind, group.ref.id, postId, reporter].filter(Boolean).join('__');
    await db.collection('groupReports').doc(docId).set({
      kind,
      groupId: group.ref.id,
      groupName: group.data.name || '',
      postId,
      target,
      reporter,
      reason,
      note: cleanText(req.body?.note, REPORT_NOTE_MAX, { multiline: true }),
      status: 'open',
      createdAt: FieldValue.serverTimestamp(),
    });
    const what = kind === 'post'
      ? `a post by @${target} in group "${group.data.name}" (groupPosts/${postId})`
      : `group "${group.data.name}" (groups/${group.ref.id}, owner @${target})`;
    alertModerators(`Group report (${reason}): ${what} reported by @${reporter}. Review within 24 hours.`);
    return sendSuccess(res, 201, { reported: true });
  }

  // POST /:id/posts/:postId/report — body: { reason, note? }
  router.post('/:id/posts/:postId/report', async (req, res) => {
    try {
      const group = await loadGroup(req.params.id);
      if (!group) return sendError(res, 404, 'groups.not_found', 'That group no longer exists.');
      const snap = await posts().doc(String(req.params.postId)).get();
      if (!snap.exists || snap.get('groupId') !== group.ref.id) {
        return sendError(res, 404, 'groups.post_not_found', 'That post no longer exists.');
      }
      if (snap.get('author') === req.me) return sendError(res, 422, 'groups.cannot_report_self', 'You can’t report your own post.');
      return await saveReport(req, res, { kind: 'post', group, postId: snap.id, target: snap.get('author') });
    } catch (err) {
      console.error('POST /api/groups/:id/posts/:postId/report failed:', err);
      return sendError(res, 500, 'groups.server_error', 'Could not send the report.');
    }
  });

  // POST /:id/report — body: { reason, note? }. Reports the group itself
  // (its name or goal).
  router.post('/:id/report', async (req, res) => {
    try {
      const group = await loadGroup(req.params.id);
      if (!group) return sendError(res, 404, 'groups.not_found', 'That group no longer exists.');
      if (group.data.owner === req.me) return sendError(res, 422, 'groups.cannot_report_self', 'You can’t report your own group.');
      return await saveReport(req, res, { kind: 'group', group, target: group.data.owner });
    } catch (err) {
      console.error('POST /api/groups/:id/report failed:', err);
      return sendError(res, 500, 'groups.server_error', 'Could not send the report.');
    }
  });

  return router;
}

async function deleteGroupPosts(db, groupId) {
  const snap = await db.collection('groupPosts').where('groupId', '==', groupId).get();
  await Promise.all(snap.docs.map(d => d.ref.delete()));
}

// Called from account deletion: removes the user's posts and memberships.
// Groups they owned pass to the next member, or are deleted if empty.
async function removeUserFromGroups(db, username) {
  const key = profileKey(username);
  if (!key) return;
  const postSnap = await db.collection('groupPosts').where('author', '==', key).get();
  await Promise.all(postSnap.docs.map(d => d.ref.delete()));
  const groupSnap = await db.collection('groups').where('members', 'array-contains', key).get();
  for (const doc of groupSnap.docs) {
    const data = doc.data();
    const members = (data.members || []).filter(m => m !== key);
    if (!members.length) {
      await doc.ref.delete();
      await deleteGroupPosts(db, doc.id);
      continue;
    }
    const memberNames = { ...(data.memberNames || {}) };
    delete memberNames[key];
    await doc.ref.update({ members, memberNames, owner: data.owner === key ? members[0] : data.owner });
  }
}

module.exports = { createGroupsRouter, removeUserFromGroups, cleanPostText, cleanTags };
