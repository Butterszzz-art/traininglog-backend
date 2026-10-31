// Tests for src/nutrition/foods.js and src/routes/food.js with a fake fetch
// (no network). Run: node scripts/test-food-search.js
'use strict';

const path = require('path');
const http = require('http');
const express = require('express');
const foods = require(path.join(__dirname, '..', 'src', 'nutrition', 'foods'));
const { createFoodRouter, createCache } = require(path.join(__dirname, '..', 'src', 'routes', 'food'));

const results = [];
const check = (label, cond) => results.push({ label, pass: !!cond });

// ── Fixtures (trimmed real responses) ───────────────────────────────────────
const usdaSurvey = {
  fdcId: 2340762, description: 'Yogurt, Greek, plain, nonfat', dataType: 'Survey (FNDDS)',
  foodNutrients: [
    { nutrientId: 1008, value: 59 }, { nutrientId: 1003, value: 10.2 }, { nutrientId: 1005, value: 3.6 },
    { nutrientId: 1004, value: 0.39 }, { nutrientId: 1079, value: 0 }, { nutrientId: 2000, value: 3.2 },
    { nutrientId: 1093, value: 36 }, { nutrientId: 1087, value: 110 }, { nutrientId: 1178, value: 0.75 },
  ],
  foodMeasures: [
    { disseminationText: '1 cup', gramWeight: 245 },
    { disseminationText: 'Quantity not specified', gramWeight: 170 },
    { disseminationText: '1 container (6 oz)', gramWeight: 170 },
  ],
};
const usdaBranded = {
  fdcId: 999, description: 'GREEK YOGURT', dataType: 'Branded', brandOwner: 'Some US Brand', gtinUpc: '012345678905',
  servingSize: 150, servingSizeUnit: 'g', householdServingFullText: '1 container',
  foodNutrients: [{ nutrientId: 1008, value: 80 }, { nutrientId: 1003, value: 8.67 }, { nutrientId: 1005, value: 10.7 }, { nutrientId: 1004, value: 0 }],
};
const usdaKjOnly = {
  fdcId: 5, description: 'Thing', dataType: 'Foundation',
  foodNutrients: [{ nutrientId: 1062, value: 418.4 }, { nutrientId: 1003, value: 1 }, { nutrientId: 1005, value: 20 }, { nutrientId: 1004, value: 1 }],
};
const offHagelslag = {
  code: '8710400002970', brands: ['Albert Heijn'], countries_tags: ['en:netherlands'], product_name: 'Puur Hagelslag',
  serving_quantity: 15, serving_size: '15 g', product_quantity: 400,
  nutriments: { 'energy-kcal_100g': 435, carbohydrates_100g: 67, fat_100g: 15, fiber_100g: 7, proteins_100g: 5, salt_100g: 0.3, 'saturated-fat_100g': 9, sodium_100g: 0.12, sugars_100g: 64, iron_100g: 0.0042 },
};
const offYoghurt = {
  code: '8718452123456', brands: 'Jumbo, Huismerk', countries_tags: ['en:netherlands'], product_name_nl: 'Griekse yoghurt 0%',
  quantity: '500 g', nutriments: { 'energy-kj_100g': 238, proteins_100g: 10, carbohydrates_100g: 4, fat_100g: 0 },
};
const offBroken = { code: '123', product_name: 'x', nutriments: {} };

