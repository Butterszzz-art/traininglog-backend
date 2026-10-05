/* =============================================================
   Program import — turn a coach's own program file (Excel, Word,
   PDF, CSV, a photo) into a Pocket Coach program.

   1. readImportFile() works out what the file is and turns it into
      Messages API content: PDFs and photos go to Claude as they are;
      .xlsx / .docx are unzipped here (Node's zlib, no dependency) and
      sent as plain text tables.
   2. Claude fills IMPORT_SCHEMA (structured outputs) — see
      POST /api/ai/coach/import-program in src/routes/coach.js.
   3. toProgramDoc() turns that into the same program document the
      Library serves, so the phone imports it with
      programBuilderV2Core.importLibraryProgram().
   ============================================================= */

'use strict';

const zlib = require('zlib');

const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_TEXT_CHARS = 200000;
const MAX_UNZIPPED_BYTES = 40 * 1024 * 1024;
const MAX_WEEKS = 16;
const MAX_SETS_PER_GROUP = 15;

class ImportError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'ImportError';
    this.code = code;
    this.status = status;
  }
}

// ── zip (xlsx / docx are zip files of XML) ──────────────────────────────────

/** Map of entry name → reader() for a zip buffer. Stored and deflated entries only. */
function readZip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd === -1) throw new ImportError('unreadable', 'That file looks damaged. Try saving it again, or export it as a PDF.');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries = new Map();
  let budget = MAX_UNZIPPED_BYTES;
  for (let n = 0; n < count && p + 46 <= buf.length; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    entries.set(name, () => {
      if (local + 30 > buf.length || buf.readUInt32LE(local) !== 0x04034b50) return '';
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      const raw = buf.subarray(start, start + compSize);
      let out;
      if (method === 0) out = raw;
      else if (method === 8) {
        try { out = zlib.inflateRawSync(raw, { maxOutputLength: budget }); } catch {
          throw new ImportError('too_large', 'That file is too big to import. Import one month at a time.', 413);
        }
      } else return '';
      budget -= out.length;
      return out.toString('utf8');
    });
  }
  return entries;
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function decodeXml(s) {
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e] !== undefined ? ENTITIES[e] : m;
  });
}

const attr = (tag, name) => {
  const m = new RegExp(`\\s${name}="([^"]*)"`).exec(tag);
  return m ? decodeXml(m[1]) : null;
};
const textRuns = (xml, tag) => {
  const out = [];
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'g');
  let m;
  while ((m = re.exec(xml))) out.push(decodeXml(m[1]));
  return out.join('');
};

// "B12" → { col: 1, row: 11 }
function cellRef(ref) {
  const m = /^([A-Z]+)(\d+)$/.exec(ref || '');
  if (!m) return null;
  let col = 0;
  for (const ch of m[1]) col = col * 26 + (ch.charCodeAt(0) - 64);
  return { col: col - 1, row: Number(m[2]) - 1 };
}
const colName = c => { let s = ''; c += 1; while (c > 0) { const r = (c - 1) % 26; s = String.fromCharCode(65 + r) + s; c = Math.floor((c - 1) / 26); } return s; };

