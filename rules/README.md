# Rule registry

The parameters behind every number in a master plan. The **formulas** live in
ClientIntake's `calculations.js`, the source of truth for the calculations;
this repo carries a generated copy at `src/intakeCalculations.js`. The
**rules** here hold the inputs those formulas run with: factors, ranges,
tables, package layouts and caps. Each plan records `ruleVersion` plus a
`{ ruleId, ruleVersion, verified }` stamp on each number, so any target can
be traced back to the rule (and the evidence) that produced it.

## Format

```jsonc
{
  "id": "nutr.protein.g_per_kg",        // domain.name, stable forever
  "version": 1,                         // bump when params or statement change
  "domain": "nutrition",                // nutrition | training | recovery | safety | package | coaching
  "statement": "Protein 1.6–2.4 g/kg …",
  "params": { "min": 1.6, "default": 1.8, "max": 2.4,
              "conditions": [{ "when": { "goal": "vetverlies" }, "default": 1.8 }] },
  "evidenceGrade": "unrated",           // A | B | C | D | unrated | n/a
  "sources": [{ "label": "Butters University README — Protein" }, { "doi": "…" }],
  "moduleRef": "BU: Protein",
  "bu": { "section": "Module: Protein", "status": "match", "quotes": ["…"], "note": "…" },
  "lastReviewed": null,                 // YYYY-MM-DD
  "verified": false                     // true only after a person has reviewed it
}
```

`registry.json` holds the registry version and the list of rule files.
`src/rules/registry.js` validates every rule when it loads. If any rule is
invalid, only the plan routes are disabled.

## Changing a rule

1. Edit the rule. Bump its `version` and, in `registry.json`, the registry
   version (semver).
2. If the rule's default should differ from ClientIntake's constant, change
   ClientIntake first (it is the source of truth for the calculations), then
   regenerate:
   `node scripts/sync-intake-calculations.js <ClientIntake>/calculations.js`
3. Run `node scripts/test-plan-generator.js`. It checks, among other things,
   that the registry defaults still equal ClientIntake's constants.

Plans that were already generated keep the `ruleVersion` they were made with.

## Butters University

Butters University (BU) is the evidence behind the rules. It is the GitHub
repo `Butterszzz-art/butters-university`, and its content is `README.md`.
BU is the single source for programming, periodization, exercise science and
volume. Menno Henselmans' material (the PTC course, the ClientIntake xlsx
formulas) may personalise a number inside a BU range, or cover a topic BU is
silent on, but never overrides BU. Example: `train.volume.henselmans` runs
Menno's volume formula and clamps the result to BU's direct-set band. The AI
coach's training knowledge (`src/knowledge/training-methodology.js`) follows
the same split: Part 1 is BU, Part 2 is PTC-only material.
Each rule that rests on evidence carries a `bu` block:

```jsonc
"moduleRef": "BU: Protein",
"bu": {
  "section": "Module: Protein",         // README heading, matched exactly (case/spacing aside)
  "status": "match",                    // match | partial | conflict | not_covered | unreviewed
  "quotes": ["the PTC still recommends 1.8 g/kg for advanced lifters"],
  "note": "Why the status is what it is."
}
```

`registry.json` → `buttersUniversity.commit` pins the BU commit the quotes
were checked at. Package rules have no `bu` block: they are business
decisions, not evidence.

- **match**: BU says what the rule does.
- **partial**: BU agrees in part. The note says where it differs or says nothing.
- **conflict**: BU says something different. Every plan that uses the rule lists
  it under `butters.conflicts`, and the coach sees it before approving.
- **not_covered** / **unreviewed**: BU has no position on it, or nobody has
  checked it yet.

The `bu` status records how the rule compares with BU. It does not change
`verified`. A person sets `verified: true` and `lastReviewed` after deciding
the rule is right. For a conflict, that usually means changing ClientIntake
first (see above).

### Checking against BU

```sh
git clone https://github.com/Butterszzz-art/butters-university ../butters-university
node scripts/sync-butters-university.js ../butters-university          # report
node scripts/sync-butters-university.js ../butters-university --pin    # record BU's commit
BU_README=../butters-university/README.md node scripts/test-butters-university.js
```

The report lists every rule by status, with the README line of its section.
It exits 1 when a cited section or quote has disappeared, which means BU
changed under that rule. When that happens, re-read the section and update the
rule's quotes, status and note (and its params, through ClientIntake, if the
evidence moved). Pin once the report is clean. `--pin` refuses to pin while
anything is missing.
