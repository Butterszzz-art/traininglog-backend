// Tests for form checks (src/formChecks.js), marking a check-in reviewed
// (src/checkInComments.js) and check-in settings/answers (src/coachShare.js),
// against an in-memory stand-in for Firestore. All users are made up.
// Run: node scripts/test-form-checks.js
'use strict';

const path = require('path');
const express = require('express');
const fc = require(path.join(__dirname, '..', 'src', 'formChecks'));
const cc = require(path.join(__dirname, '..', 'src', 'checkInComments'));
const cs = require(path.join(__dirname, '..', 'src', 'coachShare'));

const results = [];
const check = (label, cond) => results.push({ label, pass: !!cond });

function fakeDb() {
  const docs = new Map(); // "a/b/c/d" -> data
  let auto = 0;
  const clone = v => JSON.parse(JSON.stringify(v));
  function docRef(p) {
    return {
      id: p.split('/').pop(),
      get: async () => snap(p, docs.get(p)),
      set: async (data, opts) => { docs.set(p, opts && opts.merge ? { ...(docs.get(p) || {}), ...clone(data) } : clone(data)); },
      delete: async () => { docs.delete(p); },
    };
  }
  const snap = (p, data) => ({
    id: p.split('/').pop(), exists: data !== undefined, ref: docRef(p),
    data: () => (data === undefined ? undefined : clone(data)),
    get: f => (data == null ? undefined : data[f]),
  });
  const coll = (p, filters = []) => ({
    doc: id => docRef(`${p}/${id || `auto${String(++auto).padStart(4, '0')}`}`),
    where: (f, _op, v) => coll(p, [...filters, [f, v]]),
    get: async () => ({
      docs: [...docs.entries()]
        .filter(([k]) => k.startsWith(`${p}/`) && !k.slice(p.length + 1).includes('/'))
        .filter(([, d]) => filters.every(([f, v]) => d[f] === v))
        .map(([k, d]) => snap(k, d)),
    }),
  });
  return { docs, collection: coll };
}

const sendError = (res, status, code, message) => res.status(status).json({ success: false, error: { code, message } });
const sendSuccess = (res, status, data = {}) => res.status(status).json({ success: true, ...data });

