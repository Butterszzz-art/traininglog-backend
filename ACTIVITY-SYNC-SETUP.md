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
   `GOOGLE_HEALTH_REDIRECT_URI` below — your deployed function's base URL +
   `/api/activity-sync/callback`.
5. On the OAuth consent screen's **Audience** page, while in "Testing"
   status, add your own Google account(s) as test users (required to
   complete consent until the app passes Google's verification review for
   >100 users).
6. On the **Data Access** page, add scope
   `https://www.googleapis.com/auth/googlehealth.activity_and_fitness.readonly`.
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

Only the `activity_and_fitness.readonly` scope is requested. Heart rate,
sleep, and weight are not wired up yet — add scopes + new data-type fetches
to `/api/activity-sync/activity` if/when those are needed.

⚠️ **The per-data-type response field names in `server.js`
(`ACTIVITY_SYNC_DATA_TYPES`) are confirmed for `steps` only** (`countSum`,
per Google's docs) — `distance`/`active-minutes`/`total-calories`/
`sedentary-period` field names are best-effort guesses. The code falls back
to the first numeric field it finds and logs a warning if the guessed field
name is wrong, so it degrades gracefully, but check the logs after the
first real connect and fix the `valueKey`s in `ACTIVITY_SYNC_DATA_TYPES` if
you see those warnings.

## 4. Rate limits / token lifetime

Google access tokens last **1 hour** (vs. Fitbit's 8), refreshed
automatically on read the same way as before. Refresh tokens expire after 6
months of non-use.
