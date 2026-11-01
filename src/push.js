// Phone push notifications (iOS, through Apple's push service APNs).
//
// Every in-app notification written by notify() (src/routes/notifications.js)
// is also pushed to the recipient's iPhones and iPads, so people hear about a
// friend request or a coach note without opening the app.
//
// Device tokens (server-only, see firestore.rules):
//   pushTokens/{token}  { user, platform: 'ios', env, createdAt, updatedAt }
// `user` is the lowercase username (profileKey). `env` is the APNs server the
// token belongs to ('production' for TestFlight and App Store builds,
// 'sandbox' for builds run from Xcode); it's learned on the first send.
//
// Config (all three needed, otherwise push is off and nothing is sent):
//   APNS_KEY      contents of the .p8 key from developer.apple.com → Keys
//                 (a Firebase secret in production)
//   APNS_KEY_ID   the key's 10-character Key ID
//   APNS_TEAM_ID  the Apple Developer Team ID
//   APNS_BUNDLE_ID (optional, defaults to APPLE_BUNDLE_ID / com.pocketcoach.app)
const http2 = require('http2');
const jwt = require('jsonwebtoken');

const HOSTS = {
  production: 'https://api.push.apple.com',
  sandbox: 'https://api.sandbox.push.apple.com',
};
const COLLECTION = 'pushTokens';
const TOKEN_RE = /^[0-9a-f]{64,200}$/i;
const MAX_TOKENS_PER_USER = 10;
const SEND_TIMEOUT_MS = 5000;
const JWT_MAX_AGE_MS = 45 * 60 * 1000; // Apple wants a new one every 20–60 min
const BODY_MAX = 180;

function readConfig(env = process.env) {
  const key = String(env.APNS_KEY || '').replace(/\\n/g, '\n').trim();
  const keyId = String(env.APNS_KEY_ID || '').trim();
  const teamId = String(env.APNS_TEAM_ID || '').trim();
  const bundleId = String(env.APNS_BUNDLE_ID || env.APPLE_BUNDLE_ID || 'com.pocketcoach.app').trim();
  return { key, keyId, teamId, bundleId, enabled: Boolean(key && keyId && teamId) };
}

function isValidToken(token) {
  return typeof token === 'string' && TOKEN_RE.test(token);
}

// One HTTP/2 request to APNs. Resolves { status, reason } and never rejects.
function http2Transport(host, token, payload, headers) {
  return new Promise(resolve => {
    let session;
    let settled = false;
    const done = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { session && session.close(); } catch (_) { /* already closed */ }
      resolve(result);
    };
    const timer = setTimeout(() => done({ status: 0, reason: 'Timeout' }), SEND_TIMEOUT_MS);
    try {
      session = http2.connect(host);
      session.on('error', err => done({ status: 0, reason: err.code || err.message }));
      const req = session.request({ ':method': 'POST', ':path': `/3/device/${token}`, ...headers });
      let status = 0;
      let body = '';
      req.setEncoding('utf8');
      req.on('response', h => { status = Number(h[':status']) || 0; });
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        let reason = '';
        try { reason = body ? JSON.parse(body).reason || '' : ''; } catch (_) { reason = body; }
        done({ status, reason });
      });
      req.on('error', err => done({ status: 0, reason: err.code || err.message }));
      req.end(JSON.stringify(payload));
    } catch (err) {
      done({ status: 0, reason: err.message });
    }
  });
}

