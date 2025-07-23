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

