// Copies the app's src/js/program-model.js over src/programs/model.js.
// The two must stay byte-identical (one model, two repos):
//
//   node scripts/sync-program-model.js ../TrainingLog-mobile/src/js/program-model.js
'use strict';

const fs = require('fs');
const path = require('path');

const source = process.argv[2];
if (!source) {
  console.error('Usage: node scripts/sync-program-model.js <path to TrainingLog-mobile/src/js/program-model.js>');
  process.exit(1);
}
const target = path.join(__dirname, '..', 'src', 'programs', 'model.js');
fs.copyFileSync(source, target);
console.log('Wrote', path.relative(process.cwd(), target));
