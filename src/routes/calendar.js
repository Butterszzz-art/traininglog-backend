// Calendar feed: the user's plan in their phone's calendar app.
//
// The app works out what falls on which date (program days from
// src/js/program-schedule.js, the coach's meal plan and meal times, and when
// the next check-ins are due), so it uploads the next few weeks of events
// here. We serve them as an iCalendar (.ics) feed at a
// secret, unguessable URL that Apple Calendar, Google Calendar or Outlook
// subscribe to and re-check on their own schedule.
//
// Storage (server-only, see firestore.rules):
//   calendarFeeds/{token}       { user, programName, events, updatedAt }
//   calendarFeedOwners/{user}   { token }
// `user` is the lowercase username (profileKey). The token is the doc id, so
// serving a feed is a single read with no query.
//
// Authenticated routes (mounted at /api/calendar):
//   GET    /         → { enabled, path }
//   PUT    /         { programName, timeZone?, events: [{ date, title,
//                      description, kind?, key?, time?, minutes? }] }
//                    → { path }   (creates the feed on first call)
//     kind: 'training' (default) | 'meal' | 'checkin'
//     time: 'HH:MM' local time → a timed event of `minutes` (default 30);
//           without it the event is all-day.
//     key:  tells events of one kind on one day apart (e.g. 'breakfast').
//     timeZone: IANA zone the times are in; without it times float (the
//           calendar app shows them in the phone's own zone).
//   POST   /reset    → { path }   new secret URL; the old one stops working
//   DELETE /         → removes the feed
// Public route: GET /cal/:token.ics (see createCalendarFeedHandler).
const crypto = require('crypto');
const express = require('express');
const { profileKey } = require('./profiles');

const FEEDS = 'calendarFeeds';
const OWNERS = 'calendarFeedOwners';
const MAX_EVENTS = 400;          // program days + meals + check-ins
const KINDS = ['training', 'meal', 'checkin'];
const KEY_RE = /^[a-z0-9-]{1,24}$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const MAX_TZ = 64;
const MAX_TITLE = 120;
const MAX_DESCRIPTION = 1000;
const MAX_PROGRAM_NAME = 80;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{32,64}$/;

function newToken() {
  return crypto.randomBytes(24).toString('base64url'); // 32 chars
}

function feedPath(token) {
  return `/cal/${token}.ics`;
}

function cleanText(value, max) {
  return String(value == null ? '' : value)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .trim()
    .slice(0, max);
}

function isRealDate(str) {
  if (!DATE_RE.test(str)) return false;
  const [y, m, d] = str.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** An IANA time zone the runtime knows, else ''. */
function cleanTimeZone(value) {
  const tz = typeof value === 'string' ? value.trim().slice(0, MAX_TZ) : '';
  if (!tz || !/^[A-Za-z0-9_+\-/]+$/.test(tz)) return '';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch {
    return '';
  }
}

/** Validate the uploaded events. Returns { events } or { error }. */
function cleanEvents(raw) {
  if (!Array.isArray(raw)) return { error: 'events must be an array.' };
  if (raw.length > MAX_EVENTS) return { error: `At most ${MAX_EVENTS} events.` };
  const seen = new Set();
  const events = [];
  for (const e of raw) {
    const date = e && typeof e.date === 'string' ? e.date : '';
    if (!isRealDate(date)) return { error: 'Each event needs a date as YYYY-MM-DD.' };
    const kind = e.kind == null || e.kind === '' ? 'training' : e.kind;
    if (!KINDS.includes(kind)) return { error: `kind must be one of ${KINDS.join(', ')}.` };
    const key = e.key == null || e.key === '' ? '' : String(e.key);
    if (key && !KEY_RE.test(key)) return { error: 'key must be lowercase letters, digits or dashes.' };
    const id = `${date}|${kind}|${key}`;
    if (seen.has(id)) continue; // one of each per day
    seen.add(id);
    const title = cleanText(e.title, MAX_TITLE);
    if (!title) return { error: 'Each event needs a title.' };
    const ev = { date, title, description: cleanText(e.description, MAX_DESCRIPTION) };
    if (kind !== 'training') ev.kind = kind;
    if (key) ev.key = key;
    if (e.time != null && e.time !== '') {
      if (typeof e.time !== 'string' || !TIME_RE.test(e.time)) return { error: 'time must be HH:MM.' };
      ev.time = e.time;
      const minutes = Number(e.minutes);
      ev.minutes = Number.isInteger(minutes) && minutes >= 5 && minutes <= 480 ? minutes : 30;
    }
    events.push(ev);
  }
  events.sort((a, b) => (a.date !== b.date ? (a.date < b.date ? -1 : 1)
    : (a.time || '') < (b.time || '') ? -1 : (a.time || '') > (b.time || '') ? 1 : 0));
  return { events };
}

// ── iCalendar ────────────────────────────────────────────────────────────────

function escapeIcs(text) {
  return String(text)
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
}

// Lines longer than 75 bytes are folded: CRLF + one space, never splitting a
// multi-byte character.
function foldLine(line) {
  if (Buffer.byteLength(line, 'utf8') <= 75) return line;
  const parts = [];
  let cur = '';
  let curBytes = 0;
  let limit = 75;
  for (const ch of line) {
    const b = Buffer.byteLength(ch, 'utf8');
    if (curBytes + b > limit) {
      parts.push(cur);
      cur = '';
      curBytes = 0;
      limit = 74; // continuation lines start with a space
    }
    cur += ch;
    curBytes += b;
  }
  parts.push(cur);
  return parts.join('\r\n ');
}

function compactDate(date) {
  return date.replace(/-/g, '');
}

function nextDay(date) {
  const [y, m, d] = date.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + 1));
  return dt.toISOString().slice(0, 10);
}