/** Every sheet of an .xlsx as a text table: one line per row, cells tab-separated. */
function xlsxToText(zip) {
  const read = name => (zip.get(name) ? zip.get(name)() : '');
  const workbook = read('xl/workbook.xml');
  if (!workbook) throw new ImportError('unsupported', "That doesn't look like an Excel workbook. Export it as .xlsx or PDF and try again.");

  const rels = {};
  (read('xl/_rels/workbook.xml.rels').match(/<Relationship\b[^>]*>/g) || []).forEach(tag => {
    const target = attr(tag, 'Target') || '';
    rels[attr(tag, 'Id')] = target.startsWith('/') ? target.slice(1) : 'xl/' + target.replace(/^\.\//, '');
  });
  const shared = (read('xl/sharedStrings.xml').match(/<si>[\s\S]*?<\/si>/g) || [])
    .map(si => textRuns(si.replace(/<rPh\b[\s\S]*?<\/rPh>/g, ''), 't'));

  const parts = [];
  (workbook.match(/<sheet\b[^>]*>/g) || []).forEach(tag => {
    if (attr(tag, 'state') === 'hidden' || attr(tag, 'state') === 'veryHidden') return;
    const xml = read(rels[attr(tag, 'r:id')] || '');
    if (!xml) return;
    const grid = [];
    const put = (row, col, value) => { (grid[row] = grid[row] || [])[col] = value; };
    (xml.match(/<c\b[^>]*?(?:\/>|>[\s\S]*?<\/c>)/g) || []).forEach(cell => {
      const open = /^<c\b[^>]*>/.exec(cell)[0];
      const at = cellRef(attr(open, 'r'));
      if (!at) return;
      const type = attr(open, 't');
      const v = /<v>([\s\S]*?)<\/v>/.exec(cell);
      let value = '';
      if (type === 's') value = v ? shared[Number(v[1])] || '' : '';
      else if (type === 'inlineStr') value = textRuns(cell, 't');
      else if (type === 'b') value = v ? (v[1] === '1' ? 'TRUE' : 'FALSE') : '';
      else value = v ? decodeXml(v[1]) : '';
      value = value.replace(/\s+/g, ' ').trim();
      if (value) put(at.row, at.col, value);
    });
    // A merged header ("Week 1" across four columns) applies to every cell it covers.
    (xml.match(/<mergeCell\b[^>]*>/g) || []).forEach(m => {
      const [a, b] = String(attr(m, 'ref') || '').split(':').map(cellRef);
      if (!a || !b || (b.row - a.row + 1) * (b.col - a.col + 1) > 400) return;
      const value = grid[a.row] && grid[a.row][a.col];
      if (!value) return;
      for (let r = a.row; r <= b.row; r++) for (let c = a.col; c <= b.col; c++) put(r, c, value);
    });
    const lines = [];
    grid.forEach((cells, r) => {
      if (!cells || !cells.some(Boolean)) return;
      const first = cells.findIndex(Boolean);
      lines.push(`${r + 1}\t${colName(first)}: ` + Array.from(cells.slice(first), x => x || '').join('\t'));
    });
    if (lines.length) parts.push(`## Sheet "${attr(tag, 'name') || 'Sheet'}" (each line: row number, first filled column, then tab-separated cells)\n` + lines.join('\n'));
  });
  if (!parts.length) throw new ImportError('empty', 'That workbook has no filled cells.');
  return parts.join('\n\n');
}

/** A .docx as text: paragraphs as lines, table rows as tab-separated cells. */
function docxToText(zip) {
  const xml = zip.get('word/document.xml') ? zip.get('word/document.xml')() : '';
  if (!xml) throw new ImportError('unsupported', "That doesn't look like a Word document. Export it as a PDF and try again.");
  const para = p => textRuns(p.replace(/<w:tab\/>/g, '<w:t>\t</w:t>').replace(/<w:br\/>/g, '<w:t>\n</w:t>'), 'w:t');
  const out = [];
  const body = xml.replace(/<w:tbl>[\s\S]*?<\/w:tbl>/g, tbl => {
    const rows = (tbl.match(/<w:tr\b[\s\S]*?<\/w:tr>/g) || []).map(tr =>
      (tr.match(/<w:tc>[\s\S]*?<\/w:tc>/g) || []).map(tc => (tc.match(/<w:p\b[\s\S]*?<\/w:p>/g) || []).map(para).join(' ').trim()).join('\t'));
    return `<w:p><w:t>${rows.join('\n').replace(/[<&]/g, c => (c === '<' ? '&lt;' : '&amp;'))}</w:t></w:p>`;
  });
  (body.match(/<w:p\b[\s\S]*?<\/w:p>/g) || []).forEach(p => {
    const line = para(p);
    if (line.trim()) out.push(line);
  });
  if (!out.length) throw new ImportError('empty', 'That document has no text.');
  return out.join('\n');
}

// ── file → Messages API content ─────────────────────────────────────────────

function sniff(buf, fileName) {
  const ext = (/\.([a-z0-9]+)$/i.exec(fileName || '') || [])[1];
  const lower = ext ? ext.toLowerCase() : '';
  if (buf.subarray(0, 5).toString('latin1') === '%PDF-') return 'pdf';
  if (buf[0] === 0x89 && buf.subarray(1, 4).toString('latin1') === 'PNG') return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (buf.subarray(0, 4).toString('latin1') === 'GIF8') return 'image/gif';
  if (buf[0] === 0x50 && buf[1] === 0x4b) return 'zip';
  if (buf[0] === 0xd0 && buf[1] === 0xcf) return 'legacy-office';
  if (['csv', 'tsv', 'txt', 'md'].includes(lower) && !buf.subarray(0, 4096).includes(0)) return 'text';
  return null;
}

/**
 * Validate an uploaded file ({ fileName, data: base64 }) and build the user
 * content for the import request. Throws ImportError for anything unusable.
 */
function readImportFile({ fileName, data } = {}) {
  if (typeof data !== 'string' || !data) throw new ImportError('missing_file', 'Choose a file to import.');
  const name = typeof fileName === 'string' ? fileName.slice(0, 200) : 'program';
  const buf = Buffer.from(data, 'base64');
  if (!buf.length) throw new ImportError('missing_file', 'That file is empty.');
  if (buf.length > MAX_FILE_BYTES) throw new ImportError('too_large', 'That file is over 8 MB. Import one month at a time.', 413);

  const kind = sniff(buf, name);
  let text = null;
  if (kind === 'pdf') {
    return { kind, content: [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: buf.toString('base64') } }] };
  }
  if (kind && kind.startsWith('image/')) {
    return { kind: 'image', content: [{ type: 'image', source: { type: 'base64', media_type: kind, data: buf.toString('base64') } }] };
  }
  if (kind === 'zip') {
    const zip = readZip(buf);
    if (zip.has('xl/workbook.xml')) text = xlsxToText(zip);
    else if (zip.has('word/document.xml')) text = docxToText(zip);
    else throw new ImportError('unsupported', 'That file type is not supported. Use Excel (.xlsx), Word (.docx), PDF, CSV or a photo.');
  } else if (kind === 'legacy-office') {
    throw new ImportError('unsupported', 'Old .xls / .doc files are not supported. Save it as .xlsx / .docx (or PDF) and try again.');
  } else if (kind === 'text') {
    text = buf.toString('utf8').replace(/^﻿/, '');
  } else {
    throw new ImportError('unsupported', 'That file type is not supported. Use Excel (.xlsx), Word (.docx), PDF, CSV or a photo.');
  }
  if (!text.trim()) throw new ImportError('empty', 'That file has no text in it.');
  if (text.length > MAX_TEXT_CHARS) throw new ImportError('too_large', 'That file is too long to import in one go. Import one month at a time.', 413);
  return { kind: 'text', content: [{ type: 'text', text: `File: ${name}\n\n${text}` }] };
}

