// Pure helpers in src/checkInPhotos.js. Run: node scripts/test-checkin-photos.js
const assert = require('assert');
const p = require('../src/checkInPhotos');

const jpeg = (bytes = 64) => 'data:image/jpeg;base64,' + Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(bytes)]).toString('base64');

let passed = 0;
function test(name, fn) { fn(); passed += 1; console.log('ok -', name); }

test('isoDate accepts only plain dates', () => {
  assert.strictEqual(p.isoDate('2026-11-04'), '2026-11-04');
  assert.strictEqual(p.isoDate('2026-11-04T10:00'), null);
  assert.strictEqual(p.isoDate('../x'), null);
});

test('parsePhoto checks the file signature and size', () => {
  assert.strictEqual(p.parsePhoto(jpeg()).mime, 'image/jpeg');
  assert.strictEqual(p.parsePhoto('data:image/jpeg;base64,' + Buffer.from('hello').toString('base64')), null);
  assert.deepStrictEqual(p.parsePhoto(jpeg(p.PHOTO_MAX_BYTES)), { tooLarge: true });
  assert.strictEqual(p.parsePhoto('data:image/gif;base64,R0lGOD'), null);
});

test('parsePhotoList validates count and cleans poses', () => {
  assert.deepStrictEqual(p.parsePhotoList({}), { error: 'missing' });
  assert.deepStrictEqual(p.parsePhotoList({ photos: Array(p.MAX_PHOTOS + 1).fill({ image: jpeg() }) }), { error: 'too_many' });
  assert.deepStrictEqual(p.parsePhotoList({ photos: [{ image: 'nope' }] }), { error: 'invalid' });
  const ok = p.parsePhotoList({ photos: [{ image: jpeg(), pose: ' Front\nrelaxed '.padEnd(90, 'x') }] });
  assert.strictEqual(ok.photos.length, 1);
  assert.ok(ok.photos[0].pose.startsWith('Front relaxed'));
  assert.ok(ok.photos[0].pose.length <= 60);
});

test('nextIndex replaces a date and drops its old photos', () => {
  const r = p.nextIndex({ '2026-11-01': 4 }, '2026-11-01', 2);
  assert.deepStrictEqual(r.index, { '2026-11-01': 2 });
  assert.deepStrictEqual(r.dropped, [{ date: '2026-11-01', count: 4 }]);
});

test('nextIndex keeps only the newest dates', () => {
  const index = {};
  for (let d = 1; d <= p.MAX_DATES; d += 1) index[`2026-10-${String(d).padStart(2, '0')}`] = 1;
  const r = p.nextIndex(index, '2026-11-01', 3);
  assert.strictEqual(Object.keys(r.index).length, p.MAX_DATES);
  assert.ok(!('2026-10-01' in r.index));
  assert.deepStrictEqual(r.dropped, [{ date: '2026-10-01', count: 1 }]);
  // A date older than every kept one is not kept.
  assert.ok(!('2026-09-01' in p.nextIndex(r.index, '2026-09-01', 2).index));
});

test('nextIndex with 0 removes the date', () => {
  const r = p.nextIndex({ '2026-11-01': 3, '2026-10-25': 1 }, '2026-11-01', 0);
  assert.deepStrictEqual(r.index, { '2026-10-25': 1 });
  assert.deepStrictEqual(r.dropped, [{ date: '2026-11-01', count: 3 }]);
});

test('cleanIndex drops junk', () => {
  assert.deepStrictEqual(p.cleanIndex({ '2026-11-01': 2, bad: 3, '2026-11-02': 0, '2026-11-03': 99 }), { '2026-11-01': 2, '2026-11-03': p.MAX_PHOTOS });
});

console.log(`\n${passed} passed`);
