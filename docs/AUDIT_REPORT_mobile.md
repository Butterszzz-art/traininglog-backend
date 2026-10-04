# PocketCoach Audit and "Master Plan Maker" Proposal

Audit date: 2026-10-03. Read-only. No tracked files were changed and nothing was committed or pushed.

**Repos read**
- `m:` = `Butterszzz-art/TrainingLog-mobile` (public), HEAD `8bfcae8`
- `b:` = `Butterszzz-art/traininglog-backend` (private), HEAD `620f1b1`. The production API lives here, not in `m:server.js`.
- `CI:` = `Butterszzz-art/ClientIntake` (public), shallow clone of the default branch, read-only

**How the audit was done.** I read files with grep/sed, ran `npm install` and `npm test` in `m:`, and ran `git fetch --depth=5000 origin main` in `m:` and `b:` so the secret scan could cover full `main` history. That fetch only updated `.git` internals. The other ~340 remote branches were **not** scanned. Every secret below is listed by path, commit and kind only. No values are shown.

---

## Executive summary

**Top 5 risks**
1. **Critical:** one Airtable personal access token is in the git history of the **public** mobile repo (`031a2561`, `77038b56`) and the private backend repo (4 commits). It was removed from HEAD in 2026-02 (mobile) and 2026-09 (backend). I could not verify whether it has been revoked. Revoke it now.
2. **Critical (if deployed):** the legacy `m:server.js` has an **unauthenticated** read/write proxy to every Airtable table (`m:server.js:557`), an unauthenticated `/dailylogs` endpoint open to formula injection, and a hard-coded fallback JWT secret. I could not verify whether it still runs anywhere (for example on Render). Confirm it doesn't, then delete it.
3. **High:** the public intake form (`m:intake/`, which posts to `b:/api/intake`) collects GDPR special-category data (PED use, injuries, body fat, sleep) with **no consent step**. `privacy.html` doesn't cover prospects. ClientIntake also emails a summary through Web3Forms and accepts unauthenticated Firestore creates.
4. **High:** integrity and erasure gaps:
   - Any logged-in user can overwrite another user's daily-mission record (IDOR, `b:server.js:3833`).
   - When a client deletes their account, the coach-side roster entry and notes stay behind.
   - Health data on the device survives logout and account deletion, which contradicts `delete-account.html`.
5. **High (blocks the generator):** there is no single source of truth for nutrition or progress.
   - Three different macro engines disagree: ClientIntake, the backend port of it (which has drifted), and the app's `macroEngine`.
   - Check-ins, phase state, and personal details are stored only in localStorage.
   - The Program tab has no concept of dated phases or per-phase nutrition.

**Top 5 reusable assets**
1. `b:src/intakeCalculations.js` is a pure port of ClientIntake's calculations, and `POST /api/intake` already turns a submission into a coach lead.
2. The backend coach/client model already checks roster links, Firestore rules deny by default, and Firebase Auth is in place with custom claims.
3. Program schema v2 already supports `weeks[]`, `phase` labels and `sameAs`. `today-program.js` works out the current week from a start date, and 10 premium multi-week JSON programs can serve as templates.
4. Several engines are pure and tested: `progressiveOverload`, `recoveryMap` (weekly sets per muscle), `checkinEngine`, `prepMode`, `complianceEngine`, `dailyMissionEngine`. All 55 test suites (381 tests) pass.
5. The prose knowledge base (`b:src/knowledge/*-methodology.js`, from Modules 1–20) and the PDF-to-JSON extractor (`m:knowledgeBase.js`) are a ready starting point for the rule registry.

---

## Part 1 — Architecture map

### 1.1 Stack and entry points

| Piece | Where | Notes |
|---|---|---|
| PWA / web app | `m:index.html` | One ~20,900-line, ~950 KB file. It loads ~40 classic and module `<script>` tags (`m:index.html:3981-4020`). There is **no bundler or TS compiler** (no tsconfig, and `package.json` only has `jest` and `start`). |
| Hosting (web) | `m:.github/workflows/deploy.yml` | Deploys the **entire repo root** to GitHub Pages on every push to `main` (`path: .`). |
| Capacitor iOS/Android | `m:capacitor.config.json`, `m:android/`, `m:codemagic.yaml` | Codemagic rsyncs the web assets into `www/`. It excludes `server.js`, `.env*`, `*.ts`, `tests`, `/coach` and `/intake` (`m:codemagic.yaml:11-40`). |
| Coach dashboard | `m:coach/index.html`, `m:coach/coach.js` | Static page. Calls the production API (`m:coach/coach.js:7`). |
| Public intake form | `m:intake/` | Static page. Posts to `b:/api/intake` (`m:intake/intake.js:12,118`). |
| Production API | `b:functions-entry.js` → `b:server.js` | A single Express app wrapped as the Firebase Cloud Function `api` in project `pocketcoach-280c4`. Secrets come from Secret Manager (`b:functions-entry.js:19-41`). |
| Legacy API | `m:server.js` | An Express server that talks to Airtable. Nothing in the clients points at it: `m:config.js:2`, `m:src/config/constants.js:9` and `m:coach/coach.js:7` all point at the Cloud Function. `m:.env.production:2` mentions Render. **Whether it is deployed is unverified.** |
| Firebase | `b:firebase.js`, `b:firestore.rules`, `m:src/js/firebase-auth.js`, `m:src/js/firebase-config.js` | Auth and Firestore. Only the server (Admin SDK) reads and writes Firestore (`b:firestore.rules:3-9`). |
| Airtable | `b:server.js` (legacy fallback for unmigrated users), `m:server.js`, `m:index.html:4131,4257-4300` | Legacy store. The backend treats it as optional now (`b:server.js:404-420`). |
| AI | `b:src/routes/ai.js` (Anthropic SDK), `m:src/coach/client.js` (Anthropic **or OpenRouter**) | Backend AI routes require a paid plan (`b:server.js:4124,4188`). |
| Payments | `b:server.js:298` (Stripe webhook), `b:src/routes/appleIap.js` | |
| React/TS | `m:src/js/components/*.tsx`, `m:src/js/api/workoutHistory.ts`, `m:src/config/*.ts`, `m:resistanceLogs.ts` | **Dead code.** Nothing references them and there's no toolchain to compile them (see Part 2). |

### 1.2 Where each kind of data lives

| Data | Primary store | Evidence |
|---|---|---|
| Accounts | Firebase Auth plus Firestore `users/{uid}` and `usernames/{name}` | `b:server.js:1055-1160`. Legacy `/login` and `/register` return 410 (`b:server.js:968-981`). |
| Workouts / sets | Firestore `users/{uid}/workouts` via `/workouts` and `/api/sync`. Local cache in localStorage `workoutHistory` / `resistanceLogs` | `b:server.js:1190-1313`, `m:resistanceLogs.js`, `m:index.html:17232` |
| Programs | localStorage `programs_${user}` and `activeProgram_${user}`, synced to Firestore through `/api/sync`. Also `POST /programs` | `m:src/js/cloud-sync.js:62-63`, `m:src/js/programBuilderV2Core.js:2`, `b:server.js:2646-2751` |
| Bodyweight | localStorage `bodyweightLog_${user}`, synced through `/api/sync` | `m:src/js/cloud-sync.js:54`, `m:checkinEngine.js:6` |
| Macros (targets/history/daily) | localStorage `macroTargets_`, `macroHistory_`, `dailyMacro*`, synced. Also `/macrotargets` | `m:src/js/cloud-sync.js:60-73`, `b:server.js:1350-1389` |
| Personal details (weight/height/age/sex/BF%/activity) | localStorage `personalDetails` **only**, not synced | `m:index.html:9072`. Absent from the store list in `m:src/js/cloud-sync.js:53-74`. |
| Check-ins | localStorage `tl_checkins_v1_${user}` **only** | `m:checkinEngine.js:4`. Sync goes to a relative URL with no backend route (`m:checkinEngine.js:618-633`). |
| Phase / prep state | localStorage `tl_phase_state_v1_${user}` **only** | `m:prepMode.js:4,261-280`. Same problem: no backend route. |
| Compliance summary | localStorage `tl_compliance_summary_v1_` **only** | `m:complianceEngine.js:52,116-131` |
| Daily missions | localStorage `tl_daily_mission_v1_`, plus backend `users/{uid}/dailyMissions` | `m:dailyMissionEngine.js:4,156-170`, `b:server.js:3833` |
| Progress / posing photos | IndexedDB on the device | `m:posingMediaStore.js:21-31` |
| Coach–client links | Firestore `coaches/{coachUid}/clients/{clientUid}` mirrored to `users/{clientUid}/coachAssignment/{coachUid}` | `b:server.js:3039-3330` |
| Coach "plan" for a client | **Free-text strings** `currentProgram`, `nutritionSummary` and `trainingMode`, max 2000 chars each | `b:server.js:3265-3292` |
| Intake leads | Firestore `coaches/{INTAKE_COACH_UID}/leads/{id}` holding `{naam, intake, instellingen, calculations, status}` | `b:server.js:3432-3470` |
| ClientIntake clients | A **separate** Firebase project (`clientintake-cfa71`), collection `clients`, plus Storage `clients/{id}/…` | `CI:firebase.js`, `CI:client.js:106,380` |
| Community (legacy server) | In-memory arrays on the server | `m:server.js:447-538` |

