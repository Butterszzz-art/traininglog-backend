// Coach Pro codes: every coach on the Coach plan has a short code. An athlete
// who enters it under Settings › Account is linked to that coach as a client
// and gets Pro for as long as both hold:
//   - the link is still active (neither side removed it), and
//   - the coach still has the Coach plan.
//
// Storage:
//   coachCodes/{CODE}                       { coachUid, coachUsername, createdAt }
//   users/{coachUid}.coachCode              the coach's current code
//   users/{clientUid}/entitlements/coach_code
//     { plan: 'pro', source: 'coach_code', ref: coachUid, coachUsername,
//       status: 'active' | 'paused' | 'revoked', expiresAt: null, … }
//
// 'paused' means the coach's plan lapsed: Pro comes back by itself if the coach
// resubscribes. 'revoked' means the link is gone: the athlete has to enter a
// code again. verify() keeps the status current; it runs on every plan read.
const crypto = require('crypto');

// No 0/O or 1/I, so a code read aloud or copied by hand still works.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;
const CODE_RE = new RegExp(`^[${ALPHABET}]{${CODE_LENGTH}}$`);
const ENTITLEMENT_ID = 'coach_code';
const COACH_CHECK_TTL_MS = 5 * 60 * 1000;

// "abcd-efgh " → "ABCDEFGH"; null when it can't be a code.
function normalizeCode(input) {
  const code = String(input == null ? '' : input).toUpperCase().replace(/[\s-]/g, '');
  return CODE_RE.test(code) ? code : null;
}

// "ABCDEFGH" → "ABCD-EFGH", the form shown to people.
function formatCode(code) {
  return code ? `${code.slice(0, 4)}-${code.slice(4)}` : '';
}

function generateCode(randomInt = crypto.randomInt) {
  let out = '';
  for (let i = 0; i < CODE_LENGTH; i++) out += ALPHABET[randomInt(ALPHABET.length)];
  return out;
}

// What a client's entitlement status should be.
function wantedStatus({ linked, coachHasPlan }) {
  if (!linked) return 'revoked';
  return coachHasPlan ? 'active' : 'paused';
}

function createCoachCodes({ db, coachHasPlan, clock = () => new Date(), randomInt = crypto.randomInt, log = console }) {
  const codeRef = code => db.collection('coachCodes').doc(code);
  const userRef = uid => db.collection('users').doc(uid);
  const entRef = uid => userRef(uid).collection('entitlements').doc(ENTITLEMENT_ID);
  const coachCache = new Map(); // coachUid → { ok, at }

  async function coachActive(coachUid) {
    const hit = coachCache.get(coachUid);
    const now = clock().getTime();
    if (hit && now - hit.at < COACH_CHECK_TTL_MS) return hit.ok;
    const ok = !!(await coachHasPlan(coachUid));
    coachCache.set(coachUid, { ok, at: now });
    return ok;
  }

  // Claims a fresh, unused code for the coach. create() fails if the code is
  // taken, so two coaches can never share one.
  async function claimNew(coachUid, coachUsername) {
    for (let attempt = 0; attempt < 6; attempt++) {
      const code = generateCode(randomInt);
      try {
        await codeRef(code).create({ coachUid, coachUsername: coachUsername || '', createdAt: clock() });
        await userRef(coachUid).set({ coachCode: code }, { merge: true });
        return code;
      } catch (err) {
        if (err && (err.code === 6 || /already exists/i.test(err.message || ''))) continue;
        throw err;
      }
    }
    throw new Error('Could not find a free coach code');
  }

  // The coach's current code, made on first use.
  async function getOrCreate(coachUid, coachUsername) {
    const snap = await userRef(coachUid).get();
    const current = snap.exists ? snap.get('coachCode') : null;
    if (current) {
      const owner = await codeRef(current).get();
      if (owner.exists && owner.get('coachUid') === coachUid) return current;
    }
    return claimNew(coachUid, coachUsername);
  }

  // A new code; the old one stops working. Clients who already used the old
  // one keep Pro: their entitlement names the coach, not the code.
  async function regenerate(coachUid, coachUsername) {
    const snap = await userRef(coachUid).get();
    const old = snap.exists ? snap.get('coachCode') : null;
    const code = await claimNew(coachUid, coachUsername);
    if (old && old !== code) {
      const owner = await codeRef(old).get();
      if (owner.exists && owner.get('coachUid') === coachUid) await codeRef(old).delete();
    }
    return code;
  }

  // For account deletion.
  async function removeForCoach(coachUid) {
    const snap = await userRef(coachUid).get();
    const code = snap.exists ? snap.get('coachCode') : null;
    if (!code) return;
    const owner = await codeRef(code).get();
    if (owner.exists && owner.get('coachUid') === coachUid) await codeRef(code).delete();
  }

  // { coachUid, coachUsername } for a typed code, or null.
  async function lookup(input) {
    const code = normalizeCode(input);
    if (!code) return null;
    const snap = await codeRef(code).get();
    if (!snap.exists || !snap.get('coachUid')) return null;
    return { code, coachUid: snap.get('coachUid'), coachUsername: snap.get('coachUsername') || '' };
  }

  // Gives the client Pro from this coach. Replaces Pro from any earlier code.
  async function grant(clientUid, { coachUid, coachUsername, code }) {
    const now = clock();
    await entRef(clientUid).set({
      plan: 'pro',
      source: 'coach_code',
      ref: coachUid,
      coachUsername: coachUsername || '',
      code: code || '',
      startsAt: now,
      expiresAt: null,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    });
  }

  // Brings the client's coach-code Pro up to date. Returns
  // { status, coachUsername } or null when they never used a code.
  async function verify(clientUid) {
    if (!clientUid) return null;
    const snap = await entRef(clientUid).get();
    if (!snap.exists) return null;
    const ent = snap.data();
    const coachUid = ent.ref;
    let status = ent.status;
    // A revoked code stays revoked; only entering a code again restores it.
    if (status !== 'revoked' && coachUid) {
      const link = await db.collection(`users/${clientUid}/coachInvites`).doc(coachUid).get();
      const linked = link.exists && link.get('status') === 'active';
      status = wantedStatus({ linked, coachHasPlan: linked ? await coachActive(coachUid) : false });
      if (status !== ent.status) {
        await entRef(clientUid).set({ status, updatedAt: clock() }, { merge: true })
          .catch(err => log.warn(`[coachCode] status write for ${clientUid} failed:`, err.message));
      }
    }
    return { status, coachUsername: ent.coachUsername || '' };
  }

  function forgetCoach(coachUid) { coachCache.delete(coachUid); }

  return { getOrCreate, regenerate, removeForCoach, lookup, coachIsActive: coachActive, grant, verify, forgetCoach };
}

module.exports = {
  createCoachCodes, normalizeCode, formatCode, generateCode, wantedStatus,
  ALPHABET, CODE_LENGTH, ENTITLEMENT_ID,
};
