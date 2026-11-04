// Rice, pasta and other grains: cooked or dry?
//
// Packaged grains (rice, pasta, oats...) list their nutrition per 100 g
// DRY, about 350-370 kcal. Their names don't say so ("Witte Rijst"), so a
// user who weighs their cooked rice logs almost three times what they ate
// (cooked white rice is about 130 kcal per 100 g). Two fixes:
//
//   staplesFor(query) — for a plain search like "rijst" or "white rice":
//     reference foods for the cooked and the dry grain (USDA SR Legacy),
//     shown before everything else. Cooked first, unless the user typed
//     "dry"/"raw"/"ongekookt".
//   labelDryWeight(food) — a grain product with dry-weight numbers gets
//     ", dry" after its name, so the list says what the numbers are for.
'use strict';

const { stem } = require('./searchTerms');

// Per 100 g, USDA FoodData Central SR Legacy (NDB numbers in `ref`).
const STAPLES = {
  whiteRice: {
    cooked: { ref: '20045', name: 'White rice, cooked', per100: { kcal: 130, protein: 2.7, carbs: 28.2, fat: 0.3, fiber: 0.4, sugar: 0.1 }, servings: [['1 cup cooked (158 g)', 158], ['1 portion (180 g)', 180]] },
    dry: { ref: '20444', name: 'White rice, dry (uncooked)', per100: { kcal: 365, protein: 7.1, carbs: 80, fat: 0.7, fiber: 1.3, sugar: 0.1 }, servings: [['1 portion dry (75 g)', 75]] },
  },
  brownRice: {
    cooked: { ref: '20037', name: 'Brown rice, cooked', per100: { kcal: 123, protein: 2.7, carbs: 25.6, fat: 1, fiber: 1.6, sugar: 0.2 }, servings: [['1 cup cooked (195 g)', 195], ['1 portion (180 g)', 180]] },
    dry: { ref: '20036', name: 'Brown rice, dry (uncooked)', per100: { kcal: 367, protein: 7.5, carbs: 76.3, fat: 3.2, fiber: 3.6, sugar: 0.7 }, servings: [['1 portion dry (75 g)', 75]] },
  },
  pasta: {
    cooked: { ref: '20121', name: 'Pasta, cooked', per100: { kcal: 158, protein: 5.8, carbs: 30.9, fat: 0.9, fiber: 1.8, sugar: 0.6 }, servings: [['1 cup cooked (140 g)', 140], ['1 portion (200 g)', 200]] },
    dry: { ref: '20120', name: 'Pasta, dry (uncooked)', per100: { kcal: 371, protein: 13, carbs: 74.7, fat: 1.5, fiber: 3.2, sugar: 2.7 }, servings: [['1 portion dry (80 g)', 80]] },
  },
  quinoa: {
    cooked: { ref: '20137', name: 'Quinoa, cooked', per100: { kcal: 120, protein: 4.4, carbs: 21.3, fat: 1.9, fiber: 2.8, sugar: 0.9 }, servings: [['1 cup cooked (185 g)', 185]] },
    dry: { ref: '20035', name: 'Quinoa, dry (uncooked)', per100: { kcal: 368, protein: 14.1, carbs: 64.2, fat: 6.1, fiber: 7, sugar: 0 }, servings: [['1 portion dry (60 g)', 60]] },
  },
  couscous: {
    cooked: { ref: '20029', name: 'Couscous, cooked', per100: { kcal: 112, protein: 3.8, carbs: 23.2, fat: 0.2, fiber: 1.4, sugar: 0.1 }, servings: [['1 cup cooked (157 g)', 157]] },
    dry: { ref: '20028', name: 'Couscous, dry (uncooked)', per100: { kcal: 376, protein: 12.8, carbs: 77.4, fat: 0.6, fiber: 5, sugar: 0 }, servings: [['1 portion dry (70 g)', 70]] },
  },
  oats: {
    // Oats are weighed dry; there's no cooked one worth offering.
    dry: { ref: '08120', name: 'Oats, dry (rolled)', per100: { kcal: 379, protein: 13.2, carbs: 67.7, fat: 6.5, fiber: 10.1, sugar: 1 }, servings: [['½ cup (40 g)', 40]] },
  },
};

