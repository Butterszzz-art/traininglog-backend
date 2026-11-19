// =============================================================
// PT NUTRITION METHODOLOGY — Baked-in Knowledge Base
// Source of truth: Butters University (BU) — GitHub repo
// Butterszzz-art/butters-university, README.md, the nutrition modules
// (Energy balance, Health markers, Protein, Carbohydrates, Fats, Ad libitum
// dieting, Nutrient timing & fasting). BU uses the Henselmans PTC course as
// its starting point and updates it with current meta-analyses.
// Where BU and the PTC disagree, BU wins.
//
// Part 1 is BU only, and its numbers are the ones the master plan calculates
// with (src/intakeCalculations.js, rules/nutrition.json). Part 2 holds PTC
// (Menno Henselmans) material on topics BU does not cover; it is advice to
// compare against and must never contradict Part 1.
// When BU changes, update Part 1 here and the matching rules in rules/*.json.
// =============================================================

const NUTRITION_KNOWLEDGE = `
## NUTRITION METHODOLOGY — Butters University

Your nutrition advice follows Butters University (BU), the coach's evidence hub. BU starts from the Henselmans PTC course and updates it with current meta-analyses. If anything in Part 2 seems to conflict with Part 1, follow Part 1. Never contradict either with bro-science.

# PART 1 — BUTTERS UNIVERSITY (always wins)

### THE NUMBERS THE APP USES (same as the client's master plan)
- BMR: Cunningham/Katch-McArdle, 370 + 21.6 × fat-free mass (kg), for lean or trained clients. Very lean, highly muscled clients: Tinsley, 24.8 × bodyweight (kg) + 10. Cunningham is a poor default for untrained clients with higher body fat (it can underestimate by ~15–17%): correct their numbers from weigh-ins.
- Activity (PAL) covers life outside training only (sedentary 1.0, lightly active ~1.11, active ~1.26, very active ~1.47); lifting is costed separately (~0.1 kcal/kg/min). TEF ×1.1. Training days get more food than rest days.
- Deficit scales with body fat: ~2.5–7.5% near contest leanness, up to 30–50% at high body fat (an untrained woman at 30% body fat starts around 20%). Target weekly loss ~1.5% of bodyweight at higher body fat, down to ~0.5% near contest leanness.
- Surplus by training status, the smallest that keeps fat gain near zero: beginner 5–15%, intermediate 2–7%, advanced 1–3%. Maintenance ±3%.
- Protein 1.6–2.4 g/kg; default 1.8 g/kg. Fat 20–40% of energy (women toward the top). Carbohydrate fills the rest.
- Meals: 3–5 a day (default 4), each with ~0.3 g/kg (~30–40 g) of high-quality protein. Meals after training get more protein (~50% more; ~100% more if only one meal follows training).
- Every estimate is a starting point: after 2+ weeks of weigh-ins (daily, averaged per week), adjust intake to the measured trend.

### ENERGY BALANCE
- Energy balance is real and dominant. 1 kg of fat tissue ≈ 8,260 kcal (the "3,500 kcal per lb" rule overstates it).
- Adaptive thermogenesis is real but usually modest and very variable between people; it is not "metabolic damage" and it reverses.
- Don't chase extreme deficits: very-low-calorie diets don't buy proportionally more fat loss once adherence and NEAT drop, and fast loss costs leaner/trained people more muscle.
- Never cut without resistance training, and don't lower training volume during a cut: ≥10 weekly sets per muscle, held or raised as the diet goes on, protects the most muscle.
- Diet breaks/refeeds: the best-controlled trials show no reliable muscle-sparing or metabolic "reset". Use them for adherence and psychological relief. On cuts longer than ~8–10 weeks, 1–2 weeks at maintenance every 6–8 weeks is a reasonable option, not a requirement.
- Bulking: in trained lifters a bigger surplus mostly buys fat. Save larger surpluses for testing a stalled beginner.
- Body-fat ranges (men ~9–17%, women ~19–28% for long-term gains) are a soft target, not a gate. Year-round single-digit leanness is a contest state, not a health target.
- Recomposition (gaining muscle while losing fat) is real, especially for beginners, returning lifters and higher body fat. A stable scale weight can still be good progress.
- Track body composition with one consistent method (e.g. the same skinfold sites, same person); the trend matters, not the absolute number.

### PROTEIN
- Most controlled trials find no extra muscle or strength above ~1.6 g/kg; 1.8 g/kg is a safe, near-maximal default. 2.2–2.4 g/kg may add a little for lean, high-volume lifters chasing maximal growth, for people regaining lost muscle, and early on a plant-based diet. Steroid users: 2.4+ g/kg.
- Needs do NOT rise in a cut. Women: don't lower the target. Advanced lifters: still 1.8 g/kg.
- If a client already eats ~1.8–2 g/kg, more protein brings little; spend the calories on carbs or fat.
- Per-meal: ~30–40 g of quality protein; more in one sitting adds nothing. Older lifters lean to the top of that.
- Timing: the "anabolic window" is hours wide. A protein-containing meal within a few hours of training (either side) is enough once the daily total is met.
- Pre-sleep: 30–40 g casein or another slow protein before bed is well supported, especially on (evening) training days.
- Plant-based: favour soy and complementary blends (pea + rice) over single non-soy sources like wheat; aim 2.2–2.4 g/kg in the first months. The gap with animal protein shrinks over longer periods.

### CARBOHYDRATES
- At equal calories and protein, the carb/fat ratio doesn't change strength or hypertrophy — down to ketogenic intakes. Low-carb or keto is fine if the client prefers it; it gives no edge.
- Carb timing, glycemic index and within-day periodization add nothing measurable once the daily total is met.
- Fiber: 25 g/day (women), 38 g/day (men) is a floor, not a ceiling. Varied whole-food sources; response to a given fiber varies per person.
- Limit liquid sugar (soda, juice, sports drinks): its cardiometabolic risk is partly independent of bodyweight, even when macros fit.

### FATS
- 20–40% of energy. Raising fat may modestly help testosterone, but the newest meta-analysis finds no reliable effect: a slow, small lever at best.
- Omega-3 (EPA+DHA 2–3 g/day): small, inconsistent muscle effect that shows over 6+ months; take it for health (triglycerides, inflammation) as much as for muscle. ALA from plants converts poorly to EPA/DHA, so vegans need an algae source.
- Saturated fat: what replaces it matters. Swapping it for polyunsaturated fat (fatty fish, nuts, seed oils) has the clearest heart benefit.
- Industrial trans fat: avoid. Natural trans fats from dairy and beef (e.g. CLA) are not equally harmful.
- Dietary cholesterol is not a muscle-building tool; eat eggs for their protein and nutrients.
- Cardiovascular risk: ApoB (particle count) is a better marker than total or LDL cholesterol.

### HEALTH
- Resistance training independently lowers all-cause mortality (largest gains around 60–120 min/week). Lifting plus some cardio beats either alone.
- Alcohol: if the client drinks, 1–3 drinks and not within a few hours of training. 4+ (especially 9+) clearly hurts recovery and hormones. No dose is good for lifespan.
- Diet quality basics beat single "villain" foods: vegetables, fruit, fish, nuts and legumes as staples; minimize trans fat, added sugar, alcohol and tobacco. Most fears (soy, gluten, GMOs, organic status, MSG, sweeteners) are neutral once those basics are in place.
- Digestive symptoms blamed on gluten: test FODMAPs first (structured low-FODMAP elimination and reintroduction), not lifelong wheat avoidance.

### AD LIBITUM DIETING & HUNGER
- The biggest lever: eat mostly whole/minimally processed food. Ultra-processed diets cause ~500–800 kcal/day more intake at the same macros.
- High protein (~25–30%+ of energy) has a real appetite benefit; pushing higher adds little.
- For satiety, pick viscous fiber (oats/β-glucan, legumes, psyllium) over fiber grams alone.
- Sleep: short sleep raises appetite by ~300–550 kcal (ghrelin up, leptin down). Under ~7 h, fix sleep before blaming willpower.
- Meal frequency: 3–5+ meals are interchangeable for muscle and strength, but don't go below 3 meals a day in an aggressive cut.
- Adherence is the main predictor of success: the best diet is the one the client keeps.

### NUTRIENT TIMING & FASTING
- Intermittent fasting / time-restricted eating costs no muscle or strength in trained lifters at matched intake, and may limit fat gain in a bulk.
- Pick a training time the client can keep; in trained lifters time-of-day effects mostly disappear.
- Caffeine (~3 mg/kg) works best at the circadian low (usually mornings); daily use above ~50–100 mg builds tolerance.
- For prediabetes or insulin resistance, an earlier eating window improves insulin sensitivity and blood pressure on its own.
- PSMF days: protein as normal, energy ≈ 9.7 × protein (g) kcal; a short tool, not a lifestyle.

# PART 2 — SECONDARY: HENSELMANS PTC (only where BU is silent)

Use these only for topics Part 1 doesn't cover, and never against Part 1.

- Supplements with evidence: creatine monohydrate 3–5 g/day (the best-researched supplement for strength and muscle); vitamin D if deficient (common at northern latitudes). BCAAs are redundant at adequate protein intake.
- Post-workout: ≥15 g net carbs within ~3 h of training as a conservative minimum.
- Carb tolerance: people with poorer insulin sensitivity (higher body fat, family history of diabetes) may feel and perform better on lower-carb diets.
- Saturated fat: keep it under ~10% of total energy.
- Unprocessed red meat carries little risk; processed meat (bacon, sausage, hot dogs) is consistently linked to cardiovascular disease and cancer.
- Caffeine 3–6 mg/kg pre-workout for performance, but not before competition posing (vasoconstriction).
`;

module.exports = { NUTRITION_KNOWLEDGE };
