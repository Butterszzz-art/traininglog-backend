# Phase 2: Firestore Data Migration — Progress Notes

## What's built (this pass)

- **Legacy account reclaim** (`server.js` `/auth/signup-complete`, `legacyMigration.js`): a beta tester signing up with a username that matches an existing Airtable row must supply that account's old password (`legacyPassword`). On verification, their plan/referral fields carry over from Airtable instead of defaulting to free, custom claims get set accordingly, and `migrateLegacyUserData()` copies their per-table Airtable history into Firestore under the new uid. `/auth/username-available` now returns `{ available, reclaimable }` so the client can prompt for the old password instead of just blocking.
- **`firestore.rules`**: default-deny; owner-only access under `users/{uid}/**`; `usernames/{username}` and coach roster writes are server-only. Not deployed yet — needs `firebase deploy --only firestore:rules` via the Firebase CLI (manual step).
- Frontend (`TrainingLog-mobile` — separate PR, not yet merged from this pass): a `legacySignupPasswordField` appears on the Sign Up tab when the server reports `reclaimable: true`, wired through `firebaseAuth.signup()`/`completeSignup()`.

## Collection homes decided this pass

| Airtable table | Firestore home | Notes |
|---|---|---|
| `Days` | **Retired, not migrated** | Confirmed write-only in the live app — `workoutTimer.js` posts to `/days` fire-and-forget, nothing ever reads it back. Duplicates data already properly owned by Workouts/DailyMacros/CardioLog/BodyweightLog. |
| `MacroTargets` | `users/{uid}.macroTargets` (map field, not a subcollection) | Single set of numbers per user, not a history — principle #2 (small/bounded → field, not subcollection). |
| `DailyMacros` | `users/{uid}/dailyMacros/{id}` | Per-day log, unbounded over time. |
| `Templates` | `users/{uid}/templates/{id}` | `TemplateData` blob stored as-is under `templateData` (schema drifted across records — some have `dropsetArray`/`restPauseArray`/etc that others don't; don't force a rigid shape). |
| `Workouts` | `users/{uid}/workouts/{id}` + `sets` subcollection | Per the original schema doc design. **Table is nearly empty in production** — only 3 blank rows exist; real workout history lives in each browser's localStorage and was never synced here. This migration can't recover that. |
| `Programs` | `users/{uid}/programs/{id}` | `ProgramData` blob shape unconfirmed (empty in every sampled record) — stored as-is under `programData`. |
| `BodyweightLog` | `users/{uid}/bodyweightArchives/{id}` | 4-week archive snapshots, not raw daily entries. |
| `BodyMeasurements` | `users/{uid}/measurements/{id}` | |
| `CardioLog` | `users/{uid}/cardioLogs/{id}` | |
| `CrossFitLog` | `users/{uid}/crossfitLogs/{id}` | |
| `DailyMissionState` | `users/{uid}/dailyMissions/{id}` | Keyed by `UserId` in Airtable, not `Username` — but the app has no separate id system, `UserId` is populated with the username string. |
| `MobilityRoutines` | `users/{uid}/mobilityRoutines/{id}` | Migration only carries over self-created routines (`Username` match). Coach-assigned ones (`AssignedByCoach`) need a cross-account reference this pass doesn't build — **known gap**, see below. |
| `MobilitySessions` | `users/{uid}/mobilitySessions/{id}` | |
| `CoachClients` | `coaches/{coachUid}/clients/{athleteRecordId}` | Migrated when the reclaiming username matches a `CoachId`. `athleteUid` is left `null` — resolved only once that athlete also migrates (no reverse lookup yet). |
| `ExerciseVideos` | **Not yet decided** | Likely `coaches/{coachUid}/exerciseVideos/{id}` (parallels the `clients` pattern) but not confirmed against the live routes/schema — do this before building the exercise-library work. |
| `Users` | `users/{uid}` (already built in Phase 1) | |

## Known gaps

1. **Coach ↔ athlete uid resolution.** Migrated `CoachClients` rows reference the athlete only by their old Airtable record id, not a Firestore uid — there's no reverse-lookup step yet for "this athlete already migrated, link them up." Needs a follow-up pass once real coach/athlete pairs actually reclaim their accounts.
2. **Coach-assigned mobility routines** aren't migrated to the athlete's `mobilityRoutines` subcollection — only self-created ones are, for the same cross-account-reference reason as above.
3. **`ExerciseVideos`** has no decided Firestore home yet.
4. **Workouts/Programs migration recovers almost nothing** in practice, since that data lives in localStorage, not Airtable. If preserving on-device workout history matters, it needs a *client-side* migration path (sync localStorage to Firestore on first login post-reclaim), which is a different mechanism than this server-side Airtable migration.
5. Test residue in production Firestore from verification passes: a handful of `users/{uid}` + `usernames/{username}` docs from disposable test accounts (Firebase Auth accounts and Airtable rows were cleaned up; the Firestore docs are orphaned but inert — no PII, safe to delete manually from the Firebase Console if you want them gone, or ignore).

## Not started

- Rewriting the ~40 existing Express routes to read/write Firestore instead of Airtable (the actual "cutover" for non-auth data). Everything above only prepares the target structure and the reclaim-time migration path; live traffic still reads/writes Airtable until those routes are rewritten and tested — a separate, larger pass.
- Deploying `firestore.rules` (manual, needs Firebase CLI).
