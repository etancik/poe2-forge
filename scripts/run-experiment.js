#!/usr/bin/env node
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { PobClient, readJson, resolveRuntime } = require("./lib/pob-client");

function usage() {
  throw new Error(
    "Usage: node run-experiment.js <spec.json> [--output file] [--raw file] [--full-stdout] [--quiet]",
  );
}

function parseArgs(argv) {
  if (!argv[2]) usage();
  const args = { spec: path.resolve(argv[2]) };
  for (let i = 3; i < argv.length; i += 1) {
    if (argv[i] === "--output") args.output = path.resolve(argv[++i] || usage());
    else if (argv[i] === "--raw") args.raw = path.resolve(argv[++i] || usage());
    else if (argv[i] === "--full-stdout") args.fullStdout = true;
    else if (argv[i] === "--quiet") args.quiet = true;
    else usage();
  }
  return args;
}

function budgetFor(spec) {
  const count = (spec.variants || []).length;
  if (spec.exhaustive || count > 25) return "large";
  if (spec.filteredScan || count > 5) return "medium";
  return "small";
}

function getPath(value, dotted) {
  return dotted.split(".").reduce((current, key) => {
    if (current == null) return undefined;
    return current[key];
  }, value);
}

function assertOne(root, assertion) {
  const actual = getPath(root, assertion.path);
  const expected = assertion.value;
  const operations = {
    equals: () => actual === expected,
    notEquals: () => actual !== expected,
    includes: () =>
      (Array.isArray(actual) || typeof actual === "string") &&
      actual.includes(expected),
    notIncludes: () =>
      (Array.isArray(actual) || typeof actual === "string") &&
      !actual.includes(expected),
    gte: () => Number(actual) >= Number(expected),
    lte: () => Number(actual) <= Number(expected),
    exists: () => actual !== undefined && actual !== null,
  };
  const test = operations[assertion.op || "equals"];
  if (!test) throw new Error(`Unknown assertion op: ${assertion.op}`);
  return {
    ...assertion,
    actual,
    passed: Boolean(test()),
  };
}

function numericDeltas(baseline, value) {
  const deltas = {};
  for (const [key, current] of Object.entries(value)) {
    if (key === "_meta" || typeof current !== "number") continue;
    const base = baseline[key];
    if (typeof base !== "number") continue;
    deltas[key] = {
      absolute: current - base,
      percent: base === 0 ? null : ((current - base) / Math.abs(base)) * 100,
    };
  }
  return deltas;
}

function compactExperimentSummary(summary, spec) {
  const preferredMetrics = [
    ...(spec.summaryMetrics || []),
    spec.sort?.metric,
    "TotalEHP",
    "Life",
    "TotalDPS",
    "PhysicalMaximumHitTaken",
    "LightningMaximumHitTaken",
    "ChaosMaximumHitTaken",
  ].filter(Boolean);
  const metrics = [...new Set(preferredMetrics)].slice(0, 6);
  const round = (value) =>
    typeof value === "number" ? Number(value.toFixed(2)) : value;
  const stdoutTopN = Math.max(1, Number(spec.stdoutTopN) || 3);
  return {
    ok: summary.ok,
    name: summary.name,
    budget: summary.budget,
    variantCount: summary.variantCount,
    scenarioValid: summary.scenarioValid,
    baseline: Object.fromEntries(
      metrics
        .filter((metric) => summary.baseline[metric] !== undefined)
        .map((metric) => [metric, round(summary.baseline[metric])]),
    ),
    top: summary.variants.slice(0, stdoutTopN).map((variant) => ({
      id: variant.id,
      valid: variant.valid,
      stats: Object.fromEntries(
        metrics
          .filter((metric) => variant.stats[metric] !== undefined)
          .map((metric) => [metric, round(variant.stats[metric])]),
      ),
      deltaPercent: Object.fromEntries(
        metrics
          .filter((metric) => variant.deltas[metric] !== undefined)
          .map((metric) => [
            metric,
            round(variant.deltas[metric].percent),
          ]),
      ),
    })),
    omittedFromStdout: Math.max(
      0,
      summary.variantCount - Math.min(stdoutTopN, summary.variants.length),
    ),
    output: summary.output,
  };
}

async function applyActions(client, actions, actionLog) {
  for (const entry of actions || []) {
    const response = await client.call(entry.action, entry.params || {});
    const checks = (entry.expect || []).map((item) => assertOne(response, item));
    actionLog.push({ action: entry.action, checks });
    if (checks.some((item) => !item.passed)) {
      throw new Error(`Action assertion failed for ${entry.action}`);
    }
  }
}

