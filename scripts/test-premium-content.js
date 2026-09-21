// Validates content/premium/** and exercises the /api/premium routes with a
// stubbed plan lookup. No Firebase or network needed:
//   node scripts/test-premium-content.js
const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const { createPremiumRouter, loadContent } = require('../src/routes/premium');

let failures = 0;
function check(label, ok, extra) {
  console.log((ok ? 'PASS ' : 'FAIL ') + label + (ok || !extra ? '' : '  -> ' + extra));
  if (!ok) failures++;
}

// ── 1. Content files ────────────────────────────────────────────────────────
const { ebooks, programs } = loadContent();
check('at least one ebook and one program are present', ebooks.length > 0 && programs.length > 0);

const ids = new Set();
for (const doc of [...ebooks, ...programs]) {
  check(`${doc.id}: has a unique id and title`, doc.id && doc.title && !ids.has(doc.id));
  ids.add(doc.id);
}

for (const e of ebooks) {
  const okChapters = Array.isArray(e.chapters) && e.chapters.length > 0 && e.chapters.every(c =>
    c.id && c.title && Array.isArray(c.sections) && c.sections.length > 0 && c.sections.every(s =>
      s.heading && Array.isArray(s.body) && s.body.length > 0 && s.body.every(p => typeof p === 'string' && p.trim())));
  check(`ebook ${e.id}: every chapter has sections with a heading and text`, okChapters);
  const chapterIds = e.chapters.map(c => c.id);
  check(`ebook ${e.id}: chapter ids are unique`, new Set(chapterIds).size === chapterIds.length);
  // only the reader-facing text: headings, paragraphs, table cells
  const text = [];
  for (const c of e.chapters) for (const s of c.sections) {
    text.push(s.heading, ...s.body);
    for (const t of s.tables || []) text.push(t.title || '', ...t.headers, ...t.rows.flat());
  }
  const stray = text.join('\n').match(/https?:\/\/|www\.|\bDM me\b|\bQ&?N?A eBook\b|\bmy [^.]{0,30}e-?book\b/i);
  check(`ebook ${e.id}: no outside links, "DM me" or other-ebook references`, !stray, stray && stray[0]);
}

for (const p of programs) {
  const weeks = p.weeks || [];
  check(`program ${p.id}: weeks are numbered 1..${weeks.length} in order`, weeks.every((w, i) => w.week === i + 1));
  check(`program ${p.id}: durationWeeks matches weeks`, p.durationWeeks === weeks.length);
  let badRef = null;
  for (const w of weeks) {
    if (w.sameAs !== undefined) {
      const target = weeks.find(x => x.week === w.sameAs);
      if (!target || target.sameAs !== undefined || w.days) badRef = w.week;
    } else if (!Array.isArray(w.days) || w.days.length === 0) {
      badRef = w.week;
    }
  }
  check(`program ${p.id}: sameAs references resolve to real weeks`, badRef === null, 'week ' + badRef);

  const real = weeks.filter(w => w.days);
  let badSet = null;
  const exIds = new Set();
  for (const w of real) for (const d of w.days) for (const x of d.exercises) {
    if (exIds.has(x.exerciseId)) badSet = badSet || 'duplicate id ' + x.exerciseId;
    exIds.add(x.exerciseId);
    if (!x.name || !Array.isArray(x.sets) || x.sets.length === 0) badSet = badSet || x.exerciseId;
    for (const s of x.sets) {
      if (!Number.isFinite(s.reps) || (s.repsMax != null && s.repsMax < s.reps)) badSet = badSet || x.exerciseId;
    }
  }
  check(`program ${p.id}: every exercise has a name, sets and valid rep targets`, badSet === null, badSet);
  // a program week can hold more sessions than training days (e.g. a 10-day PPL cycle)
  check(`program ${p.id}: day list derives from week 1`, Array.isArray(p.days) && p.days.length === (p.split.sessionsPerWeek || p.split.daysPerWeek));
  check(`program ${p.id}: weekly schedule matches days per week`, p.schedule.weekdays.length === p.split.daysPerWeek);
}

