// Butters University connector.
//
// Butters University is a GitHub repo (Butterszzz-art/butters-university)
// whose content lives in README.md. Each rule points at the BU section it
// rests on and quotes the sentences that back it (`rule.bu`); registry.json
// pins the BU commit those quotes were read at. checkRegistry() re-reads a
// README and reports, per rule, whether the section and every quote are
// still there, so an edit to BU that drops or rewords a backing sentence
// shows up as drift instead of silently leaving the rule unsupported.
'use strict';

const BU_STATUSES = new Set(['match', 'partial', 'conflict', 'not_covered', 'unreviewed']);

// Compare text the way a reader would: ignore markdown escapes and emphasis,
// dash and quote styles, and whitespace.
function normalize(text) {
  return String(text)
    .replace(/\\([~*_`#\[\]()-])/g, '$1')
    .replace(/\*\*|__/g, '')
    .replace(/[‐-―−]/g, '-')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

// Headings in README order: { level, title, line, end } where `end` is the
// line before the next heading of the same or a higher level.
function sections(readme) {
  const lines = readme.split('\n');
  const heads = [];
  let fence = false;
  lines.forEach((l, i) => {
    if (/^\s*```/.test(l)) fence = !fence;
    const m = !fence && /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(l);
    if (m) heads.push({ level: m[1].length, title: m[2], line: i + 1 });
  });
  heads.forEach((h, i) => {
    const next = heads.slice(i + 1).find(n => n.level <= h.level);
    h.end = next ? next.line - 1 : lines.length;
  });
  return { lines, heads };
}

function findSection(parsed, title) {
  const want = normalize(title);
  return parsed.heads.find(h => normalize(h.title) === want) || null;
}

// The README line a quote starts on, or null. Quotes may span lines.
function findQuote(parsed, section, quote) {
  const want = normalize(quote);
  const body = parsed.lines.slice(section.line - 1, section.end);
  const joined = normalize(body.join('\n'));
  if (!joined.includes(want)) return null;
  for (let i = 0; i < body.length; i++) {
    if (normalize(body.slice(i).join('\n')).indexOf(want) === -1) return section.line + i - 1;
  }
  return section.line + body.length - 1;
}

function validateBu(rule) {
  const bu = rule.bu;
  const where = rule.id;
  if (bu === undefined || bu === null) return [];
  const errors = [];
  if (typeof bu !== 'object') return [`${where}: bu must be an object`];
  if (typeof bu.section !== 'string' || !bu.section.trim()) errors.push(`${where}: bu.section is required`);
  if (!BU_STATUSES.has(bu.status)) errors.push(`${where}: bu.status must be one of ${[...BU_STATUSES].join(', ')}`);
  if (!Array.isArray(bu.quotes) || bu.quotes.some(q => typeof q !== 'string' || !q.trim())) {
    errors.push(`${where}: bu.quotes must be an array of strings`);
  } else if (['match', 'partial', 'conflict'].includes(bu.status) && !bu.quotes.length) {
    errors.push(`${where}: a "${bu.status}" rule needs at least one quote from Butters University`);
  }
  if (bu.note !== undefined && typeof bu.note !== 'string') errors.push(`${where}: bu.note must be a string`);
  return errors;
}

// One result per rule: { id, status, section, line, missing[], problem }.
// `problem` is null when the section and all quotes were found, or the rule
// has no BU reference (package rules are business decisions, not evidence).
function checkRegistry(rules, readme) {
  const parsed = sections(readme);
  return rules.map(rule => {
    const bu = rule.bu;
    if (!bu) return { id: rule.id, status: null, section: null, line: null, missing: [], problem: null };
    const sec = findSection(parsed, bu.section);
    if (!sec) return { id: rule.id, status: bu.status, section: bu.section, line: null, missing: bu.quotes, problem: 'section not found' };
    const found = bu.quotes.map(q => ({ q, line: findQuote(parsed, sec, q) }));
    const missing = found.filter(f => f.line === null).map(f => f.q);
    return {
      id: rule.id,
      status: bu.status,
      section: bu.section,
      line: sec.line,
      quoteLines: found.map(f => f.line),
      missing,
      problem: missing.length ? `${missing.length} quote(s) not found` : null,
    };
  });
}

// Rule ids grouped by BU status, for a plan's review summary. Rules with
// role "comparison" (Menno Henselmans' formulas) never set a plan number:
// they are listed apart and do not count as BU conflicts.
function summarize(rules) {
  const out = { match: [], partial: [], conflict: [], not_covered: [], unreviewed: [], comparison: [] };
  for (const r of rules) {
    if (r.role === 'comparison') out.comparison.push(r.id);
    else if (r.bu) out[r.bu.status].push(r.id);
  }
  return out;
}

module.exports = { BU_STATUSES, normalize, sections, findSection, findQuote, validateBu, checkRegistry, summarize };
