# Firebase Auth — Phase 1 Setup (manual steps)

The Phase 1 code (dual-mode auth middleware, signup/login endpoints, client
flows) is built and deploy-safe: until the env var and client config below are
filled in, both servers and the app keep running on legacy JWT auth.

## 1. Firebase Console (one-time)

1. Create the Firebase project at https://console.firebase.google.com (or reuse one).
2. **Authentication → Sign-in method → enable Email/Password.**
3. **Firestore Database → Create database** (production mode). Phase 1 uses the
   `users` and `usernames` collections, written only by the Admin SDK — client
   access can stay locked (default deny rules are fine for now).
4. **Project Settings → Service Accounts → Generate new private key.**

## 2. Render (backend env)

Add one env var to the backend service:

- `FIREBASE_SERVICE_ACCOUNT` — the *entire* downloaded service-account JSON,
  pasted as a single value.

`GET /health` now reports `firebase.enabled` and the project id, so after a
redeploy you can confirm it took.

## 3. Frontend client config

In `TrainingLog-mobile/src/js/firebase-config.js`, replace the four
`REPLACE_ME` values with the web-app config from **Project Settings → General
→ Your apps → Web app** (create the web app there if none exists). This config
is public — safe to commit, unlike the service account.

Until then the app logs `[Firebase] Client config not filled in yet` and uses
legacy auth.

## 4. What happens once both are set

- **Signup** collects username + email + password → Firebase account →
  verification email → `/auth/signup-complete` claims the username
  (Firestore `usernames/{name}` + `users/{uid}`), sets custom claims
  (`username`, `tier: free`, `isCoach: false`), and best-effort creates the
  Airtable Users row so existing data routes keep working until Phase 2.
- **Login** stays username-first: `/auth/email-for-username` resolves the
  email, Firebase signs in, and the ID token is sent as the Bearer token.
- **Unverified emails are blocked server-side** (403 `auth.email_not_verified`)
  on every protected route; the app shows a check-your-email screen with resend.
- **Legacy JWTs still work** — the middleware detects the token type. Beta
  testers re-register (no import possible: legacy accounts have no email).

## 5. Cutover (step 7 of the plan — after end-to-end verification)

Remove from `server.js`: legacy `/register` + `/login` routes, the
`jwt.verify` fallback in `authenticateToken`, `JWT_SECRET` usage, and
`bcryptjs`/`jsonwebtoken` deps. Then retire `TrainingLog-mobile/server.js`
(legacy dev server) and drop `PasswordHash` from the Airtable Users table.

## Note for PAY-2 (Stripe webhooks)

When the webhook handler lands, it must call `syncTierClaim(username, tier)`
(defined next to `updateUserPlan` in `server.js`) after updating Airtable, and
the client should call `getIdToken(true)` after checkout so tier gating updates
immediately.

## Storage-efficiency rollout (compact workouts, leaderboard counters, index exemptions)

New workout saves are stored in a compact form (`workoutFormat.js`: default
per-set values are dropped and rebuilt on read — each save is verified to
read back identical, otherwise the original is stored). `GET /leaderboard`
reads running `totalVolume` / `workoutCount` counters on `users/{uid}`
instead of scanning all workouts. Existing data needs converting once, in
this order:

1. Deploy the functions code.
2. Convert existing workouts and fix their stored `sessionVolume` (workouts
   from the app's log screen were saved with 0). Check the dry run first:
   `node scripts/compact-workouts.js --dry-run`, then
   `node scripts/compact-workouts.js`. It writes a JSONL backup of every doc
   it changes before changing it (path printed at the end — keep it);
   `node scripts/restore-workouts.js <backup.jsonl>` puts the originals back.
3. Rebuild the leaderboard counters from the corrected volumes, and remove the
   old unused per-set docs:
   `node scripts/backfill-leaderboard-totals.js --delete-sets`
   (safe to re-run; `--dry-run` prints without writing).
4. Deploy the index exemptions for the stored JSON fields (`workout`,
   `programData`, `templateData`, ...), which Firestore otherwise indexes field
   by field: `firebase deploy --only firestore:indexes`. If the CLI offers to
   delete indexes that aren't in `firestore.indexes.json`, answer no unless
   you've checked they're unused.

Until steps 2–3 run, the leaderboard only reflects workouts saved after the
deploy. Unconverted workouts keep working as they are — `GET /workouts` reads
both formats.
