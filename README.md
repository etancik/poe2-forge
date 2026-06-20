# PoE2 Forge

Experimental tooling for validating, rerouting, extracting, scoring, and
searching Path of Exile 2 passive trees. Deterministic local code generates and
filters candidates; Path of Building (PoB) is the source of truth for exact
metrics and acceptance. An LLM is not in the search loop.

Slices 1-6 are implemented:

- legality validation and connector rerouting;
- passive-package extraction and profile-aware cheap scoring;
- low-respec deterministic search with canonicalization, cache, Pareto
  retention, diversity, and exact PoB checks;
- medium rebuilds covering 20-30 changed nodes with transactional rollback,
  repair, and persistent PoB evaluation;
- selective exact evaluation from predicted-best, uncertain, diverse,
  incumbent-adjacent, and deterministic-random candidates, with resumable
  checkpoints, complete cache identities, separate cheap/real Pareto archives,
  and scorer calibration diagnostics;
- calibration pools that always retain the incumbent and near-baseline probes,
  stratify deterministic samples across cheap rank, uncertainty,
  structural/role buckets, and cheap-pruned candidates, extract configured
  skill-specific objectives, and diagnose scorer failure, candidate-generation
  limits, insufficient samples, or a locally strong incumbent.

The project is experimental. It must not modify a saved build automatically
unless the user explicitly requests a separate, reviewed apply operation.

## Prerequisites

- Node.js 20 or newer.
- A local headless PoB2 API runtime containing an executable and
  `HeadlessWrapper.lua`.
- A PoE2 tree export containing `manifest.json` and `data.json`.
- A local PoB XML only for build import, smoke checks, exact evaluation, or
  benchmarking.

Only Windows has been exercised with the current PoB executable workflow.
Other platforms are not claimed as supported.

External PoB/runtime and tree data are intentionally not vendored. See
[THIRD_PARTY.md](THIRD_PARTY.md).

## Setup

Clone the repository, then either copy `config.example.json` to the ignored
`config.local.json` and edit it, or use environment variables:

```text
CBB_OPTIMIZER_CONFIG
POB2_RUNTIME
POB2_RUNTIME_MANIFEST
POB2_EXECUTABLE
POB2_WRAPPER
POE2_TREE_SNAPSHOT
OPTIMIZER_BENCHMARK
POB2_TEST_BUILD
```

Path precedence is deterministic:

1. explicit CLI argument;
2. explicitly selected config file;
3. environment variable;
4. ignored repository-local `config.local.json`;
5. `external/pob2-api/current.json` or `external/poe2-tree/current`;
6. an actionable error.

Paths inside a config file are resolved relative to that file.

```sh
npm run help
npm test
```

## Commands

The examples assume configuration supplies the tree and PoB runtime. Add
`--snapshot PATH`, `--pob-runtime PATH`, or `--runtime-manifest PATH` to
override it.

Validate:

```sh
node scripts/passive-optimizer.js validate --build PATH/Build.xml
node scripts/passive-optimizer.js validate --candidate PATH/candidate.json
```

Reroute:

```sh
node scripts/passive-optimizer.js reroute --build PATH/Build.xml --mode standard
```

Extract packages:

```sh
node scripts/passive-optimizer.js extract --build PATH/Build.xml --output artifacts/packages.json
```

Score one package:

```sh
node scripts/passive-optimizer.js score --packages artifacts/packages.json --profile examples/synthetic-ranged-totem-profile.json --package-id PACKAGE_ID
```

Low-respec search:

```sh
node scripts/passive-optimizer.js search --build PATH/Build.xml --profile examples/synthetic-ranged-totem-profile.json --respec-limit 8 --max-changes 8 --output artifacts/low-respec.json
```

Benchmark:

```sh
node scripts/benchmark-passive-optimizer.js --build PATH/Build.xml --profile examples/synthetic-ranged-totem-profile.json --snapshot PATH/tree-snapshot --output benchmarks/local-machine.json --cache artifacts/benchmark.cache.json
```

Medium rebuild:

```sh
node scripts/passive-optimizer.js search --build PATH/Build.xml --profile examples/synthetic-ranged-totem-profile.json --medium-rebuild --min-changes 20 --max-changes 30 --benchmark benchmarks/local-machine.json --runtime-limit-ms 60000 --evaluation-limit 12 --cache artifacts/medium.cache.json --output artifacts/medium.json
```

Selective real-PoB evaluation:

```sh
node scripts/passive-optimizer.js search --build PATH/Build.xml --profile examples/crossbow-tactician-profile.json --medium-rebuild --runtime-limit-ms 60000 --evaluation-limit 12 --objective-set examples/real-objectives.json --selection-mix best=0.3,uncertainty=0.2,diverse=0.2,adjacent=0.2,random=0.1 --near-baseline-count 2 --minimum-sample 8 --batch-size 4 --cache artifacts/selective.cache.json --checkpoint artifacts/selective.checkpoint.json --output artifacts/selective.json
```

Resume the same deterministic evaluation job:

```sh
node scripts/passive-optimizer.js search --build PATH/Build.xml --profile examples/crossbow-tactician-profile.json --medium-rebuild --runtime-limit-ms 60000 --evaluation-limit 12 --objective-set examples/real-objectives.json --selection-mix best=0.3,uncertainty=0.2,diverse=0.2,adjacent=0.2,random=0.1 --near-baseline-count 2 --minimum-sample 8 --batch-size 4 --cache artifacts/selective.cache.json --checkpoint artifacts/selective.checkpoint.json --resume --output artifacts/selective-resumed.json
```

The evaluation budget bounds selected candidate jobs; cache and checkpoint
hits do not consume PoB calls. Every uncached job reloads the baseline,
verifies exact tree parity and unrelated-state drift, extracts the configured
objectives, restores the baseline, and checkpoints the result. Failed,
timed-out, or drifted jobs never enter the real-PoB Pareto archive.

The calibration report includes objective deltas, baseline dominance,
confidence intervals, minimum-sample warnings, cheap-pruned false-negative
audits, and measured representatives for damage, balanced, tanky,
accuracy/recovery, low-respec, and experimental-totem roles. Scorer and profile
versions are part of exact-evaluation cache identity. No learned weights are
introduced from an insufficient sample.

Use `--full-stdout` only for local debugging: full artifacts can contain
build-derived stats, items, skills, and tree state. Default stdout is compact.

## Tests

```sh
npm test
```

The unit suite uses synthetic graphs and temporary directories. It does not
require the author's home directory, PoB, or downloaded tree data.

Integration tests skip unless all local dependencies are available:

```sh
set POB2_TEST_BUILD=PATH\Build.xml
set POE2_TREE_SNAPSHOT=PATH\tree-snapshot
set POB2_RUNTIME_MANIFEST=PATH\current.json
npm run test:integration
```

## Limitations

- Cheap scores guide search but are not authoritative build measurements.
- Cheap and real-PoB Pareto archives are intentionally independent.
- Rank correlation, top-k recall, regret, and false-negative rates include
  uncertainty warnings; small samples must not be treated as validation.
- Exact checks depend on the supplied PoB runtime and its API shim.
- Tree exports and runtime versions must match the build under evaluation.
- Build profiles remain user-authored heuristics.
- No telemetry, network upload, saved-build mutation, or automatic publishing
  is included.
- The original optimizer code is available under the
  [MIT License](LICENSE). External PoB and game/tree data retain their own
  terms and are not included.
