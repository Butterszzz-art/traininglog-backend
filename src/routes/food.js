// Food search for the app's food log. The app used to call USDA FoodData
// Central straight from the phone with the shared DEMO_KEY (30 requests an
// hour per IP, and a key anyone could lift from the app). Now the phone asks
// us, and we ask:
//   - USDA FoodData Central, with our own key (USDA_API_KEY, free from
//     api.data.gov). Without a key USDA is skipped; DEMO_KEY is never used.
//   - Open Food Facts' Search-a-licious (search.openfoodfacts.org), which has
//     far better Dutch/EU supermarket coverage. ODbL: the app shows
//     "Data: Open Food Facts" next to OFF results.
// Results are mapped onto one food shape (src/nutrition/foods.js), merged,
// and cached: in memory per instance, and in Firestore shared by all
// instances (src/nutrition/searchCache.js), so the same query from many
// users only reaches the upstream APIs once a day, even after a cold start.
//
//   GET /search?q=<text>&limit=<n>
//     → { foods: [...], sources: { usda: 'ok'|'error'|'disabled', off: ... },
//         corrected? }  corrected: the words searched instead when the ones
//         typed found nothing good and looked misspelt ("chiken" → "chicken").
// USDA is asked in English (src/nutrition/searchTerms.js turns Dutch and
// British food words into the American ones it uses).
//   GET /barcode/:code      (EAN-8/13, UPC-A, GTIN-14 with a valid check digit)
//     → { food } or 404 food.barcode_not_found. Open Food Facts' product API
//     first (it has serving sizes), then USDA Branded by GTIN.
'use strict';

const express = require('express');
const foods = require('../nutrition/foods');
const { toEnglish, correctTypos } = require('../nutrition/searchTerms');

const SEARCH_TTL_MS = 24 * 60 * 60 * 1000;
const BARCODE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const BARCODE_MISS_TTL_MS = 6 * 60 * 60 * 1000; // a product may be added to OFF soon
const OFF_SEARCH_FIELDS = 'code,product_name,product_name_nl,product_name_en,generic_name,generic_name_nl,brands,nutriments,serving_size,serving_quantity,product_quantity,product_quantity_unit,quantity,countries_tags';
const OFF_PRODUCT_FIELDS = 'code,product_name,product_name_nl,product_name_en,generic_name,generic_name_nl,brands,nutriments,serving_size,serving_quantity,product_quantity,product_quantity_unit,quantity,countries_tags';
const CACHE_MAX = 800;
// A Firestore hit is kept in memory this long (its own expiry isn't known).
const MEMORY_REFILL_TTL_MS = 60 * 60 * 1000;
const UPSTREAM_TIMEOUT_MS = 4500;
const DEFAULT_LIMIT = 20;
const USDA_PAGE = 15;
const OFF_PAGE = 20;
const DEFAULT_USER_AGENT = 'PocketCoach/1.0 (https://github.com/Butterszzz-art/traininglog-backend)';

// Small LRU with expiry. Map keeps insertion order, so the first key is the
// least recently used one.
function createCache(max = CACHE_MAX) {
  const map = new Map();
  return {
    get(key, now = Date.now()) {
      const hit = map.get(key);
      if (!hit) return undefined;
      if (hit.expires <= now) { map.delete(key); return undefined; }
      map.delete(key);
      map.set(key, hit);
      return hit.value;
    },
    set(key, value, ttl, now = Date.now()) {
      map.delete(key);
      map.set(key, { value, expires: now + ttl });
      while (map.size > max) map.delete(map.keys().next().value);
    },
    get size() { return map.size; },
  };
}

