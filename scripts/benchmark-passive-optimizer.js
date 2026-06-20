#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { performance } = require("node:perf_hooks");
const { PobClient, resolveRuntime } = require("./lib/pob-client");
const {
  buildStateFromPob,
  candidateFromBuildState,
} = require("./lib/passive-optimizer/build-state");
const { applyDelta } = require("./lib/passive-optimizer/delta");
const { withCandidateKey } = require("./lib/passive-optimizer/model");
const { extractPackages } = require("./lib/passive-optimizer/packages");
const { evaluateCandidates } = require("./lib/passive-optimizer/pob-smoke");
const {
  benchmarkFingerprint,
  deterministicBenchmarkPlan,
} = require("./lib/passive-optimizer/presets");
const { runReroute } = require("./lib/passive-optimizer/reroute");
const { scoreDelta } = require("./lib/passive-optimizer/scorer");
const {
  repairConnectivity,
  runPackageSearch,
} = require("./lib/passive-optimizer/search");
const { stableStringify } = require("./lib/passive-optimizer/stable");
const { loadTreeGraph } = require("./lib/passive-optimizer/tree-importer");
const { validateCandidate } = require("./lib/passive-optimizer/validator");

function parseArgs(argv) {
  const args = {
    iterations: 2000,
    exactCount: 12,
    seed: 424242,
  };
  if (argv.includes("--help") || argv.includes("-h")) {
    return { help: true };
  }
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--build") args.build = path.resolve(argv[++index]);
    else if (arg === "--profile") args.profile = path.resolve(argv[++index]);
    else if (arg === "--output") args.output = path.resolve(argv[++index]);
    else if (arg === "--cache") args.cache = path.resolve(argv[++index]);
    else if (arg === "--iterations") args.iterations = Number(argv[++index]);
    else if (arg === "--exact-count") args.exactCount = Number(argv[++index]);
    else if (arg === "--seed") args.seed = Number(argv[++index]);
    else if (arg === "--snapshot") args.snapshot = path.resolve(argv[++index]);
    else if (arg === "--config") args.config = path.resolve(argv[++index]);
    else if (arg === "--pob-runtime") {
      args.pobRuntime = path.resolve(argv[++index]);
    }
    else if (arg === "--runtime-manifest" || arg === "--current-runtime") {
      args.currentRuntime = path.resolve(argv[++index]);
    }
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!args.build || !args.profile || !args.output) {
    throw new Error(
      "Usage: benchmark-passive-optimizer.js --build FILE --profile FILE --output FILE [--cache FILE]",
    );
  }
  return args;
}

function runtimeRequest(args) {
  return {
    configPath: args.config,
    runtimeDir: args.pobRuntime,
    manifestPath: args.currentRuntime,
  };
}

function perSecond(count, milliseconds) {
  return count / Math.max(0.001, milliseconds / 1000);
}

function timed(iterations, callback) {
  const started = performance.now();
  let failures = 0;
  for (let index = 0; index < iterations; index += 1) {
    try {
      callback(index);
    } catch {
      failures += 1;
    }
  }
  const milliseconds = performance.now() - started;
  return {
    iterations,
    milliseconds,
    candidatesPerSecond: perSecond(iterations, milliseconds),
    failures,
  };
}

function ranks(values) {
  return values.map((value) =>
    1 + values.filter((other) => other > value).length,
  );
}

function correlation(left, right) {
  if (left.length < 2 || left.length !== right.length) return null;
  const a = ranks(left);
  const b = ranks(right);
  const meanA = a.reduce((sum, value) => sum + value, 0) / a.length;
  const meanB = b.reduce((sum, value) => sum + value, 0) / b.length;
  let numerator = 0;
  let squareA = 0;
  let squareB = 0;
  for (let index = 0; index < a.length; index += 1) {
    numerator += (a[index] - meanA) * (b[index] - meanB);
    squareA += (a[index] - meanA) ** 2;
    squareB += (b[index] - meanB) ** 2;
  }
  const denominator = Math.sqrt(squareA * squareB);
  return denominator ? numerator / denominator : null;
}

