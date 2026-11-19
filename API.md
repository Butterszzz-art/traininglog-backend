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

### `POST /workouts/import`
History brought in from another app (the app parses a Strong, Hevy or Fitbod CSV on the phone). Body: `{ source: 'strong'|'hevy'|'fitbod'|'generic', workouts: [{ date, title, workout }] }`, at most 200 per request; each `workout.id` must start with `imp_` (the app derives it from the session, so re-importing overwrites). Rows that don't validate are skipped, not fatal. Returns `{ saved, skipped }`.

Imported sessions are stored in `users/{uid}/workouts` with `imported: true` and read back by `GET /workouts` like any other, but they never count towards the leaderboard (`totalVolume` / `workoutCount`), the exercise board or "passed you" notifications. `POST /workouts` and `DELETE /workouts/:id` keep it that way for later edits. Rate limit: 60 requests an hour. See `src/workoutImport.js`.

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
- Notes: `POST|GET /api/coach/clients/:clientUid/notes`. Technique videos (per exercise): `POST|GET /coach/exercise-videos`, `DELETE /coach/exercise-videos/:id`. Coach videos (program / diet / cardio / general walkthroughs, Loom/YouTube/Vimeo/Drive links): `GET|POST /api/coach/videos`, `PATCH|DELETE /api/coach/videos/:id` — body `{ title, category: program|diet|cardio|technique|general, videoUrl, message?, audience: all|selected, clientUids? }`; active clients it reaches get a `coach_video` notification. Leads: `GET /api/coach/leads`, `PATCH /api/coach/leads/:id`.

