// Free, rule-based help for food search (no AI, no network):
//   - toEnglish: Dutch and British food words → the American words USDA
//     uses ("kipfilet" → "chicken breast", "courgette" → "zucchini").
//     Open Food Facts gets the words as typed, since it knows Dutch.
//   - correctTypos: fixes a misspelt food word ("chiken" → "chicken",
//     "yoghurd" → "yoghurt"). Only used when the search as typed found
//     nothing good, so brand names the word list doesn't know stay as typed.
//   - stem: "eggs" / "tomatoes" / "berries" → "egg" / "tomato" / "berry",
//     so a plural matches the singular in a name.
// Pro users still get AI search (searchAssist.js) for what this can't fix.
'use strict';

// Dutch → USDA English. Multi-word keys are matched before single words.
const NL_EN = {
  kipfilet: 'chicken breast', kippenborst: 'chicken breast', kippendij: 'chicken thigh', kippendijen: 'chicken thigh',
  kippendijfilet: 'chicken thigh', kip: 'chicken', kalkoen: 'turkey', kalkoenfilet: 'turkey breast',
  rundergehakt: 'ground beef', gehakt: 'ground beef', rundvlees: 'beef', biefstuk: 'beef steak', varkensvlees: 'pork',
  varkenshaas: 'pork tenderloin', spek: 'bacon', ham: 'ham', worst: 'sausage', rookworst: 'smoked sausage',
  zalm: 'salmon', tonijn: 'tuna', kabeljauw: 'cod', garnalen: 'shrimp', makreel: 'mackerel', haring: 'herring', vis: 'fish',
  ei: 'egg', eieren: 'egg', eiwit: 'egg white', eidooier: 'egg yolk',
  melk: 'milk', 'halfvolle melk': 'milk reduced fat', 'volle melk': 'milk whole', 'magere melk': 'milk nonfat',
  karnemelk: 'buttermilk', kwark: 'quark', 'magere kwark': 'quark nonfat', yoghurt: 'yogurt', 'griekse yoghurt': 'greek yogurt',
  kaas: 'cheese', 'geitenkaas': 'goat cheese', roomkaas: 'cream cheese', boter: 'butter', room: 'cream', slagroom: 'whipping cream',
  brood: 'bread', volkorenbrood: 'whole wheat bread', witbrood: 'white bread', beschuit: 'rusk', crackers: 'crackers',
  havermout: 'oats', muesli: 'muesli', rijst: 'rice', 'zilvervliesrijst': 'brown rice', 'witte rijst': 'white rice',
  pasta: 'pasta', volkorenpasta: 'whole wheat pasta', aardappel: 'potato', aardappelen: 'potato', zoete: 'sweet',
  'zoete aardappel': 'sweet potato', friet: 'french fries', patat: 'french fries', couscous: 'couscous', quinoa: 'quinoa',
  pindakaas: 'peanut butter', hagelslag: 'chocolate sprinkles', jam: 'jam', honing: 'honey', suiker: 'sugar', chocolade: 'chocolate',
  noten: 'nuts', amandelen: 'almonds', walnoten: 'walnuts', cashewnoten: 'cashews', pinda: 'peanuts', pindas: 'peanuts',
  appel: 'apple', banaan: 'banana', sinaasappel: 'orange', peer: 'pear', aardbei: 'strawberry', aardbeien: 'strawberry',
  blauwe: 'blue', 'blauwe bessen': 'blueberries', bosbessen: 'blueberries', frambozen: 'raspberries', druiven: 'grapes',
  ananas: 'pineapple', mango: 'mango', kiwi: 'kiwi', citroen: 'lemon', watermeloen: 'watermelon', meloen: 'melon',
  groente: 'vegetables', broccoli: 'broccoli', bloemkool: 'cauliflower', spinazie: 'spinach', sla: 'lettuce', tomaat: 'tomato',
  tomaten: 'tomato', komkommer: 'cucumber', paprika: 'bell pepper', ui: 'onion', uien: 'onion', knoflook: 'garlic',
  wortel: 'carrot', wortels: 'carrot', worteltjes: 'carrot', champignons: 'mushrooms', boontjes: 'green beans',
  sperziebonen: 'green beans', erwten: 'peas', doperwten: 'peas', mais: 'corn', bonen: 'beans', kidneybonen: 'kidney beans',
  kikkererwten: 'chickpeas', linzen: 'lentils', avocado: 'avocado', olijfolie: 'olive oil', olie: 'oil', zonnebloemolie: 'sunflower oil',
  pannenkoek: 'pancake', pannenkoeken: 'pancake', koekje: 'cookie', koekjes: 'cookies', taart: 'cake', ijs: 'ice cream',
  sap: 'juice', jus: 'juice', 'jus d\'orange': 'orange juice', bier: 'beer', wijn: 'wine', koffie: 'coffee', thee: 'tea',
  soep: 'soup', saus: 'sauce', mayonaise: 'mayonnaise', ketchup: 'ketchup', mosterd: 'mustard', tofu: 'tofu',
  gekookt: 'cooked', gebakken: 'fried', rauw: 'raw', gegrild: 'grilled', mager: 'lean', volkoren: 'whole wheat',
};