async function snapshot(client, metrics, sections) {
  const result = {};
  if (sections.includes("stats")) {
    result.stats = (await client.call("get_stats", { fields: metrics })).stats;
  }
  if (sections.includes("info")) {
    result.info = (await client.call("get_build_info")).info;
  }
  if (sections.includes("config")) {
    result.config = (await client.call("get_config")).config;
  }
  if (sections.includes("tree")) {
    result.tree = (await client.call("get_tree")).tree;
  }
  if (sections.includes("items")) {
    result.items = (await client.call("get_items")).items;
  }
  if (sections.includes("skills")) {
    result.skills = (await client.call("get_skills")).skills;
  }
  return result;
}

async function main() {
  const args = parseArgs(process.argv);
  const spec = readJson(args.spec);
  if (!spec.build || !Array.isArray(spec.metrics)) {
    throw new Error("Spec requires build and metrics");
  }
  const budget = budgetFor(spec);
  if (budget !== "small" && spec.approved !== true) {
    const preflight = {
      ok: false,
      requiresApproval: true,
      name: spec.name || path.basename(args.spec),
      scope: spec.scope || "focused",
      budget,
      variantCount: (spec.variants || []).length,
      metrics: spec.metrics,
    };
    process.stdout.write(`${JSON.stringify(preflight, null, 2)}\n`);
    process.exitCode = 3;
    return;
  }

  const buildPath = path.resolve(spec.build);
  const buildBytes = fs.readFileSync(buildPath);
  const runtime = resolveRuntime(spec.currentRuntime);
  const client = new PobClient(runtime);
  const sections = Array.from(
    new Set(["stats", "info", "config", ...(spec.inspect || []), "tree"]),
  );
  const raw = [];
  try {
    const ready = await client.ready();
    await client.loadBuild(buildPath, spec.xmlScenario);
    await applyActions(client, spec.scenarioActions, []);
    const baseline = await snapshot(client, spec.metrics, sections);
    const expectedEnemyLevel = spec.xmlScenario?.placeholders?.enemyLevel;
    const scenarioValidation = [];
    if (expectedEnemyLevel !== undefined) {
      scenarioValidation.push({
        field: "enemyLevel",
        expected: Number(expectedEnemyLevel),
        actual: Number(baseline.config?.enemyLevel),
        passed:
          Number(baseline.config?.enemyLevel) === Number(expectedEnemyLevel),
      });
    }
    const scenarioValid = scenarioValidation.every((item) => item.passed);

    const variants = [];
    for (const variant of spec.variants || []) {
      await client.loadBuild(buildPath, spec.xmlScenario);
      const actionLog = [];
      await applyActions(client, spec.scenarioActions, actionLog);
      await applyActions(client, variant.actions, actionLog);
      const measured = await snapshot(client, spec.metrics, sections);
      const checks = (variant.assertions || []).map((item) =>
        assertOne(measured, item),
      );
      variants.push({
        id: variant.id,
        label: variant.label || variant.id,
        valid: scenarioValid && checks.every((item) => item.passed),
        checks,
        mode: "mutated-build",
        stats: measured.stats,
        deltas: numericDeltas(baseline.stats, measured.stats),
      });
      raw.push({ variant: variant.id, actionLog, measured });
    }

    const sort = spec.sort || {};
    if (sort.metric) {
      const direction = sort.direction === "asc" ? 1 : -1;
      variants.sort(
        (a, b) =>
          direction *
          ((Number(a.stats[sort.metric]) || 0) -
            (Number(b.stats[sort.metric]) || 0)),
      );
    }
    const topN = Math.max(1, Number(spec.topN) || variants.length || 1);
    const summary = {
      ok: true,
      name: spec.name || path.basename(args.spec),
      scope: spec.scope || "focused",
      budget,
      variantCount: variants.length,
      build: {
        file: path.basename(buildPath),
        sha256: crypto.createHash("sha256").update(buildBytes).digest("hex"),
      },
      runtime: {
        version: runtime.version,
        apiVersion: runtime.apiVersion,
        apiPatchVersion: runtime.apiPatchVersion,
        ready: ready.version,
      },
      baseline: baseline.stats,
      effectiveConfig: baseline.config,
      scenarioValidation,
      scenarioValid,
      variants: variants.slice(0, topN),
      omittedVariants: Math.max(0, variants.length - topN),
      output: args.output ? path.basename(args.output) : null,
    };
    const text = `${JSON.stringify(summary, null, 2)}\n`;
    if (args.output) {
      fs.mkdirSync(path.dirname(args.output), { recursive: true });
      fs.writeFileSync(args.output, text);
    }
    if (!args.quiet) {
      const stdoutValue = args.fullStdout
        ? summary
        : compactExperimentSummary(summary, spec);
      process.stdout.write(`${JSON.stringify(stdoutValue, null, 2)}\n`);
    }
    if (args.raw) {
      fs.mkdirSync(path.dirname(args.raw), { recursive: true });
      fs.writeFileSync(
        args.raw,
        `${JSON.stringify({ baseline, variants: raw }, null, 2)}\n`,
      );
    }
  } finally {
    await client.close();
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
