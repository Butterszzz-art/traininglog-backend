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
