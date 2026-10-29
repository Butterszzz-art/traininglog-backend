// Meals sent to a friend (routes/shares.js) or posted in a group
// (routes/groups.js): the foods with their amounts and macros, plus an
// optional photo of the meal.
//
// The meal data is rebuilt from scratch here rather than stored as sent, so
// a share holds only these fields and the totals always match the foods.
//
// Photos live in their own collection (like profile photos, see
// routes/profiles.js) so listing an inbox or a group's posts never pulls
// image bytes; the app fetches a photo when it shows one. They are deleted
// with the share or post they belong to, and with the account.
//   sharedMealPhotos/{share_<shareId> | post_<postId>} { mime, data, bytes, owner, createdAt }
const { cleanText, parseAvatar } = require('./routes/profiles');

const MEAL_SLOTS = new Set(['breakfast', 'lunch', 'dinner', 'snacks']);
const ITEMS_MAX = 40;
const ITEM_NAME_MAX = 80;
const UNIT_MAX = 12;
const NUM_MAX = 10000;
const PHOTOS = 'sharedMealPhotos';

function num(value, decimals = 1) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  const f = 10 ** decimals;
  return Math.round(Math.min(n, NUM_MAX) * f) / f;
}

// { meal?, items: [{ name, amount?, unit?, grams?, kcal, protein, carbs, fat, fibre? }] }
// → the cleaned meal with totals, or null when there is no food in it.
function cleanMeal(value) {
  if (!value || typeof value !== 'object' || !Array.isArray(value.items)) return null;
  const items = [];
  for (const raw of value.items) {
    if (items.length >= ITEMS_MAX) break;
    if (!raw || typeof raw !== 'object') continue;
    const name = cleanText(String(raw.name ?? ''), ITEM_NAME_MAX);
    if (!name) continue;
    const item = {
      name,
      kcal: num(raw.kcal, 0),
      protein: num(raw.protein),
      carbs: num(raw.carbs),
      fat: num(raw.fat),
    };
    if (raw.amount != null && num(raw.amount) > 0) item.amount = num(raw.amount);
    const unit = cleanText(String(raw.unit ?? ''), UNIT_MAX);
    if (item.amount && unit) item.unit = unit;
    if (raw.grams != null && num(raw.grams) > 0) item.grams = num(raw.grams);
    if (raw.fibre != null) item.fibre = num(raw.fibre);
    items.push(item);
  }
  if (!items.length) return null;
  const sum = k => Math.round(items.reduce((t, i) => t + (i[k] || 0), 0) * 10) / 10;
  const meal = {
    items,
    totals: { kcal: Math.round(sum('kcal')), protein: sum('protein'), carbs: sum('carbs'), fat: sum('fat') },
  };
  if (MEAL_SLOTS.has(value.meal)) meal.meal = value.meal;
  return meal;
}

// Text in a meal that the word filter should see.
function mealText(meal) {
  return meal && Array.isArray(meal.items) ? meal.items.map(i => i.name).join(' ') : '';
}

// A photo sent with a meal: a JPEG/PNG/WebP data URL up to 150 KB (checked
// on the decoded bytes, see parseAvatar). Returns null, { tooLarge: true }
// or { mime, data, bytes }.
function parseMealPhoto(dataUrl) {
  return parseAvatar(dataUrl);
}

const photoDoc = (db, id) => db.collection(PHOTOS).doc(id);

async function saveMealPhoto(db, id, photo, owner) {
  await photoDoc(db, id).set({ mime: photo.mime, data: photo.data, bytes: photo.bytes, owner, createdAt: new Date() });
}

async function readMealPhoto(db, id) {
  const snap = await photoDoc(db, id).get();
  if (!snap.exists) return null;
  return `data:${snap.get('mime')};base64,${snap.get('data')}`;
}

async function deleteMealPhotos(db, ids) {
  await Promise.all((ids || []).filter(Boolean).map(id => photoDoc(db, id).delete()));
}

// Account deletion: every photo the user uploaded (their shares and posts
// are deleted separately, which also covers photos keyed by those ids).
async function deleteUserMealPhotos(db, ownerKey) {
  if (!ownerKey) return;
  const snap = await db.collection(PHOTOS).where('owner', '==', ownerKey).get();
  await Promise.all(snap.docs.map(d => d.ref.delete()));
}

module.exports = {
  cleanMeal, mealText, parseMealPhoto,
  saveMealPhoto, readMealPhoto, deleteMealPhotos, deleteUserMealPhotos,
  sharePhotoId: id => `share_${id}`,
  postPhotoId: id => `post_${id}`,
  ITEMS_MAX,
};
