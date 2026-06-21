#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const { PobClient, resolveRuntime } = require("./lib/pob-client");
const {
  loadPortableConfig,
  orderedValue,
} = require("./lib/portable-config");
const {
  buildStateFromPob,
  candidateFromBuildState,
} = require("./lib/passive-optimizer/build-state");
const { normalizeDelta } = require("./lib/passive-optimizer/delta");
const {
  normalizeCandidate,
  withCandidateKey,
} = require("./lib/passive-optimizer/model");
const {
  extractPackages,
} = require("./lib/passive-optimizer/packages");
const {
  evaluateCandidates,
  smokeCandidates,
} = require("./lib/passive-optimizer/pob-smoke");
const {
  evaluateSelectiveCandidates,
  normalizeObjectiveSet,
  normalizeSelectionMix,
  parseObjectiveSpec,
} = require("./lib/passive-optimizer/selective-evaluation");
const {
  runMediumRebuildSearch,
} = require("./lib/passive-optimizer/medium-search");
const {
  resolveSearchPreset,
} = require("./lib/passive-optimizer/presets");
const {
  estimateModes,
  MODES,
  runReroute,
} = require("./lib/passive-optimizer/reroute");
const {
  rankPackages,
  scoreDelta,
} = require("./lib/passive-optimizer/scorer");
const {
  runPackageSearch,
} = require("./lib/passive-optimizer/search");
const { loadTreeGraph } = require("./lib/passive-optimizer/tree-importer");
const { validateCandidate } = require("./lib/passive-optimizer/validator");
const {
  deriveActiveMechanics,
} = require("./lib/passive-optimizer/mechanic-relevance");
const {
  sha256,
  stableStringify,
} = require("./lib/passive-optimizer/stable");

const COMMANDS = [
  "validate",
  "reroute",
  "extract",
  "inspect",
  "score",
  "search",
  "report",
];

const HELP = `Passive tree optimizer (experimental)

Usage:
  node scripts/passive-optimizer.js <command> [options]

Commands:
  validate  Validate a candidate or imported build
  reroute   Find connector reroutes
  extract   Extract reusable passive packages
  inspect   Rank extracted packages for a profile
  score     Score one package or explicit delta
  search    Run low-respec or medium-rebuild search
  report    Summarize or inspect an existing full artifact

Required data:
  --snapshot DIR          Tree snapshot containing manifest.json and data.json
  --build FILE            Local PoB XML (required for import/exact evaluation)
  --candidate FILE        Sanitized candidate artifact instead of a build
  --packages FILE         Package artifact for inspect/score/search
  --profile FILE          Build profile for inspect/score/search

Portable configuration:
  --config FILE           JSON config file
  --pob-runtime DIR       Headless PoB runtime directory
  --runtime-manifest FILE Runtime manifest (legacy: --current-runtime)
  --benchmark FILE        Optional local benchmark for adaptive presets

Search:
  --respec-limit N        Bound changed allocations
  --max-changes N         Bound changed nodes
  --add-only              Allow zero removed nodes
  --points N              Require exactly N added nodes in final candidates
  --max-removals N        Bound removed nodes
  --medium-rebuild        Enable the slice-4 20-30-node search
  --preset NAME           auto, slow, moderate, or fast
  --evaluation-limit N    Exact PoB evaluation budget
  --rescue-limit N        Additional adaptive exact calls after a failed gate
  --runtime-limit-ms N    Overall runtime budget
  --objective-set VALUE   JSON file or field:max,field:min objective list
  --selection-mix VALUE   best/uncertainty/diverse/adjacent/random weights
  --batch-size N          Selective PoB checkpoint batch size
  --near-baseline-count N Guaranteed near-baseline calibration probes
  --minimum-sample N      Warning threshold for scorer diagnostics
  --cache FILE            Optional exact-evaluation cache
  --checkpoint FILE       Resumable selective-evaluation checkpoint
  --resume                Resume the matching checkpoint idempotently
  --summary FILE          Write compact stage summary
  --stdout-mode MODE      compact, silent, or debug (default: compact)
  --summary-max-candidates N  Maximum Pareto representatives (default: 6)
  --summary-max-failures N    Maximum failure digest rows (default: 8)
  --inspect-candidate ID  Return one candidate from an artifact
  --explain-rejection ID  Return one rejected candidate and reason codes

Output:
  --output FILE           Full JSON artifact (default: ./artifacts/...)
  --quiet                 Suppress stdout
  --full-stdout           Print the full artifact, which may contain build data
  --help                  Show this help without loading local configuration

Precedence:
  CLI argument -> explicit config -> environment -> config.local.json ->
  repository-relative discovery -> actionable error.
`;

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function parseList(value) {
  if (!value) return [];
  return value
    .split(",")
    .map(Number)
    .filter(Number.isFinite);
}

