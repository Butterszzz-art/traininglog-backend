// Describe-to-log (src/nutrition/describe.js) with a fake model and a fake
// food searcher. No network.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const d = require('../src/nutrition/describe');
const LIMITS = require('../src/config/aiLimits');

const reply = items => ({ content: [{ type: 'text', text: JSON.stringify({ items }) }] });
const item = (o = {}) => ({ text: 'x', search: 'x food', english: 'x food', amount: null, unit: null, grams: null, ...o });

test('cleanText: trims, one line, limits length, rejects empty', () => {
  assert.equal(d.cleanText('  2 eggs\n and toast  '), '2 eggs and toast');
  assert.equal(d.cleanText('a'), null);
  assert.equal(d.cleanText(42), null);
  assert.equal(d.cleanText('x'.repeat(900)).length, 400);
});

test('cleanItem: amounts in g/ml become the grams', () => {
  const r = d.cleanItem(item({ amount: 200, unit: 'g', grams: 150 }));
  assert.equal(r.grams, 200);
  assert.equal(r.count, undefined);
  const m = d.cleanItem(item({ amount: 250, unit: 'ml', grams: 250 }));
  assert.equal(m.ml, 250);
});

test('cleanItem: counts keep the estimate and a serving hint', () => {
  const r = d.cleanItem(item({ text: '2 slices of bread', amount: 2, unit: 'slice', grams: 70 }));
  assert.deepEqual([r.count, r.servingHint, r.grams], [2, 'slice', 70]);
  const e = d.cleanItem(item({ amount: 2, unit: 'piece', grams: 100 }));
  assert.equal(e.servingHint, 'piece');
  const s = d.cleanItem(item({ amount: 1, unit: 'serving', grams: 300 }));
  assert.equal(s.count, 1);
  assert.equal(s.servingHint, undefined);
});

test('cleanItem: junk is dropped or cleaned', () => {
  assert.equal(d.cleanItem(item({ search: '', english: '' })), null);
  assert.equal(d.cleanItem(null), null);
  const r = d.cleanItem(item({ search: '<b>kwark</b>', unit: 'bucket', amount: 3, grams: -5 }));
  assert.ok(!/[<>]/.test(r.search));
  assert.equal(r.unit, null);
  assert.equal(r.amount, null);
  assert.equal(r.grams, null);
  const big = d.cleanItem(item({ amount: 1e9, unit: 'g', grams: 1e9 }));
  assert.equal(big.grams, null);
});

test('parseReply: reads JSON from around text, caps the count', () => {
  const many = Array.from({ length: 15 }, (_, i) => item({ search: `food ${i}` }));
  const out = d.parseReply('here: ' + JSON.stringify({ items: many }) + ' done');
  assert.equal(out.length, d.MAX_ITEMS);
  assert.equal(d.parseReply('no idea'), null);
  assert.deepEqual(d.parseReply('{"items":[]}'), []);
});

test('describe: splits, then looks every item up in both databases', async () => {
  const sent = [];
  const model = async (_m, params) => {
    sent.push(params.messages[0].content);
    return reply([
      item({ text: '2 eggs', search: 'eieren', english: 'egg whole', amount: 2, unit: 'piece', grams: 100 }),
      item({ text: 'toast', search: 'volkoren brood', english: 'whole wheat bread', amount: 1, unit: 'slice', grams: 35 }),
    ]);
  };
  const calls = [];
  const searcher = {
    search: async (q, { sources }) => {
      calls.push(`${sources}:${q}`);
      const f = (id, name, source) => ({ id, name, source, brand: '', per100: { kcal: 100, protein: 1, carbs: 1, fat: 1 }, servings: [], nl: source === 'off' });
      return { foods: sources === 'off' ? [f(`off:${q}`, q, 'off')] : [f(`usda:${q}`, q, 'usda')] };
    },
  };
  const api = d.createDescribe({ searcher, createMessageFn: model, log: { warn() {} } });
  const out = await api.describe('2 eggs and toast');
  assert.deepEqual(sent, [JSON.stringify({ ate: '2 eggs and toast' })]);
  assert.equal(out.items.length, 2);
  assert.deepEqual(calls.sort(), ['off:eieren', 'off:volkoren brood', 'usda:egg whole', 'usda:whole wheat bread']);
  assert.equal(out.items[0].foods.length, 2);
  assert.equal(out.items[0].count, 2);

  // Same words again: no second model call.
  await api.describe('2 Eggs and toast');
  assert.equal(sent.length, 1);
});

test('describe: a failing database still returns the other one', async () => {
  const model = async () => reply([item({ search: 'kwark', english: 'quark' })]);
  const searcher = {
    search: async (q, { sources }) => {
      if (sources === 'off') throw new Error('down');
      return { foods: [{ id: 'usda:1', name: 'Quark', source: 'usda', brand: '', per100: { kcal: 60, protein: 11, carbs: 4, fat: 0 }, servings: [] }] };
    },
  };
  const out = await d.createDescribe({ searcher, createMessageFn: model, log: { warn() {} } }).describe('kwark');
  assert.equal(out.items[0].foods[0].id, 'usda:1');
});

test('describe: unusable model reply → items null', async () => {
  const model = async () => ({ content: [{ type: 'text', text: 'sorry' }] });
  const out = await d.createDescribe({ searcher: { search: async () => ({ foods: [] }) }, createMessageFn: model }).describe('stuff');
  assert.equal(out.items, null);
});

