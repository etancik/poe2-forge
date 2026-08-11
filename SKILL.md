---
name: calculator-backed-build-optimizer
description: Review and optimize Path of Exile 2 builds with current web research and an authoritative Path of Building calculator. Use for build reviews, progression checks, upgrade or respec searches, passive/gear/gem comparisons, configuration repair, or generating and triaging build ideas from current and older community sources.
---

# Calculator-Backed Build Optimizer

Use current evidence to generate useful options, then use PoB for measurable
claims. Never treat a saved PoB scenario or community sheet DPS as trusted by
default.

## Workflow

1. Identify the build, goal, player constraints, and whether the request is a
   focused comparison or broader discovery.
2. Run `scripts/refresh-build.js --build <build> --output <artifact>` for every
   calculator-backed review. It derives a level-appropriate scenario from the
   current runtime and corrects stale saved defaults before measuring.
3. If refresh returns `requiresInput`, ask only for the current Act or area
   level, then rerun with `--act` or `--area-level`. Otherwise continue without
   asking the user to maintain PoB configuration.
4. For broad reviews or requests for new directions, browse for ideas before
   committing calculator time. Follow [references/ideation.md](references/ideation.md).
   Return 6-8 distinct idea cards for shared triage, then measure the 2-4 ideas
   the user prefers.
5. Do not discard an old-patch or version-unclear idea automatically. Mark it
   `needs-revalidation`, check its dependencies against current patch notes,
   game data, and PoB, translate it when possible, and reject it only with a
   concrete current-version reason.
6. For focused work, include directly competing low-cost alternatives and run
   a bounded comparison immediately. Follow [references/budgets.md](references/budgets.md).
7. Keep one validated scenario fixed across baseline and variants. Reload the
   baseline, verify each mutation, and reject scenario or unrelated-state
   drift. Read [references/poe2-scenarios.md](references/poe2-scenarios.md).
8. Use bundled entry points instead of one-off audit scripts:
   - `scripts/inspect-build.js` for calibrated inspection;
   - `scripts/refresh-build.js` for a trusted snapshot and optional explicit
     baseline delta;
   - `scripts/run-experiment.js` for controlled variants;
   - `scripts/inspect-item-opportunities.js` before item replacement;
   - `scripts/inspect-tree.js` and `scripts/passive-optimizer.js` for passives.
9. Read [references/guardrails.md](references/guardrails.md) before damage,
   skill-mechanic, or passive experiments. Read
   [references/item-completion.md](references/item-completion.md) for items,
   [references/experiment-spec.md](references/experiment-spec.md) for variants,
   and [references/passive-tree.md](references/passive-tree.md) plus
   [references/passive-optimizer.md](references/passive-optimizer.md) for tree
   changes.
10. Lead with actionable conclusions: exact change, measured delta or evidence
    status, playstyle/cost tradeoff, uncertainty, and the next useful choice.

## Context discipline

- Do not search or load historical Codex task folders, old result dumps, or
  character roadmaps during ordinary work.
- Save complete JSON artifacts to disk. Keep stdout to the scenario, baseline,
  anomalies, 3-5 measured results, and omitted counts.
- Load only the reference needed for the current subsystem.
- Reuse a validated refresh artifact as the baseline; never load its full JSON
  into model context merely to summarize it.
- Do not mutate a saved build automatically. Applying a reviewed change is a
  separate user-approved operation.
