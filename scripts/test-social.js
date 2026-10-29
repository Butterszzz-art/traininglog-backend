// Tests for the community routes — groups, feed, shares and the exercise
// leaderboard (src/routes/groups.js, feed.js, shares.js, exerciseBoard.js) —
// against an in-memory Firestore stand-in. No network, no Firebase project.
//
// Run: node scripts/test-social.js
const express = require('express');
const { createGroupsRouter, removeUserFromGroups } = require('../src/routes/groups');
const { createFeedRouter, deleteFeedPosts } = require('../src/routes/feed');
const { createSharesRouter, deleteShares } = require('../src/routes/shares');
const { createExerciseBoardRouter, recordExerciseBests, bestSetsByLift } = require('../src/routes/exerciseBoard');
const { DEFAULT_OBJECTIONABLE_TERMS } = require('../src/objectionableTerms');

// ── Fake Firestore ───────────────────────────────────────────────────────────
const SENTINEL_TS = { __ts: true };
const FieldValue = {
  serverTimestamp: () => SENTINEL_TS,
  arrayUnion: (...v) => ({ __union: v }),
};
const store = new Map(); // "coll/id" -> data
let autoId = 0;
function resolve(data, prev = {}) {
  const out = { ...prev };
  for (const [k, v] of Object.entries(data)) {
    let val = v === SENTINEL_TS ? new Date() : v;
    if (val && val.__union) val = [...new Set([...(prev[k] || []), ...val.__union])];
    if (k.includes('.')) { const [a, b] = k.split('.'); out[a] = { ...(out[a] || {}), [b]: val }; }
    else out[k] = val;
  }
  return out;
}
function snapOf(coll, id) {
  const data = store.get(`${coll}/${id}`);
  return { id, exists: !!data, ref: docRef(coll, id), data: () => data && { ...data }, get: f => data && data[f] };
}
function docRef(coll, id) {
  return {
    id,
    get: async () => snapOf(coll, id),
    set: async (d, o) => { store.set(`${coll}/${id}`, resolve(d, o?.merge ? store.get(`${coll}/${id}`) : {})); },
    update: async d => { if (!store.has(`${coll}/${id}`)) throw new Error('no doc'); store.set(`${coll}/${id}`, resolve(d, store.get(`${coll}/${id}`))); },
    delete: async () => { store.delete(`${coll}/${id}`); },
  };
}
function query(coll, filters = [], order = null, lim = Infinity, after = null) {
  const q = {
    where: (f, op, v) => query(coll, [...filters, [f, op, v]], order, lim, after),
    orderBy: (f, dir) => query(coll, filters, [f, dir], lim, after),
    limit: n => query(coll, filters, order, n, after),
    startAfter: v => query(coll, filters, order, lim, v),
    get: async () => {
      let docs = [...store.keys()].filter(k => k.startsWith(coll + '/')).map(k => snapOf(coll, k.slice(coll.length + 1)));
      docs = docs.filter(d => filters.every(([f, op, v]) => {
        const x = d.get(f);
        return op === '==' ? x === v : op === 'array-contains' ? (x || []).includes(v) : op === 'in' ? v.includes(x) : false;
      }));
      if (order) {
        const [f, dir] = order; const s = dir === 'desc' ? -1 : 1;
        docs = docs.filter(d => d.get(f) != null).sort((a, b) => (new Date(a.get(f)) - new Date(b.get(f))) * s);
        if (after) docs = docs.filter(d => (new Date(d.get(f)) - new Date(after)) * s > 0);
      }
      docs = docs.slice(0, lim);
      return { docs, size: docs.length };
    },
    add: async d => { const id = `g${++autoId}`; await docRef(coll, id).set(d); return docRef(coll, id); },
    doc: id => docRef(coll, id),
  };
  return q;
}
const db = {
  collection: name => query(name),
  getAll: (...refs) => Promise.all(refs.map(r => r.get())),
  batch: () => { const ops = []; return { set: (r, d, o) => ops.push(() => r.set(d, o)), update: (r, d) => ops.push(() => r.update(d)), commit: async () => { for (const op of ops) await op(); } }; },
  runTransaction: async fn => fn({
    get: r => r.get(), update: (r, d) => r.update(d), delete: r => r.delete(),
  }),
};


