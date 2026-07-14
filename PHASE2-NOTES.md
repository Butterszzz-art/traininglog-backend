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
| `ExerciseVideos` | `coaches/{coachUid}/exerciseVideos/{slug}` | Decided and built — slug is the lowercased/dashed exercise name, so upsert-by-name is a plain `doc(slug).set()`. |
| `KnowledgeBase` | `knowledgeBase/{id}` (top-level, global — not per-user) | Migrated via `POST /admin/knowledgebase/migrate` (additive, idempotent). 6 of 7 real Airtable records migrated (1 skipped — missing `ModuleName`, a pre-existing bad row). |
| `Users` | `users/{uid}` (already built in Phase 1) | |

## Known gaps

1. **Coach ↔ athlete uid resolution.** Migrated `CoachClients` rows reference the athlete only by their old Airtable record id, not a Firestore uid — there's no reverse-lookup step yet for "this athlete already migrated, link them up." Needs a follow-up pass once real coach/athlete pairs actually reclaim their accounts.
2. **Coach-assigned mobility routines** aren't migrated to the athlete's `mobilityRoutines` subcollection — only self-created ones are, for the same cross-account-reference reason as above.
3. ~~`ExerciseVideos` has no decided Firestore home yet.~~ Resolved — see table above.
4. **Workouts/Programs migration recovers almost nothing** in practice, since that data lives in localStorage, not Airtable. If preserving on-device workout history matters, it needs a *client-side* migration path (sync localStorage to Firestore on first login post-reclaim), which is a different mechanism than this server-side Airtable migration.
5. Test residue in production Firestore from verification passes: a handful of `users/{uid}` + `usernames/{username}` docs from disposable test accounts (Firebase Auth accounts and Airtable rows were cleaned up; the Firestore docs are orphaned but inert — no PII, safe to delete manually from the Firebase Console if you want them gone, or ignore).
6. **No Stripe webhook exists anywhere in this codebase.** Confirmed by search while converting the plan/billing routes. `UserPlan`/`SubStatus`/etc. never actually get updated post-checkout today — a pre-existing gap, not something this pass introduced or fixed. `syncTierClaim()` (built in Phase 1) has no caller yet; wire it in whenever a webhook handler gets built.

## Route cutover — complete

**Pattern (established this pass, apply to everything below):** `const uid = await resolveFirestoreUid(req.user.username);` — if `uid` resolves, that user has migrated; read/write Firestore exclusively for this route (no dual-write, no fallback-merge — Firestore is the sole source of truth for them from this point on). If `uid` is `null`, they haven't migrated; leave the existing Airtable code path completely untouched. `resolveFirestoreUid` works identically regardless of whether the current request carries a Firebase ID token or a legacy JWT — it only depends on whether that username ever completed `/auth/signup-complete`.

Verify each conversion with the same method used for MacroTargets/Templates: `node scripts/test-firestore-routes.js` — a full HTTP-level test against the real `server.js` with `firebase.js`'s `db` mocked via `require.cache` injection and a locally-signed legacy JWT (bypasses the email-verification gate that blocks live production testing without a real inbox). Add request/assert blocks there for each newly-converted route.

