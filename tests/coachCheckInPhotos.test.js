// src/coachCheckInPhotos.js: photos a coach adds to a client's check-in.
const test = require('node:test');
const assert = require('node:assert');
const p = require('../src/coachCheckInPhotos');

const jpeg = (bytes = 64) => 'data:image/jpeg;base64,' + Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(bytes)]).toString('base64');

// In-memory stand-in for the bits of Firestore the module uses.
function fakeDb() {
  const docs = new Map();
  let auto = 0;
  const clone = v => JSON.parse(JSON.stringify(v));
  const snap = (path, data) => ({ id: path.split('/').pop(), exists: data !== undefined, get: f => (data == null ? undefined : data[f]) });
  const docRef = path => ({
    id: path.split('/').pop(), path,
    get: async () => snap(path, docs.get(path)),
    collection: name => coll(`${path}/${name}`),
  });
  const coll = path => ({ doc: id => docRef(`${path}/${id || `autoId${String(++auto).padStart(8, '0')}`}`) });
  return {
    docs,
    collection: coll,
    runTransaction: async fn => fn({
      get: ref => ref.get(),
      set: (ref, data, opts) => docs.set(ref.path, opts && opts.merge ? { ...(docs.get(ref.path) || {}), ...clone(data) } : clone(data)),
      update: (ref, data) => docs.set(ref.path, { ...docs.get(ref.path), ...clone(data) }),
      delete: ref => docs.delete(ref.path),
    }),
  };
}

test('parseUpload validates the image and cleans the pose', () => {
  assert.deepStrictEqual(p.parseUpload({}), { error: 'invalid' });
  assert.deepStrictEqual(p.parseUpload({ image: jpeg(450 * 1024) }), { error: 'too_large' });
  const ok = p.parseUpload({ image: jpeg(), pose: ' Front\nrelaxed ' });
  assert.strictEqual(ok.photo.mime, 'image/jpeg');
  assert.strictEqual(ok.photo.pose, 'Front relaxed');
});

test('cleanIndex drops bad dates, ids and duplicates', () => {
  assert.deepStrictEqual(p.cleanIndex({ '2026-11-01': ['abcdefgh1', 'abcdefgh1', '../x'], bad: ['abcdefgh2'], '2026-11-02': [] }), { '2026-11-01': ['abcdefgh1'] });
  assert.deepStrictEqual(p.counts({ '2026-11-01': ['abcdefgh1', 'abcdefgh2'] }), { '2026-11-01': 2 });
});

test('addToIndex caps photos per date and dates per client', () => {
  const full = { '2026-11-01': Array.from({ length: p.MAX_PER_DATE }, (_v, i) => `photo000${i}`) };
  assert.deepStrictEqual(p.addToIndex(full, '2026-11-01', 'photo0999'), { error: 'too_many' });
  const many = {};
  for (let i = 0; i < p.MAX_DATES; i += 1) many[new Date(Date.UTC(2024, 0, 1 + i)).toISOString().slice(0, 10)] = ['photo0001'];
  assert.deepStrictEqual(p.addToIndex(many, '2026-11-01', 'photo0002'), { error: 'too_many_dates' });
  // An existing date still takes more photos.
  assert.ok(p.addToIndex(many, '2024-01-01', 'photo0002').index);
});

test('removeFromIndex drops the date with its last photo', () => {
  assert.deepStrictEqual(p.removeFromIndex({ '2026-11-01': ['photo0001'], '2026-10-25': ['photo0002'] }, '2026-11-01', 'photo0001'), { '2026-10-25': ['photo0002'] });
  assert.strictEqual(p.removeFromIndex({}, '2026-11-01', 'photo0001'), null);
});

test('add, read and remove photos under the roster doc', async () => {
  const db = fakeDb();
  db.docs.set('coaches/c1/clients/u1', { status: 'active' });
  const photo = p.parseUpload({ image: jpeg(), pose: 'Front' }).photo;
  const a = await p.addPhoto(db, 'c1', 'u1', '2026-11-10', photo);
  const b = await p.addPhoto(db, 'c1', 'u1', '2026-11-10', { ...photo, pose: 'Back' });
  assert.strictEqual(b.count, 2);
  assert.deepStrictEqual(await p.readIndex(db, 'c1', 'u1'), { '2026-11-10': [a.id, b.id] });
  const read = await p.readPhotos(db, 'c1', 'u1', '2026-11-10');
  assert.deepStrictEqual(read.map(x => [x.id, x.pose, x.addedBy]), [[a.id, 'Front', 'coach'], [b.id, 'Back', 'coach']]);
  assert.ok(read[0].image.startsWith('data:image/jpeg;base64,'));
  // Another coach's roster is separate.
  assert.deepStrictEqual(await p.readPhotos(db, 'c2', 'u1', '2026-11-10'), []);

  assert.strictEqual(await p.removePhoto(db, 'c1', 'u1', '2026-11-10', a.id), 1);
  assert.strictEqual(await p.removePhoto(db, 'c1', 'u1', '2026-11-10', a.id), null);
  assert.strictEqual(await p.removePhoto(db, 'c1', 'u1', '2026-11-10', b.id), 0);
  assert.deepStrictEqual(await p.readIndex(db, 'c1', 'u1'), {});
  assert.ok(![...db.docs.keys()].some(k => k.includes('/checkInPhotos/')));
});
