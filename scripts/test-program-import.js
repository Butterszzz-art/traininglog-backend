// Tests for program import: src/coach/programImport.js and
// POST /api/ai/coach/import-program. Real .xlsx / .docx zips are built here;
// the Anthropic client's beta.messages.stream is a scripted fake, so no
// network and no API key are needed.
//
// Run: node scripts/test-program-import.js
const assert = require('assert');
const zlib = require('zlib');
const express = require('express');

process.env.ANTHROPIC_API_KEY = 'test';
delete process.env.COACH_MODEL;
delete process.env.COACH_IMPORT_MODEL;

const coachClient = require('../src/coach/client');
const imp = require('../src/coach/programImport');
const { router: aiRouter } = require('../src/routes/ai');

// ── a minimal zip writer (the reader ignores CRCs) ──────────────────────────

function zip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  Object.entries(files).forEach(([name, text]) => {
    const raw = Buffer.from(text, 'utf8');
    const data = zlib.deflateRawSync(raw);
    const nameBuf = Buffer.from(name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, data);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  });
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

// A coach-style sheet: merged "Week 1" / "Week 2" headers, shared and inline strings.
const XLSX = zip({
  'xl/workbook.xml': '<workbook><sheets><sheet name="Block 1" sheetId="1" r:id="rId1"/><sheet name="Old" sheetId="2" state="hidden" r:id="rId2"/></sheets></workbook>',
  'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Type="ws" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="ws" Target="worksheets/sheet2.xml"/></Relationships>',
  'xl/sharedStrings.xml': '<sst><si><t>Exercise</t></si><si><t>Week 1</t></si><si><t>Week 2</t></si><si><r><t>BB </t></r><r><t>Bench &amp; Pause</t></r></si><si><t>3x8</t></si></sst>',
  'xl/worksheets/sheet1.xml': '<worksheet><sheetData>'
    + '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="D1" t="s"><v>2</v></c></row>'
    + '<row r="2"><c r="A2" t="s"><v>3</v></c><c r="B2" t="s"><v>4</v></c><c r="C2"><v>60</v></c><c r="D2" t="inlineStr"><is><t>3x6</t></is></c><c r="E2"><v>0.75</v></c></row>'
    + '</sheetData><mergeCells count="2"><mergeCell ref="B1:C1"/><mergeCell ref="D1:E1"/></mergeCells></worksheet>',
  'xl/worksheets/sheet2.xml': '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>SECRET</t></is></c></row></sheetData></worksheet>',
});

const DOCX = zip({
  'word/document.xml': '<w:document><w:body>'
    + '<w:p><w:r><w:t>Push Day</w:t></w:r></w:p>'
    + '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Bench</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>4 x 6-8 &lt;RPE 8&gt;</w:t></w:r></w:p></w:tc></w:tr></w:tbl>'
    + '<w:p><w:r><w:t xml:space="preserve">Rest</w:t><w:tab/><w:t>2 min</w:t></w:r></w:p>'
    + '</w:body></w:document>',
});

// ── what Claude might answer ────────────────────────────────────────────────

const group = (sets, reps, more = {}) => ({ sets, setType: 'straight', reps, repsMax: null, weightKg: null, load: '', rpe: null, rir: null, restSec: null, ...more });
const ex = (name, setGroups, more = {}) => ({ name, notes: '', techniques: [], supersetGroup: '', setGroups, ...more });
const day = (name, exercises) => ({ name, notes: '', exercises });

