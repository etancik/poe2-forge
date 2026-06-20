---
name: poe2-forge
description: Review and optimize game character builds with an authoritative calculator, decide when local measurement is worth its cost, compare focused or holistic changes across passives, gear, uniques, gems, skills, and configuration, and maintain compact persistent character roadmaps. Use for measured build comparisons, progression reviews, upgrade searches, respecs, baseline refreshes, or roadmap audits.
---

# PoE2 Forge

Treat the calculator as the source of truth for measurable effects, but do not
start it before deciding whether measurement is useful.

## Workflow

1. Run a cheap preflight. State the decision, scope, evidence, and whether
   local calculation is necessary.
2. For ordinary saved-build updates, run `scripts/refresh-build.js` first.
   It performs metadata, level-correct scenario, baseline, delta, tree/item/
   ascendancy comparison, item completion, and active-baseline update in one
   process. Stop after its compact result unless it exposes a specific problem
   or the user approved deeper work.
3. Choose `focused`, `adjacent`, or `holistic` scope. For future archetypes,
   evaluate playable transitions and allow removals and respecs.
4. Classify work using [references/budgets.md](references/budgets.md). Run
   small work directly; present options before medium or large work.
5. Load only roadmap metadata and relevant decisions. Follow
   [references/character-roadmaps.md](references/character-roadmaps.md).
6. Use bundled scripts instead of rewriting inspection, delta, graph, or
   roadmap logic:
   - `scripts/refresh-build.js` for routine progression refreshes;
   - `scripts/inspect-build.js` for targeted build inspection;
   - `scripts/inspect-tree.js` for passive candidate and leaf scans;
   - `scripts/inspect-item-opportunities.js` for detailed augment choices;
   - `scripts/run-experiment.js` for controlled variants;
   - `scripts/roadmap-manager.js` for roadmap summaries and validation;
   - `scripts/learning-manager.js` for bounded post-evaluation learning.
7. Keep scenarios fixed, reload baseline for variants, verify mutations, and
   compare only relevant metrics.
8. Update semantic roadmap decisions only when evidence changes them.
9. Run [references/learning.md](references/learning.md) postflight and write
   at most one reusable rule.
10. Lead with conclusion, exact change, measured delta, and uncertainty.

If local calculation is unnecessary, prepare a small ChatGPT handoff using
[references/chat-handoff.md](references/chat-handoff.md).

Before proposing item replacement, read
[references/item-completion.md](references/item-completion.md). For a routine
refresh, use the integrated completion scan first and open the detailed scan
only when a specific augment choice is needed.

Read [references/experiment-spec.md](references/experiment-spec.md) before
creating experiments, [references/poe2-scenarios.md](references/poe2-scenarios.md)
for configuration work, and [references/passive-tree.md](references/passive-tree.md)
for passive changes.

For deterministic passive-tree legality checks and connector reroutes, use
`scripts/passive-optimizer.js` and follow
[references/passive-optimizer.md](references/passive-optimizer.md). Require an
explicitly configured, hash-verified tree snapshot; do not replace it during a
search.
Use its benchmark-derived medium-rebuild presets for 20-30-node passive
rebuilds; keep PoB as the exact tier and never apply returned candidates to a
saved build automatically.

Treat stdout as a token budget. Save full artifacts and keep stdout compact.
Never load a full result merely to summarize it.

## Context handoff

When the conversation contains several completed evaluations, repeated raw
artifacts, or enough history that another broad review would require rereading
old work, propose a new thread before starting that review. Prepare a compact
handoff containing the build path, active baseline, current decisions,
unresolved questions, runtime/scenario, and the user's requested next action.
Do not claim to create or switch threads; the user must open the new thread.
Do not interrupt a small in-progress operation solely for context hygiene.