### 1.3 Auth model
- **Production (`b:`).** `authenticateToken` accepts two kinds of token (`b:server.js:183-221`):
  - Firebase ID tokens. These must have a verified email and a `username` claim.
  - Legacy HS256 JWTs signed with `JWT_SECRET`. The server no longer issues these; the only `jwt.sign` left is the OAuth state at `b:server.js:2309`.
- **Roles:**
  - Admin: `ADMIN_USERNAMES` (`b:src/planAccess.js:17`).
  - Coach: the `coach` plan (`b:src/planAccess.js:52-64`).
  - Paid: the `pro` or `coach` plan (`b:src/planAccess.js:8`).
- **Coach→client access** checks that `coaches/{coachUid}/clients/{clientUid}` exists before reading or writing notes or plans (for example `b:server.js:3274-3280`).
- **History reads** are limited to the caller's own data by `ownUsername()` (`b:server.js:226-238`).
- **`coach/`** is a static dashboard. It uses the same Firebase login and stores the token in localStorage under `token` (`m:coach/coach.js:15-38`). Its server-side access comes from `requireCoachPlan`. It calls `/api/coach/programs` (`m:coach/coach.js:738,859`), but **no such route exists in `b:`**, so the request will 404.
- **`intake/`** needs no login. It writes leads through the unauthenticated, rate-limited `POST /api/intake` (20 per 15 minutes per IP, `b:server.js:3423-3430`). Leads all go to one hard-coded coach (`INTAKE_COACH_USERNAME`, `b:server.js:3421`).
- **Legacy (`m:server.js`):** its own JWT, falling back to `'change-me-in-production-please'` when the env var is missing (`m:server.js:38-41`). Most routes have **no auth at all** (see Part 5).

### 1.4 Languages / i18n
- `m:intake/` supports nl/en/es/pt (`m:intake/index.html:20-23`, dictionary in `m:intake/i18n.js`). It stores enum values as canonical Dutch keys whatever the display language (`m:intake/intake-form.js:9-16`).
- `CI:` supports the same four languages (`CI:intake.html:29-32`, `CI:i18n.js`).
- The **main app (`m:index.html`) and `m:coach/` are English-only, with Dutch labels in coach intake views**. There is no i18n framework (inferred from the absence of any i18n loader in index.html; not exhaustively verified).
- `privacy.html`, `terms.html` and `delete-account.html` are English-only.

---

## Part 2 — Module audit

Shared notes:
- "Registry-ready" means the constants could come from rule lookups.
- Every module except `knowledgeBase.js` is a browser script attached to `window` (several also use CommonJS `module.exports` for Jest).