// ── Mapping ─────────────────────────────────────────────────────────────────
{
  const f = foods.mapUsdaFood(usdaSurvey);
  check('usda: id/source/name', f.id === 'usda:2340762' && f.source === 'usda' && f.name === 'Greek yogurt, plain, nonfat');
  check('usda: core per100', f.per100.kcal === 59 && f.per100.protein === 10.2 && f.per100.fat === 0.4);
  check('usda: extended nutrients kept', f.per100.sodiumMg === 36 && f.per100.calciumMg === 110 && f.per100.b12Ug === 0.8 && f.per100.fiber === 0);
  check('usda: missing nutrient left out, not 0', f.per100.ironMg === undefined && f.per100.potassiumMg === undefined);
  check('usda: household measures, "not specified" skipped', f.servings.length === 2 && f.servings[0].label === '1 cup' && f.servings[0].grams === 245);
  check('usda: survey has no barcode', f.barcode === undefined);
}
{
  const f = foods.mapUsdaFood(usdaBranded);
  check('usda branded: caps name tidied', f.name === 'Greek yogurt');
  check('usda branded: label serving', f.servings[0].label === '1 container (150g)' && f.servings[0].grams === 150);
  check('usda branded: UPC padded to 13', f.barcode === '0012345678905');
}
check('usda: kJ converted when kcal missing', foods.mapUsdaFood(usdaKjOnly).per100.kcal === 100);
check('usda: junk rejected', foods.mapUsdaFood({ fdcId: 1, description: 'x', foodNutrients: [] }) === null);
{
  const f = foods.mapOffProduct(offHagelslag);
  check('off: id/name/brand/nl', f.id === 'off:8710400002970' && f.name === 'Puur Hagelslag' && f.brand === 'Albert Heijn' && f.nl === true);
  check('off: sodium g→mg, iron g→mg', f.per100.sodiumMg === 120 && f.per100.ironMg === 4.2);
  check('off: serving + pack', f.servings.length === 2 && f.servings[0].grams === 15 && f.servings[1].grams === 400);
}
{
  const f = foods.mapOffProduct(offYoghurt);
  check('off: dutch name, brand string split', f.name === 'Griekse yoghurt 0%' && f.brand === 'Jumbo');
  check('off: kJ → kcal', f.per100.kcal === 57);
  check('off: absent sugar stays absent', f.per100.sugar === undefined);
}
check('qty: plain grams', JSON.stringify(foods.parseQuantity('250 g')) === '{"count":1,"each":250}');
check('qty: multipack', JSON.stringify(foods.parseQuantity('4 x 125 g')) === '{"count":4,"each":125}');
check('qty: litres with comma', foods.parseQuantity('1,5 l').each === 1500);
check('qty: nonsense', foods.parseQuantity('one bag') === null);
check('off: search hit pack size from quantity text', (() => { const f = foods.mapOffProduct({ ...offYoghurt }); return f.servings.length === 1 && f.servings[0].grams === 500; })());
check('off: no nutriments → null', foods.mapOffProduct(offBroken) === null);
check('off: salt used when sodium missing', foods.mapOffProduct({ ...offHagelslag, nutriments: { ...offHagelslag.nutriments, sodium_100g: undefined } }).per100.sodiumMg === 120);
check('per100: >100 g macros rejected', foods.finishPer100({ kcal: 500, protein: 60, carbs: 60, fat: 10 }) === null);
check('per100: kcal from macros when missing', foods.finishPer100({ protein: 10, carbs: 10, fat: 10 }).kcal === 170);

// ── Barcodes ────────────────────────────────────────────────────────────────
check('barcode: valid EAN-13', foods.validBarcode('8710400002970'));
check('barcode: bad check digit', !foods.validBarcode('8710400002971'));
check('barcode: valid UPC-A', foods.validBarcode('012345678905'));
check('barcode: valid EAN-8', foods.validBarcode('96385074'));
check('barcode: wrong length', !foods.validBarcode('12345'));

// ── Ranking ─────────────────────────────────────────────────────────────────
{
  const off = [offYoghurt, offHagelslag].map(foods.mapOffProduct);
  const usda = [usdaBranded, usdaSurvey].map(foods.mapUsdaFood);
  const ranked = foods.rankFoods('griekse yoghurt', [off, usda]);
  check('rank: full-word Dutch match first', ranked[0].id === 'off:8718452123456');
  const r2 = foods.rankFoods('greek yogurt', [off, usda]);
  check('rank: generic USDA beats US branded', r2.findIndex(f => f.id === 'usda:2340762') < r2.findIndex(f => f.id === 'usda:999'));
  const dupe = foods.rankFoods('greek', [[{ ...foods.mapUsdaFood(usdaBranded) }], [{ ...foods.mapOffProduct(offHagelslag), barcode: '0012345678905', id: 'off:0012345678905' }]]);
  check('rank: same barcode from both sources kept once', dupe.length === 1);
}

