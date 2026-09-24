# API Overview

## Leaderboard

### `GET /leaderboard/stats`
Parameters:
- `username` or `groupId`: identifier
- `timeframe`: `weekly`, `monthly`, `all-time`
- `sortBy`: `volume`, `sets`, `reps`

Returns stats for a single user or all members of a group. When `groupId` is provided, results are sorted descending by the chosen field.

### `GET /leaderboard/weeklyVolume`
Parameters:
- `username` or `groupId`
- `timeframe`: optional timeframe

Returns weekly volume objects grouped by week for the user or group members.

## Detailed Stats

### `GET /stats/user/:username`
Parameters:
- `timeframe` or `start` and `end` dates (ISO `yyyy-mm-dd`)

Returns user profile, workouts array, exercise summary, and weekly volume.

### `GET /stats/group/:groupId`
Parameters:
- `timeframe` or `start` and `end` dates

Returns group info, top contributors, exercise summary, and weekly volume aggregated over members.

## Response structures
- `stats` objects include `username`, `workouts`, `studyHours`, `activity`, `volume`, `sets`, and `reps`.
- Weekly volume endpoints return an array of `{ week, volume }` items keyed by username when a group is requested.

### Notes on Performance
- Sample data is indexed by workout date and exercise name to speed up filtering when Airtable is unavailable.

## Environment

### `GET /envcheck`
Returns `{ "success": true, "airtableConfigured": boolean }`.
Use this to verify that the server has read `AIRTABLE_TOKEN` and `AIRTABLE_BASE_ID`
from the environment. It does not expose the actual values.

## Workout Logging

### `POST /saveWorkout`
Body:
```json
{
  "username": "userId",
  "workout": {
    "date": "YYYY-MM-DD",
    "exercises": [
      {
        "name": "Bench Press",
        "dropset": false,
        "restPause": false,
        "sets": [
          { "reps": 5, "weight": 100, "dropset": false, "restPause": false }
        ]
      }
    ]
  }
}
```
`dropset` and `restPause` flags are optional for exercises and sets and default to `false` when omitted.

### `GET /getWorkouts`
Parameters:
- `username`

Returns an array of workouts with the same structure as above. Any missing technique flags will be returned as `false` for backward compatibility.

## Templates

### `GET /templates?username=:username`
- Requires `Authorization: Bearer <JWT>` header. When `username` or `userId` is omitted, the value embedded in the token is used.
- When the Airtable base is missing, the API responds with a `503` JSON error explaining which environment variables are required.
- Returns `200` with `{ "items": [] }` when the user has no templates.

Example success:
```json
{
  "items": [
    { "id": "rec123", "name": "Push", "username": "29796" }
  ],
  "username": "29796",
  "success": true
}
```

Example structured error:
```json
{
  "success": false,
  "error": {
    "code": "templates.airtable_forbidden",
    "message": "Airtable credentials were rejected. Confirm AIRTABLE_TOKEN/API_KEY and AIRTABLE_BASE_ID.",
    "detail": "403 PERMISSION_DENIED ..."
  }
}
```


## Macro Targets

### `GET /macrotargets?username=:username`
- Requires `Authorization: Bearer <JWT>` header.
- Requires `username` query parameter.
- Reads from the `MacroTargets` Airtable table using server-side Airtable PAT credentials.
- Returns only the latest record for that username (sorted by `Date` descending).

Example success:
```json
{
  "success": true,
  "item": {
    "id": "rec123",
    "createdTime": "2026-01-01T00:00:00.000Z",
    "Username": "29796",
    "Date": "2026-01-01",
    "Calories": 2200,
    "Protein": 180
  }
}
```

Frontend usage note:
- The frontend should call this backend route instead of calling Airtable directly, so Airtable PAT credentials remain server-side.

## Premium content (ebooks and program library)

The content lives in `content/premium/ebooks/*.json` and `content/premium/programs/*.json` and ships with the function. All routes require `Authorization: Bearer <token>` and check the account's plan on every request (same source as `GET /api/user/plan`). Only `pro` and `coach` accounts receive full content; `free` accounts get metadata and a short preview. If the plan lookup fails the route returns `503 premium.plan_lookup_failed` rather than guessing.

Responses are sent with `Cache-Control: private, no-store`. Each item carries a `rev` (content hash) so the app can cache it and refetch only when it changes.