(async () => {
  // ── Check-in settings and answers (src/coachShare.js) ──
  const st = cs.sanitizeCheckInSettings({ everyDays: 14, questions: ['  How was   your sleep? ', '', 'How was your sleep?', 'Any pain?', 42] });
  check('settings keep the frequency and tidy, dedupe the questions', st.everyDays === 14 && st.questions.join('|') === 'How was your sleep?|Any pain?');
  check('settings fall back to weekly and cap at 8 questions', cs.sanitizeCheckInSettings({ everyDays: 99, questions: Array.from({ length: 12 }, (_, i) => `q${i}`) }).everyDays === 7
    && cs.sanitizeCheckInSettings({ questions: Array.from({ length: 12 }, (_, i) => `q${i}`) }).questions.length === 8 && cs.sanitizeCheckInSettings(null) === null);
  const shared = cs.buildShareFields({ checkIns: [{ date: '2026-11-02', sleep: 7, answers: [{ q: 'Any pain?', a: ' Left knee ' }, { q: 'Empty', a: '' }, 'junk'] }] }, { checkIns: true });
  check('a shared check-in keeps answered questions only', shared.checkIns[0].answers.length === 1 && shared.checkIns[0].answers[0].a === 'Left knee');

  check('cleanUrl accepts http(s) links only', fc.cleanUrl(' https://youtu.be/abc ') === 'https://youtu.be/abc' && fc.cleanUrl('javascript:alert(1)') === '' && fc.cleanUrl('nope') === '');
  check('cleanSeconds reads seconds and m:ss', fc.cleanSeconds('1:05') === 65 && fc.cleanSeconds(12.9) === 12 && fc.cleanSeconds('') === null && fc.cleanSeconds('abc') === undefined && fc.cleanSeconds(-1) === undefined);

  const db = fakeDb();
  const notified = [];
  const users = {
    coach: { uid: 'c1', username: 'coach_a' }, other: { uid: 'c2', username: 'coach_b' },
    ana: { uid: 'u1', username: 'client_a' }, bob: { uid: 'u2', username: 'client_b' },
  };
  db.docs.set('coaches/c1/clients/u1', { athleteDisplayName: 'client_a', status: 'active', reviewedCheckInDate: '2026-10-20' });
  db.docs.set('users/u1/coachInvites/c1', { status: 'active', coachUsername: 'coach_a' });

  let clock = Date.UTC(2026, 10, 3, 9, 0, 0);
  const deps = { db, sendError, sendSuccess, resolveCallerUid: async u => u?.uid || null, usernameForUid: async () => '', now: () => new Date(clock += 1000) };
  const routers = fc.createRouters({
    ...deps,
    notifySent: async x => { notified.push({ kind: 'sent', ...x }); },
    notifyReviewed: async x => { notified.push({ kind: 'reviewed', ...x }); },
  });
  const comments = cc.createRouters(deps);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = users[req.get('x-user')]; next(); });
  app.use('/api/client/form-checks', routers.client);
  app.use('/api/coach/form-checks', routers.coach);
  app.use('/api/coach/clients/:clientUid', comments.coach);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, user, body) => {
    const r = await fetch(base + url, { method, headers: { 'content-type': 'application/json', 'x-user': user }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json() };
  };

  try {
    // ── Mark a check-in reviewed ──
    let r = await call('POST', '/api/coach/clients/u1/checkins/2026-11-02/reviewed', 'coach');
    check('coach marks a check-in reviewed', r.status === 200 && db.docs.get('coaches/c1/clients/u1').reviewedCheckInDate === '2026-11-02');
    r = await call('POST', '/api/coach/clients/u1/checkins/2026-10-01/reviewed', 'coach');
    check('an older date never moves the marker back', r.body.reviewedCheckInDate === '2026-11-02');
    r = await call('POST', '/api/coach/clients/u1/checkins/2026-11-02/reviewed', 'other');
    check('a coach not linked cannot mark reviewed', r.status === 404);

    // ── Form checks ──
    r = await call('POST', '/api/client/form-checks', 'ana', { exercise: '  Back   squat ', videoUrl: 'https://youtu.be/abc', note: 'Third set, felt my hips shoot up.' });
    const id = r.body.formCheck && r.body.formCheck.id;
    check('client sends a form check', r.status === 201 && r.body.formCheck.exercise === 'Back squat' && r.body.formCheck.status === 'pending' && r.body.formCheck.coachUid === 'c1');
    check('coach is notified with the exercise', notified.length === 1 && notified[0].kind === 'sent' && notified[0].coachUsername === 'coach_a' && notified[0].exercise === 'Back squat');
    r = await call('POST', '/api/client/form-checks', 'ana', { exercise: 'Squat', videoUrl: 'ftp://x' });
    check('a non-http link is refused', r.status === 422 && r.body.error.code === 'formchecks.invalid_url');
    r = await call('POST', '/api/client/form-checks', 'ana', { exercise: '', videoUrl: 'https://x.test/v' });
    check('the exercise is required', r.status === 422 && r.body.error.code === 'formchecks.missing_exercise');
    r = await call('POST', '/api/client/form-checks', 'bob', { exercise: 'Squat', videoUrl: 'https://x.test/v' });
    check('a client without a coach cannot send one', r.status === 409);

    r = await call('GET', '/api/coach/form-checks', 'coach');
    check('coach lists it as waiting', r.status === 200 && r.body.formChecks.length === 1 && r.body.formChecks[0].status === 'pending');
    r = await call('GET', '/api/coach/form-checks', 'other');
    check('another coach sees nothing', r.body.formChecks.length === 0);

    r = await call('POST', `/api/coach/form-checks/${id}/comments`, 'coach', { text: 'Chest up out of the hole.', atSeconds: '0:12' });
    check('coach comments at a moment and it becomes reviewed', r.status === 201 && r.body.formCheck.status === 'reviewed' && r.body.formCheck.comments[0].atSeconds === 12 && r.body.formCheck.comments[0].author === 'coach');
    check('client is notified of the review', notified.at(-1).kind === 'reviewed' && notified.at(-1).clientUsername === 'client_a');
    r = await call('POST', `/api/coach/form-checks/${id}/comments`, 'coach', { text: 'x', atSeconds: 'later' });
    check('a bad moment is refused', r.status === 422 && r.body.error.code === 'formchecks.invalid_time');
    r = await call('POST', `/api/coach/form-checks/${id}/comments`, 'other', { text: 'hi' });
    check('another coach cannot comment', r.status === 404);
    r = await call('POST', `/api/client/form-checks/${id}/comments`, 'ana', { text: 'Got it, will film again Friday.' });
    check('client replies and it stays reviewed', r.status === 201 && r.body.formCheck.comments.length === 2 && r.body.formCheck.comments[1].author === 'client' && r.body.formCheck.status === 'reviewed');
    r = await call('POST', `/api/client/form-checks/${id}/comments`, 'bob', { text: 'hi' });
    check('another client cannot reply', r.status === 404);

    await call('POST', '/api/client/form-checks', 'ana', { exercise: 'Deadlift', videoUrl: 'https://x.test/d' });
    r = await call('GET', '/api/coach/form-checks', 'coach');
    check('waiting form checks sort before reviewed ones', r.body.formChecks.length === 2 && r.body.formChecks[0].exercise === 'Deadlift');
    r = await call('GET', '/api/client/form-checks', 'ana');
    check('client lists their own, newest first', r.body.formChecks.length === 2 && r.body.formChecks[0].exercise === 'Deadlift' && r.body.coaches[0].uid === 'c1');
    r = await call('DELETE', `/api/client/form-checks/${id}`, 'ana');
    check('client removes one', r.status === 200 && (await call('GET', '/api/client/form-checks', 'ana')).body.formChecks.length === 1);

    for (let i = 0; i < fc.MAX_PER_CLIENT - 1; i++) db.docs.set(`formChecks/fill${i}`, { coachUid: 'c1', clientUid: 'u1', exercise: 'x', videoUrl: 'https://x.test', createdAt: '2026-01-01T00:00:00Z' });
    r = await call('POST', '/api/client/form-checks', 'ana', { exercise: 'Row', videoUrl: 'https://x.test/r' });
    check('the per-client cap is enforced', r.status === 409 && r.body.error.code === 'formchecks.too_many');

    db.docs.set('formChecks/zzz_other', { coachUid: 'c2', clientUid: 'u2', exercise: 'keep', videoUrl: 'https://x.test', createdAt: '2026-01-01T00:00:00Z' });
    await fc.deleteFormChecks(db, { coachUid: 'c1', clientUid: 'u1' });
    const left = [...db.docs.keys()].filter(k => k.startsWith('formChecks/'));
    check("unlink deletes only that pair's form checks", left.length === 1 && left[0] === 'formChecks/zzz_other');
    await fc.deleteFormChecks(db, { coachUid: 'c2' });
    check('deleting a coach account clears theirs', ![...db.docs.keys()].some(k => k.startsWith('formChecks/')));
  } finally {
    server.close();
  }

  const failed = results.filter(r => !r.pass);
  for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'} - ${r.label}`);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})();
