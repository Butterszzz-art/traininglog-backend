// Premium content: the training/nutrition ebooks and the ready-made program
// library. The content lives in content/premium/**/*.json inside this repo (it
// ships with the function) and is only ever sent to Pro/Coach accounts. Free
// accounts get titles, summaries and a short preview so the app can show an
// upgrade prompt, but never the chapters or the week-by-week programs.
//
// Mounted behind authenticateToken in server.js, which passes in getPlanInfo
// so the plan check uses the same source of truth as GET /api/user/plan.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');

const CONTENT_DIR = path.join(__dirname, '..', '..', 'content', 'premium');
const PAID_PLANS = new Set(['pro', 'coach']);

let cache = null;

function readDir(sub) {
  const dir = path.join(CONTENT_DIR, sub);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      const raw = fs.readFileSync(path.join(dir, f), 'utf8');
      const doc = JSON.parse(raw);
      // rev lets the app cache the content and re-fetch only when it changes
      doc.rev = crypto.createHash('sha1').update(raw).digest('hex').slice(0, 10);
      return doc;
    })
    .sort((a, b) => (a.order || 99) - (b.order || 99) || String(a.title).localeCompare(String(b.title)));
}

function loadContent() {
  if (cache) return cache;
  const ebooks = readDir('ebooks');
  const programs = readDir('programs').map(p => {
    // days mirrors week 1 so the app's single-week screens keep working
    const first = Array.isArray(p.weeks) && p.weeks.find(w => Array.isArray(w.days));
    return first ? { ...p, days: first.days } : p;
  });
  cache = {
    ebooks,
    programs,
    ebookById: new Map(ebooks.map(e => [e.id, e])),
    programById: new Map(programs.map(p => [p.id, p])),
  };
  return cache;
}

function ebookMeta(e) {
  const chapters = e.chapters || [];
  return {
    id: e.id,
    kind: 'ebook',
    title: e.title,
    subtitle: e.subtitle || '',
    topic: e.topic || '',
    summary: e.summary || '',
    rev: e.rev,
    chapterCount: chapters.length,
    sectionCount: chapters.reduce((n, c) => n + (c.sections || []).length, 0),
    chapters: chapters.map(c => ({ id: c.id, title: c.title, sectionCount: (c.sections || []).length })),
  };
}

function programMeta(p) {
  const dayNames = (p.days || []).map(d => d.name);
  return {
    id: p.id,
    kind: 'program',
    title: p.title,
    subtitle: p.subtitle || '',
    audience: p.audience || 'all',
    goal: p.goal || '',
    level: p.level || 'all',
    summary: p.summary || '',
    rev: p.rev,
    durationWeeks: p.durationWeeks || (p.weeks ? p.weeks.length : 1),
    daysPerWeek: (p.split && p.split.daysPerWeek) || dayNames.length,
    split: p.split || null,
    dayNames,
  };
}

// The first section of the first chapter, so free users can sample the writing.
function ebookPreview(e) {
  const chapter = (e.chapters || [])[0];
  const section = chapter && (chapter.sections || [])[0];
  if (!section) return null;
  return { chapterTitle: chapter.title, heading: section.heading, body: section.body };
}

function createPremiumRouter({ getPlanInfo, sendError }) {
  const router = express.Router();

  async function accessFor(req, res) {
    try {
      const info = await getPlanInfo(req.user && req.user.username);
      return { plan: info.plan || 'free', paid: PAID_PLANS.has(info.plan) };
    } catch (err) {
      console.error('[premium] plan lookup failed:', err.message);
      sendError(res, 503, 'premium.plan_lookup_failed', 'Could not verify your plan. Please try again.');
      return null;
    }
  }

  router.use((req, res, next) => {
    res.set('Cache-Control', 'private, no-store');
    next();
  });

  // GET /api/premium/library: everything on the shelf, as metadata.
  router.get('/library', async (req, res) => {
    const access = await accessFor(req, res);
    if (!access) return;
    const { ebooks, programs } = loadContent();
    res.json({
      success: true,
      access: access.paid ? 'full' : 'preview',
      plan: access.plan,
      ebooks: ebooks.map(ebookMeta),
      programs: programs.map(programMeta),
    });
  });

  // GET /api/premium/ebooks/:id: full chapters for paid users, a preview otherwise.
  router.get('/ebooks/:id', async (req, res) => {
    const access = await accessFor(req, res);
    if (!access) return;
    const ebook = loadContent().ebookById.get(req.params.id);
    if (!ebook) return sendError(res, 404, 'premium.not_found', 'That ebook does not exist.');
    if (!access.paid) {
      return res.json({ success: true, locked: true, ebook: { ...ebookMeta(ebook), preview: ebookPreview(ebook) } });
    }
    return res.json({ success: true, locked: false, ebook });
  });

  // GET /api/premium/programs/:id: full weeks for paid users, metadata otherwise.
  router.get('/programs/:id', async (req, res) => {
    const access = await accessFor(req, res);
    if (!access) return;
    const program = loadContent().programById.get(req.params.id);
    if (!program) return sendError(res, 404, 'premium.not_found', 'That program does not exist.');
    if (!access.paid) {
      return res.json({ success: true, locked: true, program: programMeta(program) });
    }
    return res.json({ success: true, locked: false, program });
  });

  return router;
}

module.exports = { createPremiumRouter, loadContent, _resetCache: () => { cache = null; } };
