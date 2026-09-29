// Paid-plan gating. Every AI feature is part of Pro (Coach includes Pro), and
// the check runs here on the server — the app hides/locks the buttons too, but
// that alone could be bypassed by calling the API directly, and each AI call
// costs money (Anthropic).
//
// Admins (ADMIN_USERNAMES, comma-separated, case-insensitive) always have full
// paid access whatever their plan.
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

  return { isAdmin, hasPaidAccess, requirePaidPlan };
}

module.exports = { createPlanAccess, parseUsernames, PAID_PLANS };