// What people type (English and Dutch), after the cooked/dry words and
// "long grain"-type words are taken out.
const ALIASES = {
  whiteRice: ['rice', 'white rice', 'rijst', 'witte rijst', 'basmati', 'basmati rice', 'basmati rijst', 'jasmine rice', 'jasmijn rijst', 'jasmijnrijst', 'pandan rijst', 'pandanrijst', 'long grain rice', 'langkorrelige rijst', 'zilvervliesrijst wit', 'white basmati rice', 'witte basmati rijst', 'snelkook rijst'],
  brownRice: ['brown rice', 'zilvervliesrijst', 'zilvervlies rijst', 'volkoren rijst', 'bruine rijst', 'whole grain rice', 'wholegrain rice'],
  pasta: ['pasta', 'spaghetti', 'penne', 'macaroni', 'fusilli', 'farfalle', 'tagliatelle', 'linguine', 'rigatoni', 'white pasta'],
  quinoa: ['quinoa'],
  couscous: ['couscous'],
  oats: ['oats', 'oat', 'rolled oats', 'havermout', 'oatmeal', 'porridge oats', 'haver'],
};

const DRY_WORDS = new Set(['dry', 'dried', 'raw', 'uncooked', 'droog', 'ongekookt', 'rauw']);
const COOKED_WORDS = new Set(['cooked', 'boiled', 'gekookt', 'gekookte', 'steamed']);
const FILLER = new Set(['g', 'gram', 'grams', 'gr', 'per', '100', '100g', 'of', 'van']);

function fold(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function tokens(s) {
  return fold(s).split(/[^a-z0-9]+/).filter(Boolean);
}

const ALIAS_INDEX = new Map();
Object.entries(ALIASES).forEach(([key, list]) => list.forEach(a => ALIAS_INDEX.set(tokens(a).map(stem).join(' '), key)));

/** Which staple a search means, and whether the user asked for cooked or dry. */
function matchStaple(query) {
  const words = tokens(query).filter(w => !FILLER.has(w) && !/^\d+g?$/.test(w));
  const wantDry = words.some(w => DRY_WORDS.has(w));
  const wantCooked = words.some(w => COOKED_WORDS.has(w));
  const rest = words.filter(w => !DRY_WORDS.has(w) && !COOKED_WORDS.has(w)).map(stem).join(' ');
  const key = ALIAS_INDEX.get(rest);
  return key ? { key, want: wantDry && !wantCooked ? 'dry' : 'cooked' } : null;
}

function toFood(s) {
  return {
    id: `usda:sr-${s.ref}`,
    source: 'usda',
    name: s.name,
    brand: '',
    dataType: 'SR Legacy',
    basis: 'g',
    per100: { ...s.per100 },
    servings: s.servings.map(([label, grams]) => ({ label, grams })),
  };
}

/** Reference foods for a plain grain search, the one asked for first. */
function staplesFor(query) {
  const m = matchStaple(query);
  if (!m) return [];
  const s = STAPLES[m.key];
  const order = m.want === 'dry' ? [s.dry, s.cooked] : [s.cooked, s.dry];
  return order.filter(Boolean).map(toFood);
}

// A grain product whose numbers are clearly dry weight. Rice cakes, rice
// milk, flour, cereal and the like are eaten as they are, so they're left
// alone, as is anything fatty (nut mixes called "rijst").
const GRAIN = /\b(rice|rijst|riz|reis|riso|arroz|pasta|spaghetti|penne|macaroni|fusilli|farfalle|tagliatelle|linguine|rigatoni|lasagne|noodles?|noedels|mie|quinoa|couscous|bulgur|oats|havermout|lentils|linzen)\b/i;
const NOT_DRY_GRAIN = /(cake|wafel|wafer|cracker|chip|crisp|krisp|puff|pop|flour|meel|bloem|drink|milk|melk|vinegar|azijn|bar\b|reep|snack|cereal|flakes|granola|muesli|pudding|pap|sauce|saus|salad|salade|bowl|meal|maaltijd)/i;
const SAYS_STATE = /\b(dry|dried|raw|uncooked|droog|ongekookt|rauw|cooked|gekookt|gekookte|boiled|bereid|prepared)\b/i;

function isDryGrain(food) {
  const p = food && food.per100;
  const name = String(food && food.name || '');
  if (!p || !GRAIN.test(name) || NOT_DRY_GRAIN.test(name) || SAYS_STATE.test(name)) return false;
  return p.kcal >= 300 && p.carbs >= 55 && (p.fat || 0) < 10;
}

/** Adds ", dry" to the name of a dry-weight grain product. */
function labelDryWeight(food) {
  return isDryGrain(food) ? { ...food, name: `${food.name}, dry` } : food;
}

/** A search's results with the staples first and dry grains labelled. */
function withStaples(query, list, limit) {
  const top = staplesFor(query);
  const ids = new Set(top.map(f => f.id));
  const rest = (list || []).filter(f => f && !ids.has(f.id)).map(labelDryWeight);
  const out = [...top, ...rest];
  return limit ? out.slice(0, limit) : out;
}

module.exports = { staplesFor, matchStaple, labelDryWeight, isDryGrain, withStaples, STAPLES };