// ── what Claude fills in ────────────────────────────────────────────────────

const TECHNIQUES = ['RP', 'P', 'S', 'TUT'];
const SET_TYPES = ['straight', 'warmup', 'backoff', 'drop', 'amrap'];
const GOALS = ['hypertrophy', 'strength', 'fat-loss', 'general'];

const nullable = type => ({ anyOf: [{ type }, { type: 'null' }] });

const IMPORT_SCHEMA = {
  type: 'object',
  properties: {
    isProgram: { type: 'boolean' },
    title: { type: 'string' },
    goal: { type: 'string', enum: GOALS },
    daysPerWeek: { type: 'integer' },
    weekdays: { type: 'array', items: { type: 'integer' } },
    progressionNotes: { type: 'string' },
    weeks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          week: { type: 'integer' },
          phase: { type: 'string' },
          sameAsWeek: nullable('integer'),
          days: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                notes: { type: 'string' },
                exercises: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      name: { type: 'string' },
                      notes: { type: 'string' },
                      techniques: { type: 'array', items: { type: 'string', enum: TECHNIQUES } },
                      supersetGroup: { type: 'string' },
                      setGroups: {
                        type: 'array',
                        items: {
                          type: 'object',
                          properties: {
                            sets: { type: 'integer' },
                            setType: { type: 'string', enum: SET_TYPES },
                            reps: nullable('integer'),
                            repsMax: nullable('integer'),
                            weightKg: nullable('number'),
                            load: { type: 'string' },
                            rpe: nullable('number'),
                            rir: nullable('number'),
                            restSec: nullable('integer'),
                          },
                          required: ['sets', 'setType', 'reps', 'repsMax', 'weightKg', 'load', 'rpe', 'rir', 'restSec'],
                          additionalProperties: false,
                        },
                      },
                    },
                    required: ['name', 'notes', 'techniques', 'supersetGroup', 'setGroups'],
                    additionalProperties: false,
                  },
                },
              },
              required: ['name', 'notes', 'exercises'],
              additionalProperties: false,
            },
          },
        },
        required: ['week', 'phase', 'sameAsWeek', 'days'],
        additionalProperties: false,
      },
    },
    warnings: { type: 'array', items: { type: 'string' } },
  },
  required: ['isProgram', 'title', 'goal', 'daysPerWeek', 'weekdays', 'progressionNotes', 'weeks', 'warnings'],
  additionalProperties: false,
};