// Me_User <-> Alice and Me_User <-> bob are friends; carl's request is pending.
// bob blocked dave.
store.set('friendships/alice__me_user', { users: ['alice', 'me_user'], names: { alice: 'Alice', me_user: 'Me_User' }, status: 'accepted' });
store.set('friendships/bob__me_user', { users: ['bob', 'me_user'], names: { bob: 'bob', me_user: 'Me_User' }, status: 'accepted' });
store.set('friendships/carl__me_user', { users: ['carl', 'me_user'], status: 'pending' });
store.set('profileBlocks/bob', { blocked: ['dave'] });

const mail = [];
const app = express();
app.use(express.json({ limit: '256kb' }));
app.use((req, res, next) => { req.user = { username: req.headers['x-user'] }; next(); });
const sendError = (res, s, code, message) => res.status(s).json({ success: false, error: { code, message } });
const sendSuccess = (res, s, d = {}) => res.status(s).json({ success: true, ...d });
const common = {
  db, FieldValue, firebaseEnabled: true, sendError, sendSuccess, adminUsernames: ['mod'],
  objectionableTerms: DEFAULT_OBJECTIONABLE_TERMS, notifyModerators: async m => { mail.push(m); },
};
app.use('/api/groups', createGroupsRouter(common));
app.use('/api/feed', createFeedRouter(common));
app.use('/api/shares', createSharesRouter(common));
app.use('/api/leaderboard/exercises', createExerciseBoardRouter(common));

