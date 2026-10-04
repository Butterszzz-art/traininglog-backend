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
  "sources": [{ "label": "Butters University Module 11" }, { "doi": "…" }],
  "moduleRef": "BU-M11",
  "lastReviewed": null,                 // YYYY-MM-DD
  "verified": false                     // true only after review against Butters University
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

## Butters University (to do)

Every rule except the package rules is `verified: false`. The seed values
come from ClientIntake's constants and the module texts in
`src/knowledge/`. Connecting Butters University should:
- supply or confirm each rule's statement, params, evidence grade and sources;
- set `verified` and `lastReviewed`.

That connection is not built yet. The coach dashboard shows how many of a
plan's rules are still unverified.