// British → USDA (American) English.
const UK_US = {
  courgette: 'zucchini', courgettes: 'zucchini', aubergine: 'eggplant', aubergines: 'eggplant', coriander: 'cilantro',
  rocket: 'arugula', 'spring onion': 'green onion', 'spring onions': 'green onion', beetroot: 'beets', swede: 'rutabaga',
  prawn: 'shrimp', prawns: 'shrimp', mince: 'ground beef', 'beef mince': 'ground beef', 'turkey mince': 'ground turkey',
  crisps: 'potato chips', 'jacket potato': 'baked potato', porridge: 'oatmeal', 'porridge oats': 'oats',
  'semi-skimmed milk': 'milk reduced fat', 'semi skimmed milk': 'milk reduced fat', 'skimmed milk': 'milk nonfat',
  'skimmed': 'nonfat', 'double cream': 'heavy cream', 'single cream': 'light cream', yoghurt: 'yogurt', 'icing sugar': 'powdered sugar',
  'caster sugar': 'sugar', 'cornflour': 'cornstarch', 'mangetout': 'snow peas', 'broad beans': 'fava beans', gammon: 'ham',
  'streaky bacon': 'bacon', 'back bacon': 'canadian bacon', biscuit: 'cookie', biscuits: 'cookies', 'wholemeal': 'whole wheat',
  'wholemeal bread': 'whole wheat bread', sultanas: 'raisins', 'minced beef': 'ground beef',
};

// Food words the typo fixer may correct towards (besides the words above).
const EXTRA_WORDS = [
  'chicken', 'breast', 'thigh', 'beef', 'steak', 'pork', 'turkey', 'salmon', 'tuna', 'shrimp', 'egg', 'eggs', 'white', 'yolk',
  'milk', 'yogurt', 'yoghurt', 'cheese', 'cheddar', 'mozzarella', 'parmesan', 'cottage', 'butter', 'cream', 'bread', 'bagel',
  'tortilla', 'wrap', 'oats', 'oatmeal', 'granola', 'cereal', 'rice', 'pasta', 'spaghetti', 'noodles', 'potato', 'potatoes',
  'sweet', 'banana', 'apple', 'orange', 'strawberry', 'strawberries', 'blueberries', 'raspberries', 'grapes', 'pineapple',
  'broccoli', 'spinach', 'lettuce', 'tomato', 'tomatoes', 'cucumber', 'pepper', 'onion', 'garlic', 'carrot', 'carrots',
  'mushrooms', 'beans', 'lentils', 'chickpeas', 'avocado', 'almonds', 'walnuts', 'peanut', 'peanuts', 'cashews', 'protein',
  'powder', 'whey', 'shake', 'bar', 'chocolate', 'honey', 'sugar', 'olive', 'oil', 'coconut', 'salad', 'sandwich', 'pizza',
  'burger', 'fries', 'soup', 'sauce', 'juice', 'coffee', 'tea', 'cooked', 'raw', 'grilled', 'fried', 'baked', 'boiled',
  'roasted', 'lean', 'ground', 'skim', 'nonfat', 'lowfat', 'greek', 'plain', 'vanilla', 'skyr', 'quark', 'kwark',
  'hagelslag', 'pindakaas', 'havermout', 'kipfilet', 'rijst', 'banaan', 'appel', 'aardappel', 'brood', 'kaas', 'melk',
];

