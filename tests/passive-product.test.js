"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  packageRelevance,
} = require("../scripts/lib/passive-optimizer/mechanic-relevance");
const {
  scenarioFromValidatedBaseline,
} = require("../scripts/lib/passive-optimizer/scenario");
const {
  normalizeObjectiveSet,
  representativeRealPareto,
  selectCalibrationCandidates,
} = require("../scripts/lib/passive-optimizer/selective-evaluation");
const {
  parseStatLines,
} = require("../scripts/lib/passive-optimizer/stat-taxonomy");

function shortlistEntry(key, changedNodeCount, score, calibrationKind) {
  return {
    canonicalKey: key,
    changedNodeCount,
    rankScore: score,
    calibrationKind,
    candidate: { canonicalKey: key, allocatedNodeIds: [] },
  };
}

test("trusted refresh scenario is required and tied to the imported build", () => {
  const baseline = {
    trusted: true,
    file: { sha256: "same" },
    config: {
      enemyLevel: 85,
      enemyEvasion: 996,
      enemyArmour: 6355,
      resistancePenalty: -60,
      enemyDistance: 20,
    },
  };
  assert.deepEqual(
    scenarioFromValidatedBaseline(baseline, { sha256: "same" }),
    baseline.config,
  );
  assert.throws(
    () => scenarioFromValidatedBaseline(
      { ...baseline, trusted: false },
      { sha256: "same" },
    ),
    /trusted refresh-build baseline/,
  );
  assert.throws(
    () => scenarioFromValidatedBaseline(baseline, { sha256: "different" }),
    /does not match imported build/,
  );
  const { enemyDistance, ...incompleteConfig } = baseline.config;
  assert.equal(enemyDistance, 20);
  assert.throws(
    () => scenarioFromValidatedBaseline({
      ...baseline,
      config: incompleteConfig,
    }, { sha256: "same" }),
    /enemyDistance/,
  );
});

test("small calibration budgets reserve a concept-sized candidate", () => {
  const selected = selectCalibrationCandidates({
    shortlist: [
      shortlistEntry("baseline", 0, 0, "baseline"),
      shortlistEntry("near", 1, 100, "near-baseline"),
      shortlistEntry("concept", 20, 10, "medium-rebuild"),
    ],
    limit: 3,
    nearBaselineCount: 2,
  });
  assert.deepEqual(
    selected.selected.map((entry) => entry.canonicalKey),
    ["baseline", "concept", "near"],
  );
  assert.equal(selected.mandatory.targetSearchIncluded, true);
});

test("crossbow builds reject shield and melee-only totem packages", () => {
  const profile = {
    activeMechanics: ["crossbow", "projectile", "totem"],
    mechanicPreferences: { crossbow: "required", totem: "preferred" },
  };
  function relevance(line) {
    const stats = parseStatLines([line]);
    return packageRelevance({
      normalizedTags: stats.normalizedTags,
      stats,
      needsPoB: stats.needsPoB,
      uncertainty: stats.uncertainty,
    }, profile);
  }
  assert.equal(relevance("20% increased Shield Damage").accepted, false);
  assert.equal(
    relevance("Melee Attack Skills have +1 to maximum number of Summoned Totems")
      .accepted,
    false,
  );
  assert.equal(relevance("20% increased Crossbow Damage").accepted, true);
});

test("unknown mechanics stay eligible for exact revalidation", () => {
  const stats = parseStatLines(["Nearby moon phases empower your attacks"]);
  const result = packageRelevance({
    normalizedTags: stats.normalizedTags,
    stats,
    needsPoB: true,
    uncertainty: "high",
  }, {
    activeMechanics: ["crossbow"],
    mechanicPreferences: { crossbow: "required" },
  });
  assert.equal(result.accepted, true);
  assert.equal(result.reason, "NEEDS_POB_REVALIDATION");
});

test("representatives never invent a winner without measured upside", () => {
  const objectives = normalizeObjectiveSet({
    objectives: [
      { name: "damage", field: "TotalDPS", role: "damage" },
      { name: "life", field: "Life", role: "life" },
    ],
  });
  const representatives = representativeRealPareto([
    {
      canonicalKey: "equal",
      status: "success",
      calibrationKind: "candidate",
      objectives: { damage: 100, life: 100 },
      candidateSummary: { respecCost: 1 },
    },
    {
      canonicalKey: "worse",
      status: "success",
      calibrationKind: "candidate",
      objectives: { damage: 90, life: 90 },
      candidateSummary: { respecCost: 1 },
    },
    {
      canonicalKey: "bad-tradeoff",
      status: "success",
      calibrationKind: "candidate",
      objectives: { damage: 70, life: 101 },
      candidateSummary: { respecCost: 1 },
    },
  ], objectives, { damage: 100, life: 100 });
  assert.deepEqual(representatives, []);
});