function createPushSender({ config = readConfig(), transport = http2Transport, now = () => Date.now() } = {}) {
  let cachedJwt = null;
  let cachedAt = 0;

  function providerToken(force = false) {
    if (!force && cachedJwt && now() - cachedAt < JWT_MAX_AGE_MS) return cachedJwt;
    cachedJwt = jwt.sign({ iss: config.teamId, iat: Math.floor(now() / 1000) }, config.key, {
      algorithm: 'ES256',
      header: { alg: 'ES256', kid: config.keyId },
      noTimestamp: true,
    });
    cachedAt = now();
    return cachedJwt;
  }

  function headersFor(message, force) {
    const h = {
      authorization: `bearer ${providerToken(force)}`,
      'apns-topic': config.bundleId,
      'apns-push-type': 'alert',
      'apns-priority': '10',
      'content-type': 'application/json',
    };
    if (message.collapseId) h['apns-collapse-id'] = String(message.collapseId).slice(0, 64);
    return h;
  }

  function payloadFor(message) {
    const aps = {
      alert: message.title ? { title: message.title, body: message.body } : { body: message.body },
      sound: 'default',
    };
    if (message.threadId) aps['thread-id'] = message.threadId;
    return { aps, ...(message.data || {}) };
  }

  // Sends to one token. Tries the env we know for it first, then the other
  // one (a token from an Xcode build only works on sandbox and vice versa).
  // Returns { ok, env } on success, { gone: true } when the token is dead.
  async function sendOne(token, knownEnv, message) {
    const order = knownEnv === 'sandbox' ? ['sandbox', 'production'] : ['production', 'sandbox'];
    const payload = payloadFor(message);
    let wrongEnv = 0;
    for (const env of order) {
      let res = await transport(HOSTS[env], token, payload, headersFor(message, false));
      if (res.status === 403 && /ExpiredProviderToken|InvalidProviderToken/.test(res.reason)) {
        res = await transport(HOSTS[env], token, payload, headersFor(message, true));
      }
      if (res.status === 200) return { ok: true, env };
      if (res.status === 410) return { gone: true };
      if (res.status === 400 && /BadDeviceToken|DeviceTokenNotForTopic/.test(res.reason)) {
        wrongEnv += 1;
        continue;
      }
      console.warn(`[push] APNs ${env} said ${res.status} ${res.reason}`);
      return { ok: false };
    }
    return wrongEnv === order.length ? { gone: true } : { ok: false };
  }

  // Push one message to every device of each user. Never throws.
  async function sendToUsers(db, users, message) {
    if (!config.enabled || !db || !users || !users.length) return 0;
    let sent = 0;
    try {
      const body = String(message.body || '').slice(0, BODY_MAX);
      if (!body) return 0;
      const msg = { ...message, body };
      const col = db.collection(COLLECTION);
      for (const user of users) {
        const snap = await col.where('user', '==', user).get();
        await Promise.all(snap.docs.slice(0, MAX_TOKENS_PER_USER).map(async doc => {
          const result = await sendOne(doc.id, doc.get('env'), msg);
          if (result.gone) {
            await doc.ref.delete().catch(() => {});
          } else if (result.ok) {
            sent += 1;
            if (doc.get('env') !== result.env) await doc.ref.set({ env: result.env }, { merge: true }).catch(() => {});
          }
        }));
      }
    } catch (err) {
      console.error('[push] send failed:', err.message);
    }
    return sent;
  }

  return { sendToUsers, sendOne, payloadFor, enabled: config.enabled };
}

// Saves (or moves) a device token to `user`. A phone that signs in to another
// account takes its token with it, so the old account stops getting pushes.
async function saveToken(db, user, token, platform = 'ios') {
  const ref = db.collection(COLLECTION).doc(token);
  const snap = await ref.get();
  const now = new Date();
  const env = snap.exists && snap.get('user') === user ? snap.get('env') || null : null;
  await ref.set({
    user,
    platform,
    env,
    createdAt: snap.exists && snap.get('user') === user ? snap.get('createdAt') || now : now,
    updatedAt: now,
  });
}

async function removeToken(db, user, token) {
  const ref = db.collection(COLLECTION).doc(token);
  const snap = await ref.get();
  if (snap.exists && snap.get('user') === user) await ref.delete();
}

async function deleteTokensFor(db, user) {
  const snap = await db.collection(COLLECTION).where('user', '==', user).get();
  await Promise.all(snap.docs.map(d => d.ref.delete()));
}

// The sender notify() uses. Built on first use so it picks up secrets that
// Cloud Functions only puts in process.env at runtime; tests swap it.
let defaultSender = null;
function getSender() {
  if (!defaultSender) defaultSender = createPushSender();
  return defaultSender;
}
function setSender(sender) {
  defaultSender = sender;
}

module.exports = {
  createPushSender, readConfig, isValidToken, saveToken, removeToken, deleteTokensFor,
  getSender, setSender, HOSTS, COLLECTION,
};
