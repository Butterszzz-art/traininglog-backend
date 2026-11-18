// Coach guide progress: the "Get set up" checklist, the welcome sheet and the
// two tours (phone + computer) shown to a coach after they take the Coach plan.
// Stored on users/{uid}.coachGuide so the phone and the computer show the
// same progress. Marks are only ever added (a step once done stays done);
// `reset` clears the tours so "Replay" can start them again.
//
// Shape: { welcomeSeen, dismissed, steps: { [id]: ts }, tours: { phone, desktop } }
// All timestamps are ISO strings.

'use strict';

const STEP_IDS = ['code', 'client', 'program', 'macros', 'checkin', 'desktop'];
const TOUR_IDS = ['phone', 'desktop'];

function emptyGuide() {
  return { welcomeSeen: null, dismissed: null, steps: {}, tours: {} };
}

function isTs(v) {
  return typeof v === 'string' && v.length <= 40 && !Number.isNaN(Date.parse(v));
}

// Normalise whatever is stored (or nothing) into the public shape.
function readGuide(raw) {
  const out = emptyGuide();
  if (!raw || typeof raw !== 'object') return out;
  if (isTs(raw.welcomeSeen)) out.welcomeSeen = raw.welcomeSeen;
  if (isTs(raw.dismissed)) out.dismissed = raw.dismissed;
  for (const id of STEP_IDS) if (raw.steps && isTs(raw.steps[id])) out.steps[id] = raw.steps[id];
  for (const id of TOUR_IDS) if (raw.tours && isTs(raw.tours[id])) out.tours[id] = raw.tours[id];
  return out;
}

// Apply a client update to the stored guide. Body:
//   { steps?: string[], welcomeSeen?: true, tour?: 'phone'|'desktop',
//     dismissed?: boolean, replay?: 'phone'|'desktop' }
// Unknown ids are ignored. Returns { guide, changed }.
function applyUpdate(raw, body, now) {
  const guide = readGuide(raw);
  const ts = now || new Date().toISOString();
  const b = body && typeof body === 'object' ? body : {};
  let changed = false;

  if (Array.isArray(b.steps)) {
    for (const id of b.steps.slice(0, STEP_IDS.length * 2)) {
      if (STEP_IDS.includes(id) && !guide.steps[id]) { guide.steps[id] = ts; changed = true; }
    }
  }
  if (b.welcomeSeen === true && !guide.welcomeSeen) { guide.welcomeSeen = ts; changed = true; }
  if (TOUR_IDS.includes(b.tour) && !guide.tours[b.tour]) { guide.tours[b.tour] = ts; changed = true; }
  if (TOUR_IDS.includes(b.replay) && guide.tours[b.replay]) { delete guide.tours[b.replay]; changed = true; }
  if (b.dismissed === true && !guide.dismissed) { guide.dismissed = ts; changed = true; }
  if (b.dismissed === false && guide.dismissed) { guide.dismissed = null; changed = true; }

  return { guide, changed };
}

module.exports = { STEP_IDS, TOUR_IDS, readGuide, applyUpdate, emptyGuide };