function parseArgs(argv) {
  const args = {
    command: argv[2],
    mode: "standard",
    limit: 5,
    resultLimit: 10,
    maxChanges: 8,
    beamWidth: 24,
    beamDepth: 3,
    seed: 0,
    pobLimit: 0,
    pobSmokeCount: 0,
    preset: "auto",
    mediumRebuild: false,
    includeReroutes: true,
    evaluationBatchSize: 4,
    rescueLimit: 0,
    nearBaselineCount: 2,
    minimumSample: 8,
    minAdded: 0,
    stdoutMode: "compact",
    summaryMaxCandidates: 6,
    summaryMaxFailures: 8,
    explicit: {},
  };
  if (argv.includes("--help") || argv.includes("-h") || !argv[2]) {
    args.help = true;
    return args;
  }
  if (args.command === "report") args.reportCommand = argv[3] || "summarize";
  for (
    let index = args.command === "report" ? 4 : 3;
    index < argv.length;
    index += 1
  ) {
    const arg = argv[index];
    if (arg === "--build") args.build = path.resolve(argv[++index]);
    else if (arg === "--candidate") args.candidate = path.resolve(argv[++index]);
    else if (arg === "--packages") args.packages = path.resolve(argv[++index]);
    else if (arg === "--profile") args.profile = path.resolve(argv[++index]);
    else if (arg === "--package-id") args.packageId = argv[++index];
    else if (arg === "--delta") args.delta = argv[++index];
    else if (arg === "--baseline") args.baseline = path.resolve(argv[++index]);
    else if (arg === "--scorer-config") {
      args.scorerConfig = path.resolve(argv[++index]);
    } else if (arg === "--output") args.output = path.resolve(argv[++index]);
    else if (arg === "--artifact") args.artifact = path.resolve(argv[++index]);
    else if (arg === "--summary") args.summary = path.resolve(argv[++index]);
    else if (arg === "--stdout-mode") args.stdoutMode = argv[++index];
    else if (arg === "--summary-max-candidates") {
      args.summaryMaxCandidates = Number(argv[++index]);
    }
    else if (arg === "--summary-max-failures") {
      args.summaryMaxFailures = Number(argv[++index]);
    }
    else if (arg === "--inspect-candidate") {
      args.inspectCandidate = argv[++index];
    }
    else if (arg === "--explain-rejection") {
      args.explainRejection = argv[++index];
    }
    else if (arg === "--no-raw-stdout") args.noRawStdout = true;
    else if (arg === "--snapshot") args.snapshot = path.resolve(argv[++index]);
    else if (arg === "--config") args.config = path.resolve(argv[++index]);
    else if (arg === "--pob-runtime") {
      args.pobRuntime = path.resolve(argv[++index]);
    }
    else if (arg === "--runtime-manifest" || arg === "--current-runtime") {
      args.currentRuntime = path.resolve(argv[++index]);
    }
    else if (arg === "--benchmark") {
      args.benchmark = path.resolve(argv[++index]);
    }
    else if (arg === "--mode") args.mode = argv[++index];
    else if (arg === "--limit") args.limit = Number(argv[++index]);
    else if (arg === "--result-limit") {
      args.resultLimit = Number(argv[++index]);
      args.explicit.resultLimit = true;
    }
    else if (arg === "--max-changes") {
      args.maxChanges = Number(argv[++index]);
      args.explicit.maxChanges = true;
    }
    else if (arg === "--min-changes") {
      args.minChanges = Number(argv[++index]);
      args.explicit.minChanges = true;
    }
    else if (arg === "--beam-width") {
      args.beamWidth = Number(argv[++index]);
      args.explicit.beamWidth = true;
    }
    else if (arg === "--beam-depth") {
      args.beamDepth = Number(argv[++index]);
      args.explicit.beamDepth = true;
    }
    else if (arg === "--seed") args.seed = Number(argv[++index]);
    else if (arg === "--pob-limit") {
      args.pobLimit = Number(argv[++index]);
      args.evaluationLimit = args.pobLimit;
      args.explicit.evaluationLimit = true;
    }
    else if (arg === "--evaluation-limit") {
      args.evaluationLimit = Number(argv[++index]);
      args.pobLimit = args.evaluationLimit;
      args.explicit.evaluationLimit = true;
    }
    else if (arg === "--runtime-limit-ms") {
      args.runtimeLimitMs = Number(argv[++index]);
      args.explicit.runtimeLimitMs = true;
    }
    else if (arg === "--preset") args.preset = argv[++index];
    else if (arg === "--metrics") args.metrics = argv[++index]
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
    else if (arg === "--objective-set") args.objectiveSet = argv[++index];
    else if (arg === "--selection-mix") {
      args.selectionMix = normalizeSelectionMix(argv[++index]);
    }
    else if (arg === "--rescue-limit" || arg === "--evaluation-rescue-limit") {
      args.rescueLimit = Number(argv[++index]);
      args.explicit.rescueLimit = true;
    }
    else if (arg === "--add-only") {
      args.addOnly = true;
      args.maxRemovals = 0;
    }
    else if (arg === "--points") {
      args.minAdded = Number(argv[++index]);
      args.maxAdded = args.minAdded;
      args.explicit.points = true;
    }
    else if (arg === "--max-removals") {
      args.maxRemovals = Number(argv[++index]);
    }
    else if (arg === "--batch-size" || arg === "--evaluation-batch-size") {
      args.evaluationBatchSize = Number(argv[++index]);
    }
    else if (arg === "--near-baseline-count") {
      args.nearBaselineCount = Number(argv[++index]);
    }
    else if (arg === "--minimum-sample") {
      args.minimumSample = Number(argv[++index]);
    }
    else if (arg === "--cache") args.cache = path.resolve(argv[++index]);
    else if (arg === "--checkpoint") {
      args.checkpoint = path.resolve(argv[++index]);
    }
    else if (arg === "--resume") args.resume = true;
    else if (arg === "--relevant-limit") {
      args.relevantLimit = Number(argv[++index]);
    } else if (arg === "--diversity-bucket-cap") {
      args.diversityBucketCap = Number(argv[++index]);
    }
    else if (arg === "--respec-limit") args.respecLimit = Number(argv[++index]);
    else if (arg === "--pob-smoke-count") {
      args.pobSmokeCount = Number(argv[++index]);
    } else if (arg === "--ordinary-budget") {
      args.ordinaryBudget = Number(argv[++index]);
    } else if (arg === "--primary-ascendancy-budget") {
      args.primaryAscendancyBudget = Number(argv[++index]);
    } else if (arg === "--secondary-ascendancy-budget") {
      args.secondaryAscendancyBudget = Number(argv[++index]);
    } else if (arg === "--total-budget") {
      args.totalBudget = Number(argv[++index]);
    } else if (arg === "--required") args.required = parseList(argv[++index]);
    else if (arg === "--forbidden") args.forbidden = parseList(argv[++index]);
    else if (arg === "--approve-rebuild") args.approveRebuild = true;
    else if (arg === "--medium-rebuild") args.mediumRebuild = true;
    else if (arg === "--no-reroutes") args.includeReroutes = false;
    else if (arg === "--quiet") {
      args.quiet = true;
      args.stdoutMode = "silent";
    }
    else if (arg === "--full-stdout") {
      args.fullStdout = true;
      args.stdoutMode = "debug";
    }
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!COMMANDS.includes(args.command)) {
    throw new Error(
      `Usage: passive-optimizer.js ${COMMANDS.join("|")} [options]`,
    );
  }
  if (!MODES.includes(args.mode)) {
    throw new Error(`--mode must be one of ${MODES.join("|")}`);
  }
  if (args.command === "reroute" && !args.build) {
    throw new Error("reroute requires --build");
  }
  if (["inspect", "score", "search"].includes(args.command) && !args.profile) {
    throw new Error(`${args.command} requires --profile`);
  }
  if (args.command === "search" && args.evaluationLimit > 0 && !args.build) {
    throw new Error("search --pob-limit requires --build");
  }
  if (args.command === "search" && args.rescueLimit > 0 && !args.build) {
    throw new Error("search --rescue-limit requires --build");
  }
  if (!["compact", "silent", "debug"].includes(args.stdoutMode)) {
    throw new Error("--stdout-mode must be compact, silent, or debug");
  }
  if (args.command === "report") {
    if (!args.artifact) throw new Error("report requires --artifact FILE");
    return args;
  }
  if (args.resume && !args.checkpoint) {
    throw new Error("--resume requires --checkpoint FILE");
  }
  if (
    (args.checkpoint || args.selectionMix || args.rescueLimit > 0) &&
    !args.objectiveSet &&
    !args.metrics?.length
  ) {
    throw new Error(
      "--checkpoint/--selection-mix/--rescue-limit require --objective-set or --metrics",
    );
  }
  const canLoadCandidateFromPackages =
    args.packages && ["inspect", "score", "search"].includes(args.command);
  if (!args.build && !args.candidate && !canLoadCandidateFromPackages) {
    throw new Error("Missing --build, --candidate, or --packages artifact");
  }
  if (
    args.command === "score" &&
    !args.packageId &&
    !args.delta
  ) {
    throw new Error("score requires --package-id or --delta");
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

function defaultOutput(args) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return path.resolve(
    process.cwd(),
    "artifacts",
    "passive-optimizer",
    `${args.command}-${stamp}.json`,
  );
}

async function importBuild(graph, args) {
  const runtime = resolveRuntime(runtimeRequest(args));
  const client = new PobClient(runtime);
  try {
    await client.ready();
    await client.loadBuild(args.build);
    const info = (await client.call("get_build_info")).info;
    const tree = (await client.call("get_tree")).tree;
    const config = (await client.call("get_config")).config;
    const skills = (await client.call("get_skills")).skills;
    const xml = fs.readFileSync(args.build, "utf8");
    const state = buildStateFromPob({
      graph,
      tree,
      info,
      xml,
      buildPath: args.build,
      config,
      budgets: {
        ...(Number.isFinite(args.ordinaryBudget)
          ? { ordinary: args.ordinaryBudget }
          : {}),
        ...(Number.isFinite(args.primaryAscendancyBudget)
          ? { primaryAscendancy: args.primaryAscendancyBudget }
          : {}),
        ...(Number.isFinite(args.secondaryAscendancyBudget)
          ? { secondaryAscendancy: args.secondaryAscendancyBudget }
          : {}),
        ...(Number.isFinite(args.totalBudget)
          ? { total: args.totalBudget }
          : {}),
      },
      requiredNodeIds: args.required,
      forbiddenNodeIds: args.forbidden,
      respecBudget: Number.isFinite(args.respecLimit)
        ? args.respecLimit
        : null,
    });
    return {
      state,
      candidate: candidateFromBuildState(state),
      runtime: {
        version: runtime.version,
        apiVersion: runtime.apiVersion,
        apiPatchVersion: runtime.apiPatchVersion,
      },
      skills,
      activeMechanics: deriveActiveMechanics(skills),
    };
  } finally {
    await client.close();
  }
}

function candidateFromJson(value) {
  return withCandidateKey(
    normalizeCandidate(value.candidate || value.baseCandidate || value),
  );
}

function loadCandidate(file) {
  return candidateFromJson(readJson(file));
}

function loadDelta(value) {
  const trimmed = String(value).trim();
  const parsed =
    trimmed.startsWith("{") || trimmed.startsWith("[")
      ? JSON.parse(trimmed)
      : readJson(path.resolve(trimmed));
  return normalizeDelta(parsed.delta || parsed);
}

function artifactCandidates(artifact) {
  return [
    ...(artifact.pobEvaluation?.results || []),
    ...(artifact.search?.archive || []),
    ...(artifact.search?.calibrationPool || []),
  ];
}

function inspectArtifactCandidate(artifact, id, rejectionOnly = false) {
  const match = artifactCandidates(artifact).find((entry) =>
    [entry.canonicalKey, entry.jobId, entry.cacheKey].includes(id));
  if (!match) throw new Error(`Unknown candidate ID: ${id}`);
  if (rejectionOnly) {
    return {
      candidateId: match.canonicalKey || match.jobId,
      status: match.status,
      accepted: match.accepted,
      reasonCodes: match.reasonCodes || [],
      error: match.error || null,
      drift: (match.drift || []).map((entry) => ({
        field: entry.field,
        beforeHash: entry.before
          ? sha256(stableStringify(entry.before))
          : null,
        afterHash: entry.after
          ? sha256(stableStringify(entry.after))
          : null,
      })),
      warnings: match.rejectionWarnings || [],
      nodeExplanations: match.nodeExplanations || [],
    };
  }
  return match;
}

function buildStageSummary(artifact, options = {}) {
  const maxCandidates = Math.max(1, Number(options.maxCandidates || 6));
  const maxFailures = Math.max(1, Number(options.maxFailures || 8));
  const exact = artifact.pobEvaluation;
  const representatives =
    exact?.realArchive?.representatives?.length
      ? exact.realArchive.representatives
      : artifact.search?.representatives || [];
  const failures = (exact?.results || [])
    .filter((entry) => entry.status && entry.status !== "success")
    .slice(0, maxFailures)
    .map((entry) => ({
      candidateId: entry.canonicalKey || entry.jobId,
      status: entry.status,
      error: entry.error || null,
      driftFields: (entry.drift || []).map((item) => item.field),
    }));
  const summary = {
    stage: artifact.command || "search",
    baselineRef: artifact.build?.sha256 || null,
    identity: {
      buildHash: exact?.buildHash || artifact.build?.sha256 || null,
      scenarioHash: exact?.scenario?.scenarioHash || null,
      profileHash: artifact.profile
        ? sha256(stableStringify(artifact.profile))
        : null,
      runtime: exact?.runtime || artifact.runtime || null,
    },
    counts: {
      generated: artifact.search?.counts?.generated || 0,
      repaired: artifact.search?.counts?.repaired || 0,
      invalid: artifact.search?.counts?.invalid || 0,
      duplicate: artifact.search?.counts?.duplicate || 0,
      pruned: Math.max(
        0,
        Number(artifact.search?.counts?.usable || 0) -
          Number(artifact.search?.archiveSize || 0),
      ),
      retained: artifact.search?.archiveSize || 0,
      pobCalls: exact?.budget?.pobCalls || exact?.checked || 0,
      initialPobCalls: exact?.budget?.initialPobCalls || 0,
      rescuePobCalls: exact?.budget?.rescuePobCalls || 0,
      cacheHits: exact?.cacheHits || 0,
      failures: exact?.failures || 0,
      drift: exact?.drifted || 0,
    },
    timingMs: {
      search: artifact.search?.runtime?.elapsedMs || 0,
      pob: exact?.timing?.wallMs || exact?.elapsedMs || 0,
    },
    calibration: {
      spearman: exact?.diagnostics?.cheapVsPobSpearman ?? null,
      topKRecall: exact?.diagnostics?.topKRecall ?? null,
      regret: exact?.diagnostics?.regret ?? null,
      falseNegativeRate:
        exact?.diagnostics?.falseNegativePruning?.rate ?? null,
      falseNegativeScope:
        exact?.diagnostics?.falseNegativePruning?.scope ?? null,
      cheapPrunedCoverage:
        exact?.diagnostics?.falseNegativePruning?.coverage ?? null,
      confidence: exact?.adaptiveRescue?.confidence ?? null,
      rescueTriggered: exact?.adaptiveRescue?.triggered ?? false,
    },
    pareto: representatives.slice(0, maxCandidates).map((entry) => ({
      candidateId: entry.canonicalKey,
      roles: entry.representativeLabels || [],
      added: entry.candidateSummary?.addedNodeIds || entry.delta?.addNodeIds || [],
      removed:
        entry.candidateSummary?.removedNodeIds || entry.delta?.removeNodeIds || [],
      nodeExplanations: (
        entry.nodeExplanations ||
        entry.candidateSummary?.nodeExplanations ||
        []
      ).map((node) => ({
        nodeId: node.nodeId,
        name: node.name,
        reason: node.reason,
      })),
      metrics: Object.fromEntries(
        Object.entries(entry.objectives || entry.metrics || {}).slice(0, 8),
      ),
      cost: {
        points: entry.candidateSummary?.pointCost ??
          entry.costs?.marginal?.add ?? null,
        respec: entry.candidateSummary?.respecCost ??
          entry.objectives?.respecCost ?? null,
      },
      confidence: entry.confidence ?? null,
      warnings: entry.rejectionWarnings || [],
    })),
    failures,
    nextGate: failures.length
      ? "inspect_failure"
      : exact?.adaptiveRescue?.confidence === "low"
        ? "low_confidence"
        : "ready",
    tokenEfficiency: {
      toolCalls: null,
      fullArtifactsOpenedByLlm: 0,
      rawCandidatesShownToLlm: 0,
      estimatedLlmInputTokens: null,
      estimatedLlmOutputTokens: null,
    },
  };
  const text = `${JSON.stringify(summary, null, 2)}\n`;
  summary.tokenEfficiency.summaryBytes = Buffer.byteLength(text);
  return summary;
}

function loadObjectiveSet(args) {
  if (args.objectiveSet) {
    const possibleFile = path.resolve(args.objectiveSet);
    return fs.existsSync(possibleFile)
      ? normalizeObjectiveSet(readJson(possibleFile))
      : parseObjectiveSpec(args.objectiveSet);
  }
  if (args.metrics?.length) return normalizeObjectiveSet(args.metrics);
  return normalizeObjectiveSet([]);
}

function compactResult(artifact, output, limit) {
  if (artifact.search) {
    const selective = artifact.pobEvaluation?.realArchive;
    return {
      build: {
        name: artifact.build?.name,
        file: artifact.build?.file,
        sha256: artifact.build?.sha256,
      },
      tree: {
        version: artifact.source?.treeVersion,
        hash: artifact.source?.hash,
      },
      extraction: {
        packageCount: artifact.packageExtraction?.packageCount,
        unknownStatLineCount:
          artifact.packageExtraction?.unknownStatLineCount,
        uncertainPackageCount:
          artifact.packageExtraction?.uncertainPackageCount,
      },
      search: {
        preset: artifact.searchPreset,
        counts: artifact.search.counts,
        paretoArchiveSize: artifact.search.paretoArchiveSize,
        explorationBucketSize: artifact.search.explorationBucketSize,
        archiveSize: artifact.search.archiveSize,
      },
      representatives: artifact.search.representatives.map((entry) => {
        const pob = artifact.pobEvaluation?.results.find(
          (result) => result.canonicalKey === entry.canonicalKey,
        );
        return {
          labels: entry.representativeLabels,
          added: entry.delta.addNodeIds,
          removed: entry.delta.removeNodeIds,
          changed: entry.changedNodeCount,
          respecCost: entry.objectives.respecCost,
          components: Object.fromEntries(
            Object.entries(entry.components).filter(
              ([, value]) => Math.abs(Number(value)) > 1e-9,
            ),
          ),
          uncertainty: entry.objectives.uncertainty,
          status: entry.status,
          pobStatus: pob
            ? pob.accepted
              ? pob.metricError
                ? "accepted_metric_error"
                : "accepted"
              : "rejected"
            : "not_evaluated",
          canonicalKey: entry.canonicalKey,
        };
      }),
      pobEvaluation: artifact.pobEvaluation
        ? {
            checked: artifact.pobEvaluation.checked,
            accepted: artifact.pobEvaluation.accepted,
            rejected: artifact.pobEvaluation.rejected,
            failures: artifact.pobEvaluation.failures,
            timeouts: artifact.pobEvaluation.timeouts,
            drifted: artifact.pobEvaluation.drifted,
            cacheHits: artifact.pobEvaluation.cacheHits,
            resumed: artifact.pobEvaluation.resumed,
            runtimeLimited: artifact.pobEvaluation.runtimeLimited,
            elapsedMs:
              artifact.pobEvaluation.timing?.wallMs ??
              artifact.pobEvaluation.elapsedMs,
            timing: artifact.pobEvaluation.timing,
            budget: artifact.pobEvaluation.budget,
            adaptiveRescue: artifact.pobEvaluation.adaptiveRescue,
            falseNegativePruning:
              artifact.pobEvaluation.diagnostics?.falseNegativePruning,
            realImprovements:
              artifact.pobEvaluation.diagnostics?.realImprovements,
            realParetoRepresentatives:
              selective?.representatives?.map((entry) => ({
                labels: entry.representativeLabels,
                canonicalKey: entry.canonicalKey,
                objectives: entry.objectives,
              })),
            scorerDiagnostics: artifact.pobEvaluation.diagnostics,
            userReport: artifact.pobEvaluation.userReport,
          }
        : undefined,
      artifact: output,
    };
  }
  const packageSummary = artifact.packageExtraction
    ? {
        packageCounts: artifact.packageExtraction.counts,
        unknownStatLineCount:
          artifact.packageExtraction.unknownStatLineCount ??
          artifact.packageExtraction.unknownStatLines?.length ??
          0,
        unknownStatLineSample:
          artifact.packageExtraction.unknownStatLineSample?.slice(0, 10) ??
          artifact.packageExtraction.unknownStatLines?.slice(0, 10) ??
          [],
        uncertainPackageCount:
          artifact.packageExtraction.uncertainPackageCount,
      }
    : {};
  return {
    source: artifact.source,
    build: artifact.build,
    validity: artifact.validation
      ? {
          status: artifact.validation.status,
          errors: artifact.validation.errors.map((entry) => entry.code),
          needsPob: artifact.validation.needsPob.map((entry) => entry.code),
          points: artifact.validation.counts,
        }
      : undefined,
    mode: artifact.reroute?.mode,
    search: artifact.search
      ? {
          counts: artifact.search.counts,
          archiveSize: artifact.search.archiveSize,
          options: artifact.search.options,
        }
      : artifact.reroute?.search,
    topReroutes: artifact.reroute?.results.map((entry) => ({
      pointsSaved: entry.pointsSaved,
      respecCount: entry.respecCount,
      added: entry.addedNodeIds,
      removed: entry.removedNodeIds,
      canonicalKey: entry.canonicalKey,
      pobAccepted:
        artifact.pobSmoke?.results.find(
          (smoke) => smoke.canonicalKey === entry.canonicalKey,
        )?.accepted ?? null,
    })),
    ...packageSummary,
    topRelevantPackages: (artifact.rankedPackages || [])
      .slice(0, limit)
      .map((entry) => ({
        packageId: entry.packageId,
        rankScore: entry.rankScore,
        status: entry.status,
        components: entry.components,
        confidence: entry.confidence,
        reasonCodes: entry.reasonCodes,
        requiredPoBChecks: entry.requiredPoBChecks,
      })),
    score: artifact.score
      ? {
          packageId: artifact.score.packageId,
          rankScore: artifact.score.rankScore,
          status: artifact.score.status,
          components: artifact.score.components,
          confidence: artifact.score.confidence,
          reasonCodes: artifact.score.reasonCodes,
          requiredPoBChecks: artifact.score.requiredPoBChecks,
        }
      : undefined,
    representatives: (artifact.search?.representatives || []).map((entry) => {
      const pob = artifact.pobEvaluation?.results.find(
        (result) => result.canonicalKey === entry.canonicalKey,
      );
      return {
        labels: entry.representativeLabels,
        added: entry.delta.addNodeIds,
        removed: entry.delta.removeNodeIds,
        changed: entry.changedNodeCount,
        respecCost: entry.objectives.respecCost,
        components: entry.components,
        uncertainty: entry.objectives.uncertainty,
        status: entry.status,
        pobStatus: pob
          ? pob.accepted
            ? pob.metricError
              ? "accepted_metric_error"
              : "accepted"
            : "rejected"
          : "not_evaluated",
        canonicalKey: entry.canonicalKey,
      };
    }),
    pobEvaluation: artifact.pobEvaluation
      ? {
          checked: artifact.pobEvaluation.checked,
          accepted: artifact.pobEvaluation.accepted,
          rejected: artifact.pobEvaluation.rejected,
          cacheHits: artifact.pobEvaluation.cacheHits,
        }
      : undefined,
    artifact: path.basename(output),
    deeperWorkNeedsApproval: Boolean(artifact.reroute?.approvalRequired),
  };
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    process.stdout.write(HELP);
    return;
  }
  if (args.command === "report") {
    const artifact = readJson(args.artifact);
    const result = args.inspectCandidate
      ? inspectArtifactCandidate(artifact, args.inspectCandidate, false)
      : args.explainRejection
        ? inspectArtifactCandidate(artifact, args.explainRejection, true)
        : buildStageSummary(artifact, {
            maxCandidates: args.summaryMaxCandidates,
            maxFailures: args.summaryMaxFailures,
          });
    if (args.output) {
      fs.mkdirSync(path.dirname(args.output), { recursive: true });
      fs.writeFileSync(args.output, `${JSON.stringify(result, null, 2)}\n`);
    }
    if (args.stdoutMode !== "silent") {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    }
    return;
  }
  const graph = loadTreeGraph(args.snapshot, { configPath: args.config });
  const packageArtifact = args.packages ? readJson(args.packages) : null;
  let imported;
  let candidate;
  if (args.build) {
    imported = await importBuild(graph, args);
    candidate = imported.candidate;
  } else if (args.candidate) {
    candidate = loadCandidate(args.candidate);
  } else {
    candidate = candidateFromJson(packageArtifact);
  }
  const validation = validateCandidate(graph, candidate);
  const artifact = {
    generatedAt: new Date().toISOString(),
    command: args.command,
    source: graph.source,
    build: candidate.importedPobIdentity,
    runtime: imported?.runtime,
    modeEstimates: estimateModes(graph, candidate),
    baseCandidate: candidate,
    buildWarnings: imported?.state.warnings || [],
    validation,
  };

  if (args.command === "reroute") {
    artifact.reroute = runReroute(graph, candidate, {
      mode: args.mode,
      resultLimit: args.limit,
      approveRebuild: args.approveRebuild,
    });
    if (args.pobSmokeCount > 0 && artifact.reroute.results.length > 0) {
      artifact.pobSmoke = await smokeCandidates({
        buildPath: args.build,
        candidates: artifact.reroute.results.map((entry) => entry.candidate),
        currentRuntime: runtimeRequest(args),
        count: args.pobSmokeCount,
      });
    }
  }

  if (["extract", "inspect"].includes(args.command)) {
    const reroute = args.includeReroutes
      ? runReroute(graph, candidate, {
          mode: args.mode,
          resultLimit: args.limit,
          approveRebuild: args.approveRebuild,
        })
      : null;
    artifact.packageExtraction = extractPackages(graph, candidate, { reroute });
  } else if (args.command === "score" && !packageArtifact) {
    artifact.packageExtraction = extractPackages(graph, candidate);
  } else if (packageArtifact?.packageExtraction) {
    artifact.packageExtraction = packageArtifact.packageExtraction;
  } else if (packageArtifact?.packages) {
    artifact.packageExtraction = packageArtifact;
  }

  if (args.command === "inspect") {
    const profile = {
      ...readJson(args.profile),
      activeMechanics: imported?.activeMechanics || [],
    };
    artifact.profile = profile;
    artifact.rankedPackages = rankPackages({
      graph,
      buildState: imported?.state,
      candidate,
      packages: artifact.packageExtraction.packages,
      profile,
      baselineMetrics: args.baseline ? readJson(args.baseline) : null,
      config: args.scorerConfig ? readJson(args.scorerConfig) : {},
    });
  }

  if (args.command === "score") {
    const profile = {
      ...readJson(args.profile),
      activeMechanics: imported?.activeMechanics || [],
    };
    const scorerConfig = args.scorerConfig ? readJson(args.scorerConfig) : {};
    const baselineMetrics = args.baseline ? readJson(args.baseline) : null;
    const pkg = args.packageId
      ? artifact.packageExtraction.packages.find(
          (entry) => entry.id === args.packageId,
        )
      : null;
    if (args.packageId && !pkg) {
      throw new Error(`Unknown package ID: ${args.packageId}`);
    }
    artifact.profile = profile;
    artifact.score = scoreDelta({
      graph,
      buildState: imported?.state,
      candidate,
      package: pkg,
      delta: args.delta ? loadDelta(args.delta) : undefined,
      profile,
      baselineMetrics,
      config: scorerConfig,
    });
  }

  if (args.command === "search") {
    const profile = {
      ...readJson(args.profile),
      activeMechanics: imported?.activeMechanics || [],
    };
    const scorerConfig = args.scorerConfig ? readJson(args.scorerConfig) : {};
    const baselineMetrics = args.baseline ? readJson(args.baseline) : null;
    if (!artifact.packageExtraction) {
      const reroute = args.includeReroutes
        ? runReroute(graph, candidate, {
            mode: args.mode,
            resultLimit: Math.max(args.limit, args.beamWidth),
            approveRebuild: false,
          })
        : null;
      artifact.packageExtraction = extractPackages(graph, candidate, {
        reroute,
      });
    }
    artifact.profile = profile;
    const config = loadPortableConfig(args.config);
    const benchmarkPath = orderedValue({
      explicit: args.benchmark,
      config,
      configKey: "benchmark",
      environment: process.env.OPTIMIZER_BENCHMARK,
    });
    const benchmark = benchmarkPath ? readJson(benchmarkPath) : null;
    const preset = args.mediumRebuild
      ? resolveSearchPreset({
          name: args.preset,
          benchmark,
          runtimeLimitMs: args.runtimeLimitMs,
          evaluationLimit: args.explicit.evaluationLimit
            ? args.evaluationLimit
            : undefined,
        })
      : null;
    if (preset) artifact.searchPreset = preset;
    const searchStartedAt = Date.now();
    const searchInput = {
      graph,
      buildState: imported?.state,
      candidate,
      packages: artifact.packageExtraction.packages,
      profile,
      baselineMetrics,
      scorerConfig,
      maxChanges: args.explicit.maxChanges
        ? args.maxChanges
        : args.mediumRebuild
          ? 30
          : args.maxChanges,
      beamWidth: args.explicit.beamWidth
        ? args.beamWidth
        : args.mediumRebuild
          ? preset.beamWidth
          : args.beamWidth,
      beamDepth: args.beamDepth,
      resultLimit: args.explicit.resultLimit
        ? args.resultLimit
        : args.mediumRebuild
          ? preset.resultLimit
          : args.resultLimit,
      relevantLimit: args.relevantLimit,
      seed: args.seed,
      diversityBucketCap: args.diversityBucketCap ??
        (args.mediumRebuild ? preset.diversityBucketCap : undefined),
      maxRemovals: Number.isFinite(args.maxRemovals)
        ? args.maxRemovals
        : undefined,
      minAdded: args.minAdded,
      maxAdded: args.explicit.points ? args.maxAdded : undefined,
    };
    let nearBaselineSearch = null;
    if (args.mediumRebuild) {
      nearBaselineSearch = runPackageSearch({
        ...searchInput,
        maxChanges: 4,
        beamDepth: 1,
        beamWidth: Math.max(24, Math.min(80, searchInput.beamWidth)),
        resultLimit: Math.max(6, args.nearBaselineCount + 1),
      });
    }
    artifact.search = args.mediumRebuild
      ? runMediumRebuildSearch({
          ...searchInput,
          minChanges: args.explicit.minChanges ? args.minChanges : 20,
          branchLimit: preset.branchLimit,
          remotePackageLimit: preset.remotePackageLimit,
          transactionLimit: preset.transactionLimit,
          batchSize: preset.batchSize,
          runtimeLimitMs: Number.isFinite(args.runtimeLimitMs)
            ? Math.max(1, args.runtimeLimitMs - (Date.now() - searchStartedAt))
            : undefined,
        })
      : runPackageSearch(searchInput);
    if (nearBaselineSearch) {
      const combined = [...new Map(
        [
          ...nearBaselineSearch.calibrationPool,
          ...artifact.search.calibrationPool,
        ].map((entry) => [entry.canonicalKey, entry]),
      ).values()]
        .sort(
          (left, right) =>
            right.rankScore - left.rankScore ||
            left.canonicalKey.localeCompare(right.canonicalKey),
        )
        .map((entry, cheapRank) => ({
          ...entry,
          cheapRank: cheapRank + 1,
        }));
      artifact.search.calibrationPool = combined;
      artifact.search.calibration = {
        baselineCandidates: combined.filter(
          (entry) => entry.calibrationKind === "baseline",
        ).length,
        nearBaselineCandidates: combined.filter(
          (entry) => entry.calibrationKind === "near-baseline",
        ).length,
        cheapPrunedCandidates: combined.filter(
          (entry) => entry.cheapPruned,
        ).length,
        structuralRoleBuckets: [...new Set(
          combined.map((entry) =>
            `${(entry.families || []).join("+") || "unclassified"}@${
              entry.transaction?.type ||
              entry.moveHistory?.[0]?.type ||
              "unknown"
            }`),
        )].sort(),
      };
    }
    artifact.packageExtraction = {
      packageSchemaVersion: artifact.packageExtraction.packageSchemaVersion,
      extractorVersion: artifact.packageExtraction.extractorVersion,
      treeDataHash: artifact.packageExtraction.treeDataHash,
      treeVersion: artifact.packageExtraction.treeVersion,
      candidateCanonicalKey:
        artifact.packageExtraction.candidateCanonicalKey,
      counts: artifact.packageExtraction.counts,
      packageCount: artifact.packageExtraction.packages.length,
      unknownStatLineCount:
        artifact.packageExtraction.unknownStatLines.length,
      unknownStatLineSample:
        artifact.packageExtraction.unknownStatLines.slice(0, 25),
      uncertainPackageCount:
        artifact.packageExtraction.uncertainPackageCount,
    };
    const evaluationCandidates =
      artifact.search.calibrationPool || artifact.search.archive;
    const evaluationLimit = args.mediumRebuild
      ? args.explicit.evaluationLimit
        ? Math.max(0, Math.floor(args.evaluationLimit))
        : preset.evaluationLimit
      : Math.max(0, Math.floor(args.pobLimit || 0));
    const remainingRuntimeMs = Number.isFinite(args.runtimeLimitMs)
      ? Math.max(0, args.runtimeLimitMs - (Date.now() - searchStartedAt))
      : undefined;
    if (evaluationLimit > 0 && evaluationCandidates.length > 0 && args.build) {
      const objectiveSet = loadObjectiveSet(args);
      artifact.pobEvaluation = objectiveSet.objectives.length
        ? await evaluateSelectiveCandidates({
            buildPath: args.build,
            shortlist: evaluationCandidates,
            objectiveSet,
            enemyProfile: profile,
            treeData: graph.source,
            currentRuntime: runtimeRequest(args),
            evaluationLimit,
            rescueLimit: args.rescueLimit,
            runtimeLimitMs: remainingRuntimeMs,
            batchSize: args.evaluationBatchSize,
            selectionMix: args.selectionMix,
            seed: args.seed,
            cachePath: args.cache,
            checkpointPath: args.checkpoint,
            resume: args.resume,
            nearBaselineCount: args.nearBaselineCount,
            minimumSample: args.minimumSample,
            scenario: profile.scenario,
          })
        : await evaluateCandidates({
            buildPath: args.build,
            candidates: evaluationCandidates.map(
              (entry) => entry.candidate,
            ),
            metrics: args.metrics || [],
            currentRuntime: runtimeRequest(args),
            count: evaluationLimit,
            cachePath: args.cache,
            runtimeLimitMs: remainingRuntimeMs,
            scenario: profile.scenario,
          });
    }
  }

  const output = args.output || defaultOutput(args);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(artifact, null, 2)}\n`);
  const summary = buildStageSummary(artifact, {
    maxCandidates: args.summaryMaxCandidates,
    maxFailures: args.summaryMaxFailures,
  });
  if (args.summary) {
    fs.mkdirSync(path.dirname(args.summary), { recursive: true });
    fs.writeFileSync(args.summary, `${JSON.stringify(summary, null, 2)}\n`);
  }
  if (args.stdoutMode !== "silent") {
    process.stdout.write(
      `${JSON.stringify(
        args.stdoutMode === "debug"
          ? artifact
          : artifact.search
            ? summary
            : compactResult(artifact, output, args.limit),
        null,
        2,
      )}\n`,
    );
  }
  if (!validation.valid) process.exitCode = 2;
  if (artifact.score?.status === "invalid") process.exitCode = 2;
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