let failures = 0;
const check = (label, cond, extra) => {
  if (!cond) failures++;
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${label}${!cond && extra ? ' → ' + JSON.stringify(extra) : ''}`);
};
const tick = () => new Promise(r => setTimeout(r, 3));

const server = app.listen(0, async () => {
  const base = `http://127.0.0.1:${server.address().port}`;
  const api = prefix => async (user, method, p, body) => {
    const r = await fetch(base + prefix + p, { method, headers: { 'x-user': user, 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  const G = api('/api/groups');
  const F = api('/api/feed');
  const S = api('/api/shares');
  const X = api('/api/leaderboard/exercises');
  try {
    console.log('— groups');
    let r = await G('Me_User', 'POST', '/', { name: 'Morning Lifters', goal: 'Bench 100', tags: ['Strength', 'strength', 'x'], members: ['carl'] });
    check('create with non-friend rejected', r.status === 422 && r.body.error.code === 'groups.not_friends', r);
    r = await G('Me_User', 'POST', '/', { name: 'fuck club' });
    check('objectionable name rejected', r.status === 422 && r.body.error.code === 'groups.objectionable', r);
    r = await G('Me_User', 'POST', '/', { name: 'Morning Lifters', goal: 'Bench 100', tags: ['Strength', 'strength', 'x'], members: ['alice'] });
    check('create with friend', r.status === 201 && r.body.group.memberCount === 2 && r.body.group.isOwner, r);
    check('tags cleaned', JSON.stringify(r.body.group.tags) === '["strength","x"]', r.body.group.tags);
    check('display names kept', r.body.group.members.map(m => m.userId).join() === 'Me_User,Alice', r.body.group.members);
    const gid = r.body.group.id;

    r = await G('bob', 'GET', '/');
    await 0; check('bob discovers group, not member', r.body.groups.length === 1 && !r.body.groups[0].isMember, r.body);
    r = await G('bob', 'GET', `/${gid}/posts`);
    check('non-member cannot read posts', r.status === 403, r);
    r = await G('bob', 'POST', `/${gid}/posts`, { text: 'hi' });
    check('non-member cannot post', r.status === 403, r);
    r = await G('bob', 'POST', `/${gid}/join`);
    check('bob joins', r.status === 200 && r.body.group.isMember && r.body.group.memberCount === 3, r);
    r = await G('bob', 'POST', `/${gid}/join`);
    check('join is idempotent', r.body.group.memberCount === 3, r);

    r = await G('bob', 'POST', `/${gid}/posts`, { text: '  Hit a PR today!\n\n\n\nfelt good  ' });
    check('bob posts', r.status === 201 && r.body.post.text === 'Hit a PR today!\n\nfelt good', r);
    const bobPost = r.body.post.id;
    await new Promise(res => setTimeout(res, 5));
    r = await G('Alice', 'POST', `/${gid}/posts`, { text: 'you are a cunt' });
    check('objectionable post rejected', r.status === 422, r);
    r = await G('Alice', 'POST', `/${gid}/posts`, { text: '', share: { type: 'program', name: 'PPL', data: { weeks: 4 } } });
    check('share-only post', r.status === 201 && r.body.post.share.name === 'PPL', r);
    r = await G('Alice', 'POST', `/${gid}/posts`, { text: '' });
    check('empty post rejected', r.status === 422, r);
    r = await G('Alice', 'POST', `/${gid}/posts`, { share: { type: 'program', name: 'Big', data: { x: 'a'.repeat(70000) } } });
    check('oversized share rejected', r.status === 413, r);

    r = await G('Me_User', 'GET', `/${gid}/posts`);
    check('owner sees 2 posts newest first', r.body.posts.length === 2 && r.body.posts[0].author === 'Alice', r.body);
    check('owner can delete any post', r.body.posts.every(p => p.canDelete), r.body);
    r = await G('Alice', 'GET', `/${gid}/posts`);
    check('alice can only delete own', r.body.posts.find(p => p.author === 'bob').canDelete === false, r.body);
    r = await G('Alice', 'DELETE', `/${gid}/posts/${bobPost}`);
    check('alice cannot delete bob post', r.status === 403, r);

    r = await G('Alice', 'POST', `/${gid}/posts/${bobPost}/report`, { reason: 'spam' });
    check('report post', r.status === 201 && mail.length === 1 && mail[0].includes('@bob'), { r, mail });
    r = await G('bob', 'POST', `/${gid}/posts/${bobPost}/report`, { reason: 'spam' });
    check('cannot report own post', r.status === 422, r);
    r = await G('bob', 'POST', `/${gid}/report`, { reason: 'bogus' });
    check('bad reason rejected', r.status === 422, r);
    r = await G('bob', 'POST', `/${gid}/report`, { reason: 'inappropriate' });
    check('report group', r.status === 201 && mail.length === 2, r);

    // Block filtering: me_user blocked dave; dave joins and posts.
    await G('dave', 'POST', `/${gid}/join`);
    await G('dave', 'POST', `/${gid}/posts`, { text: 'dave here' });
    r = await G('bob', 'GET', `/${gid}/posts`);
    check('blocked author hidden', !r.body.posts.some(p => p.author === 'dave'), r.body);
    r = await G('Me_User', 'GET', `/${gid}/posts`);
    check('others still see dave', r.body.posts.some(p => p.author === 'dave'), r.body);

    r = await G('Me_User', 'POST', `/${gid}/invite`, { username: 'carl' });
    check('invite non-friend rejected', r.status === 422, r);
    r = await G('Me_User', 'POST', `/${gid}/invite`, { username: 'alice' });
    check('invite existing member 409', r.status === 409, r);
    r = await G('zed', 'POST', `/${gid}/invite`, { username: 'alice' });
    check('non-member invite 403', r.status === 403, r);

    r = await G('Me_User', 'GET', '/');
    const grp = r.body.groups[0];
    check('recent post times tracked', grp.recentPostTimes.length === 3, grp);

    // Owner leaves: ownership passes on.
    r = await G('Me_User', 'POST', `/${gid}/leave`);
    r = await G('Alice', 'GET', '/');
    check('ownership transferred to alice', r.body.groups[0].isOwner && r.body.groups[0].memberCount === 3, r.body.groups[0]);
    r = await G('bob', 'DELETE', `/${gid}`);
    check('non-owner cannot delete', r.status === 403, r);

    // Account deletion of alice (owner): bob becomes owner, her posts gone.
    await removeUserFromGroups(db, 'Alice');
    r = await G('bob', 'GET', `/${gid}/posts`);
    check('deleted user posts removed', !r.body.posts.some(p => p.author === 'Alice'), r.body);
    r = await G('bob', 'GET', '/');
    check('bob now owner', r.body.groups[0].isOwner, r.body.groups[0]);

    console.log('— group meals');
    const jpeg = `data:image/jpeg;base64,${Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64)]).toString('base64')}`;
    const lunch = { meal: 'lunch', items: [{ name: 'Chicken', amount: 200, unit: 'g', kcal: 330, protein: 62, carbs: 0, fat: 7 }, { name: 'Rice', kcal: 325, protein: 6, carbs: 70, fat: 1 }] };
    r = await G('bob', 'POST', `/${gid}/posts`, { text: 'lunch', share: { type: 'meal', name: 'Lunch', data: lunch }, photo: jpeg });
    check('meal post with photo', r.status === 201 && r.body.post.share.type === 'meal' && r.body.post.share.data.totals.kcal === 655 && r.body.post.hasPhoto, r);
    const mealPost = r.body.post.id;
    check('photo stored apart from the post', store.has(`sharedMealPhotos/post_${mealPost}`) && !JSON.stringify(store.get(`groupPosts/${mealPost}`)).includes('base64'), [...store.keys()]);
    r = await G('dave', 'GET', `/${gid}/posts/${mealPost}/photo`);
    check('member reads the photo', r.status === 200 && r.body.photo.startsWith('data:image/jpeg;base64,'), r);
    r = await G('zed', 'GET', `/${gid}/posts/${mealPost}/photo`);
    check('non-member cannot read the photo', r.status === 403, r);
    r = await G('bob', 'POST', `/${gid}/posts`, { text: 'pic', photo: jpeg });
    check('photo without a meal rejected', r.status === 422 && r.body.error.code === 'groups.invalid_photo', r);
    r = await G('bob', 'POST', `/${gid}/posts`, { share: { type: 'meal', name: 'Empty', data: { items: [] } } });
    check('meal with no food rejected', r.status === 422, r);
    r = await G('bob', 'POST', `/${gid}/posts`, { share: { type: 'meal', name: 'Snack', data: { items: [{ name: 'fuck nuts', kcal: 100 }] } } });
    check('objectionable food name rejected', r.status === 422 && r.body.error.code === 'groups.objectionable', r);
    r = await G('bob', 'DELETE', `/${gid}/posts/${mealPost}`);
    check('deleting the post deletes its photo', r.status === 200 && !store.has(`sharedMealPhotos/post_${mealPost}`), [...store.keys()]);
    r = await G('bob', 'POST', `/${gid}/posts`, { share: { type: 'meal', name: 'Dinner', data: lunch }, photo: jpeg });
    const mealPost2 = r.body.post.id;

    r = await G('mod', 'DELETE', `/${gid}`);
    check('moderator deletes group', r.status === 200, r);
    check('group posts deleted', ![...store.keys()].some(k => k.startsWith('groupPosts/')), [...store.keys()]);
    check('group meal photos deleted', !store.has(`sharedMealPhotos/post_${mealPost2}`), [...store.keys()]);
    r = await G('bob', 'GET', `/nope!/posts`);
    check('bad id 404', r.status === 404, r);
    console.log('— feed');
    mail.length = 0;
    r = await F('Me_User', 'POST', '', { type: 'update', text: '' });
    check('empty post rejected', r.status === 422, r);
    r = await F('Me_User', 'POST', '', { type: 'update', text: 'what a shit day' });
    check('objectionable post rejected', r.status === 422 && r.body.error.code === 'feed.objectionable', r);
    r = await F('Me_User', 'POST', '', { type: 'pr', text: 'Bench 100kg!' });
    check('post PR', r.status === 201 && r.body.post.type === 'pr' && r.body.post.mine, r);
    await tick();
    r = await F('Alice', 'POST', '', { type: 'workout', text: '', workout: { title: 'Push', volume: 5230.4, exercises: 3, sets: 12, names: ['Bench', 'OHP'], top: { name: 'Bench', kg: 80, reps: 5 }, extra: 'x' } });
    check('workout-only post with summary', r.status === 201 && r.body.post.workout.volume === 5230 && !('extra' in r.body.post.workout), r);
    const alicePost = r.body.post.id;
    await tick();
    await F('carl', 'POST', '', { type: 'update', text: 'carl here' });
    await F('dave', 'POST', '', { type: 'update', text: 'dave here' });
    await tick();
    r = await F('bob', 'POST', '', { type: 'bogus', text: 'bob here' });
    check('unknown type becomes update', r.body.post.type === 'update', r);
    r = await F('Me_User', 'GET', '');
    const authors = r.body.posts.map(p => p.author);
    check('feed = me + friends only', authors.includes('Me_User') && authors.includes('Alice') && authors.includes('bob') && !authors.includes('carl') && !authors.includes('dave'), authors);
    check('feed newest first', authors[0] === 'bob', authors);
    r = await F('carl', 'GET', '');
    check('non-friend sees only own posts', r.body.posts.every(p => p.author === 'carl'), r.body);
    r = await F('Me_User', 'DELETE', `/${alicePost}`);
    check("cannot delete a friend's post", r.status === 403, r);
    r = await F('Me_User', 'POST', `/${alicePost}/report`, { reason: 'spam' });
    await tick();
    check('report friend post emails moderators', r.status === 201 && mail.some(m => m.includes('@alice')), { r, mail });
    r = await F('Alice', 'POST', `/${alicePost}/report`, { reason: 'spam' });
    check('cannot report own post', r.status === 422, r);
    r = await F('mod', 'DELETE', `/${alicePost}`);
    check('moderator deletes post', r.status === 200, r);
    await deleteFeedPosts(db, 'bob');
    r = await F('Me_User', 'GET', '');
    check('account deletion removes posts', !r.body.posts.some(p => p.author === 'bob' || p.author === 'Alice'), r.body.posts.map(p => p.author));

    console.log('— shares');
    const program = { name: 'PPL', days: [{ name: 'Push' }] };
    r = await S('Me_User', 'POST', '', { to: 'carl', type: 'program', name: 'PPL', data: program });
    check('share with non-friend rejected', r.status === 422 && r.body.error.code === 'shares.not_friends', r);
    r = await S('Me_User', 'POST', '', { to: 'alice', type: 'workout', name: 'x', data: {} });
    check('bad type rejected', r.status === 422, r);
    r = await S('Me_User', 'POST', '', { to: 'alice', type: 'program', name: 'Big', data: { x: 'a'.repeat(70000) } });
    check('oversized share rejected', r.status === 413, r);
    r = await S('Me_User', 'POST', '', { to: 'ALICE', type: 'program', name: 'PPL', data: program, note: 'try this' });
    check('share with friend', r.status === 201 && r.body.share.to === 'Alice', r);
    r = await S('Alice', 'GET', '');
    check('recipient inbox has it', r.body.inbox.length === 1 && r.body.inbox[0].from === 'Me_User' && r.body.inbox[0].data.days[0].name === 'Push' && r.body.inbox[0].note === 'try this', r.body);
    const shareId = r.body.inbox[0].id;
    r = await S('Me_User', 'GET', '');
    check('sender sees it as sent', r.body.sent.length === 1 && r.body.inbox.length === 0, r.body);
    r = await S('bob', 'DELETE', `/${shareId}`);
    check('third party cannot delete', r.status === 403, r);
    await S('Alice', 'DELETE', `/${shareId}`);
    r = await S('Alice', 'GET', '');
    check('recipient removes it', r.body.inbox.length === 0, r.body);
    const photo = `data:image/jpeg;base64,${Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64)]).toString('base64')}`;
    const meal = { meal: 'dinner', items: [{ name: 'Salmon', amount: 150, unit: 'g', kcal: 310, protein: 31, carbs: 0, fat: 20 }] };
    r = await S('Me_User', 'POST', '', { to: 'alice', type: 'meal', name: 'Dinner', data: meal, photo });
    check('send a meal with a photo', r.status === 201 && r.body.share.hasPhoto, r);
    r = await S('Alice', 'GET', '');
    const mealShare = r.body.inbox[0];
    check('meal arrives with totals', mealShare.type === 'meal' && mealShare.data.totals.protein === 31 && mealShare.hasPhoto && !('photo' in mealShare), mealShare);
    r = await S('Alice', 'GET', `/${mealShare.id}/photo`);
    check('recipient reads the photo', r.status === 200 && r.body.photo.startsWith('data:image/jpeg'), r);
    r = await S('bob', 'GET', `/${mealShare.id}/photo`);
    check('others cannot read the photo', r.status === 404, r);
    r = await S('Me_User', 'POST', '', { to: 'alice', type: 'program', name: 'PPL', data: program, photo });
    check('photo only allowed on meals', r.status === 422 && r.body.error.code === 'shares.invalid_photo', r);
    r = await S('Me_User', 'POST', '', { to: 'alice', type: 'meal', name: 'x', data: meal, photo: 'data:image/jpeg;base64,AAAA' });
    check('fake photo rejected', r.status === 422, r);
    await S('Alice', 'DELETE', `/${mealShare.id}`);
    check('dismissing deletes the photo', !store.has(`sharedMealPhotos/share_${mealShare.id}`), [...store.keys()]);

    await S('Me_User', 'POST', '', { to: 'bob', type: 'template', name: 'Legs', data: { exercises: [] } });
    r = await S('Me_User', 'POST', '', { to: 'bob', type: 'meal', name: 'Dinner', data: meal, photo });
    const bobMeal = r.body.share.id;
    await deleteShares(db, 'Me_User');
    r = await S('bob', 'GET', '');
    check('account deletion removes shares', r.body.inbox.length === 0, r.body);
    check('account deletion removes share photos', !store.has(`sharedMealPhotos/share_${bobMeal}`), [...store.keys()]);

    console.log('— exercise leaderboard');
    const best = bestSetsByLift({ units: 'kg', log: [
      { name: 'Back Squat', repsArray: [5, 3, 20], weightsArray: [100, 110, 60] },
      { name: 'Bench-Press', repsArray: [5], weightsArray: [80] },
      { name: 'Leg Press', repsArray: [10], weightsArray: [300] },
    ] });
    check('best set per lift, >12 reps ignored, unknown lifts skipped', best.squat.kg === 110 && best.squat.reps === 3 && best.bench && Object.keys(best).length === 2, best);
    const lbs = bestSetsByLift({ units: 'lbs', sets: [{ exercise: 'Deadlift', weight: 405, reps: 1 }] });
    check('lbs converted to kg', Math.round(lbs.deadlift.kg) === 184, lbs);
    const today = new Date().toISOString().slice(0, 10);
    const old = new Date(Date.now() - 40 * 86400000).toISOString().slice(0, 10);
    await recordExerciseBests(db, { username: 'Alice', workoutId: 'w1', date: old, workout: { log: [{ name: 'Squat', repsArray: [1], weightsArray: [150] }] } });
    await recordExerciseBests(db, { username: 'Alice', workoutId: 'w2', date: today, workout: { log: [{ name: 'Squat', repsArray: [5], weightsArray: [100] }] } });
    await recordExerciseBests(db, { username: 'bob', workoutId: 'w3', date: today, workout: { log: [{ name: 'Squat', repsArray: [3], weightsArray: [120] }] } });
    await recordExerciseBests(db, { username: 'dave', workoutId: 'w4', date: today, workout: { log: [{ name: 'Squat', repsArray: [1], weightsArray: [200] }] } });
    // Re-posting the same workout with a lighter set replaces that session.
    await recordExerciseBests(db, { username: 'bob', workoutId: 'w3', date: today, workout: { log: [{ name: 'Squat', repsArray: [3], weightsArray: [118] }] } });
    r = await X('Me_User', 'GET', '?lift=squat&range=all');
    check('all-time ranks by best e1RM', r.body.items.map(i => i.username).join() === 'dave,Alice,bob' && r.body.items[1].kg === 150, r.body.items);
    r = await X('Me_User', 'GET', '?lift=squat&range=weekly');
    check('weekly ignores old sessions', r.body.items.map(i => i.username).join() === 'dave,bob,Alice' && r.body.items[2].kg === 100, r.body.items);
    check('re-posted session replaced', r.body.items[1].kg === 118, r.body.items);
    r = await X('bob', 'GET', '?lift=squat&range=weekly');
    check('blocked lifter hidden', !r.body.items.some(i => i.username === 'dave'), r.body.items);
    r = await X('bob', 'GET', '?lift=nope');
    check('unknown lift falls back to squat + lift list', r.body.lift === 'squat' && r.body.lifts.length === 5, r.body);
  } catch (e) { failures++; console.error(e); }
  server.close();
  console.log(failures ? `${failures} FAILED` : 'All social route tests passed.');
  process.exit(failures ? 1 : 0);
});
