// node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const { staplesFor, matchStaple, labelDryWeight, withStaples } = require('../src/nutrition/staples');

test('a plain rice search gets cooked white rice first, then dry', () => {
  for (const q of ['white rice', 'rijst', 'witte rijst', 'Rice', 'basmati rijst', 'rijst 200g']) {
    const [cooked, dry] = staplesFor(q);
    assert.equal(cooked.name, 'White rice, cooked', q);
    assert.equal(cooked.per100.kcal, 130);
    assert.equal(dry.name, 'White rice, dry (uncooked)');
    assert.equal(dry.per100.kcal, 365);
  }
});

test('asking for dry or raw puts the dry one first', () => {
  assert.equal(staplesFor('rijst ongekookt')[0].name, 'White rice, dry (uncooked)');
  assert.equal(staplesFor('raw white rice')[0].name, 'White rice, dry (uncooked)');
  assert.equal(staplesFor('gekookte rijst')[0].name, 'White rice, cooked');
});

test('other grains and Dutch names', () => {
  assert.equal(staplesFor('zilvervliesrijst')[0].name, 'Brown rice, cooked');
  assert.equal(staplesFor('spaghetti')[0].name, 'Pasta, cooked');
  assert.equal(staplesFor('quinoa')[0].per100.kcal, 120);
  assert.deepEqual(staplesFor('havermout').map(f => f.name), ['Oats, dry (rolled)']);
});

test('no staples for products or dishes that only contain the word', () => {
  for (const q of ['rice cakes', 'rijstwafels', 'kip rijst', 'rice krispies', 'pasta saus', 'ben\'s original']) {
    assert.equal(matchStaple(q), null, q);
  }
});

test('staple kcal add up from their macros', () => {
  for (const q of ['rice', 'brown rice', 'pasta', 'quinoa', 'couscous', 'oats']) {
    for (const f of staplesFor(q)) {
      const p = f.per100;
      const fromMacros = p.protein * 4 + p.carbs * 4 + p.fat * 9;
      assert.ok(Math.abs(fromMacros - p.kcal) / p.kcal < 0.12, `${f.name}: ${fromMacros} vs ${p.kcal}`);
    }
  }
});

const food = (name, per100) => ({ id: name, source: 'off', name, per100 });

test('dry-weight grain products get ", dry"; others are left alone', () => {
  assert.equal(labelDryWeight(food('Witte Rijst', { kcal: 364, carbs: 80, fat: 0.6 })).name, 'Witte Rijst, dry');
  assert.equal(labelDryWeight(food('Snelkook rijst', { kcal: 353, carbs: 79.6, fat: 1 })).name, 'Snelkook rijst, dry');
  // Already cooked, eaten as is, fatty, or already says its state.
  assert.equal(labelDryWeight(food('Crops Witte Rijst Precooked', { kcal: 131, carbs: 28, fat: 0.5 })).name, 'Crops Witte Rijst Precooked');
  assert.equal(labelDryWeight(food('Rice cakes', { kcal: 387, carbs: 81, fat: 2.8 })).name, 'Rice cakes');
  assert.equal(labelDryWeight(food('Noten rijst', { kcal: 445, carbs: 54, fat: 22 })).name, 'Noten rijst');
  assert.equal(labelDryWeight(food('White rice, long-grain, raw', { kcal: 365, carbs: 80, fat: 0.7 })).name, 'White rice, long-grain, raw');
  assert.equal(labelDryWeight(food('Kipfilet', { kcal: 110, carbs: 0, fat: 1.5 })).name, 'Kipfilet');
});

test('withStaples puts the staples first and keeps the rest', () => {
  const list = [food('Witte Rijst', { kcal: 364, carbs: 80, fat: 0.6 }), food('Pandan rijst', { kcal: 352, carbs: 77, fat: 1 })];
  const out = withStaples('rijst', list);
  assert.deepEqual(out.map(f => f.name), ['White rice, cooked', 'White rice, dry (uncooked)', 'Witte Rijst, dry', 'Pandan rijst, dry']);
  assert.deepEqual(withStaples('kipfilet', [food('Kipfilet', { kcal: 110, carbs: 0, fat: 1.5 })]).map(f => f.name), ['Kipfilet']);
});
