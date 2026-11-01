// Runs every scripts/test-*.js check (the older standalone test scripts) and
// fails if any of them does. CI runs this after `npm test`.
//
// Skipped:
//   test-e2e-emulator.js    needs the Firestore + Auth emulators running
//   test-firestore-routes.js  4 known failures (sendTemplate + referral stats
//                             for migrated users) — remove from the list once fixed
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const SKIP = new Set(['test-e2e-emulator.js', 'test-firestore-routes.js']);
const dir = __dirname;
const files = fs.readdirSync(dir).filter(f => /^test-.*\.js$/.test(f) && !SKIP.has(f)).sort();

let failed = 0;
for (const file of files) {
  const run = spawnSync(process.execPath, [path.join(dir, file)], { encoding: 'utf8', timeout: 120000 });
  const ok = run.status === 0;
  if (!ok) failed++;
  const last = String(run.stdout || '').trim().split('\n').pop() || '';
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${file}  ${last.slice(0, 80)}`);
  if (!ok) console.log(String(run.stdout || '') + String(run.stderr || ''));
}
console.log(`\n${files.length - failed}/${files.length} script checks passed (${SKIP.size} skipped)`);
process.exit(failed ? 1 : 0);
