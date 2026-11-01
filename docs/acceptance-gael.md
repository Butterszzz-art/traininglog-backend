# Acceptance: Gael's plan, from the coach dashboard to his phone

Private repo on purpose: this names a real client. The public app repo only
has an anonymised copy of the plan (`tests/fixtures/plan-v2-published.json`).

## The plan

| | Weeks | Training day (kcal / P / C / F) | Rest day | Program |
|---|---|---|---|---|
| Phase 1 · Cut | 1–12 | 2350 / 165 / 275 / 65 | 2000 / 165 / 190 / 65 | X-frame from program week 1 |
| Phase 2 · Maintain | 13–15 | 2700 / 165 / 364 / 65 | same | X-frame from program week 13 |
| Phase 3 · Deload | 16 | same as phase 2 | same | X-frame from program week 16 |

Package Cut Cycle, start on a Monday you pick (**S** below). X-frame weeks 1–4
come from `tests/fixtures/gael-xframe-weeks-1-4.xlsx` (Mon Lower A, Tue Upper A,
Thu Lower B, Fri Upper B). Weeks 5–12 are added later; until then week 4 repeats.
Phase 2 carbs (364 g) are the dashboard's suggestion for 2700 kcal with P165 / F65.
Change them if you want a different split.

## What's automated

| Check | Where |
|---|---|
| The sheet imports exactly: 4 weeks, 104 rows, RIR per week incl. last set, rest ranges, notes | `tests/tableImport.test.js` |
| Generate from intake → reshape to 12/3/1 → nutrition → link X-frame (0/12/15) → approve → publish → client copy with program snapshot → program grows → revise → publish v2 → v1 superseded | `tests/planV2.test.js` |
| Intake energy fix with his numbers (+4.5 %, not +15 %) | `tests/intakeEnergy.test.js` |
| The editor sends exactly the ops for this reshape | app `tests/planEditor.test.js` |
| The phone on S, S+2, S+15, S+84 and S+105: session, RIR, targets, phase | app `tests/planToday.test.js` |
| The Macros tab across the phase boundary and local midnight | app `tests/coachPlanMacros.test.js` |

Not automated: the dashboard and app screens against a deployed backend. That's
the checklist below.

## Deploy order

1. ClientIntake#20, then backend #113 (energy fix).
2. Backend #114 → #115 → #116 (programs, table import, plan/2). Deploy the `api` function.
3. App #503 → #504 → #505 → #506 (builder, import, plan editor, client). GitHub
   Pages deploys on merge to main; the iOS build picks it up in the next TestFlight.
4. CI first if you like: backend #112 and app #502.

## Checklist: coach dashboard (laptop)

1. Gael's client page → Program tab → **Import file** → `gael-xframe-weeks-1-4.xlsx`.
   - [ ] Banner says *Read directly from the sheet*, with no warnings.
   - [ ] W3 → Upper A → Cable lateral raise shows RIR 2, last set 1, rest 1–2 min.
   - [ ] Ab-wheel rows are *Core* with no RIR.
   - [ ] **Save to library** → the list shows `X-frame (4 wk · 4 days)`.
2. Master Plan: intake = Gael, package = Cut Cycle, start = **S** → **Save as draft**.
3. Edit plan:
   - [ ] Remove the last maintain phase.
   - [ ] Phase 2 → 3 weeks.
   - [ ] Phase 3 → type Deload, 1 week.
   - [ ] Phase dates read weeks 1–12, 13–15 and 16.
   - [ ] Enter the nutrition from the table. "From grams" shows 2345 kcal for 2350 (fine, under 3 %). Use **Suggest carbs** and **Copy training day** for phases 2–3.
   - [ ] Link X-frame: phase 1 from program week 1, phase 2 from 13, phase 3 from 16.
   - [ ] Each phase warns that X-frame has 4 weeks and week 4 repeats.
   - [ ] **Save changes** without a reason is refused. With a reason it saves, and the preview shows 16 weeks.
4. **Approve** → **Publish to client**.
   - [ ] Status shows `v1 · published`.

## Checklist: Gael's phone (after he refreshes Settings → Your Coach)

- [ ] Your Coach shows **Program · X-frame · Week n of 16 · Cut** with **Start**. Tap it.
- [ ] On **S** (Mon): Home shows Lower A, *Hack squat 2 × 6–10 RIR 3*. Macros show 2350 / 165 / 275 / 65.
- [ ] On **S+2** (Wed): Home shows a rest day. Macros show 2000 / 165 / 190 / 65.
- [ ] On **S+15** (Tue, week 3): Upper A, *Cable lateral raise 4 × 10–20 RIR 2/1*.
- [ ] My Plan → Today matches the Home card and Macros.
- [ ] On **S+84** (Mon, week 13): My Plan says Maintain. Macros show 2700 on both a training and a rest day.
- [ ] On **S+105** (Mon, week 16): Deload, same nutrition.

To check future dates without waiting, set the phone's date, or in the web app
run `PlanToday.resolve(JSON.parse(localStorage.getItem('coachPlan_<user>')), 'YYYY-MM-DD')`
in the console.

## Weeks 5–12 later

1. Edit X-frame in the library (**Edit selected**): on W4, **Copy W4 → W5**, change it, and repeat up to W12. Importing a sheet makes a new program; it doesn't add weeks to this one. If you import weeks 1–12 as a new program, re-link the phases to it in the new version.
2. Master Plan → **Make new version** → approve → publish.
   - [ ] The dashboard shows v2 published and v1 superseded.
   - [ ] Gael's app switches to v2 by itself (toast: *new version of your plan*). Week 5 now shows the new sessions.
