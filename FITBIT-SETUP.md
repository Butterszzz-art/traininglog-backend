# Fitbit Integration — Setup (manual steps)

The code (OAuth connect/callback/disconnect + `GET /api/fitbit/activity` for
daily steps/activity) is built and deploy-safe: until the env vars below are
set, `fitbitEnabled` is false and every `/api/fitbit/*` route returns
`503 fitbit.disabled`.

## 1. Register an app at dev.fitbit.com (one-time)

1. Go to https://dev.fitbit.com/apps/new (log in with any Fitbit account).
2. **OAuth 2.0 Application Type:** `Server`.
3. **Callback URL:** must exactly match `FITBIT_REDIRECT_URI` below —
   `https://traininglog-backend.onrender.com/api/fitbit/callback`.
4. **Default Access Type:** `Read Only`.
5. Save, then copy the **OAuth 2.0 Client ID** and **Client Secret**.

## 2. Render (backend env)

Add three env vars to the backend service:

- `FITBIT_CLIENT_ID`
- `FITBIT_CLIENT_SECRET`
- `FITBIT_REDIRECT_URI` — `https://traininglog-backend.onrender.com/api/fitbit/callback`

`APP_URL` (already set for Stripe) is reused as the frontend origin the user
gets redirected back to after consent (`?fitbit=connected` / `?fitbit=error`).

## 3. What's built

- `GET /api/fitbit/connect` (auth required) → `{ url }`, the Fitbit consent
  screen. Frontend does `window.location.href = url`.
- `GET /api/fitbit/callback` — Fitbit redirects here after consent; exchanges
  the code for tokens and stores them in `fitbitTokens/{uid}` (server-only
  Firestore collection, not readable by the client SDK).
- `GET /api/fitbit/status` (auth required) → `{ connected }`.
- `POST /api/fitbit/disconnect` (auth required) — revokes + deletes the stored
  token.
- `GET /api/fitbit/activity?date=YYYY-MM-DD` (auth required) → steps,
  distance (km), calories out, active/sedentary minutes for that day. Cached
  to `users/{uid}/fitbitActivity/{date}`.

Only the `activity` scope is requested. Heart rate, sleep, and weight are not
wired up yet — add scopes + a new fetch to `/api/fitbit/activity` if/when
those are needed.

## 4. Not built yet (frontend)

No UI calls these routes — a "Connect Fitbit" button, the `?fitbit=connected`
redirect landing handling, and a place to display the synced steps still need
to be added in `TrainingLog-mobile`.

## 5. Rate limits

Fitbit allows 150 requests/hour per user access token. `/api/fitbit/activity`
makes one request per call (plus one token refresh at most every ~8h), so this
is not a practical concern for the current scope.
