// Paid-plan gating: every AI feature is Pro (Coach includes Pro), and the
// coach tools are Coach only. The check runs here on the server — the app
// locks the buttons too, but that alone could be bypassed by calling the API
// directly, and each AI call costs money (Anthropic).
//
// Admins (ADMIN_USERNAMES, comma-separated, case-insensitive) always have full
// paid access whatever their plan.
//
// getPlanInfo (getUserPlanInfo in server.js) returns the *effective* plan from
// src/entitlements.js resolveEffectivePlan, so every gate here counts passes,
// trials and lifetime access, not just subscriptions.
const PAID_PLANS = new Set(['pro', 'coach']);

function parseUsernames(value) {
  return String(value || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
}

function createPlanAccess({ getPlanInfo, adminUsernames = [], sendError }) {
  const admins = new Set(adminUsernames.map(u => String(u).trim().toLowerCase()).filter(Boolean));

  function isAdmin(username) {
    return admins.has(String(username || '').toLowerCase());
  }

  async function hasPaidAccess(username) {
    if (isAdmin(username)) return true;
    const info = await getPlanInfo(username);
    return PAID_PLANS.has(info && info.plan);
  }

  // Express middleware; mount after authenticateToken.
  async function requirePaidPlan(req, res, next) {
    let allowed;
    try {
      allowed = await hasPaidAccess(req.user && req.user.username);
    } catch (err) {
      console.error('[plan] lookup failed:', err.message);
      return sendError(res, 503, 'plan.lookup_failed', 'Could not verify your plan. Please try again.');
    }
    if (!allowed) {
      return sendError(res, 403, 'plan.upgrade_required', 'AI features are part of Pocket Coach Pro. Upgrade to use them.');
    }
    return next();
  }

  async function hasCoachAccess(username) {
    if (isAdmin(username)) return true;
    const info = await getPlanInfo(username);
    return (info && info.plan) === 'coach';
  }

  // Coach tools (client roster, invites, notes, leads, logging for clients,
  // exercise videos) are the Coach plan. The athlete side of coaching —
  // accepting an invite, reading your coach's notes/assignment — stays open
  // so a free client can still work with a paying coach.
  async function requireCoachPlan(req, res, next) {
    let allowed;
    try {
      allowed = await hasCoachAccess(req.user && req.user.username);
    } catch (err) {
      console.error('[plan] lookup failed:', err.message);
      return sendError(res, 503, 'plan.lookup_failed', 'Could not verify your plan. Please try again.');
    }
    if (!allowed) {
      return sendError(res, 403, 'plan.coach_required', 'Coaching tools are part of the Pocket Coach Coach plan. Upgrade to use them.');
    }
    return next();
  }

  return { isAdmin, hasPaidAccess, hasCoachAccess, requirePaidPlan, requireCoachPlan };
}

module.exports = { createPlanAccess, parseUsernames, PAID_PLANS };
