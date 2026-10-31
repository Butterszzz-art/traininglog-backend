// node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const { createFirestoreStore, docId } = require('../src/nutrition/searchCache');

function fakeDb() {
  const docs = new Map();
  return {
    docs,
    collection: () => ({
      doc: id => ({
        get: async () => ({ exists: docs.has(id), data: () => docs.get(id) }),
        set: async v => { docs.set(id, v); },
      }),
    }),
  };
}

test('stores and returns a value until it expires', async () => {
  let t = 1000;
  const db = fakeDb();
  const store = createFirestoreStore(db, { now: () => t, log: { warn() {} } });
  await store.set('s:all:kwark', { foods: [{ id: 'off:1' }] }, 500);
  assert.deepEqual(await store.get('s:all:kwark'), { foods: [{ id: 'off:1' }] });
  t = 1600;
  assert.equal(await store.get('s:all:kwark'), undefined);
});

test('a cached null (barcode not found) comes back as null, a miss as undefined', async () => {
  const store = createFirestoreStore(fakeDb(), { log: { warn() {} } });
  await store.set('b:123', null, 1000);
  assert.equal(await store.get('b:123'), null);
  assert.equal(await store.get('b:456'), undefined);
});

test('documents are keyed by a hash and hold only the key, the value and the expiry', async () => {
  const db = fakeDb();
  const store = createFirestoreStore(db, { now: () => 0, log: { warn() {} } });
  await store.set('s:off:kipfilet', { foods: [] }, 1000);
  const doc = db.docs.get(docId('s:off:kipfilet'));
  assert.deepEqual(Object.keys(doc).sort(), ['expiresAt', 'key', 'value']);
  assert.match(docId('x'), /^[0-9a-f]{40}$/);
});

test('oversized values are not stored, and errors count as a miss', async () => {
  const db = fakeDb();
  const store = createFirestoreStore(db, { log: { warn() {} } });
  await store.set('big', { x: 'a'.repeat(600 * 1024) }, 1000);
  assert.equal(db.docs.size, 0);
  const broken = createFirestoreStore({ collection: () => { throw new Error('down'); } }, { log: { warn() {} } });
  assert.equal(await broken.get('k'), undefined);
  await broken.set('k', 1, 1000); // no throw
});
