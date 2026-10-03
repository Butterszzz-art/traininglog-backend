// Tests for in-app notifications (src/routes/notifications.js) and the routes
// that raise them — friends, shares, groups, feed, exercise board and the
// volume leaderboard — against an in-memory Firestore stand-in.
//
// Run: node scripts/test-notifications.js
const express = require('express');
const { createFriendsRouter } = require('../src/routes/friends');
const { createSharesRouter } = require('../src/routes/shares');
const { createGroupsRouter } = require('../src/routes/groups');
const { createFeedRouter } = require('../src/routes/feed');
const { createNotificationsRouter, notify, notifyVolumePasses, deleteNotifications } = require('../src/routes/notifications');
const { recordExerciseBests } = require('../src/routes/exerciseBoard');
const coach = require('../src/coachNotifications');

// ── Fake Firestore ───────────────────────────────────────────────────────────
const TS = { __ts: true };
const FieldValue = { serverTimestamp: () => TS, arrayUnion: (...v) => ({ __union: v }) };
const store = new Map(); // "coll/id" -> data
let autoId = 0;
let clock = Date.parse('2026-09-30T10:00:00Z');
const later = () => new Date((clock += 1000));

function resolve(data, prev = {}) {
  const out = { ...prev };
  for (const [k, v] of Object.entries(data)) {
    let val = v === TS ? later() : v;
    if (val && val.__union) val = [...new Set([...(prev[k] || []), ...val.__union])];
    if (k.includes('.')) { const [a, b] = k.split('.'); out[a] = { ...(out[a] || {}), [b]: val }; } else out[k] = val;
  }
  return out;
}
function snapOf(coll, id) {
  const data = store.get(`${coll}/${id}`);
  return { id, exists: !!data, ref: docRef(coll, id), data: () => data && { ...data }, get: f => data && data[f] };
}
function docRef(coll, id) {
  const key = `${coll}/${id}`;
  return {
    id,
    get: async () => snapOf(coll, id),
    set: async (d, o) => { store.set(key, resolve(d, o?.merge ? store.get(key) : {})); },
    update: async d => { if (!store.has(key)) throw new Error('no doc ' + key); store.set(key, resolve(d, store.get(key))); },
    delete: async () => { store.delete(key); },
  };
}
const cmp = v => (v instanceof Date ? v.getTime() : v);
const OPS = {
  '==': (x, v) => x === v,
  '>': (x, v) => x != null && cmp(x) > cmp(v),
  '>=': (x, v) => x != null && cmp(x) >= cmp(v),
  '<': (x, v) => x != null && cmp(x) < cmp(v),
  'array-contains': (x, v) => (x || []).includes(v),
  in: (x, v) => v.includes(x),
};
function query(coll, filters = [], order = null, lim = Infinity) {
  const run = () => {
    let docs = [...store.keys()].filter(k => k.startsWith(coll + '/')).map(k => snapOf(coll, k.slice(coll.length + 1)));
    docs = docs.filter(d => filters.every(([f, op, v]) => OPS[op](d.get(f), v)));
    if (order) {
      const [f, dir] = order;
      docs = docs.filter(d => d.get(f) != null).sort((a, b) => (cmp(a.get(f)) - cmp(b.get(f))) * (dir === 'desc' ? -1 : 1));
    }
    return docs.slice(0, lim);
  };
  return {
    where: (f, op, v) => query(coll, [...filters, [f, op, v]], order, lim),
    orderBy: (f, dir) => query(coll, filters, [f, dir], lim),
    limit: n => query(coll, filters, order, n),
    startAfter: () => query(coll, filters, order, lim),
    count: () => ({ get: async () => ({ data: () => ({ count: run().length }) }) }),
    get: async () => { const docs = run(); return { docs, size: docs.length, empty: !docs.length }; },
    add: async d => { const id = `a${++autoId}`; await docRef(coll, id).set(d); return docRef(coll, id); },
    doc: id => docRef(coll, id || `a${++autoId}`),
  };
}
const db = {
  collection: name => query(name),
  getAll: (...refs) => Promise.all(refs.map(r => r.get())),
  batch: () => {
    const ops = [];
    return {
      set: (r, d, o) => ops.push(() => r.set(d, o)),
      update: (r, d) => ops.push(() => r.update(d)),
      commit: async () => { for (const op of ops) await op(); },
    };
  },
  runTransaction: async fn => fn({ get: r => r.get(), set: (r, d, o) => r.set(d, o), update: (r, d) => r.update(d), delete: r => r.delete() }),
};

// Accounts: alice, bob, carl, dave. dave blocked alice.
[['Alice', 'u_alice'], ['bob', 'u_bob'], ['carl', 'u_carl'], ['dave', 'u_dave']].forEach(([name, uid]) => {
  store.set(`usernames/${name.toLowerCase()}`, { uid });
  store.set(`users/${uid}`, { username: name });
});
store.set('profileBlocks/dave', { blocked: ['alice'] });