| Module | Purpose | Inputs → outputs | Hard-coded constants (file:line) | Pure / tests | Dead / dup | Registry change needed |
|---|---|---|---|---|---|---|
| `periodization.js` | Makes a 4-week %1RM load template and a simple day→exercise schedule | `(type, exercises[])` → `[{week, load, exercises}]`; `(days, exercises[])` → `[{day, exercise}]` | linear 70/75/80/85, block 60/65/70/55, undulating 60/80/70/85, hybrid 70/80/65/90 (`:3-8`) | Pure, **no tests** | **Dead.** Loaded at `m:index.html:4007` but nothing calls `buildPeriodizationTemplate` or `createSplitSchedule`. | Replace with registry `training.periodization.*` load tables, or delete. |
| `autoProgression.js` | Flags each exercise "deload" or "progress" from PR history | `(user)` → `[{type:'deload'|'progress', exercise}]` | Deload if ≥4 history points and latest 1RM ≤ the one 4 points ago (`:8-13`) | Reads localStorage through `loadPRs` (`:1`), so impure. **No tests.** | Called at `m:index.html:6073`. Its logic overlaps the `reduce` branch of `progressiveOverload`. | Window (4) and comparison → `training.deload.stallTrigger`. Pass history in to make it pure. |
| `progressiveOverload.js` | Suggests next-session load/reps from history, RPE and rep goal | `(exercise|entry, workouts[])` → `{strategy, sets[{reps,weight}], previousSets, averageRate, message}` | Default rate +2.5 kg / +1 rep (`:70`); min step 1.25 (`:148,169,191`); round to 0.5 (`:169,177,191`); reduce = max(1.25, step×0.5) (`:169`); trend threshold 0.25 (`:189,196`); `maxedOut` adds reps (`:151-165`). Increments assume kg even when `unit` is lb; unit is only used for the label (`:120`). | Pure, 4 tests | — | Increments, rounding and thresholds → `training.progression.*`, with `conditions` for unit, equipment and exercise class. Use the client's smallest plate (`materiaal.laagstePlaat`) as the rounding increment. |
| `checkinEngine.js` | Normalises check-ins, attaches weigh-ins, builds trends and season milestones | `(userId, checkIn, phaseState)` → normalised check-in `{date, phase, bodyweight, waist, energy, hunger, sleep, stress, digestion, trainingPerformance, adjustments{…}, review{status,…}}` (`:72-140`); insights `{weightTrend, recoveryTrend, …}` | Lookback 6 days (`:10`); LB→KG 0.453592 (`:7`); stable trend ±0.25 (`:446`); weight change ±0.2, stable <0.15, **on-target loss 0.25–1.25 per check-in in absolute units, aggressive >1.25** (`:483-496`); recovery ±0.6 (`:521-524`); performance 0.4 (`:536`); milestones 16/12/8 weeks out, peak −7 d, post-show +7 d (`:345-357`); default archetype `recreational` (`:21`) | Mostly pure (storage is injectable), 16 tests | Backend sync targets a non-existent relative route (`:618-633`) | Rate-of-loss thresholds should be **%BW/week** registry rules. Absolute units per check-in ignore body size and lb/kg. Milestones → per-package phase config. |
| `complianceEngine.js` | Weighted daily and weekly compliance % per archetype, plus insights | `(userId, endDate, archetype)` → `{averagePercent, completedDays, status, insights[]}` | Buckets 90/75/50 (`:4-9`); weights per archetype (`:12-50`, e.g. bodybuilder macros 0.24, powerlifter workout 0.30); "completed day" ≥90% (`:261`); insight cut-offs 90/75/50 (`:359-373`); default archetype **`hybrid`** (`:11`), which conflicts with checkinEngine's `recreational` | Mostly pure, 4 tests | Sync targets a non-existent route (`:116-131`) | Weights → `coaching.compliance.weights.{archetype}`. Pick one default archetype. |
| `macrosFeatures.js` | UI glue for macros: quick-add, sparklines, heatmap, week planner | DOM / localStorage → charts | 4/4/9 kcal per gram (`:94,148,225`); macro text regex (`:29-33`). Mixes key names `fat` and `fats` (`:50,67`). | Impure (DOM), **no tests** | Target maths delegates to `window.calculateMacroTargets` (`:194`) | Nothing to move. It should *display* plan targets rather than compute them. |
| *(related)* `src/utils/macroEngine.js` | The app's actual macro target calculator | `{weightKg, heightCm, ageYears, bodyFatPercent, sex, activityFactor, goal, rate, formula}` → `{calories, proteinGrams, fatGrams, carbGrams, …}` | Katch 370+21.6·LBM (`:15`); Mifflin (`:25-28`, **the UI default** at `m:index.html:9094`); cut −10/−15/−20% (`:45`); bulk +5/+8/+12% (`:46`); protein **2.0 g/kg cut**, 1.8 otherwise (`:63`); fat floor 0.6 g/kg, fat 25%/30% of kcal (`:68-71`); training-day and sleep adjustments (`:141-206`); carb-cycle multipliers (`:253-285`); meal templates (`:308-316`) | Pure functions, but **no direct tests** (I found no test file importing `macroEngine`) | **A third nutrition model** (see Part 3) | Highest-priority candidate for the registry. |
| `prepMode.js` | Single current phase state for bodybuilding prep (mode, show date, labels, peak-week checklist) | `(userId, state)` → sanitised state `{mode, showDate, startDate, targetStageWeight, targetRateOfLoss, checkInDay, prepStartDate, reverseDietStartDate, …}` (`:96-141`); `getPhaseContext` → `{daysUntilShow, weeksOut, isPeakWeek…}` | Modes improvement / mini_cut / contest_prep / peak_week / show_day / post_show (`:5-23`); peak week ≤7 days (`:336,360`); "execution ready" ≥85% (`:463`) | Mostly pure, 6 tests | Sync targets non-existent `/api/bodybuilding/phase-state` and `/api/ping` (`:261-290`) | Holds **one** phase only, with no sequence. A phase timeline (Part 7) should replace it. Modes → registry phase types. |
| `knowledgeBase.js` | Server-side: PDF → Claude → structured JSON → Airtable `KnowledgeBase` | PDF buffer → `{principles[], methods[], progressionModel, nutritionGuidelines{}, …}` (`:17-34`) | 50 MB upload limit (`:8`); model `claude-sonnet-4-6` (`:49`); text cut at 120k chars (`:39`) | Network I/O, **no tests** | Used only by legacy `m:server.js:642-720` | Good starting point for *drafting* registry entries, but its output has no IDs, params or evidence grades. It needs a human-verified step before anything reaches the registry. |
| `exerciseMuscleMap.js` | Exercise name → **primary** muscle | `name` → `'chest'|'back'|…` | ~1,080 name→muscle entries (`:4-1088`) | Pure, 2 tests | Generated or synced by `m:scripts/sync-exercise-muscle-map.js` | Add fractional secondary muscles (e.g. rows count 0.5 to biceps). Without them, weekly set counts per muscle are wrong for an evidence-based volume rule. |
| `recoveryMap.js` | Per-muscle 7-day fatigue score and colour, from sets vs targets plus recency | `(workouts[], {targets, soreness, now})` → per muscle `{sets, target, fatigueScore, status, color}` | **Weekly set targets** chest 14, back 16, shoulders 12, traps 8, biceps 10, triceps 10, forearms 8, quads 14, hamstrings 10, glutes 10, calves 8, adductors 6, abductors 6, abs 8 (`:3-7`); bounds (`:12-18`); recovery half-life days (`:27-31`); status cut-offs 25/55/80 (`:79-81`); 7-day window (`:96`); score = 0.55·volume + 0.35·recency + 0.10·soreness (`:135-136`) | Pure, 9 tests | — | The default targets should come from the plan's `training.weeklySetsPerMuscle`, which in turn comes from registry `training.volume.*`. Treat half-lives as a low-evidence heuristic and grade them accordingly. |
| `calculateWorkoutVolume.js` | Tonnage (reps × weight), total and by muscle | `workout{log[{repsArray, weightsArray, exercise}]}` → number / `{muscle: tonnage}` | none | Pure, 1 test | **Duplicate.** There's no `<script>` tag for it. The app uses its own copy at `m:index.html:13672`, so the test covers the copy nobody runs. | None. Volume rules should count **sets**, not tonnage (`b:src/knowledge/training-methodology.js:53`). |
| `goals.js` | SMART goals: create, update progress, compute progress from workouts | `(user, goalInput)` → goal `{id, type, targetValue, startValue, currentValue, …}` | none of note | localStorage, 3 tests | Separate from the unrelated `lifestyle_goals` store in `lifestyle.js:205-227` | Phase end criteria (Part 7) could reuse this goal shape. |
| `lifestyle.js` | Study/todo/habit planner built on `prompt()` dialogs | DOM → localStorage `lifestyle_*` (`:1-6`) | none | Impure, **no tests** | **Name clash:** nothing to do with intake "lifestyle" (activity, stress, sleep) | None. Consider removing it from a coaching product. |
| `dailyMissionEngine.js` | Daily checklist per phase (workout, cardio, macros, weigh-in, posing, recovery, steps) | `(userId, date, phase)` → mission state `{workoutComplete, …}` | `PHASE_MISSION_MAP` (`:15-20`); steps goal 10,000 (`:340`) | Mostly pure, 5 tests | Syncs to `b:/api/bodybuilding/daily-mission/:userId` (`:156-170`), the endpoint with the IDOR (Part 5) | Mission sets per phase type → registry or package config. Steps target → plan `recovery.stepsTarget`. |
| `progressAI.js` | Text tip when e1RM rises ≥5% over 3 entries | `(prsHistory, weeks=3)` → `string[]` | 5% threshold, 3-week window (`:6-12`) | Pure, **no tests** | Called at `m:index.html:16320` | Threshold → registry. Low priority. |

**Duplicates and dead code**
- `resistanceLogs.ts` is labelled "Prototype-only" (`m:resistanceLogs.ts:1`). It exports the same names as `resistanceLogs.js`, has no compiler, and is excluded from mobile builds (`m:codemagic.yaml:32`). The app imports the `.js` version (`m:history.js:2`). The same applies to `src/config/constants.ts`, `loadConfig.ts`, `src/js/api/workoutHistory.ts` and `src/js/components/*.tsx`: nothing imports them.
- `.clone/worktrees/loving-lalande-7c033d/src/js/challenges.js` is a stale tracked copy. Its diff against `src/js/challenges.js` is 298 lines.
- Volume maths lives in two places (`calculateWorkoutVolume.js` and `index.html:13672`).
- Intake calculations live in two places (`CI:calculations.js` and `b:src/intakeCalculations.js`), and the copies have drifted (Part 3).

---

## Part 3 — Overlap with ClientIntake

`m:intake/intake-form.js` already uses ClientIntake's schema (a subset of it). `b:/api/intake` stores `{intake, instellingen}` and runs the ported `berekenClient` on them. Neither the app's profile/macro model nor the coach dashboard maps these fields onto app data yet.

### 3.1 Field mapping

Columns:
- **CI** = `CI:intake-form.js:49-89`
- **PC-intake** = `m:intake/intake-form.js:37-62`
- **PC-app** = the main app's equivalent: `personalDetails` (`m:index.html:9086-9095`), settings profile (`m:src/js/settings.js:215-220`) and prepMode state

