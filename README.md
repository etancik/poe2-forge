# PoE2 Forge

Experimental tooling for validating, rerouting, extracting, scoring, and
searching Path of Exile 2 passive trees. Deterministic local code generates and
filters candidates; Path of Building (PoB) is the source of truth for exact
metrics and acceptance. An LLM is not in the search loop.

Slices 1-4 are implemented:

- legality validation and connector rerouting;
- passive-package extraction and profile-aware cheap scoring;
- low-respec deterministic search with canonicalization, cache, Pareto
  retention, diversity, and exact PoB checks;
- medium rebuilds covering 20-30 changed nodes with transactional rollback,
  repair, and persistent PoB evaluation.

The project is experimental. It must not modify a saved build automatically
unless the user explicitly requests a separate, reviewed apply operation.
Slice 5 is not included.

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
- Exact checks depend on the supplied PoB runtime and its API shim.
- Tree exports and runtime versions must match the build under evaluation.
- Build profiles remain user-authored heuristics.
- No telemetry, network upload, saved-build mutation, or automatic publishing
  is included.
- The original optimizer code is available under the
  [MIT License](LICENSE). External PoB and game/tree data retain their own
  terms and are not included.