### `GET /api/premium/library`
Everything on the shelf as metadata: `{ success, access: "full" | "preview", plan, ebooks: [...], programs: [...] }`.

### `GET /api/premium/ebooks/:id`
- Paid: `{ success, locked: false, ebook }` with every chapter, section and table.
- Free: `{ success, locked: true, ebook }` where `ebook` is metadata plus `preview` (the first section of the first chapter). No other chapter text is sent.

### `GET /api/premium/programs/:id`
- Paid: `{ success, locked: false, program }`. `program.weeks` is the week-by-week plan; a week with `sameAs: n` repeats week `n`. `program.days` mirrors the first real week.
- Free: `{ success, locked: true, program }` with metadata and `dayNames` only.

Unknown ids return `404 premium.not_found`. Run `node scripts/test-premium-content.js` to validate the content files and the gating rules.

## Coaching

All routes need `Authorization: Bearer <token>` and a Firebase (migrated) account. A link lives in two places: `coaches/{coachUid}/clients/{clientUid}` (the coach's roster) and `users/{clientUid}/coachInvites/{coachUid}` (the client's side).

**Coach side**
- `GET /api/coach/clients`: roster. Each row has `status` (`pending` or `active`) plus whatever the client shares: `lastCheckIn`, `compliancePercent`, `workoutsLoggedThisWeek`, `currentBodyweight`, `weeklyWeightChangePercent`, `sharing`. `alerts` / `alertStatus` (`ok`, `watch`, `action`) are computed at read time by `src/coachShare.js`, and missing data never raises an alert.
- `GET /api/coach/clients/:clientUid`: the same row plus `checkIns` (latest 12), `bodyweight` (up to 120 points) and `weeklyWorkouts`.
- `POST /api/coach/clients/invite` `{ clientUsername }`: needs the Coach plan (`403 coach.plan_required`). `INTAKE_COACH_USERNAME` is always allowed, and `COACH_PLAN_REQUIRED=false` turns the check off.
- `PATCH /api/coach/clients/:clientUid` `{ programId?, macroTargets?, nutritionSummary?, currentProgram?, trainingMode? }`: `programId` copies a library program, converted to the app's program format, into the client's assignment (`''` clears it). `macroTargets` is `{ calories, protein, carbs, fat }`.
- `DELETE /api/coach/clients/:clientUid`: removes a client or cancels an invite, including everything the client shared.
- `GET /api/coach/programs`, `PUT /api/coach/programs/:id` `{ name, notes?, days: { Mon: [{ name, sets, reps, repsMax? }] } }`, `DELETE /api/coach/programs/:id`: the coach's program library, shared by the mobile builder and the desktop console.
- `POST /coach/workouts` `{ clientUid | clientUsername, date, title?, workout }`: checks the Firestore link first and falls back to Airtable `CoachClients`.
- Notes: `POST|GET /api/coach/clients/:clientUid/notes`. Videos: `POST|GET /coach/exercise-videos`, `DELETE /coach/exercise-videos/:id`. Leads: `GET /api/coach/leads`, `PATCH /api/coach/leads/:id`.

**Client side**
- `GET /api/client/coach-invites`, `POST /api/coach/clients/accept` `{ coachUsername }`, `DELETE /api/client/coaches/:coachUid` (decline a pending invite or leave a coach).
- `GET|PUT /api/client/coach-sharing` `{ checkIns, bodyweight, workouts }`: all on by default. Turning a switch off deletes that data from every coach's copy.
- `POST /api/client/coach-share` `{ checkIns, bodyweight, workouts: { thisWeek, weekStart, weekly }, compliancePercent, activeProgramName }`: filtered by the switches and copied to each active coach. Returns `{ coaches: 0 }` when there is no coach.
- `GET /api/client/coach-assignment` (includes `program` and `macroTargets`), `GET /api/client/coach-notes`, `GET /exercise-videos`.

Run `node scripts/test-coach-share.js` (helpers) and `node scripts/test-firestore-routes.js` (routes).

## Auth error note after JWT secret rotation

If the server JWT secret changes, previously issued browser tokens become invalid and requests can fail with:

```json
{
  "success": false,
  "error": {
    "code": "auth.invalid_signature",
    "message": "Token signature is invalid. Clear localStorage jwt and sign in again.",
    "detail": "Run localStorage.removeItem(\"jwt\") in the browser console, then log in again to get a fresh token."
  }
}
```
