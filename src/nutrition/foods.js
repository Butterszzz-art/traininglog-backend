// Food data from USDA FoodData Central and Open Food Facts, mapped onto one
// shape the app logs from. Pure functions only (no network, no Express) so
// they can be tested with plain node: scripts/test-food-search.js.
//
// A food:
//   { id: 'usda:171287' | 'off:8710400002970',
//     source: 'usda' | 'off',
//     name, brand, barcode?,          // barcode only for OFF / USDA Branded
//     basis: 'g' | 'ml',              // what "per 100" means
//     per100: { kcal, protein, carbs, fat, fiber?, sugar?, satFat?,
//               sodiumMg?, ironMg?, calciumMg?, potassiumMg?,
//               magnesiumMg?, vitDUg?, b12Ug? },
//     servings: [{ label, grams }] }  // portions besides plain grams
//
// A nutrient the source doesn't list is left out, never set to 0: the app
// shows "no data" for it instead of a fake zero.
'use strict';

const { stem } = require('./searchTerms');

const CORE = ['kcal', 'protein', 'carbs', 'fat'];
const NUTRIENT_KEYS = [
  'kcal', 'protein', 'carbs', 'fat',
  'fiber', 'sugar', 'satFat', 'sodiumMg',
  'ironMg', 'calciumMg', 'potassiumMg', 'magnesiumMg', 'vitDUg', 'b12Ug',
];
const MAX_SERVINGS = 8;