const IMPORT_INSTRUCTIONS = `You convert a strength coach's training program into Pocket Coach's program format. The program arrives as a file the coach made elsewhere: an Excel sheet (given as text tables), a Word document, a PDF, or a photo.

Copy the program faithfully. Do not add, remove, reorder or "improve" anything; the coach wrote it on purpose. When something is ambiguous, take the most likely reading and add a short warning saying what you assumed.

How to fill the fields:
- isProgram: false if the file is not a training program at all; then leave weeks empty and say why in warnings.
- title: the program's name from the file, or a short descriptive one ("4-Week Upper/Lower").
- goal: the closest of hypertrophy, strength, fat-loss, general.
- daysPerWeek: training days in a normal week.
- weekdays: ISO weekdays (1 = Monday … 7 = Sunday) only when the file names them (e.g. "Monday: Push"); otherwise [].
- progressionNotes: the coach's progression, deload and general instructions, in their words, condensed.
- weeks: one entry per program week, numbered from 1. A program with no week structure is one week. When the file prescribes different numbers per week (e.g. columns "Wk1 Wk2 Wk3 Wk4" or "Week 1: 3x10, Week 2: 4x8"), write each week out. If a week is identical to an earlier one, set sameAsWeek to that week's number and leave its days empty; otherwise sameAsWeek is null. phase is a short label from the file ("Accumulation", "Deload") or "".
- days: in the file's order, named as the coach names them ("Push A", "Day 1 - Lower").
- exercises: name each exercise with its standard full name, expanding abbreviations ("BB bench" → "Barbell Bench Press", "RDL" → "Romanian Deadlift", "DB" → "Dumbbell"). Keep the coach's exercise choice exactly. Put cues, tempo, and anything that has no field into notes.
- supersetGroup: the same letter (e.g. "A") on exercises the coach pairs as a superset or giant set (often labelled A1/A2); otherwise "".
- techniques: RP = rest-pause or myo-reps, P = partials / lengthened partials, S = intra-set stretch, TUT = time under tension / slow tempo. Only when the coach prescribes them.
- setGroups: consecutive sets with the same prescription. "3x8-10" → one group {sets 3, reps 8, repsMax 10}. "1x5 then 3x8 backoff" → two groups. A top set then back-off sets → setType backoff for the back-offs. Warm-up sets the coach lists → setType warmup. AMRAP → setType amrap with reps as the target minimum (or null). Drop sets → setType drop.
  - reps / repsMax: a fixed number → reps, repsMax null. A range → both. Time-based sets ("30s", "1 min") → reps null and the time in load.
  - weightKg: only when the file gives an absolute load in kg; convert lb to kg (× 0.4536, one decimal). Otherwise null.
  - load: the load exactly as written ("75% 1RM", "60kg", "RPE 8 top set", "bodyweight", "30s"), or "".
  - rpe / rir: when prescribed. "@8" next to sets is usually RPE. In spreadsheets a value like 0.75 in a %1RM column means 75%.
  - restSec: rest in seconds when given ("2-3 min" → 150), otherwise null.
- warnings: short notes for the coach to check (max 8), e.g. "Week 3 Day 2 had no rep count for Leg Press; set to null." Do not repeat information that is already in the program.`;

// ── Claude's answer → a Library-shaped program document ─────────────────────

const str = (v, max) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');
const num = (v, lo, hi) => (typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? v : null);
const int = (v, lo, hi) => { const n = num(v, lo, hi); return n === null ? null : Math.round(n); };
const slug = s => str(s, 60).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'program';

function toSets(groups) {
  const sets = [];
  (Array.isArray(groups) ? groups : []).forEach(g => {
    if (!g || typeof g !== 'object') return;
    const count = Math.min(int(g.sets, 1, 100) || 1, MAX_SETS_PER_GROUP);
    const reps = int(g.reps, 0, 1000);
    const repsMax = int(g.repsMax, 0, 1000);
    const rest = int(g.restSec, 0, 3600);
    const set = {
      setType: SET_TYPES.includes(g.setType) ? g.setType : 'straight',
      reps,
      weight: num(g.weightKg, 0, 1000),
      rpe: num(g.rpe, 1, 10),
      rir: num(g.rir, 0, 10),
      restSec: rest === null ? 120 : rest,
    };
    if (reps !== null && repsMax !== null && repsMax > reps) set.repsMax = repsMax;
    for (let i = 0; i < count; i++) sets.push({ ...set });
  });
  return sets;
}

// Load text worth keeping that the set fields don't already say.
function loadNote(groups) {
  const notes = [];
  (Array.isArray(groups) ? groups : []).forEach(g => {
    const load = str(g && g.load, 60);
    if (!load || (num(g.weightKg, 0, 1000) !== null && /^\d+(\.\d+)?\s*kgs?$/i.test(load))) return;
    if (!notes.includes(load)) notes.push(load);
  });
  return notes.length ? 'Load: ' + notes.join(' / ') : '';
}

