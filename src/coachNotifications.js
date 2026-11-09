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
// announce (optional) says exactly what arrived, for the client's "New from
// your coach" sheet: { kind: 'plan' | 'program', name, version?, message?, key }.
// The push reads e.g. "arman published your plan: 16-week X-frame plan".
async function notifyCoachPlan(db, { coachUsername, clientUsername, fields = {}, announce = null }) {
  if (announce && ['plan', 'program', 'meals'].includes(announce.kind)) {
    const name = String(announce.name || '').slice(0, 60);
    const message = String(announce.message || '').trim();
    let text = announce.kind === 'meals' ? 'sent you a meal plan'
      : announce.kind === 'program'
      ? `sent you a new program${name ? `: ${name}` : ''}`
      : announce.version > 1 ? `published version ${announce.version} of your plan` : `published your plan${name ? `: ${name}` : ''}`;
    if (message) text += ` · "${message.length > 70 ? `${message.slice(0, 67)}…` : message}"`;
    return notify(db, {
      to: clientUsername, type: 'coach_plan', actor: coachUsername, actorName: coachUsername,
      text,
      data: {
        coach: coachUsername, kind: announce.kind, name, version: Number(announce.version) || 1,
        message: message.slice(0, 500), key: String(announce.key || '').slice(0, 120),
        program: fields.currentProgram ? String(fields.currentProgram).slice(0, 80) : '',
      },
      collapseKey: `coach_plan__${profileKey(coachUsername)}`,
    });
  }
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

// A coach commented on a check-in (or pinned a comment to one of its photos).
// One row per coach and check-in date while unread. The comment text stays
// out of the notification and the push: the client reads it in the app.
async function notifyCheckInComment(db, { coachUsername, clientUsername, date, onPhoto }) {
  const day = String(date || '').slice(0, 10);
  return notify(db, {
    to: clientUsername, type: 'coach_checkin_comment', actor: coachUsername, actorName: coachUsername,
    text: onPhoto ? 'commented on a photo in your check-in' : 'commented on your check-in',
    data: { coach: coachUsername, date: day },
    collapseKey: `coach_checkin_comment__${profileKey(coachUsername)}__${day}`,
  });
}

// The client replied under a check-in; the coach is told.
async function notifyCheckInReply(db, { coachUsername, clientUsername, clientUid, date }) {
  const day = String(date || '').slice(0, 10);
  return notify(db, {
    to: coachUsername, type: 'client_checkin_reply', actor: clientUsername, actorName: clientUsername,
    text: 'replied on their check-in',
    data: { client: clientUsername, clientUid: String(clientUid || ''), date: day },
    collapseKey: `client_checkin_reply__${profileKey(clientUsername)}__${day}`,
  });
}

module.exports = { notifyCheckInComment, notifyCheckInReply, notifyCoachInvite, coachInviteAccepted, coachInviteWithdrawn, coachLeftByClient, notifyCoachNote, notifyCoachPlan, notifyCoachVideo };