| CI field | PC-intake | PC-app equivalent | Notes / conflicts |
|---|---|---|---|
| `persoonsgegevens.naam`, `email` | ✓ | account username / email | No link from lead to uid until the client accepts an invite |
| `persoonsgegevens.adres/postcode/stad/land` | ✗ | ✗ | **CI only.** Personal data with no stated purpose in PocketCoach. Don't migrate unless needed for billing. |
| `leeftijd` | ✓ | `ageYears` | — |
| `lengte` (cm) | ✓ | `heightCm` | App supports imperial display; intake is metric only |
| `gewicht` (kg) | ✓ | `weightKg`, `bodyweightLog_` | Check-in units can be lb (`m:checkinEngine.js:7`) |
| `vetpercentage` | ✓ | `bodyFatPercent` (optional) | Required by intake and by Katch; optional in the app |
| `geslacht` `man|vrouw|anders` | ✓ | `sex` `male|female` | **Enum conflict.** `anders` has no app mapping and Mifflin needs a binary. CI's volume calculator uses `vrouw` 0/1 (`CI:coach.html:208-209`). |
| `trainingservaring` (years) | ✓ | `settings.profile.experienceLevel` (string) | Unit conflict: years vs level label |
| `huidigeKracht[{oefening,kg,herhalingen,sets}]` | ✓ | PR history (`progressUtils`) | Could seed starting loads |
| `doel.categorie` `vetverlies|spieropbouw|onderhoud|krachttoename` | ✓ | macro `goal` `cut|maintain|bulk`; prepMode `mode` | **Enum conflict.** `krachttoename` has no app equivalent. |
| `doel.tekst` | ✓ | — | |
| `doel.spiergroepenNietGroter`, `andereSporten`, `gewenstFrequentieTekst` | ✗ | — | **CI only** |
| `motivatieMindset.*` | ✓ | — | |
| `trainingsfrequentie.huidig` | ✓ | program `split.daysPerWeek` / `schedule.weekdays` | |
| `trainingsfrequentie.trainingsmomenten[]` | ✓ | program `schedule.weekdays` (ints 1–7) | Free-text tags vs ints |
| `trainingsfrequentie.nietBeschikbaarTekst` | ✗ | — | **CI only** |
| `baan.{type,urenZittend,urenStaand}` | ✓ | — | Could inform PAL |
| `blessures.{tekst, vermijdenOefeningen[]}` | ✓ | rehab notes (`src/js/rehab.js`) | Program generator must apply `detecteerBlessureConflicten` |
| `dieet.{huidig, voorkeuren[], afkeuren[]}` | ✓ | — | |
| `dieet.specifiekDieet` | ✗ | — | **CI only** |
| `peds.{gebruikt, toelichting}` | ✓ | — | Special-category data |
| `peds.disclaimerGeaccepteerd` | ✗ | — | **CI only.** PocketCoach records no PED disclaimer or consent. |
| `lifestyle.activityLevel` | ✓ `sedentair|licht actief|actief` | `activityFactor` (number) | **CI adds `erg actief` (1.725)** (`CI:calculations.js:10`). The backend port drops it (`b:src/intakeCalculations.js:6-10`), so `palVoorActiviteitsniveau('erg actief')` silently falls back to **1.2**. That underestimates a very active client's maintenance by about 30%. |
| `lifestyle.stressLevel` | ✓ `laag|gemiddeld|hoog` | check-in `stress` 1–10 | **CI uses a 4-level scale** `stressvrij|sporadisch_mild|gemiddeld|veel_stress` (`CI:intake.html:242-245`). The backend red-flag check only tests `'hoog'` (`b:src/intakeCalculations.js:253`), so CI's `veel_stress` never raises a flag on the backend. |
| `lifestyle.slaap.{uren,kwaliteit}` | ✓ | check-in `sleep` rating, activity-sync sleep | |
| `slaap.ritmeToelichting`, `cafeineToelichting` | ✗ | — | **CI only** |
| `lifestyle.cafeine` (mg) | ✓ | — | |
| `vetpercentageMeting.huidplooimeter` | ✓ | — | |
| `vetpercentageMeting.methode` | ✗ | — | **CI only** |
| `materiaal.{laagstePlaat, dumbbellStapgrootte}` | ✓ | plate calculator settings | Should drive the progression rounding increment |
| `materiaal.apparatuur[]` | ✓ (12 keys) | — | **CI has 19 keys.** The extra seven are `reverse_hyper`, `glute_ham_raise`, `standing_calf_raise_machine`, `seated_calf_raise`, `knee_wraps`, `gymnastic_rings` and `resistance_bands` (`CI:intake-form.js:13-19` vs `m:intake/intake-form.js:12-16`). |
| `materiaal.overig` | ✗ | — | **CI only** |
| `supplementen` | ✓ | — | |
| `genen.{polsomtrek, enkelomtrek, gewichtVoorheen, zwareBaby}` | ✓ | — | `frameSizeCheck` uses ankle 21.9 ± 1.3 cm |
| `genen.lengteVoorheen`, `handFotoUrl/Bestandsnaam` | ✗ | — | **CI only.** The hand photo is stored in CI's Firebase Storage. |
| `huidigProgramma.{tekst, bestandUrl, bestandNaam}` | ✗ | — | **CI only** |
| `instellingen.*` (coach overrides: `trainingsdagenPerWeek`, `trainingsduurMinuten`, `MET`, `pal`, `tef`, `energiebalansFactor`, `eiwitFactor`, `percentageVetVanREE`, `aantalMaaltijden`, `postTrainingBoost`) | stored by `b:` | — | Exactly the per-client coach overrides the plan schema needs |
| `calculations.*` | computed by `b:` | `macroTargets_` | Two different engines produce these (below) |
| — | — | `archetype`, check-ins, phase state, bodyweight log, programs | **PocketCoach only** |

### 3.2 Formula conflicts (nutrition)

| Item | ClientIntake / backend port | PocketCoach app `macroEngine` | Knowledge base text |
|---|---|---|---|
| BMR | Katch–McArdle 370 + 21.6·FFM (`CI:calculations.js:62-64`) | Mifflin by default (`m:index.html:9094`, `macroEngine.js:25-28`); Katch available (`:15`) | — |
| Activity | PAL 1.2 / 1.375 / 1.55 / (1.725) | User-entered `activityFactor` | — |
| TEF | ×1.1 applied **on top of** BMR×PAL, and again on exercise EE (`CI:calculations.js:71-77`, `:406-408`) | none | — (**Verify against the course material.** PAL multipliers conventionally already include TEF, so this may count it twice.) |
| Training-day EE | MET 5.7 × 3.5 × kg / 200 × 60 min (`CI:calculations.js:66-68`) | Training-day adjustments from volume/RPE (`macroEngine.js:141-206`) | — |
| Deficit / surplus | Factor 0.8 / 1.0 / 1.1 / 1.05 (`CI:calculations.js:15-20`). The displayed range is 0.70–0.90, or +200–500 kcal (`:34-39`). | −10/−15/−20%, +5/+8/+12% by rate (`macroEngine.js:45-46`) | Module 14 ranges as in CI |
| Protein | 1.8 g/kg **for all goals** (range 1.6–2.4) (`CI:calculations.js:26,395`) | **2.0 g/kg on a cut**, 1.8 otherwise (`macroEngine.js:63`) | "Protein during a cut does NOT increase … keep at 1.8 g/kg" (`b:src/knowledge/nutrition-methodology.js:20`). The app **contradicts** the knowledge base. |
| Fat | 40% of REE / 9 by default (range 20–40% of REE) (`CI:calculations.js:95-97,27`) | 25% (cut) / 30% of total kcal, floor 0.6 g/kg (`macroEngine.js:68-71`) | — |
| Carbs | Remainder, separate for rest and training days | Remainder | Module 12: carbs largely optional |
| Training volume | Henselmans formula `(f<3 ? f : 2.5)·5·herstel·EBF·√status + 3·vrouw` (`CI:calculations.js:121-128`). **Not ported** to `b:`. | Fixed defaults (`recoveryMap.js:3-7`) | 10–30 sets/muscle/week; beginners 10; 1 session per 6 sets (`b:src/knowledge/training-methodology.js:54,62,296`) |

**Conclusion.** The plan maker needs exactly one nutrition engine and one volume engine, both driven by the registry. Start from the ClientIntake functions, because they are pure and cite modules. Fix the drift in the backend port. Retire `macroEngine`'s independent defaults, or make them read the same rules.

---

## Part 4 — Program tab ingestion

**How a program is represented today** (`m:src/js/programBuilderV2Core.js`, schema version 2, `:5`):

```
{ schemaVersion:2, name, title, goal, archetype, coachId, clientId|null,
  split:{name, daysPerWeek}, schedule:{startDate, weekdays:[1..7]},
  days:[{dayId, name, notes, exercises:[{exerciseId, name, notes, rirNote, rpeNote, progressionNotes,
         archetypeTags[], techniques[], supersetGroup?, sets:[{setType, reps, repsMax?, weight, rpe, rir, restSec}]}]}],
  weeks?:[{week, label, phase:"free text", days?|sameAs?}], durationWeeks?, progressionNotes,
  recommendations?:{deloadPlan:{recommendedDeloadWeeks:[…]}} }
```

Sources: `:212-277` (days), `:283-299` (weeks), `:326-388` (draft), `:73-90` (deload summary).

**How it is rendered and resolved.**
- `today-program.js` takes the program's `startDate` and the active weekdays, works out the week number, and calls `getWeekDays(program, week)` (`m:src/js/today-program.js:74,103-163`).
- After the last week, programs **wrap around** (`m:src/js/programBuilderV2Core.js:307`).
- The `phase` label only appears in the header (`today-program.js:79-82,219`).