async function importBuild(graph, args, runtime) {
  const xml = fs.readFileSync(args.build, "utf8");
  const started = performance.now();
  const client = new PobClient(runtime);
  await client.ready();
  const startupReadyMs = performance.now() - started;
  const loadStarted = performance.now();
  await client.loadXml(xml, "Passive Optimizer Benchmark");
  const initialLoadMs = performance.now() - loadStarted;
  const info = (await client.call("get_build_info")).info;
  const tree = (await client.call("get_tree")).tree;
  const config = (await client.call("get_config")).config;
  await client.close();
  const state = buildStateFromPob({
    graph,
    tree,
    info,
    xml,
    buildPath: args.build,
    config,
  });
  return {
    state,
    candidate: candidateFromBuildState(state),
    startupReadyMs,
    initialLoadMs,
  };
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    process.stdout.write(
      "Usage: benchmark-passive-optimizer.js --build FILE --profile FILE " +
      "--output FILE --snapshot DIR [--config FILE] [--pob-runtime DIR] " +
      "[--runtime-manifest FILE] [--cache FILE]\n",
    );
    return;
  }
  const profile = JSON.parse(fs.readFileSync(args.profile, "utf8"));
  const runtime = resolveRuntime(runtimeRequest(args));
  const graphStarted = performance.now();
  const graph = loadTreeGraph(args.snapshot, { configPath: args.config });
  const graphLoadMs = performance.now() - graphStarted;
  const imported = await importBuild(graph, args, runtime);
  const incumbent = imported.candidate;
  const reroute = runReroute(graph, incumbent, {
    mode: "standard",
    resultLimit: 24,
  });
  const extractionStarted = performance.now();
  const extraction = extractPackages(graph, incumbent, { reroute });
  const packageExtractionMs = performance.now() - extractionStarted;
  const packageIds = deterministicBenchmarkPlan({
    packageIds: extraction.packages.map((pkg) => pkg.id),
    seed: args.seed,
    sampleSize: Math.max(64, args.iterations),
  });
  const byId = new Map(extraction.packages.map((pkg) => [pkg.id, pkg]));
  const packages = packageIds.map((id) => byId.get(id)).filter(Boolean);
  const rawCandidates = packages.map((pkg) =>
    applyDelta(incumbent, {
      addNodeIds: pkg.addNodeIds,
      removeNodeIds: pkg.removeNodeIds,
    }),
  );
  const iterations = Math.max(1, Math.floor(args.iterations));
  const stageThroughput = {
    canonicalization: timed(iterations, (index) =>
      withCandidateKey(rawCandidates[index % rawCandidates.length]),
    ),
    validation: timed(iterations, (index) =>
      validateCandidate(
        graph,
        withCandidateKey(rawCandidates[index % rawCandidates.length]),
        { baselineAllocatedNodeIds: incumbent.allocatedNodeIds },
      ),
    ),
    repair: timed(iterations, (index) =>
      repairConnectivity(
        graph,
        incumbent,
        withCandidateKey(rawCandidates[index % rawCandidates.length]),
        { maxChanges: 30 },
      ),
    ),
    scoring: timed(iterations, (index) =>
      scoreDelta({
        graph,
        buildState: imported.state,
        candidate: incumbent,
        package: packages[index % packages.length],
        profile,
      }),
    ),
  };
  const batchScaling = [];
  for (const batchSize of [25, 100, 400, 1600]) {
    const before = process.memoryUsage().rss;
    const started = performance.now();
    for (let index = 0; index < batchSize; index += 1) {
      const pkg = packages[index % packages.length];
      scoreDelta({
        graph,
        buildState: imported.state,
        candidate: incumbent,
        package: pkg,
        profile,
      });
    }
    const milliseconds = performance.now() - started;
    batchScaling.push({
      batchSize,
      milliseconds,
      candidatesPerSecond: perSecond(batchSize, milliseconds),
      rssDeltaMb: (process.memoryUsage().rss - before) / (1024 * 1024),
    });
  }
  const searchInput = {
    graph,
    buildState: imported.state,
    candidate: incumbent,
    packages: extraction.packages,
    profile,
    maxChanges: 8,
    beamWidth: 24,
    beamDepth: 3,
    resultLimit: 100,
    relevantLimit: 160,
    diversityBucketCap: 10,
    seed: args.seed,
  };
  const searchStarted = performance.now();
  const search = runPackageSearch(searchInput);
  const searchMs = performance.now() - searchStarted;
  const repeat = runPackageSearch(searchInput);
  const deterministic =
    stableStringify(search) === stableStringify(repeat);
  const exactCandidates = search.archive
    .slice(0, Math.max(0, Math.floor(args.exactCount)))
    .map((entry) => entry.candidate);
  const exact = await evaluateCandidates({
    buildPath: args.build,
    candidates: exactCandidates,
    metrics: ["TotalDPS", "Life", "Evasion"],
    currentRuntime: runtimeRequest(args),
    count: exactCandidates.length,
    cachePath: args.cache,
  });
  const repeated = await evaluateCandidates({
    buildPath: args.build,
    candidates: exactCandidates,
    metrics: ["TotalDPS", "Life", "Evasion"],
    currentRuntime: runtimeRequest(args),
    count: exactCandidates.length,
    cachePath: args.cache,
  });
  const exactByKey = new Map(
    exact.results.map((entry) => [entry.canonicalKey, entry]),
  );
  const correlated = search.archive.filter((entry) =>
    Number.isFinite(Number(exactByKey.get(entry.canonicalKey)?.metrics?.TotalDPS)),
  );
  const cheap = correlated.map((entry) => entry.rankScore);
  const measured = correlated.map((entry) =>
    Number(exactByKey.get(entry.canonicalKey).metrics.TotalDPS),
  );
  const cheapOrder = [...correlated].sort(
    (left, right) => right.rankScore - left.rankScore,
  );
  const exactOrder = [...correlated].sort(
    (left, right) =>
      Number(exactByKey.get(right.canonicalKey).metrics.TotalDPS) -
      Number(exactByKey.get(left.canonicalKey).metrics.TotalDPS),
  );
  const cheapKept = new Set(
    cheapOrder.slice(0, Math.max(1, Math.ceil(cheapOrder.length / 2)))
      .map((entry) => entry.canonicalKey),
  );
  const exactBest = exactOrder.slice(
    0,
    Math.max(1, Math.ceil(exactOrder.length / 4)),
  );
  const falseNegatives = exactBest.filter(
    (entry) => !cheapKept.has(entry.canonicalKey),
  );
  const repairRate = stageThroughput.repair.candidatesPerSecond;
  const persistentExactMs = Math.max(
    1,
    exact.elapsedMs - imported.startupReadyMs,
  );
  const exactRate = perSecond(exact.checked, persistentExactMs);
  const report = {
    benchmarkVersion: 1,
    pipeline: "slice-3-existing",
    measuredAt: new Date().toISOString(),
    deterministicSeed: args.seed,
    environment: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
    },
    runtime: {
      version: runtime.version,
      apiVersion: runtime.apiVersion,
      apiPatchVersion: runtime.apiPatchVersion,
    },
    build: {
      file: path.basename(args.build),
      sha256: incumbent.importedPobIdentity.sha256,
    },
    packages: extraction.packages.length,
    milliseconds: {
      graphLoad: graphLoadMs,
      packageExtraction: packageExtractionMs,
      slice3Search: searchMs,
      pobStartupReady: imported.startupReadyMs,
      pobInitialBuildLoad: imported.initialLoadMs,
    },
    candidatesPerSecond: Object.fromEntries(
      Object.entries(stageThroughput).map(([name, result]) => [
        name,
        result.candidatesPerSecond,
      ]),
    ),
    stageThroughput,
    batchScaling,
    rates: {
      duplicate: search.counts.duplicate /
        Math.max(1, search.counts.generated),
      invalid: search.counts.invalid /
        Math.max(1, search.counts.expanded),
      cache: repeated.cacheHits / Math.max(1, repeated.checked),
      pobFailure: exact.rejected / Math.max(1, exact.checked),
    },
    determinism: {
      searchExactEquality: deterministic,
      repeatedMetricEquality:
        stableStringify(exact.results.map((entry) => entry.metrics)) ===
        stableStringify(repeated.results.map((entry) => entry.metrics)),
    },
    pob: {
      persistentEvaluationsPerSecond: exactRate,
      checked: exact.checked,
      accepted: exact.accepted,
      failureRate: exact.rejected / Math.max(1, exact.checked),
      cacheHitsOnRepeat: repeated.cacheHits,
    },
    cheapScoreQuality: {
      metric: "TotalDPS",
      sampleSize: correlated.length,
      spearman: correlation(cheap, measured),
      pruningRule: "keep top 50% by cheap score",
      exactPositiveRule: "top 25% by exact TotalDPS",
      falseNegativeCount: falseNegatives.length,
      falseNegativeRate:
        falseNegatives.length / Math.max(1, exactBest.length),
    },
    estimatedCapacities: Object.fromEntries(
      [
        ["50ms", 0.05],
        ["500ms", 0.5],
        ["5s", 5],
        ["1min", 60],
        ["10min", 600],
      ].map(([label, seconds]) => [
        label,
        {
          cheapCandidates: Math.floor(repairRate * seconds),
          persistentPobEvaluations: Math.floor(exactRate * seconds),
        },
      ]),
    ),
  };
  report.fingerprint = benchmarkFingerprint(report);
  fs.mkdirSync(path.dirname(args.output), { recursive: true });
  fs.writeFileSync(args.output, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({
    output: path.basename(args.output),
    fingerprint: report.fingerprint,
    packages: report.packages,
    candidatesPerSecond: report.candidatesPerSecond,
    rates: report.rates,
    pob: report.pob,
    estimatedCapacities: report.estimatedCapacities,
  }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
