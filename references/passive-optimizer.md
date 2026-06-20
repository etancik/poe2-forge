# Passive Optimizer

Use `scripts/passive-optimizer.js` for deterministic passive-tree work. Run
`--help` before loading a build when the local configuration is uncertain.

## Inputs

- Supply tree data with `--snapshot`, `POE2_TREE_SNAPSHOT`, user config, or
  `external/poe2-tree/current`.
- Supply the headless PoB runtime with `--pob-runtime`,
  `--runtime-manifest`, environment variables, user config, or
  `external/pob2-api/current.json`.
- Supply personal PoB XML only through an explicit `--build` path. Never add
  it to the repository.
- Use `--candidate` or `--packages` for sanitized offline work.

The tree importer verifies the manifest schema and SHA-256 before search.
Do not substitute tree data during a run.

## Commands

```sh
node scripts/passive-optimizer.js validate --build PATH/Build.xml
node scripts/passive-optimizer.js reroute --build PATH/Build.xml --mode standard
node scripts/passive-optimizer.js extract --build PATH/Build.xml --output artifacts/packages.json
node scripts/passive-optimizer.js inspect --packages artifacts/packages.json --profile examples/synthetic-ranged-totem-profile.json
node scripts/passive-optimizer.js score --packages artifacts/packages.json --profile examples/synthetic-ranged-totem-profile.json --package-id PACKAGE_ID
node scripts/passive-optimizer.js search --build PATH/Build.xml --profile examples/synthetic-ranged-totem-profile.json --respec-limit 8 --max-changes 8
```

For a medium rebuild:

```sh
node scripts/passive-optimizer.js search --build PATH/Build.xml --profile examples/synthetic-ranged-totem-profile.json --medium-rebuild --min-changes 20 --max-changes 30 --benchmark benchmarks/local-machine.json --runtime-limit-ms 60000 --evaluation-limit 12 --cache artifacts/medium.cache.json
```

For selective real-PoB measurement, configure an objective set and persistent
job state:

```sh
node scripts/passive-optimizer.js search --build PATH/Build.xml --profile examples/crossbow-tactician-profile.json --medium-rebuild --runtime-limit-ms 60000 --evaluation-limit 12 --objective-set examples/real-objectives.json --selection-mix best=0.3,uncertainty=0.2,diverse=0.2,adjacent=0.2,random=0.1 --near-baseline-count 2 --minimum-sample 8 --batch-size 4 --cache artifacts/selective.cache.json --checkpoint artifacts/selective.checkpoint.json
```

Use `--resume` with the same checkpoint only when the build, shortlist,
runtime/API, tree data, enemy profile, objective set, and selection inputs are
unchanged. A mismatched checkpoint is rejected.

`auto` selects `slow`, `moderate`, or `fast`. Without a local benchmark it
uses the moderate fallback. Explicit runtime/evaluation limits override the
adaptive budget.

Generate a machine-local benchmark after material runtime, tree, build, or
hardware changes:

```sh
node scripts/benchmark-passive-optimizer.js --build PATH/Build.xml --profile examples/synthetic-ranged-totem-profile.json --snapshot PATH/tree-snapshot --output benchmarks/local-machine.json --cache artifacts/benchmark.cache.json
```

## Acceptance and safety

PoB smoke reloads the same XML before every candidate, applies `set_tree`,
reads the tree back, checks exact observable parity and unrelated-state drift,
then reloads the baseline. Setter success alone is not acceptance.

Selective evaluation additionally records startup, batch, and wall time;
cache/checkpoint use; failures, timeouts, and drift; real improvements; time to
first improvement; cheap-versus-real rank correlation; top-k recall and
regret; confidence intervals and minimum-sample warnings; baseline dominance;
cheap-pruned false-negative audits; limitation diagnosis; and real-PoB
representatives for damage, balanced, tanky, accuracy/recovery, low-respec,
and experimental-totem roles.

Calibration always retains the incumbent and available near-baseline probes.
The remaining deterministic budget spans cheap-rank quantiles, uncertainty,
structural/role buckets, and candidates omitted by cheap Pareto pruning.
Objective entries may select a named skill and may derive point/respec costs
from the exact candidate delta.

Cache identities include the normalized candidate, build XML, items, skills,
jewels, choices, config, enemy profile, tree data, PoB/API runtime identity,
objective set, and objective-extractor version. Cheap dominance never removes
a confirmed real-PoB Pareto candidate. Scorer, profile-schema, and profile
versions also invalidate exact-evaluation cache entries.

The optimizer returns proposals and artifacts. Never apply them to a saved
build automatically without a separate explicit user request.

Keep stdout compact. `--full-stdout` may reveal build-derived details and is
for local debugging only.