**Can it ingest external JSON?** Partly.
- Premium library programs are JSON with `weeks[]` (for example `b:content/premium/programs/aesthetics-ppl-arms-periodized.json`: 12 weeks, with phase labels like "10 working sets · 3-4 RIR"). The library copies them into `programs_${user}`, and `normalizeDraft` accepts them.
- A coach can **not** push a structured program to a client. Coach→client assignment is free text only (`b:server.js:3265-3268`), and the coach dashboard's `/api/coach/programs` route doesn't exist.

**What's supported vs missing**

| Capability | Status |
|---|---|
| Multi-week blocks | ✓ `weeks[]` (with `sameAs` compression) |
| Phases | Only a free-text label per week. No phase type, start/end, caps or end criteria. |
| Dated blocks | Only one program-level `startDate`. No per-phase dates, no re-flow when a phase ends early. |
| Per-phase nutrition targets | ✗. Macros live separately in `macroTargets_${user}`, one value at a time. |
| Deloads | Only a summary field (`recommendations.deloadPlan`). The engine doesn't schedule them; `autoProgression` produces reactive "deload" flags that aren't connected to the program. |
| Provenance / approval | ✗ |

**What must change to load a Cut Cycle (32 weeks) or Physique Plan (28 weeks)**
1. **Backend:**
   - Add a `plans` resource: coach-side draft and published copies, plus a client-side published mirror (Part 7). Add routes such as `POST /api/coach/clients/:uid/plans` (draft), `POST …/plans/:id/publish`, and `GET /api/client/plan`.
   - Add Firestore rules for the new collections.
   - Implement or remove the `/api/coach/programs` route that `coach.js` calls.
2. **Program schema v3**, staying backward compatible with v2:
   - Add an optional top-level `planRef {planId, phaseId}`.
   - Add a structured `phase` on each week (`{type:'cut'|'maintain'|'build', phaseId}`) next to the existing label.
   - Add `isDeload` on each week.
   - Keep `days[]` and `weeks[]` unchanged so the renderer still works.
3. **Week resolution.** Week number must come from the *phase* start date of the active phase, not the program's `startDate`. Past the end, stop instead of wrapping (`programBuilderV2Core.js:307`).
4. **Nutrition.**
   - The macro tab should read `plan.phases[active].nutrition` (rest-day and training-day targets) instead of `macroTargets_${user}`.
   - Keep `macroTargets_` as the client's "current" value, written only when a plan is published or a phase transitions.
5. **Phase engine.**
   - Evaluate end criteria (target hit or time cap) against synced bodyweight and check-in data.
   - That needs **check-ins and phase state moved to Firestore** first, because today they are localStorage-only.
   - A phase transition creates a *draft* re-plan for coach approval.
6. **Coach UI.** Show the plan timeline, review drafts, and record overrides.
7. **Client UI.** Show the read-only plan timeline, the current phase, and the next check-in. Show provenance in a coach-only view.

---

## Part 5 — Security and privacy review

### Answers to the specific questions
- **`/config` endpoints.**
  - `b:/config` is unauthenticated and returns only `{airtableBaseId}` (`b:server.js:833-835`).
  - `m:/config` is unauthenticated and returns only `{serverUrl}` (`m:server.js:225-227`).
  - **No credential is returned today.** However, the front end still contains code that would accept and use an `airtableToken` from config or from `window.airtableConfig` (`m:index.html:4257-4300`, `:4131`, `:13548`; about 12 direct `api.airtable.com` references), and the Airtable base ID is hard-coded at `m:index.html:4304`.
  - `window.airtableConfig` is no longer defined; it was removed from `config.js` in `a12fb1b`, 2026-02-25.
  - `m:README.md:45` still says `/config` "provides the Airtable credentials". That documentation is stale.
- **`.env.development` / `.env.production`.**
  - Both are **tracked** and visible in the public repo. Each holds only `REACT_APP_BACKEND_URL` (localhost, or the public Cloud Functions URL) plus a commented placeholder `ANTHROPIC_API_KEY=sk-ant-...` (a 10-character literal placeholder, not a key) on line 3. **No secrets.**
  - `b:.env` is also tracked (in the private repo). It holds `CORS_ORIGINS`, `MODERATION_EMAIL_TO` (an email address, which is personal data), `PROFILE_ADMINS`, `ADMIN_USERNAMES` and an empty `OBJECTIONABLE_TERMS`. No secrets, but it reveals the admin usernames.
- **Committed secrets in git history** (main branch, full history; other branches not scanned):

  | Repo | Commit | Path | Kind |
  |---|---|---|---|
  | m (public) | `77038b56` (2025-07-16) | `TrainingLog-webapp/config.js`, `TrainingLog-webapp/server.js` | Airtable personal access token |
  | m (public) | `031a2561` (2025-07-21) | `config.js` | Airtable PAT (same token) |
  | b (private) | `8aad049d`, `574d1add` (2025-06-06) | `server.js` | Airtable PAT (same token) |
  | b (private) | `89fb437d`, `8618be39` (2025-07-09) | `.env`, `.env.example` | Airtable PAT (same token) |
  | m | `897f2f73`, `6e1207fa` | `src/js/firebase-config.js`, `coach/coach.js` | Firebase web API key (public by design, *not* a secret) |

  - I matched all PAT occurrences by SHA-256 prefix; they are **one token**.
  - The public repo `Butterszzz-art/TrainingLog-webapp` (pushed 2025-07-20) probably contains the same token too. I did not scan it, so that is **unverified**.
  - `CI:client.js:19` has a Web3Forms access key. These keys are designed to be used client-side, so it's low risk, but it's worth knowing.

### Findings, ranked