**Client side**
- `GET /api/client/coach-invites`, `POST /api/coach/clients/accept` `{ coachUsername }`, `DELETE /api/client/coaches/:coachUid` (decline a pending invite or leave a coach).
- `GET|PUT /api/client/coach-sharing` `{ checkIns, bodyweight, workouts, nutrition, photos }`: check-ins, bodyweight and workouts are on by default; nutrition and photos are off and stay undecided (see `decided`) until the client answers. Turning a switch off deletes that data from every coach's copy.
- `POST /api/client/coach-share` `{ checkIns, bodyweight, workouts: { thisWeek, weekStart, weekly }, compliancePercent, activeProgramName }`: filtered by the switches and copied to each active coach. Returns `{ coaches: 0 }` when there is no coach.
- `PUT /api/client/checkin-photos/:date` `{ photos: [{ image: dataUrl, pose? }] }` (up to 10 JPEG/PNG/WebP, 450 KB each) replaces the photos on that check-in; `DELETE` removes them. Refused unless check-in sharing and photo sharing (`photos`) are both on; turning either off deletes them, and so does the last coach link ending. Only the newest 12 check-in dates keep photos. Coaches read them with `GET /api/coach/clients/:clientUid/checkin-photos/:date`; `GET /api/coach/clients/:clientUid` adds `photoCount` to check-ins that have photos (src/checkInPhotos.js).
- Check-in comments (src/checkInComments.js): `GET|POST /api/coach/clients/:clientUid/checkins/:date/comments` `{ text ≤ 1000, photoIndex? }` (a photoIndex pins the comment to one of that check-in's photos), `GET /api/client/checkins/comments` (every thread + `photoDates`), `GET|POST /api/client/checkins/:date/comments` `{ text, coachUid? }`. Notifications `coach_checkin_comment` (to the client) and `client_checkin_reply` (to the coach), one row per person and date while unread; the comment text is never in the notification. Roster rows carry `photoDates`, `coachCommentDates` and `awaitingReplyDates`. Comments go when the link ends or either account is deleted.
- Messages (src/coachMessages.js): the coach's notes and the client's replies read as one thread. `GET /api/coach/clients/:clientUid/messages` (oldest first; marks the thread read), `POST /api/coach/clients/:clientUid/checkin-request` (at most one per 12 hours; notification `coach_checkin_request`), `GET /api/client/messages` (the caller's own replies + `coaches`), `POST /api/client/messages` `{ text ≤ 1000, coachUid? }` (notification `client_message` to the coach, text never included). The coach still writes with `POST /api/coach/clients/:clientUid/notes`. Roster rows carry `lastMessageAt`, `lastMessageText`, `lastMessageAuthor`, `unreadMessages` and `checkInRequestedAt`. Replies go when the link ends or either account is deleted.
- Check-in settings and review: `PATCH /api/coach/clients/:clientUid` accepts `checkInSettings` `{ everyDays 1–28, questions: up to 8 strings ≤ 140 }` (mirrored to the client's coach assignment); a shared check-in may carry `answers: [{ q, a }]`. `POST /api/coach/clients/:clientUid/checkins/:date/reviewed` sets the roster's `reviewedCheckInDate`. Roster rows carry `checkInSettings` and `reviewedCheckInDate`.
- Roadmap and calendar: `PATCH /api/coach/clients/:clientUid` accepts `roadmap` `{ phases: [{ name, start, end, goal? }] (12 max), milestones: [{ date, title }] (20 max) }` or `null`, mirrored to the client's coach assignment and announced as a plan update; roster rows carry `roadmap`. The coach's own calendar entries: `GET /api/coach/events`, `PUT /api/coach/events/:id` `{ title, date, time?, kind: 'call'|'other', clientUid?, note? }`, `DELETE /api/coach/events/:id` (coach-only, 1000 max).
- Groups and automations: `GET /api/coach/groups`, `PUT /api/coach/groups/:id` `{ name, clientUids }` (members limited to the roster; coach-only, 100 max), `DELETE /api/coach/groups/:id`. `GET|PUT /api/coach/automations` `{ checkInReminder: { enabled, graceDays 0–14 }, welcome: { enabled, text ≤ 1000 } }` (src/coachAutomations.js). The reminder runs daily as the `coachCheckInReminders` scheduled function and sends `coach_checkin_request` once per missed check-in; the welcome is sent as a coach note when a client becomes active.
- Coach libraries (src/routes/coachLibrary.js): workouts `GET /api/coach/workouts`, `PUT /api/coach/workouts/:id` `{ name, focus?, notes?, exercises }` (one program/2 day, same validation as programs; 300 max), `DELETE /api/coach/workouts/:id`. Vault, links only: `GET|POST /api/coach/vault` `{ title, url, description?, folder?, audience: 'all'|'selected', clientUids? }` (300 max; notification `coach_resource`), `DELETE /api/coach/vault/:id`, `GET /api/client/coach-vault` (items from active coaches meant for the caller).
- Form checks (src/formChecks.js), links only: `GET|POST /api/client/form-checks` `{ exercise, videoUrl, note?, coachUid? }` (30 per client), `POST /api/client/form-checks/:id/comments` `{ text }`, `DELETE /api/client/form-checks/:id`, `GET /api/coach/form-checks` (waiting ones first), `POST /api/coach/form-checks/:id/comments` `{ text, atSeconds? }` (seconds or `m:ss`; marks it reviewed). Notifications `client_form_check` (to the coach) and `coach_form_check` (to the client). Deleted when the link ends or either account is deleted.
- `GET /api/client/coach-assignment` (includes `program` and `macroTargets`), `GET /api/client/coach-notes`, `GET /exercise-videos`, `GET /api/client/coach-videos` (videos from active coaches meant for the caller, newest first).

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
Returns the registry version, the packages with their phase layouts, the
tier adjustment caps, and `butters`: the pinned Butters University commit
plus rule ids grouped by BU status (`match`, `partial`, `conflict`,
`not_covered`, `unreviewed`). See `rules/README.md`.

### `POST /api/coach/plans/preview`
Body: `{ leadId | intake, instellingen?, packageId, startDate: "YYYY-MM-DD", tier: "basis"|"medium"|"premium", clientUid? }`.
Returns `{ plan }` **without saving it**. `plan.butters` lists the rules
behind the plan that conflict with or only partly match Butters University,
so the coach can review them before approving. It stays coach-side.

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
- copies a client view of the plan to `users/{clientUid}/plans`, without the override log, provenance, red flags or the Butters University review
- marks the client's previous plan from this coach as superseded
- updates the coach-assignment summary fields and notifies the client

### `GET /api/client/plan`
Returns the signed-in client's current published plan, or `{ plan: null }`.

## Calendar sync (program days as a calendar feed)

The app works out which program session falls on which date and uploads the
days from two weeks ago to twelve weeks ahead. They are served as an iCalendar
feed at a secret link that Apple Calendar, Google Calendar or Outlook subscribe
to. Server-only storage: `calendarFeeds/{token}`, `calendarFeedOwners/{user}`.
See `src/routes/calendar.js`; tests in `scripts/test-calendar.js`.

### `GET /api/calendar`
`{ enabled, path }`: `path` is `/cal/<token>.ics` when the feed exists.

### `PUT /api/calendar`
Body `{ programName, events: [{ date: 'YYYY-MM-DD', title, description }] }`
(max 120 events). Creates the feed on first call and replaces its events after
that. Returns `{ path, count }`.

### `POST /api/calendar/reset`
New secret link, same events. The old link stops working.

### `DELETE /api/calendar`
Removes the feed. Also removed on account deletion.

### `GET /cal/:token.ics` (public)
The feed itself, `text/calendar`. No login (calendar apps can't send one); the
unguessable token is the protection. All-day events with one stable UID per
date, so a changed day updates in place.

## Coach guide (setup checklist and tours)

Progress for the welcome sheet, "Get set up" checklist and tours shown to coaches after they take the Coach plan (`src/coachGuide.js`). Stored on `users/{uid}.coachGuide` so the phone app and the `coach/` dashboard show the same progress. Coach plan only (`403 plan.coach_required` otherwise).

### `GET /api/coach/guide`
Returns `{ success, synced, guide: { welcomeSeen, dismissed, steps: { [id]: iso }, tours: { phone?, desktop? } } }`. Step ids: `code`, `client`, `program`, `macros`, `checkin`, `desktop`.

### `POST /api/coach/guide`
Body (all optional): `{ steps: [id…], welcomeSeen: true, tour: 'phone'|'desktop', replay: 'phone'|'desktop', dismissed: true|false }`. Marks are only added (the first time is kept); `replay` clears a tour so it runs again; unknown ids are ignored. Returns the merged guide.