// Local date + HH:MM (+ minutes) → 'YYYYMMDDTHHMMSS' wall-clock time.
function localStamp(date, time, addMinutes) {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d, hh, mm + (addMinutes || 0)));
  return dt.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, '');
}

function stamp(iso) {
  const d = iso ? new Date(iso) : new Date();
  const safe = isNaN(d.getTime()) ? new Date() : d;
  return safe.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

/**
 * Build the .ics text. Program days and check-ins without a time are all-day,
 * so they land on the right date in any time zone; meals have a time, in the
 * user's zone (TZID) or floating. Each UID is tied to the date, kind and key,
 * so when the plan for a day changes the calendar updates that event instead
 * of adding a second one. Program-day UIDs keep their original form so
 * existing subscriptions don't see every session twice.
 */
function buildIcs({ token, programName, events, updatedAt, timeZone }) {
  const calName = programName ? `${programName} · Pocket Coach` : 'Pocket Coach';
  const tz = cleanTimeZone(timeZone);
  const uidSeed = crypto.createHash('sha256').update(String(token)).digest('hex').slice(0, 12);
  const dtstamp = stamp(updatedAt);
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Pocket Coach//Training Calendar//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeIcs(calName)}`,
    'X-WR-CALDESC:Your training\\, meals and check-ins from Pocket Coach',
    ...(tz ? [`X-WR-TIMEZONE:${tz}`] : []),
    'REFRESH-INTERVAL;VALUE=DURATION:PT6H',
    'X-PUBLISHED-TTL:PT6H',
  ];
  for (const e of events || []) {
    const kind = e.kind || 'training';
    const tail = kind === 'training' && !e.key ? '' : `-${kind}${e.key ? '-' + e.key : ''}`;
    lines.push(
      'BEGIN:VEVENT',
      `UID:${compactDate(e.date)}${tail}-${uidSeed}@pocketcoachcoms.org`,
      `DTSTAMP:${dtstamp}`,
    );
    if (e.time && TIME_RE.test(e.time)) {
      const param = tz ? `;TZID=${tz}` : '';
      lines.push(
        `DTSTART${param}:${localStamp(e.date, e.time)}`,
        `DTEND${param}:${localStamp(e.date, e.time, e.minutes || 30)}`,
      );
    } else {
      lines.push(
        `DTSTART;VALUE=DATE:${compactDate(e.date)}`,
        `DTEND;VALUE=DATE:${compactDate(nextDay(e.date))}`,
      );
    }
    lines.push(`SUMMARY:${escapeIcs(e.title)}`);
    if (e.description) lines.push(`DESCRIPTION:${escapeIcs(e.description)}`);
    if (kind !== 'training') lines.push(`CATEGORIES:${kind === 'meal' ? 'Meal' : 'Check-in'}`);
    lines.push('TRANSP:TRANSPARENT', 'END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.map(foldLine).join('\r\n') + '\r\n';
}

// ── Storage helpers ──────────────────────────────────────────────────────────

async function currentToken(db, user) {
  const snap = await db.collection(OWNERS).doc(user).get();
  const token = snap.exists ? snap.get('token') : null;
  return typeof token === 'string' && TOKEN_RE.test(token) ? token : null;
}

/** Remove a user's feed (used on account deletion too). */
async function deleteCalendarFeed(db, username) {
  const user = profileKey(username);
  if (!user) return;
  const token = await currentToken(db, user);
  if (token) await db.collection(FEEDS).doc(token).delete();
  await db.collection(OWNERS).doc(user).delete();
}

// ── Routes ───────────────────────────────────────────────────────────────────

function createCalendarRouter({ db, FieldValue, firebaseEnabled, sendError, sendSuccess }) {
  const router = express.Router();

  router.use((req, res, next) => {
    if (!firebaseEnabled) return sendError(res, 503, 'calendar.firebase_disabled', 'Calendar sync is not available right now.');
    req.calUser = profileKey(req.user?.username);
    if (!req.calUser) return sendError(res, 403, 'calendar.no_username', 'This session has no username.');
    next();
  });

  router.get('/', async (req, res) => {
    try {
      const token = await currentToken(db, req.calUser);
      return sendSuccess(res, 200, { enabled: !!token, path: token ? feedPath(token) : null });
    } catch (err) {
      console.error('GET /api/calendar failed:', err);
      return sendError(res, 500, 'calendar.server_error', 'Could not load calendar sync.');
    }
  });

  router.put('/', async (req, res) => {
    const { events, error } = cleanEvents(req.body && req.body.events);
    if (error) return sendError(res, 400, 'calendar.invalid_events', error);
    const programName = cleanText(req.body && req.body.programName, MAX_PROGRAM_NAME);
    const timeZone = cleanTimeZone(req.body && req.body.timeZone);
    try {
      let token = await currentToken(db, req.calUser);
      if (!token) {
        token = newToken();
        await db.collection(OWNERS).doc(req.calUser).set({ token, createdAt: FieldValue.serverTimestamp() });
      }
      await db.collection(FEEDS).doc(token).set({
        user: req.calUser,
        programName,
        timeZone,
        events,
        updatedAt: new Date().toISOString(),
      });
      return sendSuccess(res, 200, { path: feedPath(token), count: events.length });
    } catch (err) {
      console.error('PUT /api/calendar failed:', err);
      return sendError(res, 500, 'calendar.server_error', 'Could not update the calendar.');
    }
  });

  router.post('/reset', async (req, res) => {
    try {
      const old = await currentToken(db, req.calUser);
      const token = newToken();
      let data = { user: req.calUser, programName: '', events: [], updatedAt: new Date().toISOString() };
      if (old) {
        const snap = await db.collection(FEEDS).doc(old).get();
        if (snap.exists) data = { ...snap.data(), updatedAt: new Date().toISOString() };
        await db.collection(FEEDS).doc(old).delete();
      }
      await db.collection(FEEDS).doc(token).set(data);
      await db.collection(OWNERS).doc(req.calUser).set({ token, createdAt: FieldValue.serverTimestamp() });
      return sendSuccess(res, 200, { path: feedPath(token) });
    } catch (err) {
      console.error('POST /api/calendar/reset failed:', err);
      return sendError(res, 500, 'calendar.server_error', 'Could not reset the calendar link.');
    }
  });

  router.delete('/', async (req, res) => {
    try {
      await deleteCalendarFeed(db, req.calUser);
      return sendSuccess(res, 200, {});
    } catch (err) {
      console.error('DELETE /api/calendar failed:', err);
      return sendError(res, 500, 'calendar.server_error', 'Could not turn off calendar sync.');
    }
  });

  return router;
}

/** Public GET /cal/:file — the .ics feed calendar apps subscribe to. */
function createCalendarFeedHandler({ db, firebaseEnabled }) {
  return async (req, res) => {
    const m = /^([A-Za-z0-9_-]+)\.ics$/.exec(String(req.params.file || ''));
    const token = m && TOKEN_RE.test(m[1]) ? m[1] : null;
    if (!token || !firebaseEnabled) return res.status(404).type('text/plain').send('Not found');
    try {
      const snap = await db.collection(FEEDS).doc(token).get();
      if (!snap.exists) return res.status(404).type('text/plain').send('Not found');
      const data = snap.data() || {};
      res.set('Content-Type', 'text/calendar; charset=utf-8');
      res.set('Content-Disposition', 'inline; filename="pocket-coach.ics"');
      res.set('Cache-Control', 'private, no-cache');
      return res.status(200).send(buildIcs({ token, ...data }));
    } catch (err) {
      console.error('GET /cal failed:', err);
      return res.status(500).type('text/plain').send('Calendar unavailable');
    }
  };
}

module.exports = {
  createCalendarRouter,
  createCalendarFeedHandler,
  deleteCalendarFeed,
  buildIcs,
  cleanEvents,
  cleanTimeZone,
  foldLine,
  escapeIcs,
};