const aiProgram = () => ({
  isProgram: true,
  title: 'Coach Sam 4-Week Upper/Lower',
  goal: 'hypertrophy',
  daysPerWeek: 2,
  weekdays: [1, 4],
  progressionNotes: 'Add a rep each week.',
  weeks: [
    { week: 1, phase: 'Base', sameAsWeek: null, days: [
      day('Upper', [
        ex('Barbell Bench Press', [group(1, 5, { setType: 'backoff', weightKg: 100, load: '100kg' }), group(3, 8, { repsMax: 10, rpe: 8, restSec: 150, load: '75% 1RM' })]),
        ex('Cable Fly', [group(2, 12)], { techniques: ['RP', 'BOGUS'], supersetGroup: 'A' }),
      ]),
      day('Lower', [ex('Back Squat', [group(4, 6)])]),
    ] },
    // identical to week 1 but written out — should collapse to sameAs: 1
    { week: 2, phase: 'Base', sameAsWeek: null, days: [
      day('Upper', [
        ex('Barbell Bench Press', [group(1, 5, { setType: 'backoff', weightKg: 100, load: '100kg' }), group(3, 8, { repsMax: 10, rpe: 8, restSec: 150, load: '75% 1RM' })]),
        ex('Cable Fly', [group(2, 12)], { techniques: ['RP', 'BOGUS'], supersetGroup: 'A' }),
      ]),
      day('Lower', [ex('Back Squat', [group(4, 6)])]),
    ] },
    { week: 3, phase: 'Push', sameAsWeek: null, days: [day('Upper', [ex('Barbell Bench Press', [group(4, 6)])]), day('Lower', [ex('Back Squat', [group(5, 5)])])] },
    { week: 4, phase: 'Deload', sameAsWeek: 1, days: [] },
  ],
  warnings: ['Week 3 had no rest times.'],
});

// ── scripted stream ─────────────────────────────────────────────────────────

const calls = [];
let script = [];
// `via` tags each recorded call with the provider whose client got it.
function installFakes(client, via) {
client.beta.messages.stream = params => {
  calls.push({ ...JSON.parse(JSON.stringify(params)), ...(via ? { via } : {}) });
  const step = script.shift();
  return {
    abort() {},
    async finalMessage() {
      if (step.throw) throw step.throw;
      return step.message;
    },
  };
};
}
installFakes(coachClient.getClient());

// Switch to open-model providers for one test; each has its own client.
async function withOpenModels(names, fn) {
  delete process.env.ANTHROPIC_API_KEY;
  names.forEach(n => { process.env[`${n.toUpperCase()}_API_KEY`] = 'test'; });
  coachClient.markGood(null);
  names.forEach(n => installFakes(coachClient.getClient(n), n));
  try {
    await fn();
  } finally {
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.OLLAMA_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'test';
    coachClient.markGood(null);
  }
}
const withOpenRouter = fn => withOpenModels(['openrouter'], fn);
const reply = (obj, stop = 'end_turn') => ({ message: { stop_reason: stop, content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: JSON.stringify(obj) }] } });

const app = express();
app.use('/api/ai/coach/import-program', express.json({ limit: '12mb' }));
app.use(express.json());
app.use('/api/ai', (req, _res, next) => { req.user = { uid: 'u1', username: 'coach' }; next(); }, aiRouter);