function round(n, digits = 1) {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

// A finite, non-negative number, or null for anything else (missing,
// '', NaN, negative). Number('') and Number(null) are 0, so check first.
function amount(v) {
  if (v === null || v === undefined || v === '' || typeof v === 'boolean') return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function cleanText(v, max = 160) {
  return typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '';
}

// Drops nutrients that came out null and rounds the rest. Returns null when
// the four core values can't be worked out, since such a food can't be
// logged meaningfully.
function finishPer100(raw) {
  const out = {};
  for (const key of NUTRIENT_KEYS) {
    const v = amount(raw[key]);
    if (v === null) continue;
    out[key] = key === 'kcal' ? Math.round(v) : round(v, 1);
  }
  // Calories missing but macros present: fill them in from the macros.
  if (out.kcal === undefined && ['protein', 'carbs', 'fat'].every(k => out[k] !== undefined)) {
    out.kcal = Math.round(out.protein * 4 + out.carbs * 4 + out.fat * 9);
  }
  // A label that lists calories but leaves out a macro it has none of
  // (water, oil, sugar) — treat the missing macro as 0 only in that case.
  if (out.kcal !== undefined) {
    for (const k of ['protein', 'carbs', 'fat']) if (out[k] === undefined) out[k] = 0;
  }
  if (!CORE.every(k => out[k] !== undefined)) return null;
  // Over 100 g of macros per 100 g, or more than pure fat's 900 kcal: bad data.
  if (out.protein + out.carbs + out.fat > 101 || out.kcal > 950) return null;
  return out;
}

function addServing(list, label, grams) {
  const g = amount(grams);
  const l = cleanText(label, 60);
  if (!l || !g || g > 5000) return;
  if (list.some(s => s.label.toLowerCase() === l.toLowerCase())) return;
  list.push({ label: l, grams: round(g, 1) });
}

// ── USDA FoodData Central ────────────────────────────────────────────────────
// Search results list nutrients per 100 g for every data type (Branded
// included). IDs: https://fdc.nal.usda.gov/ (nutrient numbers are the same
// across Foundation, SR Legacy, Survey and Branded).

const USDA_IDS = {
  kcal: [1008, 2047, 2048],
  kj: [1062],
  protein: [1003],
  carbs: [1005, 1050],
  fat: [1004, 1085],
  fiber: [1079],
  sugar: [2000, 1063],
  satFat: [1258],
  sodiumMg: [1093],
  ironMg: [1089],
  calciumMg: [1087],
  potassiumMg: [1092],
  magnesiumMg: [1090],
  vitDUg: [1114],
  vitDIu: [1110],
  b12Ug: [1178],
};

function usdaNutrient(food, ids) {
  const list = Array.isArray(food.foodNutrients) ? food.foodNutrients : [];
  for (const id of ids) {
    const n = list.find(x => Number(x.nutrientId ?? x.nutrient?.id) === id
      || String(x.nutrientNumber ?? x.nutrient?.number) === String(id));
    const v = amount(n && (n.value ?? n.amount));
    if (v !== null) return v;
  }
  return null;
}

function mapUsdaFood(food) {
  if (!food || typeof food !== 'object' || !food.fdcId) return null;
  const pick = key => usdaNutrient(food, USDA_IDS[key]);
  let kcal = pick('kcal');
  if (kcal === null) {
    const kj = pick('kj');
    if (kj !== null) kcal = kj / 4.184;
  }
  let vitD = pick('vitDUg');
  if (vitD === null) {
    const iu = pick('vitDIu');
    if (iu !== null) vitD = iu / 40;
  }
  const per100 = finishPer100({
    kcal, protein: pick('protein'), carbs: pick('carbs'), fat: pick('fat'),
    fiber: pick('fiber'), sugar: pick('sugar'), satFat: pick('satFat'), sodiumMg: pick('sodiumMg'),
    ironMg: pick('ironMg'), calciumMg: pick('calciumMg'), potassiumMg: pick('potassiumMg'),
    magnesiumMg: pick('magnesiumMg'), vitDUg: vitD, b12Ug: pick('b12Ug'),
  });
  if (!per100) return null;

  const unit = String(food.servingSizeUnit || '').toLowerCase();
  const basis = unit === 'ml' || unit === 'mlt' ? 'ml' : 'g';
  const servings = [];
  // Branded: the label serving, e.g. 150 g "1 container".
  const size = amount(food.servingSize);
  if (size && (unit === 'g' || unit === 'grm' || unit === 'ml' || unit === 'mlt')) {
    const household = cleanText(food.householdServingFullText, 40);
    addServing(servings, household ? `${household} (${round(size, 0)}${basis})` : `1 serving (${round(size, 0)}${basis})`, size);
  }
  // Survey (FNDDS) / SR Legacy: household measures with gram weights.
  for (const m of [...(Array.isArray(food.foodMeasures) ? food.foodMeasures : []), ...(Array.isArray(food.foodPortions) ? food.foodPortions : [])]) {
    const text = cleanText(m.disseminationText || m.portionDescription
      || [m.amount, m.modifier || m.measureUnit?.name].filter(Boolean).join(' '), 50);
    if (!text || /quantity not specified/i.test(text)) continue;
    addServing(servings, text, m.gramWeight);
    if (servings.length >= MAX_SERVINGS) break;
  }

  const branded = food.dataType === 'Branded';
  const barcode = branded ? normalizeBarcode(food.gtinUpc) : null;
  return {
    id: `usda:${food.fdcId}`,
    source: 'usda',
    name: branded ? tidyUsdaName(food.description) : shortUsdaName(food.description),
    brand: cleanText(food.brandName || food.brandOwner, 80),
    ...(barcode ? { barcode } : {}),
    dataType: cleanText(food.dataType, 30),
    basis,
    per100,
    servings,
  };
}

// USDA names are often ALL CAPS ("GREEK YOGURT"). Sentence-case those.
function tidyUsdaName(v) {
  const s = cleanText(v);
  if (s && s === s.toUpperCase() && /[A-Z]/.test(s)) return s.charAt(0) + s.slice(1).toLowerCase();
  return s;
}

// USDA's generic foods have catalogue names: "Chicken, broilers or fryers,
// breast, meat only, cooked, roasted". This turns them into what a person
// would type: "Chicken breast, cooked, roasted". Category prefixes
// ("Cereals, oats" → "Oats") and filler segments go; a part or kind is
// joined to the food ("Rice, white" → "White rice", "Chicken, breast" →
// "Chicken breast"); cooking words stay after a comma.
const USDA_CATEGORIES = new Set([
  'cereals', 'cereals ready-to-eat', 'beverages', 'spices', 'snacks', 'candies', 'fish', 'nuts', 'seeds',
  'vegetables', 'fruit', 'fruits', 'babyfood', 'alcoholic beverage', 'alcoholic beverages', 'fast foods',
  'restaurant', 'legumes', 'cheese spread', 'game meat', 'crustaceans', 'mollusks',
]);
const USDA_FILLER = [
  /^broilers or fryers$/, /^meat only$/, /^fluid$/, /^regular$/, /^enriched$/, /^unenriched$/, /^mature seeds$/,
  /^not fortified$/, /^fortified$/, /^all commercial varieties$/, /^commercial$/, /^year round average$/,
  /^salad or cooking$/, /^without salt$/, /^ns as to /, /^nfs$/, /^includes /, /^with added vitamin/,
  /^solids and liquids$/, /^drained solids$/, /^usda commodity/, /^prepared from recipe$/, /^unprepared$/,
];
const USDA_PARTS = new Set([
  'breast', 'thigh', 'thighs', 'leg', 'legs', 'wing', 'wings', 'drumstick', 'drumsticks', 'fillet', 'fillets', 'liver',
  'steak', 'loin', 'tenderloin', 'chop', 'chops', 'ribs', 'shoulder', 'belly', 'juice', 'butter', 'oil', 'flour',
  'sauce', 'milk', 'bread', 'powder',
]);
// "Egg, white" is an egg white, but "Rice, white" is white rice.
const EGG_PARTS = new Set(['white', 'whites', 'yolk', 'yolks']);
const USDA_STATES = /^(raw|cooked|boiled|baked|roasted|fried|grilled|broiled|braised|steamed|stewed|dried|dry|frozen|canned|fresh|toasted|microwaved|scrambled|poached|dry heat|moist heat|pan-fried|unheated|heated|ready-to-eat|ready-to-drink|prepared|with salt|without skin|skin not eaten|from raw|from frozen)(\s|$)/;

function shortUsdaName(v) {
  const full = tidyUsdaName(v);
  let segs = full.split(/\s*,\s*/).filter(Boolean);
  if (segs.length < 2) return full;
  if (USDA_CATEGORIES.has(segs[0].toLowerCase()) && segs.length > 1) segs = segs.slice(1);
  segs = segs.filter((seg, i) => i === 0 || !USDA_FILLER.some(re => re.test(seg.toLowerCase())));
  let [head, ...rest] = segs;
  const next = rest[0];
  // Join a one-word food with a short kind/part that isn't a cooking word.
  if (next && !/\s/.test(head) && next.split(/\s+/).length <= 2 && !USDA_STATES.test(next.toLowerCase()) && !/[\d%()/]/.test(next)) {
    const kind = next.toLowerCase();
    const noun = head.toLowerCase();
    const last = kind.split(/\s+/).pop();
    const isPart = USDA_PARTS.has(last) || (/^eggs?$/.test(noun) && EGG_PARTS.has(last));
    head = isPart ? `${noun} ${kind}` : `${next} ${noun}`;
    rest = rest.slice(1);
  }
  const name = [head, ...rest.slice(0, 4)].join(', ');
  return name.charAt(0).toUpperCase() + name.slice(1);
}

// ── Open Food Facts ──────────────────────────────────────────────────────────
// Nutriments are per 100 g (or 100 ml for drinks). Minerals and vitamins are
// stored in grams, sodium too; salt only when sodium is missing.

function offNum(n, key) {
  return amount(n[key]);
}

function offName(p) {
  const pick = v => (typeof v === 'string' ? v : (v && typeof v === 'object' ? (v.nl || v.en || v.main || Object.values(v)[0]) : ''));
  return cleanText(pick(p.product_name_nl) || pick(p.product_name) || pick(p.product_name_en) || pick(p.generic_name_nl) || pick(p.generic_name));
}

function offBrand(p) {
  const b = Array.isArray(p.brands) ? p.brands[0] : (typeof p.brands === 'string' ? p.brands.split(',')[0] : '');
  return cleanText(b, 80);
}

function mapOffProduct(p) {
  if (!p || typeof p !== 'object') return null;
  const barcode = normalizeBarcode(p.code || p._id);
  const name = offName(p);
  if (!barcode || !name) return null;
  const n = p.nutriments && typeof p.nutriments === 'object' ? p.nutriments : {};
  let kcal = offNum(n, 'energy-kcal_100g');
  if (kcal === null) {
    const kj = offNum(n, 'energy-kj_100g') ?? offNum(n, 'energy_100g');
    if (kj !== null) kcal = kj / 4.184;
  }
  const g2mg = v => (v === null ? null : v * 1000);
  const g2ug = v => (v === null ? null : v * 1e6);
  let sodium = offNum(n, 'sodium_100g');
  if (sodium === null) {
    const salt = offNum(n, 'salt_100g');
    if (salt !== null) sodium = salt / 2.5;
  }
  const per100 = finishPer100({
    kcal,
    protein: offNum(n, 'proteins_100g'),
    carbs: offNum(n, 'carbohydrates_100g'),
    fat: offNum(n, 'fat_100g'),
    fiber: offNum(n, 'fiber_100g'),
    sugar: offNum(n, 'sugars_100g'),
    satFat: offNum(n, 'saturated-fat_100g'),
    sodiumMg: g2mg(sodium),
    ironMg: g2mg(offNum(n, 'iron_100g')),
    calciumMg: g2mg(offNum(n, 'calcium_100g')),
    potassiumMg: g2mg(offNum(n, 'potassium_100g')),
    magnesiumMg: g2mg(offNum(n, 'magnesium_100g')),
    vitDUg: g2ug(offNum(n, 'vitamin-d_100g')),
    b12Ug: g2ug(offNum(n, 'vitamin-b12_100g')),
  });
  if (!per100) return null;

  const qtyUnit = String(p.product_quantity_unit || '').toLowerCase();
  const basis = qtyUnit === 'ml' || /\b\d+(?:[.,]\d+)?\s*(ml|cl|l)\b/i.test(String(p.quantity || '')) ? 'ml' : 'g';
  const servings = [];
  const sq = amount(p.serving_quantity);
  if (sq) {
    const size = cleanText(p.serving_size, 40);
    addServing(servings, size ? `1 serving (${size})` : `1 serving (${round(sq, 0)}${basis})`, sq);
  }
  // Search results carry only the pack text ("250 g", "4 x 125 g"); the
  // product API also has product_quantity.
  const parsed = parseQuantity(p.quantity);
  if (parsed && parsed.count > 1 && parsed.each <= 2000) addServing(servings, `1 unit (${round(parsed.each, 0)}${basis})`, parsed.each);
  const pq = amount(p.product_quantity) || (parsed ? parsed.each * parsed.count : null);
  if (pq && pq <= 2000 && (!sq || Math.abs(pq - sq) > 1)) addServing(servings, `whole pack (${round(pq, 0)}${basis})`, pq);

  const countries = Array.isArray(p.countries_tags) ? p.countries_tags : [];
  return {
    id: `off:${barcode}`,
    source: 'off',
    name,
    brand: offBrand(p),
    barcode,
    basis,
    per100,
    servings,
    ...(countries.includes('en:netherlands') ? { nl: true } : {}),
  };
}

// "250 g" → { count: 1, each: 250 }; "4 x 125 g" → { count: 4, each: 125 };
// "1,5 l" → { count: 1, each: 1500 }. Grams or millilitres; null otherwise.
function parseQuantity(text) {
  const m = /(?:(\d+)\s*[x×]\s*)?(\d+(?:[.,]\d+)?)\s*(kg|g|gr|gram|l|cl|ml)\b/i.exec(String(text || ''));
  if (!m) return null;
  const factor = { kg: 1000, g: 1, gr: 1, gram: 1, l: 1000, cl: 10, ml: 1 }[m[3].toLowerCase()];
  const each = Number(m[2].replace(',', '.')) * factor;
  const count = m[1] ? Number(m[1]) : 1;
  return each > 0 && count > 0 && count <= 48 ? { count, each } : null;
}

// EAN-8, UPC-A (12), EAN-13 and GTIN-14 digits only. UPC-A is padded to 13
// digits the way Open Food Facts stores it.
function normalizeBarcode(v) {
  const s = String(v ?? '').replace(/\D/g, '');
  if (![8, 12, 13, 14].includes(s.length)) return null;
  return s.length === 12 ? '0' + s : s;
}

// GS1 check digit, so a misread scan is caught before any lookup.
function validBarcode(v) {
  const s = normalizeBarcode(v);
  if (!s) return false;
  const digits = s.split('').map(Number);
  const check = digits.pop();
  const sum = digits.reverse().reduce((acc, d, i) => acc + d * (i % 2 === 0 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === check;
}

// ── Ranking ──────────────────────────────────────────────────────────────────
// Merges both sources into one list. A name that contains every word the
// user typed beats one that doesn't; Dutch products and USDA's generic
// foods (Foundation / SR Legacy / Survey) beat US branded products, which
// Dutch users can't buy anyway.

// Lowercase, accents and plurals folded ("Eggs" → "egg"), so "eggs" finds
// "Egg, whole" and "tomato" finds "Tomatoes".
function words(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .split(/[^a-z0-9%]+/).filter(Boolean).map(stem);
}

function scoreFood(food, queryWords, position) {
  const nameOnly = words(food.name);
  const nameWords = words(`${food.name} ${food.brand || ''}`);
  const hits = queryWords.filter(q => nameWords.some(w => w.startsWith(q))).length;
  let score = queryWords.length ? (hits / queryWords.length) * 10 : 0;
  if (nameOnly[0] && queryWords[0] && nameOnly[0].startsWith(queryWords[0])) score += 2;
  // The thing itself before things made with it: "banaan" → a banana before
  // "banaan speltpannenkoek". Exact name wins; each extra word costs a bit.
  // (Not for US branded products: their names are often just the category.)
  const usBranded = food.source === 'usda' && food.dataType === 'Branded';
  if (!usBranded && queryWords.length && nameOnly.join(' ') === queryWords.join(' ')) score += 6;
  const extra = nameOnly.filter(w => !queryWords.some(q => w.startsWith(q))).length;
  score -= Math.min(extra, 4) * 0.6;
  if (food.source === 'off') score += food.nl ? 3 : 1;
  if (food.source === 'usda') score += usBranded ? -2 : 2;
  return score - position * 0.25;
}

// `alsoQuery`: the same search in other words (the English one sent to
// USDA); a food scores by whichever of the two it matches best.
function rankFoods(query, lists, limit = 20, alsoQuery = '') {
  const q = words(query);
  const q2 = alsoQuery && alsoQuery !== query ? words(alsoQuery) : null;
  const seen = new Set();
  const scored = [];
  for (const list of lists) {
    (Array.isArray(list) ? list : []).forEach((food, i) => {
      if (!food) return;
      // Same product from both sources (USDA Branded and OFF share GTINs).
      const key = food.barcode ? `bc:${food.barcode}` : food.id;
      if (seen.has(key)) return;
      seen.add(key);
      const score = q2 ? Math.max(scoreFood(food, q, i), scoreFood(food, q2, i)) : scoreFood(food, q, i);
      scored.push({ food, score });
    });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map(s => s.food);
}

// Whether any of the first few results has every word typed in its name or
// brand (the app's isWeakSearch does the same on the phone).
function isWeakResult(query, list, top = 5) {
  const q = words(query);
  if (!q.length) return false;
  return !(list || []).slice(0, top).some(f => {
    const w = words(`${f.name} ${f.brand || ''}`);
    return q.every(x => w.some(y => y.startsWith(x)));
  });
}

function normalizeQuery(q) {
  return cleanText(String(q || ''), 80).toLowerCase();
}

module.exports = {
  NUTRIENT_KEYS,
  mapUsdaFood,
  mapOffProduct,
  normalizeBarcode,
  validBarcode,
  rankFoods,
  isWeakResult,
  shortUsdaName,
  normalizeQuery,
  finishPer100,
  parseQuantity,
};
