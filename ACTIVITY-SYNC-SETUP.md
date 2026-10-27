# Activity Sync (Google Health API) — Setup (manual steps)

The code (OAuth connect/callback/disconnect + `GET /api/activity-sync/activity`
for daily steps/distance/calories/active-minutes) is built and deploy-safe:
until the env vars below are set, `activitySyncEnabled` is false and every
`/api/activity-sync/*` route returns `503 activity_sync.disabled`.

This replaces the earlier Fitbit Web API integration (see git history for
`FITBIT-SETUP.md`) — Google is sunsetting the legacy Fitbit Web API on
**September 30, 2026**, so new integrations target the **Google Health API**
directly (Google OAuth 2.0 via Google Cloud Console, not `dev.fitbit.com`).

## 1. Register an OAuth client in Google Cloud Console (one-time)

1. Pick/create a GCP project (can be the same project as Firebase, or a
   separate one — just note which project ID you used).
2. Enable **Google Health API**:
   `https://console.developers.google.com/apis/library/health.googleapis.com`
3. Create OAuth 2.0 credentials (APIs & Services → Credentials → Create
   Credentials → OAuth client ID), type **Web application**.
4. Set the **Authorized redirect URI** to exactly match
   `GOOGLE_HEALTH_REDIRECT_URI` below. For the deployed function that is:
   `https://us-central1-pocketcoach-280c4.cloudfunctions.net/api/api/activity-sync/callback`
   (the doubled `/api/api/` is correct: the function is named `api` and the
   Express routes also start with `/api/`). Any difference, even a trailing
   slash, makes Google reject the connect with `redirect_uri_mismatch`.
5. On the OAuth consent screen's **Audience** page, while in "Testing"
   status, add your own Google account(s) as test users (required to
   complete consent until the app passes Google's verification review for
   >100 users).
6. On the **Data Access** page, add both scopes:
   `https://www.googleapis.com/auth/googlehealth.activity_and_fitness.readonly`
   and `https://www.googleapis.com/auth/googlehealth.sleep.readonly`.
7. Copy the **Client ID** and **Client Secret**.

## 2. Firebase secrets

```
firebase functions:secrets:set GOOGLE_HEALTH_CLIENT_ID
firebase functions:secrets:set GOOGLE_HEALTH_CLIENT_SECRET
firebase functions:secrets:set GOOGLE_HEALTH_REDIRECT_URI
```

`APP_URL` (already set for Stripe) is reused as the frontend origin the user
gets redirected back to after consent (`?activitySync=connected` /
`?activitySync=error`).

## 3. What's built

- `GET /api/activity-sync/connect` (auth required) → `{ url }`, the Google
  consent screen. Frontend does `window.location.href = url`.
- `GET /api/activity-sync/callback` — Google redirects here after consent;
  exchanges the code for tokens, resolves the Health-API user id via
  `users.getIdentity`, and stores both in `activitySyncTokens/{uid}`
  (server-only Firestore collection, not readable by the client SDK).
- `GET /api/activity-sync/status` (auth required) → `{ connected }`.
- `POST /api/activity-sync/disconnect` (auth required) — revokes + deletes
  the stored token.
- `GET /api/activity-sync/activity?date=YYYY-MM-DD` (auth required) → steps,
  distance (km), calories out, active/sedentary minutes for that day, built
  from one `dailyRollUp` call per data type. Cached to
  `users/{uid}/activitySync/{date}`.
- `GET /api/activity-sync/sleep?date=YYYY-MM-DD&goalMinutes=480` (auth
  required) → last night's bedtime/wake time, sleep-stage minutes (light/
  deep/REM/awake), awakening count, and an estimated 0-100 sleep score +
  label. Sleep has no `dailyRollUp` (sessions can span midnight), so this
  uses the `dataTypes.dataPoints` `list` method instead and picks the
  session that ends latest in a window covering the prior evening through
  midday of `date`. Cached to `users/{uid}/activitySync/{date}.sleep`
  (merged into the same doc as `/activity`, not a separate collection).

Heart rate and weight are not wired up yet — add scopes + new data-type
fetches if/when those are needed.

Field names and request shapes were checked against Google's v4 reference
(`*RollupValue` pages, `dataPoints.list`, `users.getIdentity`). int64 values
(steps, distance in millimetres, active minutes) come back as strings and
durations as `"123s"` strings, which `buildActivitySummary` parses. Sleep is
filtered with `sleep.interval.end_time`, prefers the `mainSleep` session over
naps, and counts `ASLEEP`/`RESTLESS` stages for "classic" (non-staged) sleep.
The sleep score (`computeSleepScore` in `server.js`) is an original estimate,
not Fitbit's or Google's own scoring — don't present it in the UI as anything
more than an in-app estimate.

## Checking it's switched on

`GET /api/health` now includes an `activitySync` block showing each of the
three secrets as `SET` or `MISSING`. All three must be `SET` (and the function
redeployed after setting them) before the app's Settings stops saying
"Activity Sync is not available yet."

## 4. Rate limits / token lifetime

Google access tokens last **1 hour** (vs. Fitbit's 8), refreshed
automatically on read the same way as before. Refresh tokens expire after 6
months of non-use.
