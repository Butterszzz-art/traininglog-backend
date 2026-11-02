// =============================================================
// PT TRAINING METHODOLOGY — Baked-in Knowledge Base
// Source of truth: Butters University (BU) — GitHub repo
// Butterszzz-art/butters-university, README.md. BU uses the Henselmans PTC
// course as its starting point and updates it with current meta-analyses.
// Where BU and the PTC disagree, BU wins.
//
// Part 1 is BU only (programming, periodization, exercise science, volume).
// Part 2 holds PTC (Menno Henselmans) material on topics BU does not cover;
// it must never contradict Part 1.
// When BU changes, update Part 1 here and the matching rules in rules/*.json.
// =============================================================

const TRAINING_KNOWLEDGE = `
## CORE TRAINING METHODOLOGY — Butters University

Your training advice follows Butters University (BU), the coach's evidence hub. BU starts from the Henselmans PTC course and updates it with current meta-analyses. If anything in Part 2 seems to conflict with Part 1, follow Part 1. Never contradict either with bro-science.

# PART 1 — BUTTERS UNIVERSITY (always wins)

### THE NUMBERS THE APP USES (same as the client's master plan)
- Weekly volume = DIRECT sets per muscle per week. Indirect sets count about half (bench press = 1 chest set + ~0.5 triceps set; 50/75/100% is a rule of thumb, not a measured figure).
- Bands: beginner 8–12 (coach default; BU only says moderate volume beat high volume in untrained lifters), intermediate 10–15, advanced 10–20. Clients aged 60+: at most ~12 — lower volume did better for lean mass and function in older adults (open question, but the default).
- Go past ~20 direct sets only when recovery markers AND continued strength progress support it. Add volume slowly (≤1 set per exercise per week).
- Frequency: at least one session per week for every ~6 weekly sets of a muscle. Twice a week per muscle is the default. Frequency mainly spreads volume into recoverable sessions; its own effect on growth is small.
- Effort: leave 1–3 reps in reserve (RIR) on most sets; all-out failure only on the last set of an exercise, and mainly on isolation work.
- Progression: double progression in the rep range, then the smallest load increase.
- Deloads: triggered by evidence of fatigue, never by the calendar.

### MECHANICAL TENSION & BIOMECHANICS
- Mechanical tension is the main driver of growth. Muscle damage and "the burn" are side effects, not drivers. Don't chase soreness; DOMS is neutral information.
- Hormones and metabolic stress are not primary drivers. Light-load or BFR training is a bridge when heavy loading isn't possible (injury, travel), not the main growth strategy.
- Think in moment arms: choose body position and resistance type (cable vs dumbbell) by where the rep stays hard, not by exercise name. Dumbbell curls and raises lose tension at the top; cables keep it.
- Muscle mass is the one fully transferable part of strength and performance. "Functional" or structural-balance corrective work does not beat full-ROM resistance training (plyometrics are the exception for jumping/sprinting goals).

### INTENSITY, VOLUME & FREQUENCY
- Hypertrophy is about the same across ~30–90% 1RM when sets are taken close to failure — pick load for joint comfort and fatigue cost, not a "hypertrophy zone". Use heavy loads (≥80% 1RM) where 1RM strength itself matters.
- Volume as in "The numbers" above. The volume–growth curve is positive but flattening (square-root shaped) with no clear plateau, with more uncertainty at high volumes and in already-trained lifters.
- Use progress and recovery as the feedback loop: if strength climbs and sleep, joints and session quality are fine, keep or nudge volume up; if progress stalls and fatigue is high, cut volume before adding frequency or intensity.
- Worked example (intermediate, chest, 2x/week): bench 4×6, incline DB 3×10, cable fly 3×15 = 10 direct sets, plus overhead press 3×8 at half = ~11.5. No session over ~7 direct-equivalent sets.

### EXERCISE SELECTION
1. Pick exercises by what limits them: if grip, balance or a smaller muscle gives out before the target muscle, fix the limiter (straps, stance, order) or switch exercise.
2. At least one exercise per muscle that loads it in the lengthened (stretched) position. Full ROM is the standard; lengthened partials are fine but not better than full ROM for trained lifters. Shortened partials are worst.
3. Combine a multi-joint and a single-joint exercise per major muscle — whole-muscle growth is similar, but they hit different regions.

### FUNCTIONAL ANATOMY
- For muscles with several heads or regions (chest, delts, lats, traps, quads, hamstrings, calves), use at least 2 exercises at different angles.
- Bi-articular muscles need an exercise at the joint where they are otherwise insufficient: leg extension for rectus femoris (squats barely train it), a hip-extension hamstring exercise plus leg curls, overhead triceps extension for the long head, straight-knee calf raise for gastrocnemius (seated for soleus).
- Glutes: hip thrusts / bent-knee hip extension isolate them, but higher EMG alone is not proof an exercise grows more. Prefer outcome data (muscle thickness over weeks) over acute EMG.
- Where no direct research exists (adductors, erectors, obliques, forearms), use the same attachment/moment-arm logic, held more loosely.

### EXERCISE EXECUTION
- Failure has a real dose-response for growth, but costs disproportionate fatigue and later-set volume. Keep compounds at RPE 7–9 (1–3 RIR); genuine failure only on isolation/accessory work, last set.
- Focus: internal ("feel the muscle") on isolation work; external ("push the floor away") on main strength lifts, where it raises force output.
- Tempo: control the eccentric, don't slow reps beyond that — deliberately slow reps cost volume with no extra growth.

### STRUCTURING A SESSION / BLOCK
- Rest roughly 2–3 minutes between sets of main compound lifts. Short rest does not grow more muscle ("metabolic stress needs short rest" is a myth).
- Order: priority first, compounds before isolation, heaviest work first.
- Antagonist supersets (chest/back, quads/hamstrings) save time with no growth penalty — use them whenever equipment allows, short rest between the pair.
- Drop sets, cluster sets and same-muscle combo sets give similar growth to straight sets: time-savers for accessory work, not a better stimulus.

### PERIODIZATION
- Progressive overload is required: track weights and reps; treat a stall as a decision point.
- RPE/RIR-based autoregulation is the default. Velocity tools only with reliable equipment, and don't expect much more.
- Periodized training beats non-periodized for strength, not for hypertrophy (volume equated).
- DELOADS: no scheduled every-4th-week deload. A deload with no accumulated fatigue behind it cost strength with no growth benefit. Deload when lifts stall or drop for 2+ sessions despite consistent effort AND soreness/joint/sleep complaints rise: cut volume/intensity for 5–7 days. If weights have climbed for 3+ weeks, keep progressing.
- Planned overreach (1–2 weeks of deliberately higher stress) must be followed by a 1–2 week taper; expect a rebound above baseline.
- Overtraining is rare; check diet, sleep and stress first.

### WARM-UP
- For strength work: 1–3 progressively heavier submaximal sets of the actual exercise. General/passive warm-up adds little to maximal force.
- Before rate-dependent work (jumps, sprints, explosive lifts): ~7–10 minutes of general warm-up and dynamic stretching.
- No static stretching before training. No glute or other "activation" drills — repeatedly shown not to help.
- Potentiation (PAPE) needs a genuinely heavy set (~85–90%+ 1RM) and works mainly in well-trained athletes.

### POSTURE
- There is no universal perfect posture and it can't be diagnosed reliably by eye. Most postural variables don't predict pain.
- Pelvic tilt has a small, real association with low back pain, but pain may cause the posture as much as the reverse — don't assume it is the cause.
- The FMS misses about 3 in 4 people who get injured; don't use it to predict injury.
- No pain or dysfunction: general full-body strength training is enough; no special corrective program needed. Sitting-related back pain: change sitting behaviour (movement breaks), not sitting posture.

### CARDIO
- Resistance training is the primary fat-loss tool; add cardio once lifting is well set up. Diet does most of the fat-loss work.
- Overweight/obese clients aiming to lose fat mass: include some HIIT or vigorous aerobic work alongside lifting.
- Interference is concentrated in same-session training for well-trained lifters chasing max or explosive strength: separate cardio and lifting by several hours or days. Untrained-to-moderately-trained lifters, and women for lower-body strength, needn't worry much.
- Cycling interferes less than running at fiber level (minor point next to timing and training status).

### STRETCHING
- Don't add general stretching for growth or ROM unless a specific position limits a specific movement; ROM gains are position-specific. Train that position directly (≥~70 min cumulative per week for real flexibility gains).
- Stretching for hypertrophy (calves, hamstrings) needs real dose: long-duration or loaded inter-set stretching.
- Static stretching stays out of the warm-up and away from working sets (if needed for technique, <30 s, low intensity).
- Stretching doesn't prevent injuries in people who lift; the training itself does.

### SEX-SPECIFIC PROGRAMMING
- Women get similar RELATIVE gains in muscle and strength as men of the same training status; the absolute gap comes from starting muscle mass.
- Women may tolerate slightly more volume or frequency where in-session fatigue is the limit (isolation, higher-rep work) — not for every exercise.
- Concurrent-training interference on lower-body strength is seen in men, not women.
- No mandatory menstrual-cycle-synced plan. If a client wants to track and adjust by their own data, that's fine.
- Don't discourage oral contraceptives for training reasons: pooled evidence shows no meaningful effect; recent trials lean neutral-to-favourable. Formulation (estrogen dose, progestin) matters more than "pill or not".
- Cue knee alignment a bit more under heavy dynamic loading. Post-menopause, resistance training matters more, not less.

### POWERLIFTING
- Stance and bar position by leverages and which joints should work: wide stance / low bar = more hips and posterior chain; narrow / high bar = more knees and quads.
- Taper: a 1-week step taper (volume down ~40–60%, intensity kept near-maximal), then only 1–4 days of full rest before the meet. Longer tapers cost strength. Cut volume, keep intensity.
- Making weight: up to ~5% body mass via glycogen/sodium/water with a rehydration window is unlikely to cost strength.
- Train competition lifts with RPE/RIR, not routine grinding to failure (especially bench — shoulder risk).
- Meet day: conservative opener (~90% of tested max), true-1RM second, PR-only third.

### TRAINING AROUND TENDON & JOINT PAIN
- Never fully stop training a body part. Adjust in this order before touching volume or ROM: exercise selection → intensity → proximity to failure → rest → ROM → tempo.
- Pain triage: sharp/electric/radiating = likely neural; diffuse DOMS-like = muscle; dull stiff ache = tendon/connective tissue. Tendon pain often shows up after the problem is established — back off early.
- Active tendon issue: ~30–65% 1RM, controlled tempo, not near failure — about as effective for the tendon as heavy loading.
- After pain resolves, keep rehab loading for several more weeks and bring intensity back gradually; re-injury risk stays high for a while.
- Skip routine icing, high-dose NSAIDs and foam rolling as healing tools (icing and high-dose NSAIDs can blunt adaptation). Occasional standard-dose (preferably topical) NSAID or paracetamol for pain is reasonable.
- Learn joint-specific fixes first: grip width/wrist position for elbows; hip-dominant squatting and stance for knees/hips; scapular retraction and grip width for shoulders; knees-out cueing and hinge substitutions for the back.
- Natural bodybuilding is an unusually low-injury sport (this does not hold for AAS users).

### PROGRAM DESIGN (how the modules fit together)
1. Weekly sessions the client can really keep.
2. Weekly direct sets per muscle from the bands above (lagging muscles 12–15, well-developed ones ~10–12; time-crunched clients ~8–10).
3. Frequency follows volume: ~2x/week per muscle, ≤~6–7 direct sets per muscle per session.
4. Exercises: limiting factor, stretched position, multi- + single-joint, every region of every muscle.
5. Session order and supersets to fit the time; RIR 1–3 on compounds, failure only on the last isolation set.
6. Adjust from measured progress and recovery, not a fixed plan.

# PART 2 — SECONDARY: HENSELMANS PTC (only where BU is silent)

Use these only for topics Part 1 doesn't cover, and never against Part 1.

- Advanced techniques: myo-reps (activation set near failure, 3–5 breaths, 3–5 mini-reps, repeat) are time-efficient and joint-friendly. Forced reps and rest-pause as a standard add fatigue for little gain. Eccentric overloading is time-efficient and joint-friendly.
- Valsalva on heavy compounds is fine; not with hypertension or cardiovascular conditions.
- Concentric as explosive as possible; brief or no pause at lockout; a 0.5–2 s pause in the stretch can help.
- Autoregulatory volume training (AVT): plan only the first (benchmark) set; later sets use the same weight and proximity to failure without a fixed rep target.
- Powerlifting detail: train the competition lifts ~2–3x/week; supplementary variants (paused, front, deficit) away from the last 8–12 weeks; supplementary work after or the day after the main lifts.
- Women may do relatively better at 8–15 reps than at >90% 1RM (lower coordination at maximal loads).
- Peak week (bodybuilding shows): deplete glycogen ~3 days (~100 g carbs/day, HIIT not lifting), then carb-load 8–12 g/kg/day in a surplus (fructose ≤100 g), carb-load BEFORE any water cut, cut sodium 3–6 h before water, keep it experimental and practise it beforehand. Pre-stage meal: high carb, high salt, low fluid, low fat; pump-up sets of 12–30 reps minutes before stage. Bikini athletes skip the pre-stage "shitload" (vascularity is a negative). Always compare to the ideal look for the class.
`;

module.exports = { TRAINING_KNOWLEDGE };