{
  const mk = (id, name, extra = {}) => ({ id, source: 'off', name, brand: '', per100: { kcal: 1, protein: 0, carbs: 0, fat: 0 }, servings: [], nl: true, ...extra });
  const r = foods.rankFoods('banaan', [[mk('off:1', 'Banaan speltpannenkoek'), mk('off:2', 'Hipro banaan'), mk('off:3', 'Banaan')]]);
  check('rank: the plain food beats foods made with it', r[0].id === 'off:3', r.map(f => f.name));
  const z = foods.rankFoods('zalm', [[mk('off:1', 'Eggwrap gerookte zalm'), mk('off:2', 'Zalm steak'), mk('off:3', 'Zalm')]]);
  check('rank: exact name first, then names starting with it', z[0].id === 'off:3' && z[1].id === 'off:2', z.map(f => f.name));
}

// ── Cache ───────────────────────────────────────────────────────────────────
{
  const c = createCache(2);
  c.set('a', 1, 1000, 0); c.set('b', 2, 1000, 0); c.get('a', 1); c.set('c', 3, 1000, 1);
  check('cache: LRU evicts least recent', c.get('b', 2) === undefined && c.get('a', 2) === 1);
  check('cache: expiry', c.get('a', 5000) === undefined);
}

// ── Route ───────────────────────────────────────────────────────────────────
const sendError = (res, status, code, message) => res.status(status).json({ success: false, error: { code, message } });
const sendSuccess = (res, status, data = {}) => res.status(status).json({ success: true, ...data });

function fakeFetch(behaviour) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url: String(url), opts });
    const host = new URL(url).host;
    const b = behaviour[host];
    if (!b || b === 'fail') return { ok: false, status: 503, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => b };
  };
  fn.calls = calls;
  return fn;
}

function serve(router) {
  const app = express();
  app.use('/api/food', router);
  return new Promise(resolve => {
    const server = http.createServer(app).listen(0, () => resolve(server));
  });
}

async function get(server, p) {
  const { port } = server.address();
  const res = await fetch(`http://127.0.0.1:${port}${p}`);
  return { status: res.status, body: await res.json() };
}

