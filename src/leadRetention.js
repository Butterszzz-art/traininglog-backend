// Retention for intake leads (coaches/{coachUid}/leads/{leadId}).
//
// privacy.html promises that an intake from someone who does not become a
// client is deleted within 12 months. A converted lead stays: it is now part
// of that client's coaching record and goes with their account. Every other
// status ('new', 'dismissed') is deleted once it is older than maxAgeDays.
//
// Run daily by the purgeStaleLeads scheduled function (functions-entry.js).

const DEFAULT_MAX_AGE_DAYS = 365;

async function purgeStaleLeads(db, { now = new Date(), maxAgeDays = DEFAULT_MAX_AGE_DAYS } = {}) {
  const cutoff = new Date(now.getTime() - maxAgeDays * 86400000);
  let deleted = 0;
  // listDocuments() also returns coach docs that only exist as a parent of
  // subcollections (coaches/{uid} has no fields of its own).
  const coaches = await db.collection('coaches').listDocuments();
  for (const coachRef of coaches) {
    const snap = await coachRef.collection('leads').where('createdAt', '<', cutoff).get();
    for (const doc of snap.docs) {
      if (doc.get('status') === 'converted') continue;
      await doc.ref.delete();
      deleted++;
    }
  }
  return { deleted, cutoff };
}

module.exports = { purgeStaleLeads, DEFAULT_MAX_AGE_DAYS };
