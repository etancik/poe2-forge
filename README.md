# PoE2 Forge

PoE2 Forge is the source repository for the
`calculator-backed-build-optimizer` Codex skill. It combines current web idea
discovery with deterministic local triage and Path of Building as the
authoritative calculator.

The default workflow repairs stale PoB scenarios automatically, produces
several actionable candidates, and measures selected variants without mutating
the saved build. Character roadmaps and historical task folders are not part of
the workflow.

## What it does

- derives enemy level, Armour, Evasion, distance, and campaign resistance
  penalty from the current build and runtime;
- asks for Act/area confirmation only near progression boundaries;
- verifies all scenario fields after PoB loads;
- inspects build, tree, skills, items, and item-local completion opportunities;
- validates, reroutes, scores, and searches legal passive trees;
- runs controlled variant experiments with compact stdout and full artifacts;
- guides web discovery, old-idea revalidation, and shared player-preference
  triage.

## Prerequisites

- Node.js 20 or newer;
- a validated headless PoB2 API runtime with `calc_with_stats`;
- a hash-verified PoE2 tree export for passive search;
- a local PoB XML for calculator-backed work.

Configure paths with CLI arguments, environment variables, or an ignored
`config.local.json`. Copy `config.example.json` as a starting point.

```text
CBB_OPTIMIZER_CONFIG
POB2_RUNTIME
POB2_RUNTIME_MANIFEST
POB2_EXECUTABLE
POB2_WRAPPER
POE2_TREE_SNAPSHOT
```

## Calibrated inspection

```powershell
node scripts/refresh-build.js `
  --build "C:\path\Build.xml" `
  --current-runtime "C:\path\pob2-api\current.json" `
  --output "C:\path\refresh.json"
```

The command normally infers progression. Near a boundary it returns exit code
2 with `requiresInput`; rerun with one of:

```powershell
--act 3
--area-level 42
```

Use an explicit previous artifact only when a delta is useful:

```powershell
--baseline "C:\path\previous-refresh.json"
```

Targeted inspection uses the same calibration:

```powershell
node scripts/inspect-build.js `
  --build "C:\path\Build.xml" `
  --sections info,stats,skills,items,tree,config `
  --output "C:\path\inspection.json"
```

## Controlled experiments

Create a JSON spec using the complete scenario from refresh, then run:

```powershell
node scripts/run-experiment.js experiment.json --output results.json
```

Up to 12 variants are small, 13-40 are bounded medium work, and only larger or
explicitly exhaustive experiments require `approved: true`. Baseline and every
variant must preserve the complete scenario.

## Passive search

```powershell
node scripts/passive-optimizer.js validate --build "C:\path\Build.xml"

node scripts/passive-optimizer.js search `
  --build "C:\path\Build.xml" `
  --profile examples/crossbow-tactician-profile.json `
  --medium-rebuild --preset auto `
  --runtime-limit-ms 60000 --evaluation-limit 12 `
  --cache artifacts/search.cache.json `
  --checkpoint artifacts/search.checkpoint.json `
  --output artifacts/search.json
```

Cheap scores are only prefilters. Exact acceptance uses non-mutating
`calc_with_stats`, verifies baseline integrity, and keeps cheap/exact Pareto
archives separate.

## Development and review

`AGENTS.md` defines the repository workflow. Make changes on a local branch,
leave them uncommitted for user review, and run:

```powershell
npm test
npm run audit
npm run sync:check
```

After review, install the complete validated tree with explicit local runtime
and tree pointers:

```powershell
node scripts/sync-installed-skill.js --apply `
  --runtime-manifest "C:\path\pob2-api\current.json" `
  --tree-snapshot "C:\path\poe2-tree\current"
```

The installer validates the exact target name, stages the replacement, keeps
or creates `config.local.json`, swaps the directory, and rolls back if the swap
fails.

The companion estimate-poe2-build-costs skill is versioned under skills/estimate-poe2-build-costs. Check both installed skills with npm run sync:check and install the companion after review with npm run sync:apply:cost.

## Safety and limitations

- No automatic saved-build mutation, publishing, telemetry, or network upload.
- Community builds and old patch ideas are evidence sources, not calculator
  truth; uncertain ideas are revalidated rather than discarded by age alone.
- PoB cannot model every uptime, queue, AI, or playstyle effect. Mark those for
  targeted in-game verification.
- External runtime and tree data are not vendored. See `THIRD_PARTY.md`.
