// Coaching notifications, kept beside the in-app inbox (src/routes/
// notifications.js) so an athlete sees a coach's invite, notes and plan
// changes in the same bell as everything else, and a coach sees when an
// invite is accepted.
//
// The coach routes live in server.js and know the client by uid; these
// helpers take usernames. Each one swallows its own errors (notify() never
// throws, and the update/delete here are wrapped) so a notification can
// never fail the coaching action itself.
const { notify, collapsedRef } = require('./routes/notifications');
const { profileKey } = require('./routes/profiles');

// One invite row per coach, so re-inviting after a cancel replaces it.
const inviteKey = coach => `coach_invite__${profileKey(coach)}`;

async function notifyCoachInvite(db, { coachUsername, clientUsername }) {
  return notify(db, {
    to: clientUsername, type: 'coach_invite', actor: coachUsername, actorName: coachUsername,
    text: 'wants to coach you', data: { coach: coachUsername, status: 'pending' },
    collapseKey: inviteKey(coachUsername),
  });
}

// The athlete accepted (from the bell or from Settings › Your Coach): the
// invite row stops offering Accept, and the coach is told.
async function coachInviteAccepted(db, { coachUsername, clientUsername }) {
  try {
    const ref = collapsedRef(db, clientUsername, inviteKey(coachUsername));
    const snap = await ref.get();
    if (snap.exists) {
      await ref.set({ read: true, text: 'is now your coach', data: { ...(snap.get('data') || {}), status: 'accepted' } }, { merge: true });
    }
  } catch (err) {
    console.error('[notifications] coach invite update failed:', err.message);
  }
  return notify(db, {
    to: coachUsername, type: 'coach_accepted', actor: clientUsername, actorName: clientUsername,
    text: 'accepted your coaching invite', data: { client: clientUsername },
  });
}

// The coach cancelled a pending invite, or the athlete declined or left:
// drop the invite row so nobody taps Accept on something that's gone.
async function coachInviteWithdrawn(db, { coachUsername, clientUsername }) {
  try {
    const ref = collapsedRef(db, clientUsername, inviteKey(coachUsername));
    const snap = await ref.get();
    if (snap.exists && snap.get('data')?.status !== 'accepted') await ref.delete();
  } catch (err) {
    console.error('[notifications] coach invite cleanup failed:', err.message);
  }
}

// The athlete declined a pending invite or left: the coach is told, and the
// athlete's invite row goes.
async function coachLeftByClient(db, { coachUsername, clientUsername, wasPending }) {
  await coachInviteWithdrawn(db, { coachUsername, clientUsername });
  return notify(db, {
    to: coachUsername, type: 'coach_left', actor: clientUsername, actorName: clientUsername,
    text: wasPending ? 'declined your coaching invite' : 'stopped being coached by you',
    data: { client: clientUsername, declined: !!wasPending },
  });
}

async function notifyCoachNote(db, { coachUsername, clientUsername }) {
  return notify(db, {
    to: clientUsername, type: 'coach_note', actor: coachUsername, actorName: coachUsername,
    text: 'sent you a note', data: { coach: coachUsername },
    collapseKey: `coach_note__${profileKey(coachUsername)}`,
  });
}

// fields: what the coach changed — { currentProgram?, nutritionSummary?, trainingMode? }
async function notifyCoachPlan(db, { coachUsername, clientUsername, fields = {} }) {
  const parts = [];
  if (fields.currentProgram) parts.push('program');
  if (fields.nutritionSummary || fields.macroPlan) parts.push('nutrition');
  if (fields.trainingMode && !parts.length) parts.push('training plan');
  if (!parts.length) return 0;
  return notify(db, {
    to: clientUsername, type: 'coach_plan', actor: coachUsername, actorName: coachUsername,
    text: `updated your ${parts.join(' and ')}`,
    data: { coach: coachUsername, program: fields.currentProgram ? String(fields.currentProgram).slice(0, 80) : '' },
    collapseKey: `coach_plan__${profileKey(coachUsername)}`,
  });
}

// A coach shared a video (src/routes/coachVideos.js). Repeats from the same
// coach collapse into one "sent you N videos" row while it's unread.
async function notifyCoachVideo(db, { coachUsername, clientUsernames, title }) {
  return notify(db, {
    to: clientUsernames, type: 'coach_video', actor: coachUsername, actorName: coachUsername,
    text: 'sent you a video', data: { coach: coachUsername, title: String(title || '').slice(0, 80) },
    collapseKey: `coach_video__${profileKey(coachUsername)}`,
  });
}

module.exports = { notifyCoachInvite, coachInviteAccepted, coachInviteWithdrawn, coachLeftByClient, notifyCoachNote, notifyCoachPlan, notifyCoachVideo };
