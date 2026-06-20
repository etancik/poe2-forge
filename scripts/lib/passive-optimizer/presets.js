"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { stableStringify } = require("./stable");

const PRESET_PATH = path.resolve(
  __dirname,
  "../../../data/passive-optimizer-search-presets-v1.json",
);

function loadPresetConfig(file = PRESET_PATH) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function selectAdaptivePreset(benchmark, config = loadPresetConfig()) {
  const repair = Number(
    benchmark?.candidatesPerSecond?.repair ??
      benchmark?.stageThroughput?.repair?.candidatesPerSecond,
  );
  const exact = Number(
    benchmark?.pob?.persistentEvaluationsPerSecond ??
      benchmark?.pob?.persistentEvaluation?.evaluationsPerSecond,
  );
  if (
    Number.isFinite(repair) &&
    Number.isFinite(exact) &&
    repair <= config.selection.slow.maximumRepairCandidatesPerSecond &&
    exact <= config.selection.slow.maximumExactEvaluationsPerSecond
  ) {
    return "slow";
  }
  if (
    Number.isFinite(repair) &&
    Number.isFinite(exact) &&
    repair >= config.selection.fast.minimumRepairCandidatesPerSecond &&
    exact >= config.selection.fast.minimumExactEvaluationsPerSecond
  ) {
    return "fast";
  }
  return config.selection.fallback;
}

function resolveSearchPreset({
  name = "auto",
  benchmark,
  runtimeLimitMs,
  evaluationLimit,
  config = loadPresetConfig(),
}) {
  const selected = name === "auto"
    ? selectAdaptivePreset(benchmark, config)
    : name;
  if (!config.presets[selected]) {
    throw new Error(
      `Unknown preset ${name}; expected auto, ${Object.keys(config.presets).join(", ")}`,
    );
  }
  const preset = { ...config.presets[selected] };
  const exactRate = Number(
    benchmark?.pob?.persistentEvaluationsPerSecond ??
      benchmark?.pob?.persistentEvaluation?.evaluationsPerSecond ??
      0,
  );
  const runtimeSeconds = Number.isFinite(Number(runtimeLimitMs))
    ? Math.max(0, Number(runtimeLimitMs)) / 1000
    : null;
  const runtimeEvaluationCapacity = runtimeSeconds === null
    ? null
    : Math.floor(exactRate * runtimeSeconds);
  const fractionCapacity = runtimeEvaluationCapacity === null
    ? preset.minimumEvaluations
    : Math.max(
        preset.minimumEvaluations,
        Math.floor(runtimeEvaluationCapacity * preset.evaluationFraction),
      );
  const explicitEvaluationLimit = Number.isFinite(Number(evaluationLimit))
    ? Math.max(0, Math.floor(Number(evaluationLimit)))
    : null;
  const plannedEvaluations = explicitEvaluationLimit === null
    ? fractionCapacity
    : runtimeEvaluationCapacity === null
      ? explicitEvaluationLimit
      : Math.min(explicitEvaluationLimit, runtimeEvaluationCapacity);
  return {
    presetSchemaVersion: config.presetSchemaVersion,
    selected,
    requested: name,
    ...preset,
    runtimeLimitMs:
      runtimeSeconds === null ? null : Math.floor(runtimeSeconds * 1000),
    evaluationLimit: plannedEvaluations,
    runtimeEvaluationCapacity,
  };
}

function deterministicBenchmarkPlan({
  packageIds,
  seed = 0,
  sampleSize = 64,
}) {
  const { sha256 } = require("./stable");
  return [...new Set(packageIds || [])]
    .sort((left, right) =>
      sha256(`${seed}:${left}`).localeCompare(sha256(`${seed}:${right}`)) ||
      left.localeCompare(right),
    )
    .slice(0, Math.max(0, Number(sampleSize) || 0));
}

function benchmarkFingerprint(report) {
  const { sha256 } = require("./stable");
  return sha256(stableStringify({
    benchmarkVersion: report.benchmarkVersion,
    pipeline: report.pipeline,
    packages: report.packages ?? report.packageExtraction?.count,
    candidatesPerSecond: report.candidatesPerSecond,
    rates: report.rates,
    pob: report.pob,
    cheapScoreQuality: report.cheapScoreQuality,
    estimatedCapacities: report.estimatedCapacities,
  }));
}

module.exports = {
  PRESET_PATH,
  benchmarkFingerprint,
  deterministicBenchmarkPlan,
  loadPresetConfig,
  resolveSearchPreset,
  selectAdaptivePreset,
};
