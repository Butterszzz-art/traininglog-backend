// Tests for src/leadRetention.js against an in-memory stand-in for the parts
// of Firestore it uses. Run: node scripts/test-lead-retention.js
'use strict';

const path = require('path');
const { purgeStaleLeads } = require(path.join(__dirname, '..', 'src', 'leadRetention'));

const results = [];
const check = (label, cond) => results.push({ label, pass: !!cond });

// coaches/{coachUid}/leads/{id} -> { status, createdAt: Date }
function fakeDb(leadsByCoach) {
  const store = JSON.parse(JSON.stringify(leadsByCoach), (k, v) => (k === 'createdAt' ? new Date(v) : v));
  return {
    store,
    collection(name) {
      if (name !== 'coaches') throw new Error('unexpected collection ' + name);
      return {
        listDocuments: async () => Object.keys(store).map(coachUid => ({
          collection: () => ({
            where: (field, op, value) => {
              if (field !== 'createdAt' || op !== '<') throw new Error('unexpected query');
              return {
                get: async () => ({
                  docs: Object.entries(store[coachUid])
                    .filter(([, lead]) => lead.createdAt < value)
                    .map(([id, lead]) => ({
                      get: key => lead[key],
                      ref: { delete: async () => { delete store[coachUid][id]; } },
                    })),
                }),
              };
            },
          }),
        })),
      };
    },
  };
}

(async () => {
  const now = new Date('2026-10-04T00:00:00Z');
  const db = fakeDb({
    coachA: {
      oldNew:       { status: 'new',       createdAt: '2025-09-01T00:00:00Z' },
      oldDismissed: { status: 'dismissed', createdAt: '2025-01-01T00:00:00Z' },
      oldConverted: { status: 'converted', createdAt: '2024-01-01T00:00:00Z' },
      recentNew:    { status: 'new',       createdAt: '2026-06-01T00:00:00Z' },
    },
    coachB: {
      oldNoStatus:  { createdAt: '2025-05-01T00:00:00Z' },
    },
  });

  const { deleted } = await purgeStaleLeads(db, { now });

  check('deletes 3 stale unconverted leads', deleted === 3);
  check('old "new" lead removed', !db.store.coachA.oldNew);
  check('old dismissed lead removed', !db.store.coachA.oldDismissed);
  check('lead without a status removed', !db.store.coachB.oldNoStatus);
  check('converted lead kept', !!db.store.coachA.oldConverted);
  check('lead younger than 12 months kept', !!db.store.coachA.recentNew);

  for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.label}`);
  const failed = results.filter(r => !r.pass).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})();