// ── 2. Routes ───────────────────────────────────────────────────────────────
const plans = { freebie: 'free', payer: 'pro', boss: 'coach', broken: '__throw__' };
async function getPlanInfo(username) {
  if (plans[username] === '__throw__') throw new Error('firestore down');
  return { plan: plans[username] || 'free', status: 'active' };
}
function sendError(res, status, code, message) {
  return res.status(status).json({ success: false, error: { code, message } });
}

const app = express();
app.use((req, res, next) => { req.user = { username: req.headers['x-test-user'] }; next(); });
app.use('/api/premium', createPremiumRouter({ getPlanInfo, sendError }));

function get(base, url, user) {
  return fetch(base + url, { headers: { 'x-test-user': user } }).then(async r => ({ status: r.status, text: await r.text() }));
}

(async () => {
  const server = http.createServer(app).listen(0);
  const base = 'http://127.0.0.1:' + server.address().port;
  try {
    const ebook = ebooks[0];
    const secondChapterSentence = ebook.chapters[1].sections[0].body[0];
    const program = programs[0];
    const someExercise = program.days[0].exercises[0].name;

    let r = await get(base, '/api/premium/library', 'freebie');
    let body = JSON.parse(r.text);
    check('free: library lists everything as a preview', r.status === 200 && body.access === 'preview' && body.ebooks.length === ebooks.length && body.programs.length === programs.length);
    check('free: library has no chapter text or exercises', !r.text.includes(secondChapterSentence) && !r.text.includes('"sets"'));

    r = await get(base, '/api/premium/ebooks/' + ebook.id, 'freebie');
    body = JSON.parse(r.text);
    check('free: ebook is locked with a preview', r.status === 200 && body.locked === true && body.ebook.preview && body.ebook.preview.heading);
    check('free: ebook response leaks no later chapter text', !r.text.includes(secondChapterSentence) && !('chapters' in body.ebook && body.ebook.chapters.some(c => c.sections)));

    r = await get(base, '/api/premium/programs/' + program.id, 'freebie');
    body = JSON.parse(r.text);
    check('free: program is locked and carries metadata only', body.locked === true && body.program.title === program.title && !('weeks' in body.program) && !('days' in body.program));
    check('free: program response leaks no exercises', !r.text.includes(someExercise) || body.program.dayNames.some(n => n.includes(someExercise)));

    for (const who of ['payer', 'boss']) {
      r = await get(base, '/api/premium/library', who);
      body = JSON.parse(r.text);
      check(`${who}: library access is full`, body.access === 'full');
      r = await get(base, '/api/premium/ebooks/' + ebook.id, who);
      body = JSON.parse(r.text);
      check(`${who}: full ebook with every chapter`, body.locked === false && body.ebook.chapters.length === ebook.chapters.length && r.text.includes(secondChapterSentence.slice(0, 40)));
      r = await get(base, '/api/premium/programs/' + program.id, who);
      body = JSON.parse(r.text);
      check(`${who}: full program with every week`, body.locked === false && body.program.weeks.length === program.durationWeeks && body.program.days.length === program.days.length);
    }

    r = await get(base, '/api/premium/ebooks/nope', 'payer');
    check('unknown ebook is a 404', r.status === 404);
    r = await get(base, '/api/premium/programs/nope', 'freebie');
    check('unknown program is a 404 even for free users', r.status === 404);
    r = await get(base, '/api/premium/library', 'broken');
    check('plan lookup failure returns 503, not free or full content', r.status === 503 && !r.text.includes(ebook.title));
    r = await get(base, '/api/premium/library', 'stranger');
    check('unknown user is treated as free', JSON.parse(r.text).access === 'preview');
  } finally {
    server.close();
  }
  console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed');
  process.exit(failures ? 1 : 0);
})();
