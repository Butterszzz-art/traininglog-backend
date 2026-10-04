#!/usr/bin/env node
// Checks the rule registry against Butters University.
//
// Butters University is the GitHub repo Butterszzz-art/butters-university;
// its content is README.md. Every rule's `bu` block names a README section
// and quotes the sentences that back the rule. This script reads a README
// and reports, per rule, its BU status (match / partial / conflict / ...)
// and whether the section and each quote are still there.
//
//   node scripts/sync-butters-university.js <path/to/butters-university>
//   node scripts/sync-butters-university.js <path/to/README.md> --json
//   node scripts/sync-butters-university.js <path/to/butters-university> --pin
//
// --pin records the BU checkout's commit in rules/registry.json, and only
// does so when every quote was found. Exits 1 when a section or quote is
// missing (BU changed under a rule: re-read the section, update the rule's
// quotes, status and note, then pin again).
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { loadRegistry, RULES_DIR } = require('../src/rules/registry');
const { checkRegistry } = require('../src/rules/butters');

function usage(msg) {
  if (msg) console.error(msg);
  console.error('Usage: node scripts/sync-butters-university.js <butters-university dir or README.md> [--json] [--pin]');
  process.exit(2);
}

const args = process.argv.slice(2);
const flags = new Set(args.filter(a => a.startsWith('--')));
const target = args.find(a => !a.startsWith('--'));
if (!target) usage();
for (const f of flags) if (!['--json', '--pin'].includes(f)) usage(`Unknown option ${f}`);

const readmePath = fs.existsSync(target) && fs.statSync(target).isDirectory() ? path.join(target, 'README.md') : target;
if (!fs.existsSync(readmePath)) usage(`No README at ${readmePath}`);
const readme = fs.readFileSync(readmePath, 'utf8');

function headCommit(dir) {
  try {
    return execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

const loaded = loadRegistry();
const results = checkRegistry([...loaded.rules.values()], readme);
const commit = headCommit(path.dirname(path.resolve(readmePath)));
const pinned = loaded.butters?.commit || null;
const broken = results.filter(r => r.problem);

if (flags.has('--json')) {
  console.log(JSON.stringify({ pinned, checked: commit, results }, null, 2));
} else {
  const byStatus = {};
  for (const r of results) (byStatus[r.status || 'no BU reference'] ||= []).push(r);
  console.log(`Butters University ${commit ? commit.slice(0, 7) : '(not a git checkout)'} · registry pinned at ${pinned ? pinned.slice(0, 7) : 'nothing'}`);
  for (const status of ['conflict', 'partial', 'match', 'not_covered', 'unreviewed', 'no BU reference']) {
    const list = byStatus[status];
    if (!list) continue;
    console.log(`\n${status.toUpperCase()} (${list.length})`);
    for (const r of list) {
      const rule = loaded.rules.get(r.id);
      const at = r.line ? ` — ${r.section} (README:${r.line})` : '';
      console.log(`  ${r.problem ? '✗' : '·'} ${r.id}${at}`);
      if (r.problem) {
        console.log(`      ${r.problem}`);
        for (const q of r.missing) console.log(`      missing: "${q}"`);
      } else if (rule.bu?.note && ['conflict', 'partial'].includes(status)) {
        console.log(`      ${rule.bu.note}`);
      }
    }
  }
  console.log(broken.length ? `\n${broken.length} rule(s) no longer match the README.` : '\nEvery cited section and quote was found.');
}

if (flags.has('--pin')) {
  if (broken.length) {
    console.error('Not pinning: fix the rules above first.');
  } else if (!commit) {
    console.error('Not pinning: the README is not inside a git checkout, so there is no commit to record.');
    process.exitCode = 1;
  } else {
    const file = path.join(RULES_DIR, 'registry.json');
    const meta = JSON.parse(fs.readFileSync(file, 'utf8'));
    meta.buttersUniversity = { ...(meta.buttersUniversity || {}), commit };
    const text = JSON.stringify(meta, null, 2).replace(/"files": \[\s*([^\]]*?)\s*\]/, (_, l) => `"files": [${l.split(/,\s*/).join(', ')}]`);
    fs.writeFileSync(file, `${text}\n`);
    console.log(`Pinned Butters University ${commit.slice(0, 7)} in rules/registry.json.`);
  }
}

if (broken.length) process.exitCode = 1;
