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
// and cached in memory per instance, so the same query from many users only
// reaches the upstream APIs once a day.
//
//   GET /search?q=<text>&limit=<n>
//     → { foods: [...], sources: { usda: 'ok'|'error'|'disabled', off: ... } }
'use strict';

const express = require('express');
const foods = require('../nutrition/foods');

const SEARCH_TTL_MS = 24 * 60 * 60 * 1000;
const CACHE_MAX = 800;
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

function createFoodRouter({
  sendError, sendSuccess,
  fetchFn = (...a) => fetch(...a),
  usdaKey = () => process.env.USDA_API_KEY || '',
  userAgent = () => process.env.OFF_USER_AGENT || DEFAULT_USER_AGENT,
  cache = createCache(),
  log = console,
} = {}) {
  const router = express.Router();

  async function searchUsda(q) {
    const key = usdaKey();
    if (!key || key === 'DEMO_KEY') return { status: 'disabled', foods: [] };
    const url = 'https://api.nal.usda.gov/fdc/v1/foods/search?' + new URLSearchParams({
      query: q,
      pageSize: String(USDA_PAGE),
      dataType: 'Foundation,SR Legacy,Survey (FNDDS),Branded',
      api_key: key,
    });
    const data = await getJson(fetchFn, url);
    return { status: 'ok', foods: (data.foods || []).map(foods.mapUsdaFood).filter(Boolean) };
  }

  async function searchOff(q) {
    const url = 'https://search.openfoodfacts.org/search?' + new URLSearchParams({
      q,
      page_size: String(OFF_PAGE),
      langs: 'nl,en',
      fields: 'code,product_name,product_name_nl,product_name_en,generic_name,generic_name_nl,brands,nutriments,serving_size,serving_quantity,product_quantity,product_quantity_unit,quantity,countries_tags',
    });
    const data = await getJson(fetchFn, url, { 'User-Agent': userAgent() });
    return { status: 'ok', foods: (data.hits || []).map(foods.mapOffProduct).filter(Boolean) };
  }

  router.get('/search', async (req, res) => {
    const q = foods.normalizeQuery(req.query.q);
    if (q.length < 2) return sendError(res, 422, 'food.query_too_short', 'Type at least 2 characters.');
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || DEFAULT_LIMIT, 1), 40);

    const cached = cache.get(`s:${q}`);
    if (cached) return sendSuccess(res, 200, { foods: cached.foods.slice(0, limit), sources: cached.sources, cached: true });

    const [usda, off] = await Promise.allSettled([searchUsda(q), searchOff(q)]);
    const sources = {};
    const lists = [];
    for (const [name, r] of [['off', off], ['usda', usda]]) {
      if (r.status === 'fulfilled') {
        sources[name] = r.value.status;
        lists.push(r.value.foods);
      } else {
        sources[name] = 'error';
        log.warn(`[food] ${name} search failed for "${q}": ${r.reason && r.reason.message}`);
      }
    }
    const merged = foods.rankFoods(q, lists, 40);
    // Only cache an answer from every source that's switched on, so a
    // passing outage isn't remembered for a day.
    if (!Object.values(sources).includes('error')) cache.set(`s:${q}`, { foods: merged, sources }, SEARCH_TTL_MS);
    if (!merged.length && Object.values(sources).every(s => s !== 'ok')) {
      return sendError(res, 502, 'food.search_unavailable', 'Food search is unavailable right now. Try again shortly, or add the food yourself.');
    }
    return sendSuccess(res, 200, { foods: merged.slice(0, limit), sources });
  });

  return router;
}

module.exports = { createFoodRouter, createCache, DEFAULT_USER_AGENT };