let base;
const post = body => fetch(base + '/api/ai/coach/import-program', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

// ── tests ───────────────────────────────────────────────────────────────────

async function run() {
  let passed = 0;
  const t = async (name, fn) => {
    calls.length = 0;
    script = [];
    await fn();
    assert.strictEqual(script.length, 0, `${name}: ${script.length} scripted replies were not used`);
    passed++;
    console.log('  ok -', name);
  };

  console.log('file reading');

  await t('xlsx: shared, rich and inline strings, merged headers, hidden sheets skipped', () => {
    const text = imp.xlsxToText(imp.readZip(XLSX));
    assert.ok(text.includes('## Sheet "Block 1"'));
    assert.ok(!text.includes('SECRET'), 'hidden sheet must be skipped');
    const lines = text.split('\n');
    assert.strictEqual(lines[1], '1\tA: Exercise\tWeek 1\tWeek 1\tWeek 2\tWeek 2');
    assert.strictEqual(lines[2], '2\tA: BB Bench & Pause\t3x8\t60\t3x6\t0.75');
  });

  await t('docx: paragraphs, tables and tabs become text lines', () => {
    const text = imp.docxToText(imp.readZip(DOCX));
    assert.deepStrictEqual(text.split('\n'), ['Push Day', 'Bench\t4 x 6-8 <RPE 8>', 'Rest\t2 min']);
  });

  await t('readImportFile routes each file type', () => {
    const b64 = buf => Buffer.from(buf).toString('base64');
    const pdf = imp.readImportFile({ fileName: 'p.pdf', data: b64('%PDF-1.7 fake') });
    assert.strictEqual(pdf.content[0].type, 'document');
    assert.strictEqual(pdf.content[0].source.media_type, 'application/pdf');
    const jpg = imp.readImportFile({ fileName: 'photo.JPG', data: b64(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2])) });
    assert.deepStrictEqual([jpg.content[0].type, jpg.content[0].source.media_type], ['image', 'image/jpeg']);
    const csv = imp.readImportFile({ fileName: 'plan.csv', data: b64('﻿Day,Exercise\n1,Squat') });
    assert.strictEqual(csv.content[0].text, 'File: plan.csv\n\nDay,Exercise\n1,Squat');
    assert.ok(imp.readImportFile({ fileName: 'a.xlsx', data: XLSX.toString('base64') }).content[0].text.includes('BB Bench'));
    assert.ok(imp.readImportFile({ fileName: 'a.docx', data: DOCX.toString('base64') }).content[0].text.includes('Push Day'));
  });

  await t('readImportFile rejects unusable files with a code', () => {
    const code = body => { try { imp.readImportFile(body); return 'none'; } catch (e) { assert.ok(e instanceof imp.ImportError); return e.code; } };
    assert.strictEqual(code({}), 'missing_file');
    assert.strictEqual(code({ fileName: 'x.xls', data: Buffer.from([0xd0, 0xcf, 0x11, 0xe0]).toString('base64') }), 'unsupported');
    assert.strictEqual(code({ fileName: 'x.exe', data: Buffer.from('MZ\0\0').toString('base64') }), 'unsupported');
    assert.strictEqual(code({ fileName: 'x.zip', data: zip({ 'a.txt': 'hi' }).toString('base64') }), 'unsupported');
    assert.strictEqual(code({ fileName: 'x.txt', data: Buffer.from('   ').toString('base64') }), 'empty');
    assert.strictEqual(code({ fileName: 'x.txt', data: Buffer.alloc(imp.MAX_FILE_BYTES + 1, 97).toString('base64') }), 'too_large');
    assert.strictEqual(code({ fileName: 'x.txt', data: Buffer.alloc(250000, 97).toString('base64') }), 'too_large');
  });

  console.log('conversion');

  await t('toProgramDoc builds a Library-shaped program and collapses repeated weeks', () => {
    const { program, warnings } = imp.toProgramDoc(aiProgram(), 'sam.xlsx');
    assert.strictEqual(program.title, 'Coach Sam 4-Week Upper/Lower');
    assert.strictEqual(program.id, 'import-coach-sam-4-week-upper-lower');
    assert.deepStrictEqual(program.schedule, { startDate: '', weekdays: [1, 4] });
    assert.strictEqual(program.durationWeeks, 4);
    assert.deepStrictEqual(program.weeks.map(w => w.sameAs || 'own'), ['own', 1, 'own', 1]);
    assert.strictEqual(program.weeks[3].phase, 'Deload');
    assert.deepStrictEqual(warnings, ['Week 3 had no rest times.']);

    const [bench, fly] = program.weeks[0].days[0].exercises;
    assert.strictEqual(bench.exerciseId, 'w1-d1-1-barbell-bench-press');
    assert.strictEqual(bench.sets.length, 4);
    assert.deepStrictEqual(bench.sets[0], { setType: 'backoff', reps: 5, weight: 100, rpe: null, rir: null, restSec: 120 });
    assert.deepStrictEqual(bench.sets[1], { setType: 'straight', reps: 8, weight: null, rpe: 8, rir: null, restSec: 150, repsMax: 10 });
    assert.strictEqual(bench.notes, 'Load: 75% 1RM', 'an absolute kg load already in weight is not repeated');
    assert.deepStrictEqual(fly.techniques, ['RP']);
    assert.strictEqual(fly.supersetGroup, 'A');
  });

  await t('toProgramDoc rejects non-programs and empty programs', () => {
    assert.strictEqual(imp.toProgramDoc({ ...aiProgram(), isProgram: false }), null);
    assert.strictEqual(imp.toProgramDoc({ ...aiProgram(), weeks: [] }), null);
    assert.strictEqual(imp.toProgramDoc(null), null);
  });

  await t('weekdays that do not match the day count are dropped', () => {
    const { program } = imp.toProgramDoc({ ...aiProgram(), weekdays: [1, 3, 5] });
    assert.deepStrictEqual(program.schedule.weekdays, []);
  });

  console.log('POST /api/ai/coach/import-program');

  await t('sends the file with structured output and returns the program', async () => {
    script = [reply(aiProgram())];
    const res = await post({ fileName: 'sam.xlsx', data: XLSX.toString('base64') });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.program.weeks.length, 4);
    assert.strictEqual(calls[0].model, 'claude-opus-5-5');
    assert.strictEqual(calls[0].output_config.format.type, 'json_schema');
    assert.deepStrictEqual(calls[0].betas, ['server-side-fallback-2026-07-01']);
    const content = calls[0].messages[0].content;
    assert.ok(content[0].text.includes('## Sheet "Block 1"'));
    assert.strictEqual(content[1].text, 'Convert this training program.');
  });

  await t('a PDF goes to Claude as a document block', async () => {
    script = [reply(aiProgram())];
    const res = await post({ fileName: 'p.pdf', data: Buffer.from('%PDF-1.4 x').toString('base64') });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(calls[0].messages[0].content[0].type, 'document');
  });

  await t('bad files are rejected before any AI call', async () => {
    const res = await post({ fileName: 'x.xls', data: Buffer.from([0xd0, 0xcf]).toString('base64') });
    assert.strictEqual(res.status, 400);
    assert.strictEqual((await res.json()).error, 'unsupported');
    const damaged = await post({ fileName: 'x.xlsx', data: XLSX.subarray(0, XLSX.length - 30).toString('base64') });
    assert.strictEqual(damaged.status, 400);
    assert.strictEqual(calls.length, 0);
  });

  await t('not a program → 422 with the reason', async () => {
    script = [reply({ ...aiProgram(), isProgram: false, weeks: [], warnings: ['This is a meal plan.'] })];
    const res = await post({ fileName: 'meals.csv', data: Buffer.from('Breakfast,Oats').toString('base64') });
    assert.strictEqual(res.status, 422);
    assert.deepStrictEqual(await res.json(), { error: 'no_program', message: 'No training program was found in this file. This is a meal plan.' });
  });

  await t('max_tokens and refusals → 422', async () => {
    script = [reply({}, 'max_tokens'), reply({}, 'refusal')];
    const csv = { fileName: 'p.csv', data: Buffer.from('Squat,3x5').toString('base64') };
    assert.strictEqual((await (await post(csv)).json()).error, 'too_long');
    assert.strictEqual((await (await post(csv)).json()).error, 'unreadable');
  });

  await t('API errors → 502', async () => {
    script = [{ throw: new coachClient.Anthropic.RateLimitError(429, { error: {} }, 'slow down', new Headers()) }];
    const res = await post({ fileName: 'p.csv', data: Buffer.from('Squat,3x5').toString('base64') });
    assert.strictEqual(res.status, 502);
    assert.strictEqual((await res.json()).message, 'The AI is busy right now (the free AI allowance may be used up for today). Try again later.');
  });

  console.log('import through OpenRouter');

  const free = coachClient.OPENROUTER_FREE_MODELS;
  const pdf = { fileName: 'p.pdf', data: Buffer.from('%PDF-1.4 x').toString('base64') };
  const photo = { fileName: 'p.jpg', data: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1]).toString('base64') };

  await t('PDF: free-parser plugin, schema in the instructions, non-JSON reply → next model', () => withOpenRouter(async () => {
    script = [
      { message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Here is the program, week 1 is push...' }] } },
      reply(aiProgram()),
    ];
    const res = await post(pdf);
    assert.strictEqual(res.status, 200);
    assert.strictEqual((await res.json()).program.durationWeeks, 4);
    assert.deepStrictEqual(calls.map(c => c.model), [free[0], free[1]]);
    const c = calls[1];
    assert.deepStrictEqual(c.plugins, [{ id: 'file-parser', pdf: { engine: 'cloudflare-ai' } }]);
    assert.deepStrictEqual(c.output_config, { effort: 'medium' });
    assert.ok(c.system.includes('matching this JSON Schema'));
    assert.strictEqual(c.max_tokens, 16000);
    assert.strictEqual(c.betas, undefined);
    assert.strictEqual(c.messages[0].content[0].type, 'document');
  }));

  await t('spreadsheets get no PDF plugin', () => withOpenRouter(async () => {
    script = [reply(aiProgram())];
    assert.strictEqual((await post({ fileName: 'a.xlsx', data: XLSX.toString('base64') })).status, 200);
    assert.strictEqual(calls[0].plugins, undefined);
  }));

  await t('photo: a model that rejects images is skipped', () => withOpenRouter(async () => {
    script = [{ throw: new coachClient.Anthropic.NotFoundError(404, { error: {} }, 'No endpoints support image input', new Headers()) }, reply(aiProgram())];
    assert.strictEqual((await post(photo)).status, 200);
    assert.deepStrictEqual(calls.map(c => c.model), [free[0], free[1]]);
  }));

  await t('photo no model can read → a clear message', () => withOpenRouter(async () => {
    script = free.map(() => ({ throw: new coachClient.Anthropic.BadRequestError(400, { error: {} }, 'image input not supported', new Headers()) }));
    const res = await post(photo);
    assert.strictEqual(res.status, 502);
    assert.strictEqual((await res.json()).message, "The AI models couldn't read this photo. Try a PDF, Excel or Word file instead.");
  }));

  console.log('master plan import');

  const postPlan = body => fetch(base + '/api/ai/coach/import-plan', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const d = (kcal, proteinG, carbG, fatG) => ({ kcal, proteinG, carbG, fatG });
  const N = d(null, null, null, null);

  await t('plan PDF → phases with gaps filled as suggestions, PDF sent as a document', async () => {
    script = [reply({
      isPlan: true, name: '16-week plan', startDate: null, notes: 'Protein high every day.', warnings: [],
      phases: [
        { type: 'cut', weeks: 12, goal: 'Lose fat', averageKcal: 2200, trainingDay: d(2350, 165, 275, 65), restDay: d(2000, 165, 190, 65) },
        { type: 'maintain', weeks: 3, goal: 'Break', averageKcal: 2700, trainingDay: N, restDay: N },
      ],
    })];
    const res = await postPlan({ fileName: 'plan.pdf', data: Buffer.from('%PDF-1.7 plan').toString('base64') });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(calls[0].messages[0].content[0].type, 'document');
    assert.strictEqual(calls[0].output_config.format.type, 'json_schema');
    assert.strictEqual(body.isPdf, true);
    assert.deepStrictEqual(body.plan.phases[1].trainingDay, d(2700, 165, 364, 65));
    assert.strictEqual(body.plan.suggested, 8);
  });

  await t('a file that is not a plan → 422 with the reason', async () => {
    script = [reply({ isPlan: false, name: '', startDate: null, notes: '', phases: [], warnings: ['This is a grocery list.'] })];
    const res = await postPlan({ fileName: 'x.pdf', data: Buffer.from('%PDF-1.7 x').toString('base64') });
    assert.strictEqual(res.status, 422);
    assert.match((await res.json()).message, /grocery list/);
  });

  console.log('import through Ollama + OpenRouter');

  const withBoth = fn => withOpenModels(['ollama', 'openrouter'], fn);

  await t('photo and spreadsheet go to Ollama first, with the schema in the instructions', () => withBoth(async () => {
    script = [reply(aiProgram()), reply(aiProgram())];
    assert.strictEqual((await post(photo)).status, 200);
    assert.strictEqual((await post({ fileName: 'a.xlsx', data: XLSX.toString('base64') })).status, 200);
    assert.deepStrictEqual(calls.map(c => [c.via, c.model]), [['ollama', 'gemma4:31b'], ['ollama', 'gemma4:31b']]);
    assert.strictEqual(calls[0].messages[0].content[0].type, 'image');
    assert.ok(calls[0].system.includes('matching this JSON Schema'));
    assert.deepStrictEqual(calls[0].output_config, { effort: 'medium' });
  }));

  await t('PDF skips Ollama (no PDF input) and goes to OpenRouter with the parser', () => withBoth(async () => {
    script = [reply(aiProgram())];
    assert.strictEqual((await post(pdf)).status, 200);
    assert.deepStrictEqual(calls.map(c => c.via), ['openrouter']);
    assert.deepStrictEqual(calls[0].plugins, [{ id: 'file-parser', pdf: { engine: 'cloudflare-ai' } }]);
  }));

  console.log('table import (no AI)');

  const sheet = require('fs').readFileSync(require('path').join(__dirname, '..', 'tests', 'fixtures', 'gael-xframe-weeks-1-4.xlsx')).toString('base64');

  await t('Week | Day | Exercise table → program without an AI call (phone shape)', async () => {
    const res = await post({ fileName: 'xframe.xlsx', data: sheet });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(calls.length, 0);
    assert.strictEqual(body.source, 'table');
    assert.strictEqual(body.program.kind, 'program');
    assert.strictEqual(body.program.weeks.length, 4);
    assert.deepStrictEqual(body.program.schedule.weekdays, [1, 2, 4, 5]);
    const raise = body.program.weeks[2].days[1].exercises.find(e => /Cable lateral/.test(e.name));
    assert.deepStrictEqual(raise.sets.map(s => s.rir), [2, 2, 2, 1]);
  });

  await t('target: coach → program/2 with row warnings', async () => {
    const csv = Buffer.from('Week,Day,Exercise,Sets,Reps,RIR,Rest,Notes\nWeek 1,Mon - Lower A,Squat,3,6-8,2,3 min,\n,,Leg curl,lots,10-15,2,90s,\n').toString('base64');
    const res = await post({ fileName: 'p.csv', data: csv, target: 'coach' });
    const body = await res.json();
    assert.strictEqual(calls.length, 0);
    assert.strictEqual(body.program.schema, 'pocketcoach.program/2');
    assert.strictEqual(body.program.weeks[0].days[0].exercises.length, 2, 'blank Week/Day repeat the row above');
    assert.ok(body.rowWarnings.some(w => w.row === 3 && /sets "lots"/.test(w.message) && w.exerciseId));
  });

  await t('PDF with only Ollama configured → 422 before any AI call', () => withOpenModels(['ollama'], async () => {
    const res = await post(pdf);
    assert.strictEqual(res.status, 422);
    assert.strictEqual((await res.json()).error, 'unsupported');
    assert.strictEqual(calls.length, 0);
  }));

  console.log(`\n${passed} passed`);
}

const server = app.listen(0, '127.0.0.1', async () => {
  base = `http://127.0.0.1:${server.address().port}`;
  try {
    await run();
  } catch (err) {
    console.error('FAILED:', err);
    process.exitCode = 1;
  } finally {
    server.closeAllConnections();
    server.close();
  }
});
