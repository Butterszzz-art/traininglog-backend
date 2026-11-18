// Tests for src/routes/calendar.js against an in-memory Firestore stand-in.
// No network, no Firebase project needed.
//
// Run: node scripts/test-calendar.js
const assert = require('assert');
const http = require('http');
const express = require('express');
const {
  createCalendarRouter, createCalendarFeedHandler, deleteCalendarFeed,
  buildIcs, cleanEvents, cleanTimeZone, foldLine, escapeIcs,
} = require('../src/routes/calendar');

// ── Fake Firestore ───────────────────────────────────────────────────────────
const store = {};
function docRef(col, id) {
  store[col] = store[col] || {};
  return {
    id,
    async get() {
      const data = store[col][id];
      return { id, exists: !!data, get: f => data?.[f], data: () => data && { ...data } };
    },
    async set(data) { store[col][id] = { ...data }; },
    async delete() { delete store[col][id]; },
  };
}
const db = { collection: col => ({ doc: id => docRef(col, id) }) };
const FieldValue = { serverTimestamp: () => 'TS' };
const sendError = (res, status, code, message) => res.status(status).json({ success: false, error: { code, message } });
const sendSuccess = (res, status, data) => res.status(status).json({ success: true, ...data });

const app = express();
app.use(express.json());
app.use('/api/calendar', (req, res, next) => {
  const u = req.headers['x-user'];
  if (u) req.user = { username: u };
  next();
}, createCalendarRouter({ db, FieldValue, firebaseEnabled: true, sendError, sendSuccess }));
app.get('/cal/:file', createCalendarFeedHandler({ db, firebaseEnabled: true }));

