// Regenerates src/intakeCalculations.js from ClientIntake's calculations.js.
//
// ClientIntake (github.com/Butterszzz-art/ClientIntake) is the source of
// truth for the intake calculations (BMR, energy, macros, Henselmans volume,
// 1RM, injury conflicts, red flags). This backend must compute exactly the
// same numbers, so instead of a hand-maintained port it carries a generated
// CommonJS copy. Never edit src/intakeCalculations.js by hand: change
// ClientIntake, then run
//
//   node scripts/sync-intake-calculations.js ../ClientIntake/calculations.js
//
// and commit the result together with refreshed fixtures
// (node scripts/test-intake-calculations.js --update, run from a checkout
// whose ClientIntake change has been reviewed).
'use strict';

const fs = require('fs');
const path = require('path');

const source = process.argv[2];
if (!source) {
  console.error('Usage: node scripts/sync-intake-calculations.js <path to ClientIntake/calculations.js>');
  process.exit(1);
}

const esm = fs.readFileSync(source, 'utf8');
if (/^\s*import\s/m.test(esm)) {
  console.error('calculations.js has imports; this converter only handles a self-contained module.');
  process.exit(1);
}

const names = [];
const body = esm.replace(/^export (const|function|async function|let) ([A-Za-z_$][\w$]*)/gm, (_m, kind, name) => {
  names.push(name);
  return `${kind} ${name}`;
});
if (/^export\s/m.test(body)) {
  console.error('Unsupported export form left in calculations.js (only `export const|function|let` is handled).');
  process.exit(1);
}

const header = `// GENERATED from ClientIntake/calculations.js by
// scripts/sync-intake-calculations.js — do not edit by hand.
// ClientIntake is the source of truth for these calculations.

`;
const footer = `\nmodule.exports = {\n${names.map(n => `  ${n},`).join('\n')}\n};\n`;
const out = path.join(__dirname, '..', 'src', 'intakeCalculations.js');
fs.writeFileSync(out, header + body.trimEnd() + '\n' + footer);
console.log(`Wrote ${path.relative(process.cwd(), out)} (${names.length} exports)`);
