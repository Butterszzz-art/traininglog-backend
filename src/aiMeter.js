// AI usage metering: free accounts get a few AI uses a month, paid plans get
// fair-use caps, so AI cost can never run away from revenue.
//
// Counter doc: aiUsage/{userKey}_{YYYY-MM} (UTC month)
//   { total, byFeature: { [key]: n }, updatedAt }
// `total` counts credit features only; background features (auto-loading AI)
// are counted in byFeature against their own cap.
//
// meterAi runs BEFORE the model call:
//   feature not on the plan          → 403 plan.upgrade_required
//   monthly or sub-limit reached     → 403 ai.quota_exceeded { resetsAt }
//   otherwise                        → +1 in a transaction, then continue
// If the route then fails (status >= 400, or it answered with its non-AI
// fallback), the use is given back (best effort).
const DEFAULT_LIMITS = require('./config/aiLimits');

function monthKey(now) {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

function resetsAt(now) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
}

// Which limits tier applies. PAY2-9 adds 'coach_client' via `source`.
function tierFor(plan, source, limits = DEFAULT_LIMITS) {
  if (source && limits[source]) return source;
  return limits[plan] ? plan : 'free';
}

// Pure decision: may this use go ahead, given the current counter?
// Returns { ok: true, remaining } or { ok: false, code }.
function decide({ tier, feature, usage, limits = DEFAULT_LIMITS }) {
  const t = limits[tier] || limits.free;
  const u = usage || { total: 0, byFeature: {} };
  const used = (u.byFeature && u.byFeature[feature.key]) || 0;

  if (t.allowedFeatures && !t.allowedFeatures.includes(feature.key)) {
    return { ok: false, code: 'plan.upgrade_required' };
  }
  if (feature.kind === 'background') {
    if (!t.background) return { ok: false, code: 'plan.upgrade_required' };
    if (used >= t.background) return { ok: false, code: 'ai.quota_exceeded' };
    return { ok: true, remaining: Math.max(0, t.monthly - (u.total || 0)) };
  }
  if (feature.limitKey) {
    const sub = t[feature.limitKey] || 0;
    if (sub <= 0) return { ok: false, code: 'plan.upgrade_required' };
    if (used >= sub) return { ok: false, code: 'ai.quota_exceeded' };
  }
  if ((u.total || 0) >= t.monthly) return { ok: false, code: 'ai.quota_exceeded' };
  return { ok: true, remaining: Math.max(0, t.monthly - (u.total || 0) - 1) };
}

function createAiMeter({
  db, resolvePlan, isAdmin = () => false, sendError, limits = DEFAULT_LIMITS,
  features = DEFAULT_LIMITS.FEATURES, clock = () => new Date(), log = console,
}) {
  const docFor = (userKey, now) => db.collection('aiUsage').doc(`${userKey}_${monthKey(now)}`);

  // Atomic check-and-increment. Returns the decision.
  async function consume(userKey, tier, feature, now) {
    const ref = docFor(userKey, now);
    return db.runTransaction(async tx => {
      const snap = await tx.get(ref);
      const usage = snap.exists ? snap.data() : { total: 0, byFeature: {} };
      const verdict = decide({ tier, feature, usage, limits });
      if (!verdict.ok) return verdict;
      const byFeature = { ...(usage.byFeature || {}) };
      byFeature[feature.key] = (byFeature[feature.key] || 0) + 1;
      tx.set(ref, {
        total: (usage.total || 0) + (feature.kind === 'credit' ? 1 : 0),
        byFeature,
        updatedAt: now,
      });
      return verdict;
    });
  }

  async function refund(userKey, feature, now) {
    const ref = docFor(userKey, now);
    await db.runTransaction(async tx => {
      const snap = await tx.get(ref);
      if (!snap.exists) return;
      const usage = snap.data();
      const byFeature = { ...(usage.byFeature || {}) };
      byFeature[feature.key] = Math.max(0, (byFeature[feature.key] || 0) - 1);
      tx.set(ref, {
        total: Math.max(0, (usage.total || 0) - (feature.kind === 'credit' ? 1 : 0)),
        byFeature,
        updatedAt: now,
      });
    });
  }

  // { used, limit, resetsAt, byFeature } for GET /api/user/plan.
  async function getUsage(userKey, plan, source) {
    const now = clock();
    const t = limits[tierFor(plan, source, limits)] || limits.free;
    const snap = userKey ? await docFor(userKey, now).get() : null;
    const u = snap && snap.exists ? snap.data() : {};
    return {
      used: u.total || 0,
      limit: t.monthly,
      resetsAt: resetsAt(now).toISOString(),
      byFeature: u.byFeature || {},
    };
  }

  // Express middleware for everything under /api/ai. Mount after
  // authenticateToken. `featureFor(req)` defaults to the FEATURES path map.
  function meterAi(featureOverride) {
    return async function (req, res, next) {
      const feature = featureOverride || features[req.path.replace(/\/+$/, '') || '/'];
      if (req.path === '/health') return next();
      const username = req.user && req.user.username;
      if (isAdmin(username)) return next();

      const now = clock();
      let plan, userKey;
      try {
        plan = await resolvePlan(req); // { plan, source, userKey }
        userKey = plan && plan.userKey;
      } catch (err) {
        log.error('[aiMeter] plan lookup failed:', err.message);
        return sendError(res, 503, 'plan.lookup_failed', 'Could not verify your plan. Please try again.');
      }
      if (!userKey) return sendError(res, 401, 'auth.missing_token', 'Authorization token is required.');

      // Unknown AI route: paid only, counted as a credit.
      const f = feature || { key: 'other', kind: 'credit' };
      const tier = tierFor(plan.plan, plan.source, limits);
      if (!feature && tier === 'free') {
        return sendError(res, 403, 'plan.upgrade_required', 'This AI feature is part of Pocket Coach Pro.');
      }

      let verdict;
      try {
        verdict = await consume(userKey, tier, f, now);
      } catch (err) {
        log.error('[aiMeter] usage update failed:', err.message);
        return sendError(res, 503, 'ai.meter_unavailable', 'AI is unavailable right now. Please try again.');
      }
      if (!verdict.ok) {
        if (verdict.code === 'ai.quota_exceeded') {
          const at = resetsAt(now).toISOString();
          return res.status(403).json({
            success: false,
            error: { code: 'ai.quota_exceeded', message: 'Monthly AI limit reached.', resetsAt: at },
          });
        }
        return sendError(res, 403, 'plan.upgrade_required', 'This AI feature is part of Pocket Coach Pro. Upgrade to use it.');
      }

      if (f.kind === 'credit') res.set('X-AI-Remaining', String(verdict.remaining));

      // Give the use back if the AI part didn't happen.
      let refunded = false;
      const giveBack = () => {
        if (refunded) return;
        refunded = true;
        refund(userKey, f, now).catch(err => log.warn('[aiMeter] refund failed:', err.message));
      };
      const json = res.json.bind(res);
      res.json = body => {
        if (res.statusCode < 400 && body && (body.source === 'rules' || body.aiError)) giveBack();
        return json(body);
      };
      res.on('finish', () => { if (res.statusCode >= 400) giveBack(); });
      return next();
    };
  }

  return { meterAi, getUsage, consume, refund };
}

module.exports = { createAiMeter, decide, tierFor, monthKey, resetsAt };