function fold(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

// "eggs" → "egg", "tomatoes" → "tomato", "berries" → "berry", "glass" stays.
function stem(word) {
  const w = fold(word);
  if (w.length <= 3) return w;
  if (/ies$/.test(w) && w.length > 4) return w.slice(0, -3) + 'y';
  if (/(oes|ches|shes|xes|sses)$/.test(w)) return w.slice(0, -2);
  if (/[^su]s$/.test(w)) return w.slice(0, -1);
  return w;
}

// Replaces the longest matching phrases first (up to 3 words).
function replacePhrases(text, map) {
  const tokens = fold(text).split(/\s+/).filter(Boolean);
  const out = [];
  let changed = false;
  for (let i = 0; i < tokens.length;) {
    let hit = null;
    for (let n = Math.min(3, tokens.length - i); n >= 1; n--) {
      const phrase = tokens.slice(i, i + n).join(' ');
      if (Object.prototype.hasOwnProperty.call(map, phrase)) { hit = { n, value: map[phrase] }; break; }
    }
    if (hit) { out.push(hit.value); i += hit.n; changed = true; } else { out.push(tokens[i]); i += 1; }
  }
  return { text: out.join(' '), changed };
}

// Words for USDA: Dutch and British food words in American English.
// → { text, changed }
function toEnglish(query) {
  const nl = replacePhrases(query, NL_EN);
  const uk = replacePhrases(nl.text, UK_US);
  // "chicken breast chicken" after translating "kip kipfilet" — drop repeats.
  const seen = new Set();
  const text = uk.text.split(' ').filter(w => (seen.has(w) ? false : seen.add(w))).join(' ');
  return { text, changed: nl.changed || uk.changed };
}

// Damerau-Levenshtein distance (adjacent swaps count as one), capped.
function distance(a, b, cap = 3) {
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    let rowMin = Infinity;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      rowMin = Math.min(rowMin, d[i][j]);
    }
    if (rowMin > cap) return cap + 1;
  }
  return d[a.length][b.length];
}

const VOCAB = [...new Set([
  ...Object.keys(NL_EN), ...Object.keys(UK_US), ...Object.values(NL_EN), ...Object.values(UK_US), ...EXTRA_WORDS,
].flatMap(p => fold(p).split(/\s+/)).filter(w => w.length >= 3))];
const VOCAB_SET = new Set(VOCAB);

// The closest known food word, or null when none is close enough. Short
// words need to be nearer: 1 edit for 4-6 letters, 2 for 7 or more.
function closestWord(word) {
  const w = fold(word);
  if (w.length < 4 || /\d/.test(w) || VOCAB_SET.has(w) || VOCAB_SET.has(stem(w))) return null;
  const max = w.length >= 7 ? 2 : 1;
  let best = null;
  let bestD = max + 1;
  for (const v of VOCAB) {
    if (Math.abs(v.length - w.length) > max) continue;
    const dd = distance(w, v, max);
    if (dd < bestD) { best = v; bestD = dd; }
  }
  return best;
}

// → { text, changed }: each unknown word replaced by the closest food word.
function correctTypos(query) {
  let changed = false;
  const text = fold(query).split(/\s+/).filter(Boolean).map(w => {
    const fix = closestWord(w);
    if (fix && fix !== w) { changed = true; return fix; }
    return w;
  }).join(' ');
  return { text, changed };
}

module.exports = { toEnglish, correctTypos, closestWord, stem, distance, NL_EN, UK_US };
