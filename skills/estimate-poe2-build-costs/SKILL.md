---
name: estimate-poe2-build-costs
description: Estimate the current acquisition cost of proposed Path of Exile 2 build changes, including gear, uniques, gems, currency, anoints, crafting materials, and respecs, and rank options visible in screenshots or photos of runic stones and other in-game choice screens by current value. Use when comparing upgrades, attaching a price or budget to calculator-backed build recommendations, choosing the most valuable pictured reward or crafting option, checking verified item-specific acquisition alternatives, or separating measured build benefit from market cost and price uncertainty.
---

# Estimate PoE2 Build Costs

Price changes; do not claim they improve a build. Keep calculator effects and
market uncertainty separate.

## Workflow

1. Normalize alternatives into the batch contract in `references/contracts.md`.
   Preserve candidate IDs, net quantities, owned status, and mandatory versus
   optional properties. Never sum mutually exclusive candidates together.
2. If every requirement is owned, configuration-only, passive-only, or otherwise
   trade-zero, report zero trade acquisition cost and any known local respec cost
   without browsing.
3. For market work, resolve the current softcore PoE2 challenge league from the
   official trade endpoint unless the user explicitly requests another league.
   Never hardcode a temporary league name. Treat market, locale, league, and
   their evidence as separate fields.
4. Price all surfaced alternatives once from one current snapshot. Deduplicate
   shared requirements across candidates. Use `scripts/poe2-costs.py batch` for
   exchange items and final aggregation. Search fixed items, rare minimum specs,
   and crafts once per distinct requirement, then pass their evidence as
   `observed`; leave unsupported components `manual`/unpriced, never implicit
   zero.
5. Price direct acquisition first. Check only alternatives verified for the
   exact item and current version. For a deterministic recipe, run
   `scripts/poe2-costs.py optimize`; never infer family recipes or ratios.
6. Keep expensive and dream-tier candidates. Assign confidence per component,
   normalize totals to Exalted Orbs and Divine Orbs when a liquid direct pair
   exists, and avoid false precision.
7. Return a short human comparison plus one compact machine packet. Lead with
   feasible totals, dominant uncertainty, and shopping/crafting steps.

Use `packet` by default, `silent` for chaining, and `debug` only for a specific
failure. **Raw artifacts are machine-only; never open a full artifact.** Use
`poe2-costs.py report --candidate <id>`.

For source selection read [sources.md](references/sources.md). For batch, result,
and handoff schemas read [contracts.md](references/contracts.md).

## Screenshot choices

Transcribe every visible option before pricing. Ask for a clearer crop only when
an unreadable field can change the ranking. Price all options in one snapshot;
separate guaranteed value, expected value, liquidity, image confidence, and
market confidence. Call overlapping ranges tied.

## Handoff

Use another task for substantial listing or crafting research. Pass only the
normalized batch contract and request a compact packet; keep full listings and
artifacts in that task.