// ── App ──────────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json({ limit: '256kb' }));
app.use((req, _res, next) => { req.user = { username: req.headers['x-user'] }; next(); });
const sendError = (res, s, code, message) => res.status(s).json({ success: false, error: { code, message } });
const sendSuccess = (res, s, d = {}) => res.status(s).json({ success: true, ...d });
const common = { db, FieldValue, firebaseEnabled: true, sendError, sendSuccess };
app.use('/api/friends', createFriendsRouter(common));
app.use('/api/shares', createSharesRouter(common));
app.use('/api/groups', createGroupsRouter(common));
app.use('/api/feed', createFeedRouter(common));
app.use('/api/notifications', createNotificationsRouter(common));

let failures = 0;
const check = (label, cond, extra) => {
  if (!cond) failures++;
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${label}${!cond && extra !== undefined ? ' → ' + JSON.stringify(extra) : ''}`);
};

const server = app.listen(0, async () => {
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (user, method, p, body) => {
    const r = await fetch(base + p, { method, headers: { 'x-user': user, 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  const inbox = async user => (await call(user, 'GET', '/api/notifications')).body;
  try {
    console.log('— friends');
    let r = await call('Alice', 'POST', '/api/friends/requests', { username: 'bob' });
    check('request sent', r.status === 201, r);
    let n = await inbox('bob');
    check('bob is told about the request', n.unread === 1 && n.items[0].type === 'friend_request' && n.items[0].actor === 'Alice', n);
    check('sender gets nothing', (await inbox('alice')).items.length === 0);
    r = await call('bob', 'POST', '/api/friends/requests/alice/accept');
    n = await inbox('Alice');
    check('alice is told bob accepted', n.items[0]?.type === 'friend_accepted' && n.items[0].actor === 'bob', n);

    // carl asks alice; alice "requests" carl back, which accepts his.
    await call('carl', 'POST', '/api/friends/requests', { username: 'alice' });
    await call('Alice', 'POST', '/api/friends/requests', { username: 'carl' });
    n = await inbox('carl');
    check('mutual request tells the first sender', n.items.some(i => i.type === 'friend_accepted' && i.actor === 'Alice'), n);

    console.log('— shares');
    r = await call('Alice', 'POST', '/api/shares', { to: 'bob', type: 'template', name: 'Push Day', data: { x: 1 } });
    check('share sent', r.status === 201, r);
    n = await inbox('bob');
    const share = n.items.find(i => i.type === 'share_received');
    check('bob is told about the share', share && share.text === 'sent you a template: Push Day' && share.data.shareId === r.body.share.id, n);

    console.log('— groups');
    r = await call('Alice', 'POST', '/api/groups', { name: 'Early Birds', members: ['bob'] });
    const gid = r.body.group.id;
    n = await inbox('bob');
    check('invitee at creation is told', n.items.some(i => i.type === 'group_added' && i.data.groupId === gid), n);
    r = await call('Alice', 'POST', `/api/groups/${gid}/invite`, { username: 'carl' });
    n = await inbox('carl');
    check('added member is told', r.status === 200 && n.items.some(i => i.type === 'group_added' && i.text === 'added you to Early Birds'), n);

    await call('Alice', 'POST', `/api/groups/${gid}/posts`, { text: 'one' });
    await call('Alice', 'POST', `/api/groups/${gid}/posts`, { text: 'two' });
    await call('Alice', 'POST', `/api/groups/${gid}/posts`, { text: 'three' });
    n = await inbox('bob');
    const gp = n.items.filter(i => i.type === 'group_post');
    check('group posts collapse to one unread row', gp.length === 1 && gp[0].count === 3, gp);
    check('poster is not told about their own post', !(await inbox('alice')).items.some(i => i.type === 'group_post'));

    console.log('— read state');
    r = await call('bob', 'POST', '/api/notifications/read', { ids: [gp[0].id] });
    n = await inbox('bob');
    check('mark one read', r.body.updated === 1 && n.items.find(i => i.id === gp[0].id).read === true, n);
    await call('Alice', 'POST', `/api/groups/${gid}/posts`, { text: 'four' });
    n = await inbox('bob');
    const again = n.items.find(i => i.type === 'group_post');
    check('a post after reading starts a fresh count', again.count === 1 && again.read === false, again);
    r = await call('carl', 'POST', '/api/notifications/read', { ids: [again.id] });
    check('cannot mark someone else’s notification', r.body.updated === 0, r);
    r = await call('bob', 'POST', '/api/notifications/read', {});
    n = await inbox('bob');
    check('mark all read', n.unread === 0 && n.items.every(i => i.read), n);
    r = await call('carl', 'DELETE', `/api/notifications/${again.id}`);
    check('cannot delete someone else’s', (await inbox('bob')).items.some(i => i.id === again.id));
    await call('bob', 'DELETE', `/api/notifications/${again.id}`);
    check('dismiss one', !(await inbox('bob')).items.some(i => i.id === again.id));

    console.log('— prefs');
    r = await call('bob', 'GET', '/api/notifications/prefs');
    check('prefs default on', Object.values(r.body.prefs).every(v => v === true) && Object.keys(r.body.prefs).length === 6, r.body);
    r = await call('bob', 'PUT', '/api/notifications/prefs', { groups: false, bogus: false, shares: 'no' });
    check('mute groups only', r.body.prefs.groups === false && r.body.prefs.shares === true && !('bogus' in r.body.prefs), r.body);
    const before = (await inbox('bob')).items.length;
    await call('Alice', 'POST', `/api/groups/${gid}/posts`, { text: 'five' });
    check('muted category is not written', (await inbox('bob')).items.length === before);

    console.log('— feed');
    await call('Alice', 'POST', '/api/feed', { type: 'workout', text: '', workout: { title: 'Leg Day', volume: 5000, exercises: 3, sets: 9, names: ['Squat'] } });
    await call('Alice', 'POST', '/api/feed', { type: 'pr', text: 'Squat 140!' });
    n = await inbox('carl');
    const fp = n.items.filter(i => i.type === 'feed_post');
    check('friend’s posts collapse per author', fp.length === 1 && fp[0].count === 2 && fp[0].text === 'posted a new PR', fp);
    check('non-friend hears nothing', !(await inbox('dave')).items.some(i => i.type === 'feed_post'));

    console.log('— blocks');
    await notify(db, { to: ['dave', 'bob'], type: 'group_added', actor: 'alice', actorName: 'Alice', text: 'x' });
    check('someone who blocked the actor is not told', (await inbox('dave')).items.length === 0);
    await notify(db, { to: 'alice', type: 'friend_request', actor: 'dave', actorName: 'dave', text: 'x' });
    check('the blocker can’t reach the blocked person either', !(await inbox('alice')).items.some(i => i.actor === 'dave'));
    check('unknown type is ignored', await notify(db, { to: 'bob', type: 'nope', actor: 'alice' }) === 0);

    console.log('— exercise board');
    const w = kg => ({ exercises: [{ name: 'Bench Press', sets: [{ weight: kg, reps: 1 }] }] });
    await recordExerciseBests(db, { username: 'bob', workoutId: 'b1', date: '2026-09-01', workout: w(100) });
    await recordExerciseBests(db, { username: 'carl', workoutId: 'c1', date: '2026-09-01', workout: w(110) });
    await recordExerciseBests(db, { username: 'dave', workoutId: 'd1', date: '2026-09-01', workout: w(130) });
    await recordExerciseBests(db, { username: 'Alice', workoutId: 'a1', date: '2026-09-02', workout: w(90) });
    check('a first entry below everyone passes nobody', !(await inbox('bob')).items.some(i => i.type === 'exercise_passed' && i.actor === 'Alice'));
    check('a first entry above someone passes them', (await inbox('bob')).items.some(i => i.type === 'exercise_passed' && i.actor === 'carl'));
    await recordExerciseBests(db, { username: 'Alice', workoutId: 'a2', date: '2026-09-03', workout: w(120) });
    const bobEx = (await inbox('bob')).items.find(i => i.type === 'exercise_passed' && i.actor === 'Alice');
    check('passing bob and carl tells both', bobEx && bobEx.text === 'passed you on the Bench Press board'
      && (await inbox('carl')).items.some(i => i.type === 'exercise_passed'), bobEx);
    check('lifter still above is not told', !(await inbox('dave')).items.some(i => i.type === 'exercise_passed' && i.actor === 'Alice'));
    const bobCount = bobEx.count;
    await recordExerciseBests(db, { username: 'Alice', workoutId: 'a3', date: '2026-09-04', workout: w(115) });
    check('a set below the best passes nobody', (await inbox('bob')).items.find(i => i.type === 'exercise_passed' && i.actor === 'Alice').count === bobCount);

    console.log('— volume board');
    store.set('users/u_bob', { username: 'bob', totalVolume: 10000 });
    store.set('users/u_carl', { username: 'carl', totalVolume: 12000 });
    store.set('users/u_dave', { username: 'dave', totalVolume: 20000 });
    store.set('users/u_alice', { username: 'Alice', totalVolume: 9000 });
    const sent = await notifyVolumePasses(db, { uid: 'u_alice', username: 'Alice', prevTotal: 9000, nextTotal: 12500 });
    check('volume pass tells bob and carl', sent === 2
      && (await inbox('bob')).items.some(i => i.type === 'volume_passed')
      && (await inbox('carl')).items.some(i => i.type === 'volume_passed'), sent);
    check('no pass when the total didn’t grow', await notifyVolumePasses(db, { uid: 'u_alice', username: 'Alice', prevTotal: 12500, nextTotal: 12500 }) === 0);

    console.log('— coaching');
    await coach.notifyCoachInvite(db, { coachUsername: 'carl', clientUsername: 'Alice' });
    let inv = (await inbox('Alice')).items.find(i => i.type === 'coach_invite');
    check('athlete is told about the invite', inv && inv.actor === 'carl' && inv.text === 'wants to coach you' && inv.data.status === 'pending', inv);
    await coach.notifyCoachInvite(db, { coachUsername: 'carl', clientUsername: 'Alice' });
    check('re-invite keeps one row', (await inbox('Alice')).items.filter(i => i.type === 'coach_invite').length === 1);
    await coach.coachInviteAccepted(db, { coachUsername: 'carl', clientUsername: 'Alice' });
    inv = (await inbox('Alice')).items.find(i => i.type === 'coach_invite');
    check('accepting turns the invite row into a read "is now your coach"', inv.read && inv.data.status === 'accepted' && inv.text === 'is now your coach', inv);
    check('coach is told it was accepted', (await inbox('carl')).items.some(i => i.type === 'coach_accepted' && i.actor === 'Alice'));
    await coach.coachInviteWithdrawn(db, { coachUsername: 'carl', clientUsername: 'Alice' });
    check('an accepted invite row survives a later removal', (await inbox('Alice')).items.some(i => i.type === 'coach_invite'));

    await coach.notifyCoachInvite(db, { coachUsername: 'bob', clientUsername: 'carl' });
    await coach.coachInviteWithdrawn(db, { coachUsername: 'bob', clientUsername: 'carl' });
    check('a cancelled invite disappears', !(await inbox('carl')).items.some(i => i.type === 'coach_invite'));

    await coach.notifyCoachNote(db, { coachUsername: 'carl', clientUsername: 'Alice' });
    await coach.notifyCoachNote(db, { coachUsername: 'carl', clientUsername: 'Alice' });
    const note = (await inbox('Alice')).items.filter(i => i.type === 'coach_note');
    check('notes collapse per coach', note.length === 1 && note[0].count === 2 && note[0].category === 'coaching', note);
    await coach.notifyCoachPlan(db, { coachUsername: 'carl', clientUsername: 'Alice', fields: { currentProgram: 'PPL', nutritionSummary: '2500 kcal' } });
    const plan = (await inbox('Alice')).items.find(i => i.type === 'coach_plan');
    check('plan update names what changed', plan && plan.text === 'updated your program and nutrition' && plan.data.program === 'PPL', plan);
    check('an empty plan update sends nothing', await coach.notifyCoachPlan(db, { coachUsername: 'carl', clientUsername: 'Alice', fields: {} }) === 0);
    await coach.notifyCoachInvite(db, { coachUsername: 'dave', clientUsername: 'bob' });
    await coach.coachLeftByClient(db, { coachUsername: 'dave', clientUsername: 'bob', wasPending: true });
    check('declining removes the invite row', !(await inbox('bob')).items.some(i => i.type === 'coach_invite'));
    const leftRow = (await inbox('dave')).items.find(i => i.type === 'coach_left');
    check('coach is told about a decline', leftRow && leftRow.text === 'declined your coaching invite' && leftRow.data.declined === true, leftRow);
    await call('Alice', 'PUT', '/api/notifications/prefs', { coaching: false });
    check('coaching can be muted', await coach.notifyCoachNote(db, { coachUsername: 'carl', clientUsername: 'Alice' }) === 0);

    console.log('— pruning + account deletion');
    for (let i = 0; i < 130; i++) store.set(`notifications/p${i}`, { to: 'carl', type: 'group_added', category: 'groups', actor: 'alice', text: 'x', read: true, count: 1, createdAt: new Date(clock - 1e9 + i) });
    n = await inbox('carl');
    const left = [...store.values()].filter(d => d.to === 'carl' && d.category).length;
    check('list returns a page and prunes past 100', n.items.length === 50 && left <= 120, { page: n.items.length, left });
    await deleteNotifications(db, 'bob');
    check('account deletion clears inbox and prefs', !(await inbox('bob')).items.length && !store.has('notificationPrefs/bob'));
  } catch (err) {
    failures++;
    console.error(err);
  }
  server.close();
  console.log(failures ? `\n${failures} failed` : '\nAll notification tests passed.');
  process.exit(failures ? 1 : 0);
});