async function getJson(fetchFn, url, headers = {}) {
  const res = await fetchFn(url, { headers: { Accept: 'application/json', ...headers }, signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

// The search itself, shared by GET /api/food/search and the AI search
// assist (src/nutrition/searchAssist.js), with one cache between them.
function createFoodSearcher({
  fetchFn = (...a) => fetch(...a),
  usdaKey = () => process.env.USDA_API_KEY || '',
  userAgent = () => process.env.OFF_USER_AGENT || DEFAULT_USER_AGENT,
  cache = createCache(),
  store = null, // shared cache: { get(key), set(key, value, ttl) }, see searchCache.js
  log = console,
} = {}) {
  // Memory first, then the shared store. undefined = not cached; null is a
  // cached "barcode not found".
  async function cacheGet(key) {
    const hit = cache.get(key);
    if (hit !== undefined || !store) return hit;
    let shared;
    try { shared = await store.get(key); } catch (err) { log.warn(`[food] shared cache read failed: ${err.message}`); return undefined; }
    if (shared !== undefined) cache.set(key, shared, MEMORY_REFILL_TTL_MS);
    return shared;
  }
  function cacheSet(key, value, ttl) {
    cache.set(key, value, ttl);
    // Not awaited: the user's answer doesn't wait for the write.
    if (store) Promise.resolve().then(() => store.set(key, value, ttl)).catch(() => {});
  }

  async function searchUsda(q) {
    const key = usdaKey();
    if (!key || key === 'DEMO_KEY') return { status: 'disabled', foods: [] };
    const url = 'https://api.nal.usda.gov/fdc/v1/foods/search?' + new URLSearchParams({
      query: toEnglish(q).text,
      pageSize: String(USDA_PAGE),
      dataType: 'Foundation,SR Legacy,Survey (FNDDS),Branded',
      api_key: key,
    });
    const data = await getJson(fetchFn, url);
    return { status: 'ok', foods: (data.foods || []).map(foods.mapUsdaFood).filter(Boolean) };
  }

  async function offQuery(q) {
    const url = 'https://search.openfoodfacts.org/search?' + new URLSearchParams({
      q,
      page_size: String(OFF_PAGE),
      langs: 'nl,en',
      fields: OFF_SEARCH_FIELDS,
    });
    const data = await getJson(fetchFn, url, { 'User-Agent': userAgent() });
    return (data.hits || []).map(foods.mapOffProduct).filter(Boolean);
  }

  // Dutch products first: the same words limited to products sold in the
  // Netherlands, run next to the worldwide query (a plain "yoghurt" otherwise
  // starts with Bulgarian products). Either one answering is enough.
  async function searchOff(q) {
    const [nl, all] = await Promise.allSettled([
      offQuery(`${q} countries_tags:"en:netherlands"`),
      offQuery(q),
    ]);
    if (nl.status === 'rejected' && all.status === 'rejected') throw all.reason;
    const list = [...(nl.status === 'fulfilled' ? nl.value.map(f => ({ ...f, nl: true })) : []),
      ...(all.status === 'fulfilled' ? all.value : [])];
    const seen = new Set();
    return { status: 'ok', foods: list.filter(f => (seen.has(f.id) ? false : seen.add(f.id))) };
  }

  // One round of asking the sources. → { foods (ranked), status }
  async function ask(q, want, limit) {
    const runs = await Promise.allSettled(want.map(name => (name === 'off' ? searchOff(q) : searchUsda(q))));
    const status = {};
    const lists = [];
    runs.forEach((r, i) => {
      const name = want[i];
      if (r.status === 'fulfilled') {
        status[name] = r.value.status;
        lists.push(r.value.foods);
      } else {
        status[name] = 'error';
        log.warn(`[food] ${name} search failed for "${q}": ${r.reason && r.reason.message}`);
      }
    });
    return { foods: foods.rankFoods(q, lists, limit, toEnglish(q).text), status };
  }

  // Weak when no top result has every word, in the words typed or in English.
  const weak = (q, list) => foods.isWeakResult(q, list) && foods.isWeakResult(toEnglish(q).text, list);

  // sources: 'off', 'usda' or 'all'. → { foods, sources: { off?, usda? }, corrected? }
  async function search(q, { sources = 'all', limit = 40 } = {}) {
    const key = `s:${sources}:${q}`;
    const cached = await cacheGet(key);
    if (cached) return { ...cached, cached: true };
    const want = sources === 'all' ? ['off', 'usda'] : [sources];
    let { foods: merged, status } = await ask(q, want, limit);
    let corrected = null;
    // Nothing good and a word looks misspelt: try the corrected words, and
    // keep them only if they do better.
    if (weak(q, merged)) {
      const fix = correctTypos(q);
      if (fix.changed && fix.text !== q) {
        const again = await ask(fix.text, want, limit);
        if (again.foods.length && !weak(fix.text, again.foods)) {
          merged = again.foods;
          status = again.status;
          corrected = fix.text;
        }
      }
    }
    const out = { foods: merged, sources: status, ...(corrected ? { corrected } : {}) };
    // Only cache an answer from every source that's switched on, so a
    // passing outage isn't remembered for a day.
    if (!Object.values(status).includes('error')) cacheSet(key, out, SEARCH_TTL_MS);
    return out;
  }

  async function lookupOff(code) {
    const url = `https://world.openfoodfacts.org/api/v2/product/${code}?fields=${OFF_PRODUCT_FIELDS}`;
    try {
      const data = await getJson(fetchFn, url, { 'User-Agent': userAgent() });
      return data && data.status === 1 ? foods.mapOffProduct({ ...data.product, code: data.product?.code || code }) : null;
    } catch (err) {
      if (err.status === 404) return null; // OFF answers 404 for unknown codes
      throw err;
    }
  }

  async function lookupUsda(code) {
    const key = usdaKey();
    if (!key || key === 'DEMO_KEY') return null;
    // Branded foods are indexed by GTIN; USDA stores UPC-A as 12 digits.
    const gtins = [...new Set([code, code.replace(/^0/, '')])];
    for (const gtin of gtins) {
      const url = 'https://api.nal.usda.gov/fdc/v1/foods/search?' + new URLSearchParams({
        query: gtin, dataType: 'Branded', pageSize: '5', api_key: key,
      });
      const data = await getJson(fetchFn, url);
      const hit = (data.foods || []).find(f => foods.normalizeBarcode(f.gtinUpc) === code);
      if (hit) return foods.mapUsdaFood(hit);
    }
    return null;
  }

  return { search, lookupOff, lookupUsda, cache, cacheGet, cacheSet, log };
}

// One searcher per server instance, so the search route and the AI assist
// share a cache.
let defaultSearcher = null;
function getDefaultSearcher() {
  if (!defaultSearcher) defaultSearcher = createFoodSearcher({ store: defaultStore() });
  return defaultSearcher;
}

// The shared Firestore cache when Firebase is set up, else memory only.
function defaultStore() {
  try {
    const { db, firebaseEnabled } = require('../../firebaseAdmin');
    return firebaseEnabled && db ? require('../nutrition/searchCache').createFirestoreStore(db) : null;
  } catch {
    return null;
  }
}

function createFoodRouter({ sendError, sendSuccess, searcher, ...opts } = {}) {
  const router = express.Router();
  const s = searcher || (Object.keys(opts).length ? createFoodSearcher(opts) : getDefaultSearcher());
  const { log } = s;

  router.get('/barcode/:code', async (req, res) => {
    const code = foods.normalizeBarcode(req.params.code);
    if (!code || !foods.validBarcode(code)) {
      return sendError(res, 422, 'food.invalid_barcode', 'That barcode doesn’t look right. Try scanning again or type the numbers under it.');
    }
    const cached = await s.cacheGet(`b:${code}`);
    if (cached !== undefined) {
      if (!cached) return sendError(res, 404, 'food.barcode_not_found', 'This product isn’t in the food databases yet. You can add it yourself.');
      return sendSuccess(res, 200, { food: cached, cached: true });
    }
    let food = null;
    let failed = 0;
    for (const lookup of [s.lookupOff, s.lookupUsda]) {
      try {
        food = await lookup(code);
      } catch (err) {
        failed++;
        log.warn(`[food] barcode ${code} lookup failed: ${err.message}`);
      }
      if (food) break;
    }
    if (!food && failed === 2) return sendError(res, 502, 'food.lookup_unavailable', 'Barcode lookup is unavailable right now. Try again shortly, or add the food yourself.');
    // Only remember a miss when every source actually answered.
    if (food || !failed) s.cacheSet(`b:${code}`, food, food ? BARCODE_TTL_MS : BARCODE_MISS_TTL_MS);
    if (!food) return sendError(res, 404, 'food.barcode_not_found', 'This product isn’t in the food databases yet. You can add it yourself.');
    return sendSuccess(res, 200, { food });
  });

  // ?source=off|usda searches one source, so the app can show Open Food
  // Facts' results (fast) without waiting for USDA (slower); no source =
  // both, merged.
  router.get('/search', async (req, res) => {
    const q = foods.normalizeQuery(req.query.q);
    if (q.length < 2) return sendError(res, 422, 'food.query_too_short', 'Type at least 2 characters.');
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || DEFAULT_LIMIT, 1), 40);
    const sources = ['off', 'usda'].includes(req.query.source) ? req.query.source : 'all';
    const r = await s.search(q, { sources });
    if (!r.foods.length && Object.values(r.sources).every(v => v !== 'ok')) {
      return sendError(res, 502, 'food.search_unavailable', 'Food search is unavailable right now. Try again shortly, or add the food yourself.');
    }
    return sendSuccess(res, 200, {
      foods: r.foods.slice(0, limit), sources: r.sources,
      ...(r.corrected ? { corrected: r.corrected } : {}), ...(r.cached ? { cached: true } : {}),
    });
  });

  return router;
}

module.exports = { createFoodRouter, createFoodSearcher, getDefaultSearcher, createCache, DEFAULT_USER_AGENT };
