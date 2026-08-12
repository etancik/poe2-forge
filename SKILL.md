---
name: calculator-backed-build-optimizer
description: Review and optimize Path of Exile 2 builds using current web evidence and Path of Building. Use for progression checks, layer and synergy analysis, build ideas, upgrades, respecs, or passive, gear, gem, skill, and configuration comparisons.
---

# Calculator-Backed Build Optimizer

Measure claims in PoB. Do not trust a saved scenario or community DPS by
default.

## Workflow

1. Before calculated review, run `scripts/refresh-build.js`. If it returns
   `requiresInput`, ask only for Act or area level; stop on other validation
   failure.
2. Run the smallest useful comparison. For idea requests or material rebuilds,
   map build layers and dependencies with `build-layers.md`, then search for
   concept-sized replacements. Do not use global brute force as ideation.
3. Use `inspect-build.js` for inspection, `run-experiment.js` for variants,
   item/tree inspectors for candidates, and `passive-optimizer.js` for search.
4. Keep the validated scenario fixed, reload the baseline, verify mutations,
   and reject drift. Never change a saved build without separate approval.
5. Keep full artifacts on disk and consume compact stdout. Report the change,
   measured delta or evidence status, tradeoff, and uncertainty.

## Handoff

Offer a handoff to another task when a separable subtask would consume
substantial research, calculator output, or context here. Pass only required
inputs and request a compact result packet. Keep small, interactive, or tightly
coupled work here.

## Load only when needed

- broad non-passive ideas: [ideation.md](references/ideation.md);
- build layers, dependencies, or material rebuilds:
  [build-layers.md](references/build-layers.md);
- item replacement: [item-completion.md](references/item-completion.md);
- custom variant spec: [experiment-spec.md](references/experiment-spec.md);
- passive search/rebuild: [passive-optimizer.md](references/passive-optimizer.md);
- scenario diagnosis/override: [poe2-scenarios.md](references/poe2-scenarios.md);
- mechanic or calculator ambiguity: [guardrails.md](references/guardrails.md).

Do not search historical tasks, roadmaps, or old result dumps.
