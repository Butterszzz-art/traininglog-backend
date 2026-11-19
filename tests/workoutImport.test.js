const test = require('node:test');
const assert = require('node:assert/strict');
const { prepareImport, saveImport, isImportedWorkout, MAX_PER_REQUEST } = require('../src/workoutImport');
const { readStoredWorkout } = require('../workoutFormat');

const NOW = Date.parse('2026-11-19T12:00:00Z');

function item(over = {}) {
  return {
    date: '2026-03-02T00:00:00.000Z',
    title: 'Push A',
    workout: {
      id: 'imp_abc123',
      title: 'Push A',
      date: '2026-03-02',
      log: [{ exercise: 'Bench Press', sets: 2, repsArray: [5, 5], weightsArray: [100, 100], unit: 'kg' }],
      ...over.workout,
    },
    ...over.item,
  };
}

test('prepareImport marks sessions imported and computes volume', () => {
  const out = prepareImport({ source: 'strong', workouts: [item()] }, { now: NOW });
  assert.equal(out.skipped, 0);
  assert.equal(out.docs.length, 1);
  const { id, data } = out.docs[0];
  assert.equal(id, 'imp_abc123');
  assert.equal(data.imported, true);
  assert.equal(data.importSource, 'strong');
  assert.equal(data.sessionVolume, 1000);
  const w = readStoredWorkout(data.workout, data.workoutFormat);
  assert.equal(w.imported, true);
  assert.equal(w.log[0].exercise, 'Bench Press');
});

test('prepareImport skips bad rows instead of failing the chunk', () => {
  const out = prepareImport({
    source: 'nope',
    workouts: [
      item(),
      item({ workout: { id: 'not-imported-prefix' } }),
      item({ workout: { log: [] } }),
      item({ item: { date: '2030-01-01' } }),
      item({ item: { date: 'yesterday' } }),
      null,
    ],
  }, { now: NOW });
  assert.equal(out.docs.length, 1);
  assert.equal(out.skipped, 5);
  assert.equal(out.docs[0].data.importSource, 'generic');
});

test('prepareImport rejects empty and oversized bodies', () => {
  assert.ok(prepareImport({ workouts: [] }).error);
  assert.ok(prepareImport({}).error);
  const many = Array.from({ length: MAX_PER_REQUEST + 1 }, () => item());
  assert.ok(prepareImport({ workouts: many }, { now: NOW }).error);
});

test('isImportedWorkout reads docs, data and workout objects', () => {
  assert.equal(isImportedWorkout({ imported: true }), true);
  assert.equal(isImportedWorkout({ workout: { imported: true } }), true);
  assert.equal(isImportedWorkout({ get: k => (k === 'imported' ? true : undefined) }), true);
  assert.equal(isImportedWorkout({ get: () => undefined }), false);
  assert.equal(isImportedWorkout({ workout: { log: [] } }), false);
  assert.equal(isImportedWorkout(null), false);
});

test('saveImport writes every doc and leaves the user totals alone', async () => {
  const writes = new Map();
  const db = {
    collection: path => ({ doc: id => ({ path: `${path}/${id}` }) }),
    batch: () => {
      const pending = [];
      return { set: (ref, data) => pending.push([ref.path, data]), commit: async () => pending.forEach(([p, d]) => writes.set(p, d)) };
    },
  };
  const { docs } = prepareImport({ source: 'hevy', workouts: [item(), item({ workout: { id: 'imp_two' } })] }, { now: NOW });
  const saved = await saveImport(db, 'u1', docs);
  assert.equal(saved, 2);
  assert.deepEqual([...writes.keys()].sort(), ['users/u1/workouts/imp_abc123', 'users/u1/workouts/imp_two']);
  assert.ok(![...writes.keys()].some(k => k === 'users/u1'));
});
