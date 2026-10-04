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

## Profiles (photo, display name, bio)

All routes need `Authorization: Bearer <token>` and a migrated (Firebase) backend. Profiles are keyed by lowercase username. Other users see a profile only if its `visibility` allows it: `everyone`, `coach` (the owner's actively linked coach or clients) or `private` (owner only).

### `GET /api/profiles/me`
`{ success, profile: { username, displayName, bio, visibility, avatarVersion, avatar } }` — `avatar` is a `data:` URL or `null`.

### `PUT /api/profiles/me`
Body: any of `{ displayName (≤40 chars), bio (≤160 chars, ≤3 lines), visibility }`. Omitted fields are kept. Text is stripped of control characters.

### `PUT /api/profiles/me/avatar`
Body: `{ image: "data:image/jpeg;base64,..." }`. JPEG, PNG or WebP (checked by file signature), at most 150 KB. The app sends a 256×256 JPEG. Returns `{ avatarVersion }`.

### `DELETE /api/profiles/me/avatar`
Removes the photo; the app falls back to initials.

### `POST /api/profiles/lookup`
Body: `{ usernames: [...≤100], have: { username: avatarVersion } }`. Returns `{ profiles: { <usernameLower>: { username, displayName, bio, avatarVersion, avatar? } } }`. `avatar` is only included when the version in `have` is out of date. Hidden or missing profiles come back as `{ username, hidden: true }`.

### `POST /api/profiles/:username/report`
Body: `{ reason: "inappropriate" | "impersonation" | "spam" | "other", note? }`. Stored in `profileReports` for review; one report per reporter per profile.

### `DELETE /api/profiles/:username/avatar`
Moderators only (usernames listed, comma-separated, in the `PROFILE_ADMINS` env var). Removes the photo and clears the bio.

Run `node scripts/test-profiles.js` for the route tests.

## Friends (request → accept)

All routes need `Authorization: Bearer <token>` and a migrated (Firebase) backend. A friendship only counts once the other person accepts it.

### `GET /api/friends`
`{ success, friends: [{ username, since }], incoming: [{ username, sentAt }], outgoing: [{ username, sentAt }] }`. The app polls this to show incoming requests.

### `POST /api/friends/requests`
Body: `{ username }`. `201 { status: "pending", username }` for a new request. If that user had already sent you a request, it is accepted instead (`200 { status: "accepted" }`). Errors: `404 friends.not_found`, `409 friends.already_friends`, `422 friends.self`, `429 friends.too_many_pending` (more than 50 unanswered).

### `POST /api/friends/requests/:username/accept`
Recipient only. `404 friends.no_request` if there is no pending request from that user.

### `POST /api/friends/requests/:username/decline`
Recipient declines, or the sender cancels. The request is deleted.

### `DELETE /api/friends/:username`
Unfriend (either side).

Run `node scripts/test-friends.js` for the route tests.

## Notifications (in-app)

Written by the server when something happens to you: `friend_request`, `friend_accepted`, `share_received`, `group_added`, `group_post`, `feed_post` (a friend posted), `exercise_passed` and `volume_passed` (someone passed you on a leaderboard), and coaching: `coach_invite` (data `{ coach, status: 'pending'|'accepted' }`; the row updates on accept and is removed if the invite is cancelled), `coach_accepted` and `coach_left` (to the coach, when the athlete accepts, declines or leaves), `coach_note`, `coach_plan`. Group posts, feed posts and passes collapse: while one is unread, repeats raise its `count`. Nothing is sent when either side has blocked the other, or when the recipient muted that category.

### `GET /api/notifications`
`{ success, items: [{ id, type, category, actor, text, data, count, read, createdAt }], unread }`, newest 50. Rows past the newest 100 are deleted. `data` carries what the app needs to open the item (`shareId`, `groupId`, `lift`, …).

### `POST /api/notifications/read`
Body: `{ ids: [...] }` marks those read; `{}` marks all read. `{ updated }`.

### `DELETE /api/notifications/:id`
Dismiss one.

### `GET /api/notifications/prefs`, `PUT /api/notifications/prefs`
`{ friends, shares, groups, feed, leaderboard, coaching }`, all `true` by default. `PUT` takes any subset of booleans.

Needs the `notifications (to asc, createdAt desc)` index. Run `node scripts/test-notifications.js`.

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

## Master plans (coach-generated, coach-approved)

A coach generates a plan from a client's intake and a package (Cut Cycle 32
or Physique Plan 28). The plan starts as a draft, which only the coach can
see. The coach previews and edits it (each edit is logged), approves it, and
publishes it. Only a published plan reaches the client. The maths comes from
`src/intakeCalculations.js`, which is generated from ClientIntake. The
parameters come from the rule registry in `rules/*.json`, and every number
in a plan records the rule that produced it. See `src/routes/plans.js` and
`src/plan/`.

Coach routes need a Bearer token and the coach plan.

### `GET /api/coach/plans/meta`
Returns the registry version, the packages with their phase layouts, and the
tier adjustment caps.

### `POST /api/coach/plans/preview`
Body: `{ leadId | intake, instellingen?, packageId, startDate: "YYYY-MM-DD", tier: "basis"|"medium"|"premium", clientUid? }`.
Returns `{ plan }` **without saving it**.

### `POST /api/coach/plans`
Same body. `clientUid` is required and must be on your roster. Saves a draft
and returns `{ plan }` (201).

### `GET /api/coach/plans?clientUid=`
Returns `{ plans: [summary] }`.

### `GET /api/coach/plans/:planId`
Returns the full plan.

### `PATCH /api/coach/plans/:planId`
Body: `{ changes: [{ path: "phases[0].nutrition.restDay.kcal", value: 2300, reason }] }`.
- Only targets, sets, progression, deloads, recovery, caps and end criteria can be edited.
- Each change is appended to `plan.overrides`.
- Editing an approved plan sends it back to draft.

### `POST /api/coach/plans/:planId/approve` · `POST /api/coach/plans/:planId/publish`
Draft → approved → published. Publishing does three things:
- copies a client view of the plan to `users/{clientUid}/plans`, without the override log, provenance or red flags
- marks the client's previous plan from this coach as superseded
- updates the coach-assignment summary fields and notifies the client

### `GET /api/client/plan`
Returns the signed-in client's current published plan, or `{ plan: null }`.