| # | Sev | Finding (evidence) | Recommended fix |
|---|---|---|---|
| S1 | **Critical** | One Airtable PAT is in the public mobile repo's history and the backend's history (table above). It was removed from HEAD on 2026-02-25 (m `a12fb1b`) and 2026-09-26 (b `a0cdf09`), but removing it from HEAD doesn't revoke it. The Airtable base held the `Users` table (bcrypt password hashes, `m:server.js:97-107`) and legacy logs. **Whether it has been revoked is unverified.** | Revoke the token in Airtable today and issue a scoped replacement only if Airtable is still needed. Review Airtable's access logs. Enable GitHub secret scanning and push protection on all repos. Rewriting history is optional once the token is revoked. If Airtable no longer holds anything you need, export it and then delete the base. |
| S2 | **Critical** (if any instance is deployed; **High** as a dormant liability) | Legacy `m:server.js`:<br>- `app.all('/airtable/:baseId/:table')` has **no auth** and allows full CRUD on any table, including `Users` (`m:server.js:557-579`).<br>- `GET /dailylogs?username=` has no auth and builds `filterByFormula: Username='${username}'` without escaping, so formula injection can return other users' logs (`m:server.js:267-293`, `:277`).<br>- `/templates` GET/POST/DELETE (`:298-397`), `/workoutlogs/archive` (`:400`), `/dailylogs` POST (`:248`) and all `/community/*`, `/api/groups`, `/createProgram`, `/shareProgram` routes are unauthenticated (`:450-538`).<br>- The JWT secret falls back to a known default (`:38-41`).<br>- `/admin/ingest-pdf` needs any valid login but no admin role, and accepts uploads up to 50 MB held in memory (`:642`, `m:knowledgeBase.js:8`).<br>- CORS reflects any origin when `CORS_ORIGINS` is unset (`:27-30`). | Confirm that no Render (or other) instance runs `m:server.js`. Then **delete** `m:server.js`, `m:knowledgeBase.js` and `m:src/routes/` and `m:src/coach/` if the backend has superseded them. Fix `README.md:45`. |
| S3 | **High** | The public intake collects GDPR Art. 9 data (PEDs, injuries, body fat, sleep, diet, measurements) from prospects with **no consent checkbox or privacy notice** (`m:intake/index.html` has no consent field; `m:intake/intake.js:103-128`).<br>- It auto-downloads a JSON file of health data to the device (`intake.js:108`) and offers a `mailto:` link that sends it by email (`intake.js:88,113`).<br>- `privacy.html` covers account holders only. It doesn't mention prospects, intake leads, PED data, a retention period for leads, or OpenRouter (`m:src/coach/client.js:19-39`, if that legacy path is used).<br>- `CI:` accepts unauthenticated creates (`allow create: if true`, `CI:README.md:64`; the rules file isn't in the repo, so its contents are **unverified**), uploads photos to Storage, and sends a summary to Web3Forms (`CI:README.md:67`), a third party listed in no notice. | Add an explicit, unticked Art. 9 consent checkbox (plus the PED disclaimer CI already has as `peds.disclaimerGeaccepteerd`) and a link to a prospect privacy notice. Store `consents{healthData, version, at}` on the lead and reject submissions without it server-side. Set a retention period for unconverted leads (e.g. 90 days, enforced by a scheduled function). Drop the email/Web3Forms copy of health data. Make the JSON download opt-in. |
| S4 | **High** | **IDOR:** `PUT /api/bodybuilding/daily-mission/:userId` writes `users/{uid}/dailyMissions` for *any* `userId`. Nothing compares it to `req.user` (`b:server.js:3833-3898`). This is an integrity problem only; it doesn't expose data. | Use `ownUsername()`, or reject with 403 when `userId` doesn't match `req.user.username`. |
| S5 | **High** | **Incomplete erasure.**<br>- `deleteFirestoreAccount` recursively deletes `users/{uid}` and `coaches/{uid}` but never removes the client from **other coaches' rosters** (`coaches/{coachUid}/clients/{clientUid}`, including `email`, `latestCheckInJson`, and the `notes` subcollection) (`b:server.js:657-669`). This contradicts `delete-account.html:42`.<br>- Leads in `coaches/{coach}/leads` are never deleted. | Before the recursive delete, read `users/{uid}/coachAssignment/*` and delete each matching roster doc and its subcollections. Match and delete leads by email. Add a test script. |
| S6 | Medium | **Device data survives logout and deletion.** `logout()` removes only auth keys (`m:index.html:10650-10666`). Per-user health data (`tl_checkins_v1_*`, `tl_phase_state_v1_*`, `bodyweightLog_*`, `personalDetails`, posing photos in IndexedDB `m:posingMediaStore.js:31`) stays on the device. Account deletion just calls `logout()` (`m:src/js/settings.js:707-711`), whose code comment wrongly says it "clears local storage". This contradicts `delete-account.html:52`. | On deletion, clear every key ending in `_${user}` plus the known prefixes, and delete the IndexedDB databases. Consider doing the same on logout on shared devices, or offer it as an option. |
| S7 | Medium | **Legacy JWT path is still accepted** (`b:server.js:210-220`) although nothing issues those tokens anymore. Anyone holding `JWT_SECRET` can impersonate any username. | Remove the legacy branch now that the Firebase cutover is done. |
| S8 | Medium | **Dormant front-end Airtable token plumbing** (`m:index.html:4131,4257-4300,13548`) plus a hard-coded base ID (`:4304`). If any config source ever returned a token again, it would be sent to the browser. | Delete the Airtable client code from `index.html`. |
| S9 | Medium | Health data reaches third parties beyond those listed: OpenRouter, if the legacy `m:src/coach/client.js` path is used; Web3Forms (CI). | Update `privacy.html` §4, or remove those integrations. |
| S10 | Low | `b:` CORS allows everything if `CORS_ORIGINS` is set but empty (`b:server.js:251-256`), and always allows requests with no `Origin` header (`:264`). Auth uses bearer tokens rather than cookies, so the impact is limited. | Treat an empty value as "use the defaults". |
| S11 | Low | Error responses include `String(err)` (e.g. `b:server.js:3409`, `3469`, `3497`). Unauthenticated `/health` endpoints reveal configuration state (`b:server.js:404-425`, `m:server.js:230-245`). | Return generic messages and log the details server-side. |
| S12 | Low | The GitHub Pages workflow publishes the whole repo root (`deploy.yml`: `path: .`), including `.env.*`, `tests/`, `server.js` and `.clone/`. The comment in the workflow claims node_modules/android/ios are excluded; whether the action really does that is **unverified**. The contents are not secret. | Publish an explicit allow-list or a `www/` directory, like Codemagic's rsync. |
| S13 | Low | Firebase web API keys are in the source. That's normal, but whether API-key restrictions (HTTP referrer / app restrictions) are set in Google Cloud is **unverified**. | Add those restrictions. |

**Can one client read another client's data?** In the production backend, **no path I read allows it.** History routes go through `ownUsername()`, coach routes check roster links, and Firestore denies all client SDK access. The exceptions are S4 (cross-user *write*) and, on the legacy `m:server.js` if it runs, S2 (cross-user *read* via `/dailylogs` and the Airtable proxy).

**Do `privacy.html`, `terms.html` and `delete-account.html` match the code?** Mostly they match for account holders: health-data consent at signup (`b:server.js:1036-1046`), AI consent, deletion and export. The mismatches are S3 (prospects and PED data), S5 (coach-side copies), S6 (data left on the device) and S9 (unlisted processors). I did not review `terms.html` line by line; I only checked that it exists, so that review is **unverified**.

---

## Part 6 — Repo hygiene

- **Tests:** `npm test` in `m:` gives **55 suites passed, 381 tests passed, 0 failed, ~7.5 s.**
  - `b:` has no automated tests: no `test` script, only manual `scripts/test-*.js`.
  - `CI:` has no tests.
- **Branches:** 341 remote branches in `m:`. 251 start with `codex/`, 41 `feat/`, 27 `claude/`, 12 `fix/`. `b:` has 77.
  - Recommendation: delete merged branches, protect `main`, and turn on auto-delete after merge.
- **Committed junk:**
  - `.clone/worktrees/loving-lalande-7c033d/…` is tracked. `.gitignore` covers `.claude/worktrees/` but not `.clone/`.
  - `.claude/launch.json` is tracked.
- **Monoliths:** `m:index.html` (~20,900 lines, mixing inline JS, CSS and HTML) and `b:server.js` (4,440 lines). Inline functions in `index.html` shadow module files, for example `calculateWorkoutVolume` (`:13672`). That makes it risky to refactor any module without browser-level tests.
- **Dead and duplicate code:** see Part 2 (TS/TSX files, `periodization.js`, `calculateWorkoutVolume.js`, legacy `server.js`, `.clone`, and two intake calculation engines).
- **Globals everywhere:** modules talk through `window.*` and depend on script load order (e.g. `recoveryMap.js:40-41`). Mixing ES modules and classic scripts (`m:index.html:3981-4020`) makes dependency injection awkward.
- **CI/CD:**
  - `m:.github/workflows/deploy.yml` deploys to Pages with **no test step**, so a red test suite still deploys.
  - `m:codemagic.yaml` builds iOS (simulator and App Store) and Android, using Codemagic integrations for signing. I saw no inline secrets. It also has no test step.
  - `b:` has no CI. Deploys are manual (`firebase deploy`).
- **Other things that make safe refactoring hard:**
  - No lint or format config.
  - No shared schema (JSON Schema/zod) between the app and the backend.
  - The "future backend endpoint" sync calls to relative URLs fail silently (`checkinEngine.js:618`, `prepMode.js:261`, `complianceEngine.js:116`), which hides data loss.

---

## Part 7 — Proposed design (proposal only)

### 7.1 Plan JSON schema (v1)

