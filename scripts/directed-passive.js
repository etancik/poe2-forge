#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { PobClient, readJson, resolveRuntime } = require("./lib/pob-client");
const { applyPassiveDeltaToXml } = require("./lib/passive-xml-variant");
const { buildStateFromPob, candidateFromBuildState } = require("./lib/passive-optimizer/build-state");
const {
  effectiveScenario,
  scenarioChecks,
} = require("./lib/passive-optimizer/scenario");
const {
  extractObjectives,
  normalizeObjectiveSet,
} = require("./lib/passive-optimizer/selective-evaluation");
const { loadTreeGraph } = require("./lib/passive-optimizer/tree-importer");
const { validateCandidate } = require("./lib/passive-optimizer/validator");

const HELP = `Usage: directed-passive.js SPEC.json [options]

Options:
  --output FILE
  --current-runtime MANIFEST
  --snapshot DIR
  --config FILE
  --stdout-mode packet|silent|debug

The spec requires build, baseline, objectives, and variants. Each variant uses
addNodes/removeNodes. More than 40 variants or exhaustive work requires
"approved": true. Evaluation uses validated in-memory XML variants and never mutates the saved build.`;

function parseArgs(argv) {
  if (argv.includes("--help") || argv.includes("-h")) return { help: true };
  if (!argv[2]) throw new Error("Missing directed passive spec");
  const args = { spec: path.resolve(argv[2]), stdoutMode: "packet" };
  for (let index = 3; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--output") args.output = path.resolve(argv[++index]);
    else if (arg === "--current-runtime") args.currentRuntime = argv[++index];
    else if (arg === "--snapshot") args.snapshot = argv[++index];
    else if (arg === "--config") args.config = argv[++index];
    else if (arg === "--stdout-mode") args.stdoutMode = argv[++index];
    else if (arg === "--quiet") args.stdoutMode = "silent";
    else if (arg === "--full-stdout") args.stdoutMode = "debug";
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!["packet", "silent", "debug"].includes(args.stdoutMode)) {
    throw new Error(`Invalid stdout mode: ${args.stdoutMode}`);
  }
  return args;
}

function sortedNodes(values) {
  return [...new Set((values || []).map(Number).filter(Number.isFinite))]
    .sort((left, right) => left - right);
}

function normalizeVariant(variant) {
  return {
    id: String(variant.id || "variant"),
    label: variant.label || variant.id || "variant",
    addNodes: sortedNodes(variant.addNodes),
    removeNodes: sortedNodes(variant.removeNodes),
  };
}

function budgetFor(spec) {
  const count = (spec.variants || []).length;
  if (spec.exhaustive || count > 40) return "large";
  if (count > 12) return "medium";
  return "small";
}

function objectiveSetFor(spec) {
  if (spec.objectiveSet) return normalizeObjectiveSet(spec.objectiveSet);
  if (Array.isArray(spec.objectives)) {
    return normalizeObjectiveSet({
      name: spec.name || "directed-passive",
      version: 1,
      objectives: spec.objectives,
    });
  }
  if (Array.isArray(spec.metrics)) {
    return normalizeObjectiveSet({
      name: spec.name || "directed-passive",
      version: 1,
      objectives: spec.metrics.map((field) => ({
        name: field,
        field,
        direction: "max",
      })),
    });
  }
  throw new Error("Spec requires objectives, objectiveSet, or metrics");
}

function buildVariantCandidate(baseCandidate, variant) {
  const allocated = new Set(baseCandidate.allocatedNodeIds || []);
  for (const nodeId of variant.removeNodes) allocated.delete(nodeId);
  for (const nodeId of variant.addNodes) allocated.add(nodeId);
  return candidateFromBuildState({
    ...baseCandidate,
    allocatedNodeIds: [...allocated].sort((left, right) => left - right),
  });
}

function metricDeltas(baseline, current) {
  return Object.fromEntries(Object.entries(current || {}).flatMap(([name, value]) => {
    const before = Number(baseline?.[name]);
    const after = Number(value);
    if (!Number.isFinite(before) || !Number.isFinite(after)) return [];
    return [[name, {
      before,
      after,
      absolute: after - before,
      percent: before === 0 ? null : ((after - before) / Math.abs(before)) * 100,
    }]];
  }));
}

function scenarioXml(scenario) {
  return {
    placeholders: {
      enemyLevel: scenario.enemyLevel,
      enemyEvasion: scenario.enemyEvasion,
      enemyArmour: scenario.enemyArmour,
    },
    inputs: {
      enemyDistance: scenario.enemyDistance,
      resistancePenalty: scenario.resistancePenalty,
    },
  };
}

function compactResult(result) {
  return {
    ok: result.ok,
    name: result.name,
    budget: result.budget,
    scenarioValid: result.scenarioValid,
    baseline: result.baseline,
    candidates: result.candidates.slice(0, 5).map((entry) => ({
      id: entry.id,
      valid: entry.valid,
      addNodes: entry.addNodes,
      removeNodes: entry.removeNodes,
      deltas: entry.deltas,
      errors: entry.errors,
    })),
    omittedCandidates: Math.max(0, result.candidates.length - 5),
    integrity: result.integrity,
    artifact: result.artifact,
  };
}