| Route(s) | Table | Status |
|---|---|---|
| `GET/POST /macrotargets` | MacroTargets | ✅ Converted |
| `POST/GET/DELETE /templates` | Templates | ✅ Converted |
| `POST/GET /dailylogs` | DailyMacros | ✅ Converted |
| `POST /bodyweight/archive`, `GET /bodyweight` | BodyweightLog | ✅ Converted |
| `POST /measurements/sync`, `GET /measurements` | BodyMeasurements | ✅ Converted |
| `POST /cardio/sync`, `GET /cardio` | CardioLog | ✅ Converted |
| `POST /crossfit/sync`, `GET /crossfit` | CrossFitLog | ✅ Converted |
| `POST /programs` (+ `/saveProgram` alias), `GET /programs`, `PATCH /programs/:id/active`, `DELETE /programs/:id` | Programs | ✅ Converted. PATCH/DELETE resolve uid from the caller's own `req.user.username`, not the query/body username param (matches DELETE's pre-existing ownership model); PATCH checks the target doc exists before setting `isActive` to avoid silently creating a doc from a bad id. |
| `PUT /api/bodybuilding/daily-mission/:userId` | DailyMissionState | ✅ Converted. Upserts by date within `users/{uid}/dailyMissions`. |
| `GET/POST/DELETE /mobility/routines`, `GET/POST /mobility/sessions` | MobilityRoutines, MobilitySessions | ✅ Converted. **Caveat carried over from gap #2:** the Airtable path's `GET /mobility/routines` shows a user's own routines *plus every coach-assigned routine system-wide* (a pre-existing quirk, not something this conversion changes); the Firestore path only shows the migrated user's own subcollection, so coach-assigned routines won't appear for migrated users until gap #2 is addressed. |
| `GET /api/coach/clients` | CoachClients | ✅ Converted. `coachId` query param resolves as the coach's own username. |
| `GET/POST /workouts` | Workouts | ✅ Converted. Whole `workout` object stored as-is (not exploded) so GET returns it byte-for-byte, matching the existing API contract; a `sets` subcollection is also populated best-effort for future analytics. |
| `POST /sendTemplate` | Templates (writes to a **different user's** templates) | ✅ Converted. Resolves the *recipient's* (`toUser`) uid, not the sender's. |
| `POST /coach/workouts` | Workouts (writes to a **client's** data, not the caller's) | ✅ Converted. Resolves the *client's* uid, not the coach's. Coach-client link verification stays on Airtable's `CoachClients` table unconditionally (gap #1 — not migrated bidirectionally yet). |
| `GET /api/user/plan`, `GET /api/referral/validate`, `GET /api/referral/stats` | Users (plan/referral fields) | ✅ Converted. Referral code/count lookups check both stores (a referrer or referred user could be on either side depending on when they migrated) and deduplicate so a migrated user's old Airtable row isn't double-counted alongside their new Firestore doc. |
| `POST /api/stripe/create-checkout-session`, `GET /api/stripe/portal` | Users (Stripe fields) | ✅ Converted the reads (referral credits, Stripe customer id). **No webhook exists to write plan fields post-checkout** (gap #6, pre-existing) — `syncTierClaim` still has no caller. |
| `POST/GET/DELETE /coach/exercise-videos`, `GET /exercise-videos` | ExerciseVideos | ✅ Converted. `GET /exercise-videos` independently resolves *each* linked coach's migration status and merges Firestore + Airtable results, since a client's coaches can be on either side regardless of the client's own status. |
| `POST /admin/ingest-pdf`, `GET /admin/knowledge-modules`, `GET /knowledge-context` | KnowledgeBase | ✅ Converted, plus new `POST /admin/knowledgebase/migrate` (one-time, additive, idempotent Airtable→Firestore copy — already run against production: 6/7 real modules migrated, 1 skipped for a pre-existing bad row missing `ModuleName`). This table is global/shared, not per-user, so the cutover check is `knowledgeBaseUsesFirestore()` (does Firestore have any modules yet) rather than `resolveFirestoreUid`. |
| `/register`, `/login` | Users (legacy auth) | Not converted, not going to be — these are the legacy JWT auth routes themselves, superseded by the Firebase flows. Removed at cutover (Phase 1 plan step 7), not migrated. |
| `/days/upsert`, `/days` (POST+GET) | Days | **Retired**, not converted — confirmed write-only dead weight. Routes stay registered (return success/empty) so cached clients don't 404, but no longer touch Airtable or Firestore. The dead `toFieldsFromDay`/`fromRecordToDay`/`findDayRecordId` helpers and `DAYS_TABLE`/`TABLE_NAME` constants were removed. |

All per-user and per-coach Airtable-backed routes are now converted to the Firestore-once-migrated pattern. Verification: `node scripts/test-firestore-routes.js` — 88/88 checks passing, covering every converted route's migrated-Firestore branch (the unmigrated-Airtable branch is untouched existing code, exercised implicitly by every route's own pre-existing behavior).

## Not started

- Deploying `firestore.rules` (manual, needs Firebase CLI).
- Building an actual Stripe webhook handler (gap #6) and wiring `syncTierClaim` into it.
- The coach↔athlete uid cross-reference (gap #1) and coach-assigned mobility routine surfacing (gap #2).
- Client-side localStorage→Firestore sync for real workout/program history (gap #4).
