---
name: calculator-backed-build-optimizer
description: Review and optimize Path of Exile 2 builds using current web evidence, Path of Building, and current acquisition-cost estimates. Use for progression checks, layer and synergy analysis, build ideas, upgrades, value comparisons, respecs, or passive, gear, gem, skill, and configuration comparisons.
---

# Calculator-Backed Build Optimizer

Measure claims in PoB. Do not trust saved scenarios or community DPS by
default.

## Workflow

1. Use `scripts/poe2-forge.js` for every routine local operation. Its default
   `packet` output is bounded; use `silent` for machine chaining and `debug`
   only for a specific reporting failure.
2. Before calculated review, run its `refresh` command. If it returns
   `requiresInput`, ask only for Act or area level. Keep this confirmation near
   progression boundaries.
3. Run the smallest useful comparison. For idea requests or material rebuilds,
   map build layers with `build-layers.md`, then search for concept-sized
   replacements. Do not use global brute force as ideation.
4. Keep the validated scenario fixed, verify legality and restoration, and
   reject drift. Use `directed` for explicit passive deltas; it preserves
   attribute choices and does not mutate the build.
5. After measurement, automatically use $estimate-poe2-build-costs for every
   legal, build-relevant candidate that requires acquiring an unowned item,
   currency, gem, jewel, anoint, craft, or service. Include luxury and dream-tier
   candidates; never prefilter them by expected affordability. Pass mandatory
   properties separately from optional premium properties, plus quantities and
   owned status. Price the batch from one current snapshot and keep PoB effect,
   market cost, and price confidence separate. Skip only invalid, unmeasured,
   configuration-only, or fully owned no-new-cost candidates.
6. Keep the large-work confirmation: more than 40 variants or exhaustive work
   requires explicit user approval. Never change a saved build without separate
   approval.

**Raw artifacts are machine-only. Never open a full artifact!** Query a bounded
packet or one candidate through `passive report`. Full files may contain
millions of tokens even though they cost no context while left on disk.

## Handoff

Offer a handoff to another task when a separable subtask would consume
substantial research, calculator output, or context here. Pass only required
inputs and request a compact result packet. Keep small, interactive, or tightly
coupled work here.

## Load only when needed

- broad non-passive ideas: [ideation.md](references/ideation.md);
- build layers or material rebuilds: [build-layers.md](references/build-layers.md);
- item replacement: [item-completion.md](references/item-completion.md);
- custom or directed variants: [experiment-spec.md](references/experiment-spec.md);
- passive search/rebuild: [passive-optimizer.md](references/passive-optimizer.md);
- scenario diagnosis: [poe2-scenarios.md](references/poe2-scenarios.md);
- mechanic ambiguity: [guardrails.md](references/guardrails.md).

Do not search historical tasks, roadmaps, or old result dumps.