async function main(argv = process.argv) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(`${HELP}\n`);
    return 0;
  }
  const spec = readJson(args.spec);
  const budget = budgetFor(spec);
  if (budget === "large" && spec.approved !== true) {
    if (args.stdoutMode !== "silent") {
      process.stdout.write(`${JSON.stringify({
        ok: false,
        requiresApproval: true,
        budget,
        variantCount: (spec.variants || []).length,
      })}\n`);
    }
    return 3;
  }
  if (!spec.build || !spec.baseline || !Array.isArray(spec.variants)) {
    throw new Error("Spec requires build, baseline, and variants");
  }
  const buildPath = path.resolve(path.dirname(args.spec), spec.build);
  const baselinePath = path.resolve(path.dirname(args.spec), spec.baseline);
  const buildBytes = fs.readFileSync(buildPath);
  const buildHash = crypto.createHash("sha256").update(buildBytes).digest("hex");
  const baselineArtifact = readJson(baselinePath);
  if (!baselineArtifact.trusted || baselineArtifact.file?.sha256 !== buildHash) {
    throw new Error("Trusted baseline does not match the directed build");
  }
  const scenario = baselineArtifact.config;
  const objectiveSet = objectiveSetFor(spec);
  const graph = loadTreeGraph(args.snapshot || spec.treeSnapshot, {
    configPath: args.config || spec.config,
  });
  const xml = buildBytes.toString("utf8");
  const baseState = buildStateFromPob({
    graph,
    tree: baselineArtifact.tree,
    info: baselineArtifact.info,
    xml,
    buildPath,
    config: scenario,
  });
  const baseCandidate = candidateFromBuildState(baseState);
  const variants = spec.variants.map(normalizeVariant);
  const runtime = resolveRuntime(args.currentRuntime || spec.currentRuntime);
  const client = new PobClient(runtime);
  const candidates = [];
  let baselineMeasurement;
  let finalBaselineMeasurement;
  const measureXml = async (xmlText, label) => {
    await client.loadXml(xmlText, label);
    await client.call("set_config", scenario);
    const effective = effectiveScenario((await client.call("get_config")).config);
    const validation = scenarioChecks(scenario, effective);
    if (validation.some((entry) => !entry.passed)) {
      throw new Error(`Directed passive scenario drift: ${label}`);
    }
    const skills = (await client.call("get_skills")).skills;
    const tree = (await client.call("get_tree")).tree;
    const report = await extractObjectives({
      client,
      skills,
      objectiveSet,
      entry: null,
    });
    return { report, tree, scenarioValidation: validation };
  };
  try {
    await client.ready();
    baselineMeasurement = await measureXml(xml, "Directed Passive Baseline");
    if (baselineMeasurement.report.missingRequired.length) {
      throw new Error(
        `Baseline objectives missing: ${baselineMeasurement.report.missingRequired.join(", ")}`,
      );
    }
    for (const variant of variants) {
      const candidate = buildVariantCandidate(baseCandidate, variant);
      const validation = validateCandidate(graph, candidate, {
        baselineAllocatedNodeIds: baseCandidate.allocatedNodeIds,
      });
      if (!validation.valid) {
        candidates.push({
          ...variant,
          valid: false,
          errors: validation.errors.map((entry) => entry.code),
          deltas: {},
        });
        continue;
      }
      const variantXml = applyPassiveDeltaToXml(xml, variant);
      const measurement = await measureXml(variantXml, `Directed Passive ${variant.id}`);
      const actual = new Set((measurement.tree.nodes || []).map(Number));
      const mutationValid =
        variant.addNodes.every((nodeId) => actual.has(nodeId)) &&
        variant.removeNodes.every((nodeId) => !actual.has(nodeId));
      const errors = [
        ...measurement.report.missingRequired,
        ...(mutationValid ? [] : ["TREE_DELTA_MISMATCH"]),
      ];
      candidates.push({
        ...variant,
        valid: errors.length === 0,
        errors,
        objectives: measurement.report.metrics,
        deltas: metricDeltas(
          baselineMeasurement.report.metrics,
          measurement.report.metrics,
        ),
        validation: {
          status: validation.status,
          points: validation.counts.total,
          respec: validation.counts.respec,
        },
      });
    }
    finalBaselineMeasurement = await measureXml(xml, "Directed Passive Restore");
  } finally {
    await client.close();
  }  const buildUnchanged = crypto.createHash("sha256")
    .update(fs.readFileSync(buildPath)).digest("hex") === buildHash;
  const result = {
    ok: true,
    name: spec.name || path.basename(args.spec, path.extname(args.spec)),
    budget,
    build: { file: buildPath, sha256: buildHash },
    scenario,
    scenarioValid: baselineMeasurement.scenarioValidation.every((entry) => entry.passed),
    baseline: baselineMeasurement.report.metrics,
    candidates,
    integrity: {
      buildUnchanged,
      treeUnchanged: JSON.stringify(baselineMeasurement.tree.nodes) === JSON.stringify(finalBaselineMeasurement.tree.nodes),
      baselineRestored:
        JSON.stringify(baselineMeasurement.report.metrics) === JSON.stringify(finalBaselineMeasurement.report.metrics),
    },
    runtime: {
      version: runtime.version,
      apiVersion: runtime.apiVersion,
      apiPatchVersion: runtime.apiPatchVersion,
    },
  };
  const output = args.output || path.join(
    process.cwd(),
    "artifacts",
    `directed-${result.name.replace(/[^a-z0-9_-]+/gi, "-").toLowerCase()}.json`,
  );
  result.artifact = output;
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`);
  if (args.stdoutMode !== "silent") {
    const value = args.stdoutMode === "debug" ? result : compactResult(result);
    process.stdout.write(`${JSON.stringify(value)}\n`);
  }
  return 0;
}

if (require.main === module) {
  main().then((code) => {
    process.exitCode = code;
  }).catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  budgetFor,
  buildVariantCandidate,
  metricDeltas,
  normalizeVariant,
  parseArgs,
};