(async () => {
  const upstream = {
    'api.nal.usda.gov': { foods: [usdaSurvey, usdaBranded] },
    'search.openfoodfacts.org': { hits: [offYoghurt, offHagelslag, offBroken] },
  };

  {
    const f = fakeFetch(upstream);
    const server = await serve(createFoodRouter({ sendError, sendSuccess, fetchFn: f, usdaKey: () => 'real-key', log: { warn() {} } }));
    const r = await get(server, '/api/food/search?q=Griekse%20Yoghurt');
    check('route: 200 with merged foods', r.status === 200 && r.body.foods.length === 4 && r.body.sources.usda === 'ok' && r.body.sources.off === 'ok');
    check('route: OFF called with custom User-Agent', f.calls.some(c => c.url.includes('openfoodfacts') && /PocketCoach/.test(c.opts.headers['User-Agent'])));
    check('route: USDA called with server key, never DEMO_KEY', f.calls.some(c => c.url.includes('api_key=real-key')) && !f.calls.some(c => c.url.includes('DEMO_KEY')));
    const before = f.calls.length;
    const again = await get(server, '/api/food/search?q=griekse yoghurt');
    check('route: second identical query served from cache', again.body.cached === true && f.calls.length === before);
    const short = await get(server, '/api/food/search?q=a');
    check('route: 1-char query rejected', short.status === 422);
    const lim = await get(server, '/api/food/search?q=yoghurt&limit=1');
    check('route: limit honoured', lim.body.foods.length === 1);
    server.close();
  }
  {
    const f = fakeFetch(upstream);
    const server = await serve(createFoodRouter({ sendError, sendSuccess, fetchFn: f, usdaKey: () => 'k', log: { warn() {} } }));
    const r = await get(server, '/api/food/search?q=hagelslag&source=off');
    check('route: source=off asks only Open Food Facts', r.status === 200 && !f.calls.some(c => c.url.includes('nal.usda.gov')) && Object.keys(r.body.sources).join() === 'off');
    check('route: OFF asked twice, once limited to Dutch products', f.calls.filter(c => c.url.includes('openfoodfacts')).length === 2
      && f.calls.some(c => decodeURIComponent(c.url).includes('countries_tags:"en:netherlands"')));
    const u = await get(server, '/api/food/search?q=hagelslag&source=usda');
    check('route: source=usda asks only USDA', u.status === 200 && Object.keys(u.body.sources).join() === 'usda');
    server.close();
  }
  {
    const f = fakeFetch(upstream);
    const server = await serve(createFoodRouter({ sendError, sendSuccess, fetchFn: f, usdaKey: () => '', log: { warn() {} } }));
    const r = await get(server, '/api/food/search?q=hagelslag');
    check('route: no USDA key → USDA disabled, no USDA request', r.body.sources.usda === 'disabled' && !f.calls.some(c => c.url.includes('nal.usda.gov')));
    check('route: OFF still answers', r.body.foods.some(x => x.id === 'off:8710400002970'));
    server.close();
  }
  {
    const f = fakeFetch(upstream);
    const server = await serve(createFoodRouter({ sendError, sendSuccess, fetchFn: f, usdaKey: () => 'DEMO_KEY', log: { warn() {} } }));
    await get(server, '/api/food/search?q=hagelslag');
    check('route: DEMO_KEY is treated as no key', !f.calls.some(c => c.url.includes('nal.usda.gov')));
    server.close();
  }
  {
    const f = fakeFetch({ ...upstream, 'search.openfoodfacts.org': 'fail' });
    const cache = createCache();
    const server = await serve(createFoodRouter({ sendError, sendSuccess, fetchFn: f, usdaKey: () => 'k', cache, log: { warn() {} } }));
    const r = await get(server, '/api/food/search?q=yogurt');
    check('route: one source down → partial results, marked error', r.status === 200 && r.body.sources.off === 'error' && r.body.foods.length === 2);
    check('route: partial answer not cached', cache.size === 0);
    server.close();
  }
  {
    const f = fakeFetch({});
    const server = await serve(createFoodRouter({ sendError, sendSuccess, fetchFn: f, usdaKey: () => 'k', log: { warn() {} } }));
    const r = await get(server, '/api/food/search?q=yogurt');
    check('route: both down → 502', r.status === 502 && r.body.error.code === 'food.search_unavailable');
    server.close();
  }

  // ── Dutch / British words and typos ─────────────────────────────────────
  {
    const f = fakeFetch(upstream);
    const server = await serve(createFoodRouter({ sendError, sendSuccess, fetchFn: f, usdaKey: () => 'k', log: { warn() {} } }));
    await get(server, '/api/food/search?q=magere%20kwark');
    const usdaUrl = f.calls.find(c => c.url.includes('nal.usda.gov')).url;
    const offUrls = f.calls.filter(c => c.url.includes('openfoodfacts')).map(c => new URL(c.url).searchParams.get('q'));
    check('route: USDA asked in English (magere kwark → quark nonfat)', new URL(usdaUrl).searchParams.get('query') === 'quark nonfat');
    check('route: Open Food Facts asked in the words typed', offUrls.every(q => q.startsWith('magere kwark')));
    server.close();
  }
  {
    // Only the correctly spelt word finds chicken.
    const chicken = { fdcId: 77, description: 'Chicken, broilers or fryers, breast, meat only, cooked, roasted', dataType: 'SR Legacy',
      foodNutrients: [{ nutrientId: 1008, value: 165 }, { nutrientId: 1003, value: 31 }, { nutrientId: 1005, value: 0 }, { nutrientId: 1004, value: 3.6 }] };
    const calls = [];
    const fetchFn = async (url) => {
      calls.push(String(url));
      const u = new URL(url);
      const q = u.searchParams.get('query') || u.searchParams.get('q') || '';
      if (u.host === 'api.nal.usda.gov') return { ok: true, status: 200, json: async () => ({ foods: /chicken/.test(q) ? [chicken] : [usdaKjOnly] }) };
      return { ok: true, status: 200, json: async () => ({ hits: [] }) };
    };
    const server = await serve(createFoodRouter({ sendError, sendSuccess, fetchFn, usdaKey: () => 'k', log: { warn() {} } }));
    const r = await get(server, '/api/food/search?q=chiken%20breast');
    check('route: misspelt search retried with corrected words', r.status === 200 && r.body.corrected === 'chicken breast' && r.body.foods[0].name === 'Chicken breast, cooked, roasted');
    const n = calls.length;
    const good = await get(server, '/api/food/search?q=chicken%20breast');
    check('route: a good search is not "corrected" and asks once', !good.body.corrected && calls.length - n === 3);
    const brand = await get(server, '/api/food/search?q=optimel');
    check('route: an unknown brand stays as typed', !brand.body.corrected);
    server.close();
  }

  // ── Barcode ───────────────────────────────────────────────────────────────
  {
    const f = fakeFetch({
      'world.openfoodfacts.org': { status: 1, product: { ...offHagelslag, serving_quantity: 20, serving_size: '20 g' } },
      'api.nal.usda.gov': { foods: [usdaBranded] },
    });
    const server = await serve(createFoodRouter({ sendError, sendSuccess, fetchFn: f, usdaKey: () => 'k', log: { warn() {} } }));
    let r = await get(server, '/api/food/barcode/8710400002970');
    check('barcode: OFF product with per-100 g and serving', r.status === 200 && r.body.food.id === 'off:8710400002970' && r.body.food.servings[0].grams === 20);
    const n = f.calls.length;
    r = await get(server, '/api/food/barcode/8710400002970');
    check('barcode: second lookup cached', r.body.cached === true && f.calls.length === n);
    r = await get(server, '/api/food/barcode/8710400002971');
    check('barcode: bad check digit rejected before any lookup', r.status === 422 && f.calls.length === n);
    server.close();
  }
  {
    const f = fakeFetch({ 'world.openfoodfacts.org': { status: 0 }, 'api.nal.usda.gov': { foods: [usdaBranded] } });
    const server = await serve(createFoodRouter({ sendError, sendSuccess, fetchFn: f, usdaKey: () => 'k', log: { warn() {} } }));
    const r = await get(server, '/api/food/barcode/012345678905');
    check('barcode: falls back to USDA Branded by GTIN', r.status === 200 && r.body.food.id === 'usda:999');
    server.close();
  }
  {
    const f = fakeFetch({ 'world.openfoodfacts.org': { status: 0 }, 'api.nal.usda.gov': { foods: [] } });
    const cache = createCache();
    const server = await serve(createFoodRouter({ sendError, sendSuccess, fetchFn: f, usdaKey: () => 'k', cache, log: { warn() {} } }));
    const r = await get(server, '/api/food/barcode/96385074');
    check('barcode: not found → 404 with add-it-yourself code', r.status === 404 && r.body.error.code === 'food.barcode_not_found');
    check('barcode: miss remembered', cache.get('b:96385074') === null);
    server.close();
  }
  {
    const f = fakeFetch({});
    const cache = createCache();
    const server = await serve(createFoodRouter({ sendError, sendSuccess, fetchFn: f, usdaKey: () => 'k', cache, log: { warn() {} } }));
    const r = await get(server, '/api/food/barcode/96385074');
    check('barcode: both sources down → 502, not cached', r.status === 502 && cache.size === 0);
    server.close();
  }

  const failed = results.filter(r => !r.pass);
  results.forEach(r => console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.label}`));
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exitCode = failed.length ? 1 : 0;
})();
