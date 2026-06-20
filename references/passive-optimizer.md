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

The optimizer returns proposals and artifacts. Never apply them to a saved
build automatically without a separate explicit user request.

Keep stdout compact. `--full-stdout` may reveal build-derived details and is
for local debugging only.
