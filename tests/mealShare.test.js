// node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const { cleanMeal, mealText, parseMealPhoto, ITEMS_MAX } = require('../src/mealShare');

test('cleanMeal keeps only the known fields and recomputes the totals', () => {
  const meal = cleanMeal({
    meal: 'lunch',
    totals: { kcal: 99999 },
    items: [
      { name: '  Chicken   breast ', amount: 200, unit: 'g', kcal: 330.4, protein: 62.04, carbs: 0, fat: 7.15, extra: 'x' },
      { name: 'White rice', amount: 1, unit: 'cup', grams: 250, kcal: 325, protein: 6, carbs: 70, fat: 1, fibre: 1.2 },
    ],
  });
  assert.deepEqual(meal.items[0], { name: 'Chicken breast', amount: 200, unit: 'g', kcal: 330, protein: 62, carbs: 0, fat: 7.2 });
  assert.equal(meal.items[1].fibre, 1.2);
  assert.equal(meal.items[1].grams, 250);
  assert.equal(meal.items[1].unit, 'cup');
  assert.deepEqual(meal.totals, { kcal: 655, protein: 68, carbs: 70, fat: 8.2 });
  assert.equal(meal.meal, 'lunch');
});

test('cleanMeal drops nameless foods, bad numbers and unknown meal slots', () => {
  const meal = cleanMeal({
    meal: 'second breakfast',
    items: [null, { name: '' }, { name: 'Oats', kcal: -5, protein: 'abc', carbs: Infinity, fat: 1e9 }],
  });
  assert.equal(meal.items.length, 1);
  assert.deepEqual(meal.items[0], { name: 'Oats', kcal: 0, protein: 0, carbs: 0, fat: 10000 });
  assert.equal('meal' in meal, false);
});

test('cleanMeal returns null for a meal with no food', () => {
  assert.equal(cleanMeal({ items: [] }), null);
  assert.equal(cleanMeal({ items: [{ name: '   ' }] }), null);
  assert.equal(cleanMeal(null), null);
  assert.equal(cleanMeal({ items: 'nope' }), null);
});

test('cleanMeal caps the number of foods', () => {
  const items = Array.from({ length: 60 }, (_, i) => ({ name: `Food ${i}`, kcal: 10 }));
  assert.equal(cleanMeal({ items }).items.length, ITEMS_MAX);
});

test('mealText lists the food names for the word filter', () => {
  assert.equal(mealText(cleanMeal({ items: [{ name: 'Oats' }, { name: 'Milk' }] })), 'Oats Milk');
  assert.equal(mealText(null), '');
});

test('parseMealPhoto accepts a real JPEG and rejects other data', () => {
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(100)]);
  const ok = parseMealPhoto(`data:image/jpeg;base64,${jpeg.toString('base64')}`);
  assert.equal(ok.mime, 'image/jpeg');
  assert.equal(ok.bytes, 104);
  assert.equal(parseMealPhoto(`data:image/jpeg;base64,${Buffer.from('not an image').toString('base64')}`), null);
  assert.equal(parseMealPhoto('https://example.com/a.jpg'), null);
  const big = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(160 * 1024)]);
  assert.equal(parseMealPhoto(`data:image/jpeg;base64,${big.toString('base64')}`).tooLarge, true);
});