```jsonc
{
  "schema": "pocketcoach.plan/1",
  "planId": "pln_01J…",
  "status": "draft",                       // draft | approved | published | superseded | cancelled
  "client": { "uid": "…", "coachUid": "…", "leadId": "…|null" },
  "package": { "id": "cut_cycle_32", "version": 1, "tier": "medium",   // basis | medium | premium
               "billing": { "blockWeeks": 4, "blocks": 8, "startDate": "2026-10-12" } },
  "ruleVersion": "butters-rules@1.3.0",    // immutable registry snapshot used for every number below
  "inputsSnapshot": { "intakeRef": "coaches/…/leads/…", "bodyweightKg": 84.2, "bodyFatPct": 18,
                      "activityLevel": "actief", "sex": "man", "trainingYears": 3, "equipment": ["squat_rack"] },
  "phases": [
    {
      "phaseId": "ph1", "type": "cut", "order": 1,
      "plannedStart": "2026-10-12", "plannedEnd": "2027-01-04",
      "actualStart": null, "actualEnd": null,
      "caps": { "maxWeeks": 12, "minWeeks": 4 },
      "endCriteria": { "any": [
        { "kind": "target",  "metric": "bodyweightKg7dAvg", "op": "<=", "value": 78.0, "ruleId": "nutr.cut.target_bw" },
        { "kind": "timeCap", "weeks": 12, "ruleId": "pkg.cut_cycle_32.cut_cap" }
      ]},
      "nutrition": {
        "restDay":     { "kcal": 2150, "proteinG": 152, "fatG": 70, "carbG": 223 },
        "trainingDay": { "kcal": 2480, "proteinG": 152, "fatG": 70, "carbG": 305 },
        "targetRatePctBwPerWeek": { "min": 0.5, "max": 1.0 },
        "provenance": {
          "kcal":     { "ruleId": "nutr.energy.deficit_factor", "value": 0.8 },
          "proteinG": { "ruleId": "nutr.protein.g_per_kg",       "value": 1.8 },
          "fatG":     { "ruleId": "nutr.fat.pct_ree",            "value": 0.4 },
          "bmr":      { "ruleId": "nutr.bmr.katch_mcardle" }
        }
      },
      "training": {
        "split": { "name": "Upper / Lower", "daysPerWeek": 4, "ruleId": "train.split.by_frequency" },
        "weeklySetsPerMuscle": { "chest": 12, "back": 14, "quads": 12, "…": 0,
                                 "provenance": { "ruleId": "train.volume.henselmans", "inputs": { "status": 2, "herstel": 0.9, "ebf": 0.8, "freq": 2 } } },
        "progression": { "scheme": "double_progression", "repRange": [6, 10], "loadIncrementKg": 1.25,
                         "rirTarget": [3, 0], "ruleId": "train.progression.double" },
        "deloads": { "mode": "scheduled", "weeks": [6, 12], "volumeFactor": 0.5, "ruleId": "train.deload.schedule" },
        "programRef": { "programId": "prg_…", "schemaVersion": 3 },   // a Program-tab v3 program generated for this phase
        "injuryConflicts": [ { "exercise": "squat", "reason": "knie", "ruleId": "safety.injury.knee" } ]
      },
      "recovery": { "sleepHoursMin": 7, "stepsTarget": 8000, "cardio": "2× LISS 30 min",
                    "notes": [], "ruleIds": ["recov.sleep.min", "recov.steps.cut"] }
    }
    // ph2 maintain 4 wk, ph3 cut 12 wk, ph4 maintain 4 wk …
  ],
  "redFlags": [ { "level": "rood", "code": "deficit_gt_25pct", "ruleId": "safety.deficit.max" } ],
  "overrides": [
    { "at": "2026-10-10T09:12:00Z", "by": "coachUid", "path": "phases[0].nutrition.restDay.kcal",
      "from": 2050, "to": 2150, "reason": "client adherence history", "ruleIdOverridden": "nutr.energy.deficit_factor" }
  ],
  "adjustments": [
    { "id": "adj_…", "at": "…", "type": "phase_transition",   // phase_transition | adhoc_client | coach_initiated | correction
      "countsTowardQuota": false, "billingMonth": "2027-01", "fromPlanVersion": 3, "toPlanVersion": 4 }
  ],
  "approval": { "generatedAt": "…", "generatedBy": "generator@0.1.0", "approvedAt": null, "approvedBy": null, "publishedAt": null },
  "version": 3, "supersedes": "pln_…|null"
}
```

**Package definitions** are data, stored in the registry under the `pkg` domain:
- `cut_cycle_32`: `[cut 12, maintain 4, cut 12, maintain 4]`, 8 billing blocks.
- `physique_28`: `[build 16, maintain 4, cut 8]`, 7 billing blocks.

**Phase transitions.** A phase ends when **any** end criterion is met, either the target or the time cap. When that happens, the later phases' planned dates shift. Billing stays on fixed 4-week blocks from `billing.startDate`. When a phase ends early, the package still runs for its billed blocks; whether the plan extends a maintain phase or ends early is a business decision for you (see the open questions below).

**Adjustment quota.**
- Quota = count of adjustments where `type == 'adhoc_client' && countsTowardQuota` in the current billing month.
- Caps: Basis 0, Medium 2, Premium unlimited (`pkg.tier.*` rules).
- `phase_transition` is always `countsTowardQuota:false`, and that is enforced **on the server**, not taken from client input.
- `coach_initiated` and `correction` don't count either.

### 7.2 Rule registry format

```jsonc
{
  "id": "nutr.protein.g_per_kg",
  "version": 2,                               // bumped when params or statement change
  "domain": "nutrition",                      // nutrition | training | recovery | safety | package | coaching
  "statement": "Daily protein intake 1.6–2.4 g/kg BW; 1.8 g/kg practical default; do not raise during a deficit.",
  "params": { "unit": "g/kg/day", "min": 1.6, "default": 1.8, "max": 2.4,
              "conditions": [ { "when": { "diet": "vegan" }, "default": 2.3 },
                              { "when": { "phase": "cut" }, "default": 1.8, "note": "no increase in deficit" } ] },
  "formula": null,                            // or an id into a vetted formula library, e.g. "katch_mcardle"
  "evidenceGrade": "A",                       // A meta-analysis/RCT · B limited RCT · C observational/mechanistic · D expert/heuristic
  "sources": [ { "doi": "10.1136/bjsports-2017-097608", "label": "Morton et al. 2018" },
               { "label": "Butters University Module 11" } ],
  "moduleRef": "BU-M11",
  "consumers": ["b:src/intakeCalculations.js#eiwitGrammen", "m:src/utils/macroEngine.js#computeMacroPlan"],
  "lastReviewed": "2026-10-01", "reviewedBy": "arman",
  "verified": true,                           // only verified rules may be used by the generator
  "supersedes": "nutr.protein.g_per_kg@1"
}
```

The DOI above is given only as an example of the format; I didn't check it. Each source must be checked when the entry is written.

**Where it should live: a separate versioned repo/package** (e.g. `butters-rules`). Recommended layout:
- `rules/*.json`, one file per domain
- a JSON Schema
- a ~100-line resolver (`resolve(id, context) → {value, ruleId, version}`)
- CI that validates the schema and the `verified`/`sources` requirements

