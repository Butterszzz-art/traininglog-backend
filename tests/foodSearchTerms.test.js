// node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const { toEnglish, correctTypos, closestWord, stem, distance } = require('../src/nutrition/searchTerms');
const foods = require('../src/nutrition/foods');

test('toEnglish turns Dutch and British food words into USDA words', () => {
  assert.equal(toEnglish('kipfilet').text, 'chicken breast');
  assert.equal(toEnglish('magere kwark').text, 'quark nonfat');
  assert.equal(toEnglish('zoete aardappel gekookt').text, 'sweet potato cooked');
  assert.equal(toEnglish('courgette').text, 'zucchini');
  assert.equal(toEnglish('semi-skimmed milk').text, 'milk reduced fat');
  assert.equal(toEnglish('Havermout').text, 'oats');
});

test('toEnglish leaves English words and brands alone', () => {
  assert.deepEqual(toEnglish('greek yogurt'), { text: 'greek yogurt', changed: false });
  assert.equal(toEnglish('optimel drinkyoghurt').text, 'optimel drinkyoghurt');
  assert.equal(toEnglish('kip kipfilet').text, 'chicken breast', 'repeats dropped');
});

test('correctTypos fixes misspelt food words', () => {
  assert.equal(correctTypos('chiken breast').text, 'chicken breast');
  assert.equal(correctTypos('bannana').text, 'banana');
  assert.equal(correctTypos('brocoli').text, 'broccoli');
  assert.equal(correctTypos('havermoud').text, 'havermout');
  assert.equal(correctTypos('yoghurd').text, 'yoghurt');
});

test('correctTypos leaves known words, short words, numbers and far-off words alone', () => {
  assert.deepEqual(correctTypos('chicken breast'), { text: 'chicken breast', changed: false });
  assert.equal(correctTypos('ah').text, 'ah');
  assert.equal(correctTypos('0% kwark').text, '0% kwark');
  assert.equal(closestWord('optimel'), null);
  assert.equal(closestWord('alpro'), null);
  assert.equal(closestWord('eggs'), null, 'a plural of a known word is known');
});

test('distance counts a swapped pair of letters as one edit', () => {
  assert.equal(distance('chikcen', 'chicken'), 1);
  assert.equal(distance('rice', 'rice'), 0);
});

test('stem folds plurals', () => {
  assert.equal(stem('eggs'), 'egg');
  assert.equal(stem('tomatoes'), 'tomato');
  assert.equal(stem('berries'), 'berry');
  assert.equal(stem('glass'), 'glass');
  assert.equal(stem('oats'), 'oat');
});

test('a plural search matches a singular name and the other way round', () => {
  const mk = (id, name) => ({ id, source: 'usda', name, brand: '', per100: { kcal: 1, protein: 0, carbs: 0, fat: 0 }, servings: [] });
  assert.equal(foods.isWeakResult('eggs', [mk('a', 'Whole egg, raw')]), false);
  assert.equal(foods.isWeakResult('tomato', [mk('a', 'Tomatoes, red, raw')]), false);
  assert.equal(foods.isWeakResult('chiken', [mk('a', 'Chicken breast')]), true);
});

test('shortUsdaName turns catalogue names into what people type', () => {
  const cases = {
    'Chicken, broilers or fryers, breast, meat only, cooked, roasted': 'Chicken breast, cooked, roasted',
    'Rice, white, long-grain, regular, raw, enriched': 'White rice, long-grain, raw',
    'Egg, white, raw, fresh': 'Egg white, raw, fresh',
    'Oil, olive, salad or cooking': 'Olive oil',
    'Cereals, oats, regular and quick, not fortified, dry': 'Oats, regular and quick, dry',
    'Fish, salmon, Atlantic, farmed, cooked, dry heat': 'Atlantic salmon, farmed, cooked, dry heat',
    'Nuts, almonds': 'Almonds',
    'Bananas, raw': 'Bananas, raw',
    'Milk, reduced fat, fluid, 2% milkfat, with added vitamin A and vitamin D': 'Reduced fat milk, 2% milkfat',
    'Beef, ground, 85% lean meat / 15% fat, patty, cooked, broiled': 'Ground beef, 85% lean meat / 15% fat, patty, cooked, broiled',
    Thing: 'Thing',
  };
  for (const [from, to] of Object.entries(cases)) assert.equal(foods.shortUsdaName(from), to, from);
});

test('a translated search ranks USDA foods by the English words', () => {
  const mk = (id, name, source) => ({ id, source, name, brand: '', dataType: 'SR Legacy', per100: { kcal: 1, protein: 0, carbs: 0, fat: 0 }, servings: [] });
  const ranked = foods.rankFoods('kipfilet', [[mk('usda:1', 'Beef steak', 'usda'), mk('usda:2', 'Chicken breast', 'usda')]], 20, 'chicken breast');
  assert.equal(ranked[0].id, 'usda:2');
});