function request(server, method, path, { user, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({
      host: '127.0.0.1', port: server.address().port, method, path,
      headers: { ...(user ? { 'x-user': user } : {}), ...(data ? { 'content-type': 'application/json' } : {}) },
    }, res => {
      let text = '';
      res.on('data', c => { text += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(text); } catch { /* ics */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

let failures = 0;
async function test(name, fn) {
  try { await fn(); console.log('ok  ', name); } catch (err) { failures++; console.error('FAIL', name, '\n', err); }
}

(async () => {
  // ── Pure helpers ──
  await test('escapeIcs escapes commas, semicolons, backslashes and newlines', () => {
    assert.strictEqual(escapeIcs('a,b;c\\d\ne'), 'a\\,b\\;c\\\\d\\ne');
  });

  await test('foldLine keeps lines within 75 bytes and never splits a character', () => {
    const long = 'DESCRIPTION:' + 'é'.repeat(100);
    const folded = foldLine(long);
    for (const line of folded.split('\r\n')) assert.ok(Buffer.byteLength(line, 'utf8') <= 75);
    assert.strictEqual(folded.split('\r\n').map((l, i) => (i ? l.slice(1) : l)).join(''), long);
  });

  await test('cleanEvents rejects bad dates, drops duplicates, sorts', () => {
    assert.ok(cleanEvents([{ date: '2026-02-30', title: 'x' }]).error);
    assert.ok(cleanEvents([{ date: '2026-11-02' }]).error);
    assert.ok(cleanEvents('nope').error);
    const { events } = cleanEvents([
      { date: '2026-11-04', title: 'B' },
      { date: '2026-11-02', title: 'A' },
      { date: '2026-11-02', title: 'dupe' },
    ]);
    assert.deepStrictEqual(events.map(e => e.title), ['A', 'B']);
  });

  await test('buildIcs makes all-day events with stable per-date UIDs', () => {
    const ics = buildIcs({ token: 'tok', programName: 'PPL', updatedAt: '2026-11-01T10:00:00.000Z',
      events: [{ date: '2026-12-31', title: 'Push, Week 1', description: 'Bench 3×8\nOHP 3×10' }] });
    assert.ok(ics.startsWith('BEGIN:VCALENDAR\r\n'));
    assert.ok(ics.endsWith('END:VCALENDAR\r\n'));
    assert.ok(ics.includes('DTSTART;VALUE=DATE:20261231'));
    assert.ok(ics.includes('DTEND;VALUE=DATE:20270101'));
    assert.ok(ics.includes('SUMMARY:Push\\, Week 1'));
    assert.ok(ics.includes('DTSTAMP:20261101T100000Z'));
    assert.ok(ics.includes('X-WR-CALNAME:PPL · Pocket Coach'));
    const again = buildIcs({ token: 'tok', events: [{ date: '2026-12-31', title: 'Pull' }] });
    const uid = s => /UID:(.+)\r\n/.exec(s)[1];
    assert.strictEqual(uid(ics), uid(again));
  });

  await test('cleanEvents: meals and check-ins share a day with the session', () => {
    const { events, error } = cleanEvents([
      { date: '2026-11-02', kind: 'meal', key: 'lunch', time: '12:30', title: 'Lunch' },
      { date: '2026-11-02', kind: 'meal', key: 'breakfast', time: '07:30', minutes: 20, title: 'Breakfast' },
      { date: '2026-11-02', title: 'Upper A' },
      { date: '2026-11-02', kind: 'checkin', title: 'Check-in' },
      { date: '2026-11-02', kind: 'meal', key: 'lunch', time: '13:00', title: 'dupe' },
    ]);
    assert.ok(!error, error);
    assert.deepStrictEqual(events.map(e => e.title), ['Upper A', 'Check-in', 'Breakfast', 'Lunch']);
    assert.strictEqual(events[2].minutes, 20);
    assert.strictEqual(events[3].minutes, 30);
    assert.ok(cleanEvents([{ date: '2026-11-02', kind: 'party', title: 'x' }]).error);
    assert.ok(cleanEvents([{ date: '2026-11-02', kind: 'meal', time: '25:00', title: 'x' }]).error);
    assert.ok(cleanEvents([{ date: '2026-11-02', kind: 'meal', key: 'Bad Key', title: 'x' }]).error);
  });

  await test('cleanTimeZone keeps real IANA zones only', () => {
    assert.strictEqual(cleanTimeZone('Europe/Amsterdam'), 'Europe/Amsterdam');
    assert.strictEqual(cleanTimeZone('Mars/Olympus'), '');
    assert.strictEqual(cleanTimeZone('a;b'), '');
    assert.strictEqual(cleanTimeZone(5), '');
  });

  await test('buildIcs: timed meals in the user\'s zone, all-day check-ins, distinct UIDs', () => {
    const ics = buildIcs({ token: 'tok', timeZone: 'Europe/Amsterdam', events: [
      { date: '2026-12-31', title: 'Push' },
      { date: '2026-12-31', kind: 'meal', key: 'dinner', time: '23:45', minutes: 30, title: 'Dinner' },
      { date: '2026-12-31', kind: 'checkin', title: 'Check-in due' },
    ] });
    assert.ok(ics.includes('X-WR-TIMEZONE:Europe/Amsterdam'));
    assert.ok(ics.includes('DTSTART;TZID=Europe/Amsterdam:20261231T234500'));
    assert.ok(ics.includes('DTEND;TZID=Europe/Amsterdam:20270101T001500'), 'end rolls into the next day');
    assert.ok(ics.includes('CATEGORIES:Meal'));
    assert.ok(ics.includes('CATEGORIES:Check-in'));
    const uids = [...ics.matchAll(/UID:(.+)\r\n/g)].map(m => m[1]);
    assert.strictEqual(new Set(uids).size, 3);
    assert.match(uids[0], /^20261231-[0-9a-f]{12}@/, 'program-day UID unchanged for existing subscribers');
    const floating = buildIcs({ token: 'tok', events: [{ date: '2026-12-31', kind: 'meal', key: 'lunch', time: '12:00', title: 'Lunch' }] });
    assert.ok(floating.includes('DTSTART:20261231T120000'));
  });

  // ── Routes ──
  const server = app.listen(0);
  try {
    await test('needs a username', async () => {
      const r = await request(server, 'GET', '/api/calendar');
      assert.strictEqual(r.status, 403);
    });

    let path;
    await test('starts disabled, PUT creates the feed', async () => {
      let r = await request(server, 'GET', '/api/calendar', { user: 'Alice' });
      assert.deepStrictEqual([r.json.enabled, r.json.path], [false, null]);
      r = await request(server, 'PUT', '/api/calendar', { user: 'Alice', body: {
        programName: 'Upper/Lower',
        events: [{ date: '2026-11-02', title: 'Upper A', description: 'Bench 4×6' }],
      } });
      assert.strictEqual(r.status, 200);
      assert.match(r.json.path, /^\/cal\/[A-Za-z0-9_-]{32}\.ics$/);
      path = r.json.path;
      r = await request(server, 'GET', '/api/calendar', { user: 'alice' });
      assert.deepStrictEqual([r.json.enabled, r.json.path], [true, path]);
    });

    await test('the public feed serves text/calendar', async () => {
      const r = await request(server, 'GET', path);
      assert.strictEqual(r.status, 200);
      assert.match(r.headers['content-type'], /^text\/calendar/);
      assert.ok(r.text.includes('SUMMARY:Upper A'));
    });

    await test('PUT again keeps the same URL and replaces the events', async () => {
      const r = await request(server, 'PUT', '/api/calendar', { user: 'Alice', body: {
        events: [{ date: '2026-11-03', title: 'Lower A' }],
      } });
      assert.strictEqual(r.json.path, path);
      const feed = await request(server, 'GET', path);
      assert.ok(feed.text.includes('Lower A'));
      assert.ok(!feed.text.includes('Upper A'));
    });

    await test('PUT keeps the time zone and serves timed meals', async () => {
      const r = await request(server, 'PUT', '/api/calendar', { user: 'Alice', body: {
        timeZone: 'America/New_York',
        events: [{ date: '2026-11-03', title: 'Lower A' }, { date: '2026-11-03', kind: 'meal', key: 'breakfast', time: '08:00', title: 'Breakfast · Oats' }],
      } });
      assert.strictEqual(r.status, 200);
      const feed = await request(server, 'GET', path);
      assert.ok(feed.text.includes('DTSTART;TZID=America/New_York:20261103T080000'));
      assert.ok(feed.text.includes('Lower A'));
    });

    await test('rejects invalid events', async () => {
      const r = await request(server, 'PUT', '/api/calendar', { user: 'Alice', body: { events: [{ date: 'tomorrow', title: 'x' }] } });
      assert.strictEqual(r.status, 400);
    });

    await test('unknown or malformed tokens 404', async () => {
      assert.strictEqual((await request(server, 'GET', '/cal/' + 'x'.repeat(32) + '.ics')).status, 404);
      assert.strictEqual((await request(server, 'GET', '/cal/short.ics')).status, 404);
      assert.strictEqual((await request(server, 'GET', '/cal/../etc')).status, 404);
    });

    await test('reset gives a new URL, keeps events, kills the old one', async () => {
      const r = await request(server, 'POST', '/api/calendar/reset', { user: 'Alice' });
      assert.notStrictEqual(r.json.path, path);
      assert.strictEqual((await request(server, 'GET', path)).status, 404);
      const feed = await request(server, 'GET', r.json.path);
      assert.ok(feed.text.includes('Lower A'));
      path = r.json.path;
    });

    await test('DELETE turns it off', async () => {
      await request(server, 'DELETE', '/api/calendar', { user: 'Alice' });
      assert.strictEqual((await request(server, 'GET', path)).status, 404);
      const r = await request(server, 'GET', '/api/calendar', { user: 'Alice' });
      assert.strictEqual(r.json.enabled, false);
    });

    await test('deleteCalendarFeed (account deletion) removes both docs', async () => {
      const r = await request(server, 'PUT', '/api/calendar', { user: 'bob', body: { events: [] } });
      assert.strictEqual(r.status, 200);
      await deleteCalendarFeed(db, 'Bob');
      assert.deepStrictEqual(Object.keys(store.calendarFeeds), []);
      assert.ok(!store.calendarFeedOwners.bob);
    });
  } finally {
    server.close();
  }

  if (failures) { console.error(`\n${failures} failed`); process.exit(1); }
  console.log('\nall passed');
})();