function toDays(days, weekNo) {
  return (Array.isArray(days) ? days : []).slice(0, 7).map((day, d) => {
    const dayId = `w${weekNo}-d${d + 1}`;
    return {
      dayId,
      name: str(day && day.name, 60) || `Day ${d + 1}`,
      notes: str(day && day.notes, 500),
      exercises: (Array.isArray(day && day.exercises) ? day.exercises : []).slice(0, 30).map((ex, e) => {
        const name = str(ex && ex.name, 80) || `Exercise ${e + 1}`;
        const sets = toSets(ex && ex.setGroups);
        const out = {
          exerciseId: `${dayId}-${e + 1}-${slug(name)}`,
          name,
          notes: [str(ex && ex.notes, 400), loadNote(ex && ex.setGroups)].filter(Boolean).join(' · '),
          sets: sets.length ? sets : [{ setType: 'straight', reps: null, weight: null, rpe: null, rir: null, restSec: 120 }],
        };
        const tech = (Array.isArray(ex && ex.techniques) ? ex.techniques : []).filter(t => TECHNIQUES.includes(t));
        if (tech.length) out.techniques = [...new Set(tech)];
        const group = str(ex && ex.supersetGroup, 4);
        if (group) out.supersetGroup = group;
        return out;
      }),
    };
  }).filter(day => day.exercises.length);
}

// Days compared without their ids, to spot repeated weeks.
const daysKey = days => JSON.stringify(days.map(d => ({ n: d.name, x: d.notes, e: d.exercises.map(({ exerciseId, ...rest }) => rest) })));

/**
 * Turn Claude's IMPORT_SCHEMA object into a program document in the Library's
 * shape ({ id, title, weeks: [{ week, days | sameAs }], ... }).
 * Returns { program, warnings } or null when there is no usable program.
 */
function toProgramDoc(obj, fileName) {
  if (!obj || typeof obj !== 'object' || obj.isProgram === false) return null;
  const warnings = (Array.isArray(obj.warnings) ? obj.warnings : []).map(w => str(w, 200)).filter(Boolean).slice(0, 8);
  const source = (Array.isArray(obj.weeks) ? obj.weeks : []).filter(w => w && typeof w === 'object');
  if (source.length > MAX_WEEKS) warnings.push(`Only the first ${MAX_WEEKS} weeks were imported.`);

  const weeks = [];
  const keys = new Map(); // week number → days key, for real weeks
  source.slice(0, MAX_WEEKS).forEach((w, i) => {
    const week = i + 1;
    const phase = str(w.phase, 40);
    const label = `Week ${week}`;
    const target = int(w.sameAsWeek, 1, week - 1);
    if (target && keys.has(target)) { weeks.push({ week, label, phase, sameAs: target }); return; }
    const days = toDays(w.days, week);
    if (!days.length) {
      // An empty week can only mean "same as before"; point at the last real one.
      const last = [...keys.keys()].pop();
      if (last) weeks.push({ week, label, phase, sameAs: last });
      return;
    }
    const key = daysKey(days);
    const twin = [...keys.entries()].find(([, k]) => k === key);
    if (twin) { weeks.push({ week, label, phase, sameAs: twin[0] }); return; }
    keys.set(week, key);
    weeks.push({ week, label, phase, days });
  });
  if (!keys.size) return null;

  const firstDays = weeks.find(w => w.days).days;
  const title = str(obj.title, 80) || str(String(fileName || '').replace(/\.[^.]+$/, ''), 80) || 'Imported program';
  const weekdays = [...new Set((Array.isArray(obj.weekdays) ? obj.weekdays : []).map(d => int(d, 1, 7)).filter(Boolean))]
    .sort((a, b) => a - b);
  const program = {
    id: `import-${slug(title)}`,
    kind: 'program',
    title,
    goal: GOALS.includes(obj.goal) ? obj.goal : 'general',
    archetype: 'general',
    split: { type: 'custom', name: '', daysPerWeek: int(obj.daysPerWeek, 1, 7) || firstDays.length },
    schedule: { startDate: '', weekdays: weekdays.length === firstDays.length ? weekdays : [] },
    progressionNotes: typeof obj.progressionNotes === 'string' ? obj.progressionNotes.trim().slice(0, 2000) : '',
    durationWeeks: weeks.length,
    weeks,
  };
  return { program, warnings };
}

module.exports = {
  ImportError, readImportFile, readZip, xlsxToText, docxToText,
  IMPORT_SCHEMA, IMPORT_INSTRUCTIONS, toProgramDoc, MAX_FILE_BYTES,
};