Why separate:
1. **Three consumers.** The backend generator, ClientIntake (until it's absorbed) and the app's display all need it.
2. **Immutable snapshots.** Every plan pins `ruleVersion`, so a rule can be changed without silently changing historical plans. A tagged package version is the simplest immutable artifact.
3. **Different review cadence and owner.** Evidence review is content work, not app releases.
4. **The mobile app has no build step.** It shouldn't compute targets at all. It only displays plan values and their `ruleId`s. The backend can serve `GET /api/rules/:version/:id` for coach-side "why this number" views.

The backend consumes the package as an npm git dependency pinned to a tag. If you'd rather avoid a new repo at first, a `rules/` folder in `b:` with the same layout and tags is acceptable as a stepping stone.

### 7.3 How existing engines consume the registry (minimal rewrite)

- **Pattern.** Each engine keeps its function signatures, and every constant gets an injectable default: `fn(inputs, rules = defaultRules)`. `defaultRules` is generated from the registry snapshot, so today's behaviour keeps working until values are deliberately changed. The functions are already pure (`intakeCalculations`, `macroEngine`, `recoveryMap`, `progressiveOverload`), so this is mostly mechanical.
- **Provenance.** Engine outputs return `{value, ruleId}` pairs only at the plan generator boundary. Internal maths stays numeric.

**What moves first**

| Priority | Rules | Today |
|---|---|---|
| P1 nutrition | BMR method (Katch vs Mifflin, and when each applies); PAL table **including `erg actief`**; TEF policy (fix the double count if confirmed); energy factors/ranges per goal and phase; protein g/kg with conditions; fat (choose one: %REE vs %kcal + g/kg floor); carb remainder; meal split and post-training boost; red-flag thresholds (deficit >25%, below BMR) | `b:src/intakeCalculations.js:6-40,224-276`; `m:src/utils/macroEngine.js:15-71` |
| P1 training volume | Henselmans volume formula (port it to `b:`); weekly sets-per-muscle defaults and bounds; max sets per session (~10); frequency rule "1 session per 6 sets"; split by frequency; injury→exercise sensitivity map | `CI:calculations.js:121-128`; `m:recoveryMap.js:3-18`; `b:src/knowledge/training-methodology.js:54-62`; `b:src/intakeCalculations.js:42-52,187-222` |
| P2 | Progression increments and rounding; deload trigger and schedule; rate-of-loss as %BW/week | `m:progressiveOverload.js:70,148-196`; `m:autoProgression.js:8-13`; `m:checkinEngine.js:483-496` |
| P3 | Compliance weights; mission maps; recovery half-lives; insight thresholds | `m:complianceEngine.js:12-50`; `m:dailyMissionEngine.js:15-20`; `m:recoveryMap.js:27-31` |

**Fix the drift before any rules move:**
- Add `erg actief` and `veel_stress` to the backend port.
- Port `trainingsvolumeAdvies` and the 1RM functions.
- Write a parity test that runs CI's and the backend's `berekenClient` on the same fixtures.

### 7.4 Coach-review step

1. The generator runs **server-side** (a Cloud Function route `POST /api/coach/clients/:uid/plans:generate` or `/api/coach/leads/:id/plans:generate`). It writes `status:"draft"` to `coaches/{coachUid}/clients/{clientUid}/plans/{planId}`, which only the coach can read (Firestore rules plus the route's roster check).
2. The coach reviews the draft in `coach/`. Every edited field appends an `overrides[]` entry. The generator never overwrites a field the coach has overridden when it regenerates.
3. Hard red flags (for example intake below BMR) block **Approve** until the coach acknowledges them.
4. **Publish** is a separate explicit action. It:
   - copies the approved plan to `users/{clientUid}/plans/{planId}` with `status:"published"`
   - writes the Program-tab v3 program and the current phase's macro targets
   - sends a notification (the existing `coachNotifications` path)
5. The client app reads **only** published plans. Nothing in `draft` or `approved` is ever mirrored to the client.
6. Phase transitions and ad-hoc requests create a new **draft** version (`supersedes` points at the previous one) and go through the same review.

### 7.5 Migration path: ClientIntake → PocketCoach

1. **Freeze the schema.** Make CI's schema (19 equipment keys, 4-level stress, `erg actief`, extra text fields, `disclaimerGeaccepteerd`) canonical in `m:intake/` and the backend validator. Version it as `intake/2`.
2. **Backend.** Add a JSON-Schema validation step to `POST /api/intake` and store `schemaVersion` and `consents`. Leave `adres/postcode/stad/land` out unless they're needed.
3. **One-off export/import.**
   - Write an Admin SDK script that reads CI project `clientintake-cfa71/clients/*`, maps each record to `intake/2`, and writes it to `coaches/{coachUid}/leads/{id}` with `source:"clientintake"`, `importedAt`, and the original `createdAt`.
   - Re-run `berekenClient` and keep CI's original `calculations` as `calculationsLegacy` for comparison.
   - Copy Storage files (hand photo, current program) into the PocketCoach bucket, or drop them.
   - **Only migrate people who gave consent**, or record the legal basis for each record.
4. **Lead → client.** Converting a lead starts the existing invite flow (`b:server.js:3039`). When the client accepts, set `leadId` on the roster doc and copy the relevant intake fields to a new `users/{uid}/profile/intake` doc. That gives the plan generator a uid-scoped input.
5. **Sync app-side state** (a prerequisite for the phase engine): add `personalDetails`, `tl_checkins_v1_`, `tl_phase_state_v1_` and `tl_compliance_summary_v1_` to `cloud-sync` STORES (`m:src/js/cloud-sync.js:53-74`), or give them proper backend routes. Remove the dead relative-URL sync calls.
6. **Retire CI.** Point CI's `intake.html` at `b:/api/intake` (or redirect it to `m:intake/`), switch its Firestore to deny-all, then decommission the project after a retention check.
7. **Data-model changes, in summary:**
   - new `users/{uid}/profile/intake`
   - `coaches/{c}/clients/{u}/plans/*` and `users/{u}/plans/*`
   - `users/{u}/checkins/*` and `users/{u}/phaseState`
   - `adjustments` (or fold them into the plan)
   - `consents` on leads
   - Program schema v3 fields (Part 4)
   - a `tier` on the roster doc for the quota

### 7.6 Ordered task list

Security fixes come first. "Dep" means the task depends on the listed task numbers.

| # | Task | Effort | Risk | Dep |
|---|---|---|---|---|
| 1 | Revoke and rotate the Airtable PAT. Review Airtable logs. Enable secret scanning and push protection on all repos, and check `TrainingLog-webapp` for the same token. | S | Low | — |
| 2 | Confirm no deployment of `m:server.js`, then delete it along with `knowledgeBase.js`, legacy `src/routes`, legacy `src/coach` and the front-end Airtable code (`index.html:4131-4304,13548`). Fix the README. | M | Med (check nothing imports them) | 1 |
| 3 | Fix the daily-mission IDOR (`b:server.js:3833`) and add a manual test script. | S | Low | — |
| 4 | Intake consent: Art. 9 checkbox, PED disclaimer, prospect privacy notice, server-side enforcement, lead retention job. Make the JSON download opt-in and drop the email copy. | M | Low | — |
| 5 | Erasure: remove the client from other coaches' rosters (and notes) and delete matching leads. Clear device storage and IndexedDB on deletion. | M | Med | — |
| 6 | Remove the legacy JWT path. Harden CORS for empty values. Return generic error bodies. | S | Med (any client still holding a legacy token gets logged out) | — |
| 7 | Update `privacy.html` and `delete-account.html` to match (processors, prospects, PEDs, device data). | S | Low | 4, 5 |
| 8 | Hygiene: remove `.clone/`, the TS/TSX dead code, `periodization.js` and the duplicate `calculateWorkoutVolume.js`. Prune merged branches. Add `npm test` to the Pages deploy and Codemagic. Add a minimal backend test harness (Jest + Firestore emulator). | M | Low | 2 |
| 9 | Fix intake calculation drift (`erg actief`, `veel_stress`, port the Henselmans volume and 1RM functions). Add a CI↔backend parity test. | S | Low | 8 |
| 10 | Create the `butters-rules` repo: schema, resolver, CI validation. Seed P1 nutrition and volume rules from the current constants and the knowledge text, all `verified:false` until you review them. | M | Low | 9 |
| 11 | Make `intakeCalculations` and the volume calculator rule-injectable (defaults = registry snapshot). Resolve the Katch/Mifflin, protein-on-cut, fat and TEF conflicts **with your decision**. | M | Med (target values change) | 10 |
| 12 | Sync check-ins, phase state, personal details and compliance to Firestore. Remove the dead sync calls. | M | Med (data migration from localStorage) | 8 |
| 13 | Plan data model, Firestore rules and coach routes (draft / approve / publish / get). Add the `tier` on the roster. Add the adjustment ledger and quota enforcement. | L | Med | 6, 11 |
| 14 | Generator v0: intake + package → draft plan with nutrition, volume, split, deload schedule, injury conflicts and red flags, all with `ruleId`s. | L | Med | 11, 13 |
| 15 | Program schema v3 plus `today-program` phase-aware week resolution (no wrap-around). Macro tab reads targets from the published plan. | M | Med (renderer is in `index.html`) | 13 |
| 16 | Coach UI: plan timeline, draft review, overrides, publish. Fix or remove the `/api/coach/programs` call. | L | Med | 13, 14 |
| 17 | Phase engine: evaluate end criteria → create a phase-transition draft (never counted toward the quota) → notify the coach. | M | Med | 12, 13, 14 |
| 18 | ClientIntake migration script plus decommissioning (consented records only). | M | Med (personal data handling) | 4, 9, 13 |
| 19 | Move P2/P3 constants into the registry (progression, deload, rate-of-loss as %BW, compliance). | M | Low | 10 |

**Open questions for you.** Each of these blocks the corresponding task.
- Which BMR method should apply in which cases (affects 11)?
- Should TEF be applied on top of PAL (affects 11)?
- Fat: % of REE or % of kcal plus a g/kg floor (affects 11)?
- What is the cut target metric: bodyweight, body-fat %, or waist (affects 14 and 17)?
- What happens to billing and remaining blocks when a phase ends early on target (affects 13)?
- Can a client on the Basis tier request any adjustment at all, or are adjustments coach-only (affects 13)?

*End of report. Stopping here for your approval; no implementation has been started.*
