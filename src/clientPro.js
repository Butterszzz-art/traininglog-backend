// Client Pro: clients linked to a coach on an active Coach plan get Pro
// included ("coach_client" entitlement, see src/entitlements.js).
//
// Access lasts while there is real coaching:
//   - granted when the client ACCEPTS the invite (never on a pending invite)
//   - revoked when the link ends (coach removes / client leaves), when the
//     coach's Coach plan ends, or after 30 days without coach activity for
//     that client
//   - granted again automatically when the reason goes away (the coach acts
//     again, or their plan comes back)
// Data always stays with the client; only the entitlement changes.
//
// State is derived: sync(clientUid) looks at every coach link and writes one
// entitlement doc per coach, users/{clientUid}/entitlements/coach_client_{coachUid}:
//   { plan: 'pro', source: 'coach_client', ref: coachUid, expiresAt: null,
//     status, coachUsername, grantedAt, revokedAt, revokedReason, regrantedAt }
// It also writes clientPro ('active' | 'paused_inactive' | 'off') on the
// coach's roster doc so the dashboard can show a badge.
//
// "Coach activity" = lastCoachActivityAt on coaches/{coachUid}/clients/{clientUid},
// set by touch() when the coach assigns/edits a program or nutrition, sends a
// note, publishes a plan or sends a video to that client. acceptedAt counts
// as the first activity.
const { toDate } = require('./entitlements');

const INACTIVITY_DAYS = 30;
const DAY_MS = 86400000;
const docId = coachUid => `coach_client_${coachUid}`;

// Pure: may this client have Pro from this coach right now?
function evaluate({ link, coachHasCoachPlan, now }) {
  if (!link || link.status !== 'active') return { eligible: false, reason: 'unlinked' };
  if (!coachHasCoachPlan) return { eligible: false, reason: 'coach_plan_lapsed' };
  const times = [toDate(link.lastCoachActivityAt), toDate(link.acceptedAt)].filter(Boolean);
  const last = times.length ? new Date(Math.max(...times.map(t => t.getTime()))) : null;
  if (!last || now.getTime() - last.getTime() > INACTIVITY_DAYS * DAY_MS) {
    return { eligible: false, reason: 'inactive' };
  }
  return { eligible: true, reason: null };
}

function rosterBadge(verdict) {
  if (verdict.eligible) return 'active';
  return verdict.reason === 'inactive' ? 'paused_inactive' : 'off';
}

function createClientPro({ db, coachHasCoachPlan, clock = () => new Date(), log = console }) {
  const ents = uid => db.collection('users').doc(uid).collection('entitlements');
  const linkRef = (coachUid, clientUid) => db.collection(`coaches/${coachUid}/clients`).doc(clientUid);

  // Re-evaluates every coach link for one client and writes the result.
  // Returns the summary GET /api/user/plan sends (see summarize()).
  async function sync(clientUid) {
    const now = clock();
    const [invitesSnap, entsSnap] = await Promise.all([
      db.collection(`users/${clientUid}/coachInvites`).get(),
      ents(clientUid).get(),
    ]);
    const existing = {};
    for (const d of entsSnap.docs) {
      const data = d.data();
      if (data.source === 'coach_client' && data.ref) existing[data.ref] = data;
    }
    const invites = {};
    for (const d of invitesSnap.docs) invites[d.id] = d.data();
    const coachUids = new Set([...Object.keys(existing), ...Object.keys(invites).filter(id => invites[id].status === 'active')]);

    const results = [];
    for (const coachUid of coachUids) {
      const linkSnap = await linkRef(coachUid, clientUid).get();
      const link = linkSnap.exists ? linkSnap.data() : null;
      const hasPlan = link && link.status === 'active' ? await coachHasCoachPlan(coachUid) : false;
      const verdict = evaluate({ link, coachHasCoachPlan: hasPlan, now });
      const prev = existing[coachUid] || null;
      const coachUsername = (invites[coachUid] && invites[coachUid].coachUsername) || (prev && prev.coachUsername) || '';

      let next = null;
      if (verdict.eligible) {
        if (!prev || prev.status !== 'active') {
          next = {
            plan: 'pro', source: 'coach_client', ref: coachUid, expiresAt: null, status: 'active',
            coachUsername,
            startsAt: (prev && prev.startsAt) || now,
            createdAt: (prev && prev.createdAt) || now,
            grantedAt: (prev && prev.grantedAt) || now,
            regrantedAt: prev ? now : null,
            revokedAt: null, revokedReason: null,
          };
        }
      } else if (prev && (prev.status !== 'revoked' || prev.revokedReason !== verdict.reason)) {
        next = { status: 'revoked', revokedAt: now, revokedReason: verdict.reason };
      }
      if (next) await ents(clientUid).doc(docId(coachUid)).set(next, { merge: true });

      if (link) {
        const badge = rosterBadge(verdict);
        if (link.clientPro !== badge) {
          await linkRef(coachUid, clientUid).set({ clientPro: badge }, { merge: true })
            .catch(err => log.warn('[clientPro] roster badge write failed:', err.message));
        }
      }
      results.push({ coachUid, coachUsername, ...(prev || {}), ...(next || {}) });
    }
    return summarize(results.filter(r => r.status));
  }

  // The active grant if any, else the most recent revocation.
  function summarize(entries) {
    const pick = entries.find(e => e.status === 'active')
      || entries.slice().sort((a, b) => (toDate(b.revokedAt) || 0) - (toDate(a.revokedAt) || 0))[0];
    if (!pick) return null;
    const iso = v => { const d = toDate(v); return d ? d.toISOString() : null; };
    return {
      active: pick.status === 'active',
      coachUid: pick.coachUid || pick.ref,
      coachName: pick.coachUsername || '',
      grantedAt: iso(pick.grantedAt),
      regrantedAt: iso(pick.regrantedAt),
      revokedAt: pick.status === 'active' ? null : iso(pick.revokedAt),
      revokedReason: pick.status === 'active' ? null : pick.revokedReason || null,
    };
  }

  // Coach did something for these clients: record it and re-sync them.
  async function touch(coachUid, clientUids) {
    const now = clock();
    for (const clientUid of new Set(clientUids || [])) {
      if (!clientUid) continue;
      try {
        const ref = linkRef(coachUid, clientUid);
        const snap = await ref.get();
        if (!snap.exists) continue;
        await ref.set({ lastCoachActivityAt: now }, { merge: true });
        await sync(clientUid);
      } catch (err) {
        log.warn(`[clientPro] touch ${coachUid}→${clientUid} failed:`, err.message);
      }
    }
  }

  // The coach's own plan changed: re-sync every client on their roster.
  async function syncRoster(coachUid) {
    const snap = await db.collection(`coaches/${coachUid}/clients`).get();
    for (const d of snap.docs) {
      try { await sync(d.id); } catch (err) { log.warn(`[clientPro] roster sync ${d.id} failed:`, err.message); }
    }
  }

  return { sync, touch, syncRoster };
}

module.exports = { createClientPro, evaluate, rosterBadge, INACTIVITY_DAYS };