test('the routes spend a monthly credit and are not on the free plan', () => {
  assert.deepEqual(LIMITS.FEATURES['/food-describe'], { key: 'food-describe', kind: 'credit' });
  assert.deepEqual(LIMITS.FEATURES['/food-photo'], { key: 'food-photo', kind: 'credit' });
  assert.ok(!LIMITS.free.allowedFeatures.includes('food-describe'));
  assert.ok(!LIMITS.free.allowedFeatures.includes('food-photo'));
});

// ── Photos ────────────────────────────────────────────────────────────────
const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 7)]);
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(200, 7)]);

test('cleanPhoto: JPEG/PNG data URLs or bare base64 only', () => {
  assert.deepEqual(d.cleanPhoto(`data:image/jpeg;base64,${jpeg.toString('base64')}`), { mediaType: 'image/jpeg', data: jpeg.toString('base64') });
  assert.equal(d.cleanPhoto(png.toString('base64')).mediaType, 'image/png');
  // The type comes from the bytes, not the label.
  assert.equal(d.cleanPhoto(`data:image/png;base64,${jpeg.toString('base64')}`).mediaType, 'image/jpeg');
  assert.equal(d.cleanPhoto(`data:image/jpeg;base64,${Buffer.from('<svg>' + 'x'.repeat(200)).toString('base64')}`), null);
  assert.equal(d.cleanPhoto('not base64 at all!'.repeat(10)), null);
  assert.equal(d.cleanPhoto(42), null);
  const huge = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(d.MAX_PHOTO_BYTES + 10)]);
  assert.equal(d.cleanPhoto(huge.toString('base64')), null);
});

test('cleanNote: one line, 200 characters', () => {
  assert.equal(d.cleanNote(' fried in\n olive oil '), 'fried in olive oil');
  assert.equal(d.cleanNote('x'.repeat(500)).length, 200);
  assert.equal(d.cleanNote(null), '');
});

test('describePhoto: sends the image and note, skips unusable models, looks foods up', async () => {
  let sent = null;
  let opts = null;
  const stream = async (_m, params, o) => {
    sent = params;
    opts = o;
    const reply = reply2([item({ text: 'rice', search: 'rijst', english: 'rice white cooked', grams: 180 })]);
    assert.equal(o.accept(reply), true);
    assert.equal(o.accept({ content: [{ type: 'text', text: 'I see a plate' }] }), false);
    return { reply };
  };
  const reply2 = items => ({ content: [{ type: 'text', text: JSON.stringify({ items }) }] });
  const searcher = { search: async (q, { sources }) => ({ foods: [{ id: `${sources}:${q}`, name: q, source: sources, brand: '', per100: { kcal: 130, protein: 2.7, carbs: 28, fat: 0.3 }, servings: [] }] }) };
  const api = d.createDescribe({ searcher, streamMessageFn: stream, openModels: () => true, log: { warn() {} } });
  const photo = d.cleanPhoto(jpeg.toString('base64'));
  const out = await api.describePhoto(photo, ' met\nolijfolie ');
  const content = sent.messages[0].content;
  assert.equal(content[0].type, 'image');
  assert.equal(content[0].source.media_type, 'image/jpeg');
  assert.equal(content[1].text, JSON.stringify({ note: 'met olijfolie' }));
  assert.ok(opts.skipStatuses.includes(400) && opts.skipStatuses.includes(404));
  assert.equal(out.items.length, 1);
  assert.equal(out.items[0].grams, 180);
  assert.equal(out.items[0].foods.length, 2);
});

test('describePhoto: no usable answer → items null; no food → empty list', async () => {
  const photo = d.cleanPhoto(jpeg.toString('base64'));
  const bad = d.createDescribe({ searcher: { search: async () => ({ foods: [] }) }, streamMessageFn: async () => ({ reply: { content: [{ type: 'text', text: 'hmm' }] } }) });
  assert.equal((await bad.describePhoto(photo)).items, null);
  const none = d.createDescribe({ searcher: { search: async () => ({ foods: [] }) }, streamMessageFn: async () => ({ reply: reply([]) }) });
  assert.deepEqual((await none.describePhoto(photo)).items, []);
});

test('Claude models: typed meals on the fast model, photos on the smart one', async () => {
  const seen = [];
  const reply = { content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: '{"items":[]}' }] };
  const api = d.createDescribe({
    searcher: { search: async () => ({ foods: [] }) },
    createMessageFn: async (model, params) => { seen.push({ model, effort: params.output_config.effort }); return reply; },
    streamMessageFn: async (model, params) => { seen.push({ model, effort: params.output_config.effort }); return { reply }; },
    log: { warn() {} },
  });
  await api.describe('twee boterhammen met kaas');
  await api.describePhoto(d.cleanPhoto('data:image/jpeg;base64,' + Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(200)]).toString('base64')), '');
  assert.deepEqual(seen, [
    { model: d.MODEL, effort: 'low' },
    { model: d.PHOTO_MODEL, effort: 'medium' },
  ]);
  assert.equal(d.MODEL, 'claude-haiku-5-5');
  assert.equal(d.PHOTO_MODEL, 'claude-sonnet-5-5');
});
