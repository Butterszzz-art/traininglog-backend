// Entitlements: every way a user can hold Pro or Coach access, and the one
// "effective plan" computed from them.
//
// Each source of access is a doc in users/{uid}/entitlements/{id}:
//   { plan: 'pro' | 'coach',
//     source: 'stripe_sub' | 'apple_sub' | 'prep_pass' | 'meet_pass'
//           | 'founder_lifetime' | 'reverse_trial' | 'moment_trial'
//           | 'referral' | 'admin' | 'coach_client' | 'coach_code',
//     startsAt, expiresAt (null = no expiry), status: 'active' | 'expired' | 'revoked',
//     ref, createdAt }
//
// Subscriptions still keep their fields on users/{uid} (userPlan, subStatus,
// subSource, …) — billing screens and the stores read those. Each Stripe or
// Apple change also writes a mirror entitlement (see mirrorSubscription).
// Accounts that subscribed before mirrors existed have no entitlement doc yet,
// so the resolver also counts the user doc's own userPlan as a source.
const PLAN_RANK = { free: 0, pro: 1, coach: 2 };
const SUBSCRIPTION_SOURCES = new Set(['stripe_sub', 'apple_sub']);
const FREE = Object.freeze({ plan: 'free', source: null, expiresAt: null, status: 'none', id: null });

function toDate(value) {
  if (value == null || value === '') return null;
  if (value instanceof Date) return isNaN(value.getTime()) ? null : value;
  if (typeof value.toDate === 'function') return value.toDate(); // Firestore Timestamp
  if (typeof value === 'number') return new Date(value);
  const d = new Date(value);
  return isNaN(d.getTime()) ? null : d;
}

function isActive(ent, now) {
  if (!ent || ent.status !== 'active' || !PLAN_RANK[ent.plan]) return false;
  const starts = toDate(ent.startsAt);
  if (starts && starts > now) return false; // stacked pass that hasn't begun
  const expires = toDate(ent.expiresAt);
  return !expires || expires > now;
}

// Higher wins: plan first, then no expiry > later expiry > earlier expiry.
function compare(a, b) {
  const byPlan = PLAN_RANK[a.plan] - PLAN_RANK[b.plan];
  if (byPlan) return byPlan;
  const ea = toDate(a.expiresAt), eb = toDate(b.expiresAt);
  if (!ea && !eb) return 0;
  if (!ea) return 1;
  if (!eb) return -1;
  return ea - eb;
}

// Pure: picks the strongest active entitlement. Returns FREE when none.
function pickEffective(entitlements, now = new Date()) {
  let best = null;
  for (const ent of entitlements || []) {
    if (!isActive(ent, now)) continue;
    if (!best || compare(ent, best) > 0) best = ent;
  }
  if (!best) return { ...FREE };
  return {
    plan: best.plan,
    source: best.source || null,
    expiresAt: toDate(best.expiresAt),
    status: 'active',
    id: best.id || null,
  };
}

// The user doc's own subscription fields as a pseudo-entitlement, so accounts
// with no mirror doc yet (and plans set by hand in the console) keep access.
function legacyEntitlement(userDoc) {
  const u = userDoc || {};
  if (!PLAN_RANK[u.userPlan]) return null;
  const source = u.subSource === 'apple' ? 'apple_sub' : u.subSource === 'stripe' ? 'stripe_sub' : 'admin';
  return { id: 'legacy_user_doc', plan: u.userPlan, source, expiresAt: null, status: 'active' };
}

function createEntitlements({ db, clock = () => new Date(), log = console }) {
  const col = uid => db.collection('users').doc(uid).collection('entitlements');

  async function list(uid) {
    const snap = await col(uid).get();
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  }

  // Lazily marks lapsed entitlements expired. Best effort: a failed write
  // never affects the answer.
  function markExpired(uid, entitlements, now) {
    for (const ent of entitlements) {
      const expires = toDate(ent.expiresAt);
      if (ent.status === 'active' && expires && expires <= now) {
        col(uid).doc(ent.id).set({ status: 'expired' }, { merge: true })
          .catch(err => log.warn(`[entitlements] could not mark ${uid}/${ent.id} expired:`, err.message));
      }
    }
  }

  // { plan, source, expiresAt, status } for the strongest active entitlement.
  // userDoc is optional (pass it when already loaded to save a read).
  async function resolveEffectivePlan(uid, now = clock(), userDoc) {
    if (!uid) return { ...FREE };
    let doc = userDoc;
    if (doc === undefined) {
      const snap = await db.collection('users').doc(uid).get();
      doc = snap.exists ? snap.data() : {};
    }
    const ents = await list(uid);
    markExpired(uid, ents, now);
    const legacy = legacyEntitlement(doc);
    return pickEffective(legacy ? [...ents, legacy] : ents, now);
  }

  // Mirror a Stripe/Apple subscription change. One doc per rail
  // ('stripe_sub' / 'apple_sub'), overwritten on every change.
  async function mirrorSubscription(uid, { plan, status, rail, ref = '', revoked = false }) {
    const source = rail === 'apple' ? 'apple_sub' : 'stripe_sub';
    const live = PLAN_RANK[plan] > 0 && !['canceled', 'incomplete_expired', 'unpaid'].includes(status);
    const now = clock();
    const ref_ = col(uid).doc(source);
    const existing = await ref_.get();
    await ref_.set({
      plan: PLAN_RANK[plan] > 0 ? plan : (existing.exists ? existing.data().plan : 'pro'),
      source,
      startsAt: existing.exists && existing.data().startsAt ? existing.data().startsAt : now,
      expiresAt: null,
      status: live ? 'active' : revoked ? 'revoked' : 'expired',
      ref: String(ref || ''),
      subStatus: status || null,
      createdAt: existing.exists && existing.data().createdAt ? existing.data().createdAt : now,
      updatedAt: now,
    }, { merge: true });
  }

  return { list, resolveEffectivePlan, mirrorSubscription };
}

module.exports = {
  createEntitlements, pickEffective, legacyEntitlement, isActive, toDate,
  PLAN_RANK, SUBSCRIPTION_SOURCES,
};
