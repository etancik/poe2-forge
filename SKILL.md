---
name: calculator-backed-build-optimizer
description: Review and optimize Path of Exile 2 builds using current web evidence, Path of Building, and current acquisition-cost estimates. Use for progression checks, layer and synergy analysis, build ideas, upgrades, value comparisons, respecs, or passive, gear, gem, skill, and configuration comparisons.
---

# Calculator-Backed Build Optimizer

Measure claims in PoB. Do not trust saved scenarios or community DPS by default.

## Workflow

1. Use `scripts/poe2-forge.js` for routine local work. Default to bounded
   `packet`; use `silent` for chaining and `debug` only for a specific failure.
2. Run `refresh` before calculated review. If it returns `requiresInput`, ask
   only for Act or area level near a progression boundary.
3. For ideas or material rebuilds, map build layers, search concept-sized
   replacements, and show acquisition footprints. Do not use global brute force
   as ideation or run detailed pricing before shared triage.
4. Let the user select or combine promising concepts, then run the smallest
   useful comparisons. Keep the scenario fixed, verify legality/restoration,
   reject drift, and use `directed` for explicit passive deltas.
5. Collect every legal measured candidate worth surfacing into one alternative
   batch for $estimate-poe2-build-costs. Preserve candidate IDs, mandatory versus
   optional properties, quantities, and owned status. Include luxury and
   dream-tier options; price must inform ranking, not prefilter ideas. Skip
   invalid, unmeasured, configuration-only, passive-only trade-zero, and fully
   owned no-new-cost candidates. Do not price the same concept both before and
   after measurement.
6. Keep PoB effect, market cost, and price confidence separate. Require approval
   for more than 40 variants or exhaustive work. Never change a saved build
   without separate approval.

**Raw artifacts are machine-only. Never open a full artifact!** Query bounded
packets or one candidate through a report command.

## Handoff

Offer another task when separable market research, calculation, or output would
consume substantial context here. Pass only candidate IDs and normalized
requirements; request one compact result packet. Keep tightly coupled or
interactive work here.

## Load only when needed

- broad non-passive ideas: [ideation.md](references/ideation.md);
- build layers or material rebuilds: [build-layers.md](references/build-layers.md);
- item replacement: [item-completion.md](references/item-completion.md);
- custom variants: [experiment-spec.md](references/experiment-spec.md);
- passive work: [passive-optimizer.md](references/passive-optimizer.md);
- scenario diagnosis: [poe2-scenarios.md](references/poe2-scenarios.md);
- mechanic ambiguity: [guardrails.md](references/guardrails.md).

Do not search historical tasks, roadmaps, or old result dumps.
