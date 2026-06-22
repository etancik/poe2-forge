"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { withCandidateKey } = require(
  "../scripts/lib/passive-optimizer/model",
);
const {
  cacheKeyFor,
  evaluateSelectiveCandidates,
  extractObjectives,
  normalizeObjectiveSet,
  objectiveEvidence,
  realParetoArchive,
  representativeRealPareto,
  scorerDiagnostics,
  scorerQualityGate,
  selectCalibrationCandidates,
  selectRescueCandidates,
  structuralBucket,
} = require(
  "../scripts/lib/passive-optimizer/selective-evaluation",
);
const { stableStringify } = require(
  "../scripts/lib/passive-optimizer/stable",
);

function candidate(id = 0) {
  return withCandidateKey({
    treeDataHash: "a".repeat(64),
    treeVersion: "test",
    classId: 1,
    className: "Test",
    classStart: 1,
    primaryAscendancy: null,
    secondaryAscendancy: null,
    allocatedNodeIds: id ? [1, id] : [1],
    freeStartNodeIds: [1],
    weaponSetAllocations: {},
    attributeOverrides: {},
    switchableOverrides: {},
    multipleChoiceSelections: {},
    masterySelections: {},
    jewelState: {},
    budgets: {
      ordinary: 20,
      primaryAscendancy: 0,
      secondaryAscendancy: 0,
      weaponSets: {},
      total: 20,
      respec: 20,
    },
    requiredNodeIds: [],
    forbiddenNodeIds: [],
    generatedNodeIds: [],
    importedPobIdentity: {
      file: "Build.xml",
      sha256: "b".repeat(64),
      name: "Build",
    },
    configRelevantState: {},
  });
}

function entry(id, rankScore, overrides = {}) {
  const value = candidate(id);
  const changed = id ? 1 : 0;
  return {
    canonicalKey: value.canonicalKey,
    candidate: value,
    scorerVersion: 2,
    buildProfileSchemaVersion: 2,
    profileVersion: 1,
    profileId: "test",
    rankScore,
    changedNodeCount: changed,
    changedNodeIds: id ? [id] : [],
    calibrationKind: id ? "candidate" : "baseline",
    cheapPruned: false,
    families: ["damage.crossbow"],
    components: { uncertainty: 0 },
    objectives: { uncertainty: 0, respecCost: changed },
    costs: {
      marginal: { add: changed, remove: 0 },
      respec: changed,
    },
    delta: {
      addNodeIds: id ? [id] : [],
      removeNodeIds: [],
    },
    ...overrides,
  };
}

const SIMPLE_OBJECTIVES = normalizeObjectiveSet({
  name: "simple",
  version: 1,
  objectives: [
    { name: "damage", field: "TotalDPS", direction: "max", role: "damage" },
    { name: "life", field: "Life", direction: "max", role: "defense.life" },
  ],
});

const PERFORMANCE_AND_COST_OBJECTIVES = normalizeObjectiveSet({
  name: "performance-and-cost",
  version: 1,
  objectives: [
    { name: "damage", field: "TotalDPS", direction: "max", role: "damage" },
    { name: "life", field: "Life", direction: "max", role: "defense.life" },
    {
      name: "point_cost",
      field: "pointCost",
      source: "candidate",
      direction: "min",
      role: "cost.points",
    },
    {
      name: "respec_cost",
      field: "respecCost",
      source: "candidate",
      direction: "min",
      role: "cost.respec",
    },
  ],
});

test("performance evidence does not let point and respec costs reverse an upgrade", () => {
  assert.deepEqual(
    PERFORMANCE_AND_COST_OBJECTIVES.objectives.map((objective) => [
      objective.name,
      objective.kind,
    ]),
    [
      ["damage", "performance"],
      ["life", "performance"],
      ["point_cost", "cost"],
      ["respec_cost", "cost"],
    ],
  );
  const evidence = objectiveEvidence({
    canonicalKey: "upgrade",
    status: "success",
    objectives: {
      damage: 107,
      life: 1000,
      point_cost: 3,
      respec_cost: 1,
    },
  }, {
    damage: 100,
    life: 1000,
    point_cost: 0,
    respec_cost: 0,
  }, PERFORMANCE_AND_COST_OBJECTIVES);

  assert.equal(evidence.performanceComparison, "dominates_baseline");
  assert.ok(evidence.performanceUtility > 0);
  assert.deepEqual(evidence.costs, {
    point_cost: 3,
    respec_cost: 1,
  });
  assert.equal(evidence.baselineComparison, "dominates_baseline");
  assert.equal(evidence.normalizedUtility, evidence.performanceUtility);

  const regression = objectiveEvidence({
    canonicalKey: "regression",
    status: "success",
    objectives: {
      damage: 95,
      life: 1000,
      point_cost: 0,
      respec_cost: 0,
    },
  }, {
    damage: 100,
    life: 1000,
    point_cost: 0,
    respec_cost: 0,
  }, PERFORMANCE_AND_COST_OBJECTIVES);
  assert.equal(regression.performanceComparison, "dominated_by_baseline");
  assert.ok(regression.performanceUtility < 0);

  const archive = realParetoArchive([
    {
      canonicalKey: "baseline",
      status: "success",
      objectives: {
        damage: 100,
        life: 1000,
        point_cost: 0,
        respec_cost: 0,
      },
    },
    {
      canonicalKey: "upgrade",
      status: "success",
      objectives: {
        damage: 107,
        life: 1000,
        point_cost: 3,
        respec_cost: 1,
      },
    },
  ], PERFORMANCE_AND_COST_OBJECTIVES);
  assert.deepEqual(archive.map((entry) => entry.canonicalKey), ["upgrade"]);
});

test("scorer diagnostics calibrate against performance utility instead of costs", () => {
  const baseline = entry(0, 0);
  const stronger = entry(2, 10, {
    costs: { marginal: { add: 3, remove: 0 }, respec: 1 },
  });
  const weaker = entry(3, 5, {
    costs: { marginal: { add: 0, remove: 0 }, respec: 0 },
  });
  const diagnostics = scorerDiagnostics({
    shortlist: [baseline, stronger, weaker],
    results: [
      {
        canonicalKey: baseline.canonicalKey,
        status: "success",
        objectives: {
          damage: 100,
          life: 1000,
          point_cost: 0,
          respec_cost: 0,
        },
      },
      {
        canonicalKey: stronger.canonicalKey,
        status: "success",
        objectives: {
          damage: 107,
          life: 1000,
          point_cost: 3,
          respec_cost: 1,
        },
      },
      {
        canonicalKey: weaker.canonicalKey,
        status: "success",
        objectives: {
          damage: 103,
          life: 1000,
          point_cost: 0,
          respec_cost: 0,
        },
      },
    ],
    baselineObjectives: {
      damage: 100,
      life: 1000,
      point_cost: 0,
      respec_cost: 0,
    },
    objectiveSet: PERFORMANCE_AND_COST_OBJECTIVES,
    cheapParetoKeys: [
      baseline.canonicalKey,
      stronger.canonicalKey,
      weaker.canonicalKey,
    ],
    pobCalls: 2,
    minimumSample: 2,
  });

  assert.equal(diagnostics.cheapVsPobSpearman, 1);
  assert.equal(diagnostics.realImprovements, 2);
  assert.equal(diagnostics.realRegressions, 0);
});

test("structural buckets merge IDs but separate role, move, and size", () => {
  const damageA = entry(2, 10, {
    changedNodeCount: 3,
    families: [
      "damage.attack@travel_corridor:123.456",
      "role.projectile@terminal_connector:456.789",
    ],
    moveHistory: [{ type: "reroute", packageIds: ["pkg-a"] }],
  });
  const damageB = entry(3, 9, {
    changedNodeCount: 4,
    families: [
      "damage.crossbow@travel_corridor:900.901",
      "role.projectile@terminal_connector:901.902",
    ],
    moveHistory: [{ type: "reroute", packageIds: ["pkg-b"] }],
  });
  const defense = entry(4, 8, {
    changedNodeCount: 3,
    families: ["defense@travel_corridor:123.456"],
    moveHistory: [{ type: "reroute", packageIds: ["pkg-c"] }],
  });
  const add = entry(5, 7, {
    changedNodeCount: 3,
    families: ["damage.attack@travel_corridor:123.456"],
    moveHistory: [{ type: "add", packageIds: ["pkg-d"] }],
  });
  const larger = entry(6, 6, {
    changedNodeCount: 5,
    families: ["damage.attack@travel_corridor:123.456"],
    moveHistory: [{ type: "reroute", packageIds: ["pkg-e"] }],
  });

  assert.equal(structuralBucket(damageA), structuralBucket(damageB));
  assert.notEqual(structuralBucket(damageA), structuralBucket(defense));
  assert.notEqual(structuralBucket(damageA), structuralBucket(add));
  assert.notEqual(structuralBucket(damageA), structuralBucket(larger));
  assert.equal(structuralBucket(damageA), "damage@reroute@3-4");
  assert.doesNotMatch(structuralBucket(damageA), /123|456|789|900|901|902|pkg/);
});

test("calibration tiers keep one-to-two changes adjacent and larger moves ordinary", () => {
  const shortlist = [
    entry(0, 0),
    entry(2, 4, { changedNodeCount: 1 }),
    entry(3, 3, { changedNodeCount: 2 }),
    entry(4, 2, { changedNodeCount: 3 }),
    entry(5, 1, { changedNodeCount: 4 }),
  ];
  const selection = selectCalibrationCandidates({
    shortlist,
    limit: shortlist.length,
    nearBaselineCount: 2,
    mix: { predictedBest: 1 },
  });
  const tiers = Object.fromEntries(selection.selected.map((value) => [
    value.changedNodeCount,
    value.calibrationTier,
  ]));

  assert.deepEqual(tiers, {
    0: "baseline",
    1: "adjacent",
    2: "adjacent",
    3: "ordinary",
    4: "ordinary",
  });
  assert.equal(selection.mandatory.nearBaselineAvailable, 2);
});

test("calibration always includes baseline and near-baseline probes", () => {
  const shortlist = [
    entry(0, 0),
    entry(2, 8, { calibrationKind: "near-baseline" }),
    entry(3, 7, { calibrationKind: "near-baseline" }),
    entry(4, 100, { changedNodeCount: 20, cheapRank: 1 }),
    entry(5, 50, {
      changedNodeCount: 22,
      cheapRank: 2,
      cheapPruned: true,
      families: ["defense.life"],
    }),
    entry(6, -10, {
      changedNodeCount: 24,
      cheapRank: 3,
      cheapPruned: true,
      objectives: { uncertainty: 4, respecCost: 12 },
      families: ["role.totem"],
    }),
  ];
  const first = selectCalibrationCandidates({
    shortlist,
    limit: 6,
    seed: 42,
    nearBaselineCount: 2,
  });
  const second = selectCalibrationCandidates({
    shortlist,
    limit: 6,
    seed: 42,
    nearBaselineCount: 2,
  });
  assert.equal(stableStringify(first), stableStringify(second));
  assert.equal(first.mandatory.baselineIncluded, true);
  assert.equal(first.mandatory.nearBaselineIncluded, 2);
  assert.ok(first.selected.some((value) => value.cheapPruned));
  assert.ok(first.selected.some((value) =>
    value.selectionReasons.includes("structuralRole")));
  assert.ok(first.selected.some((value) =>
    value.selectionReasons.includes("cheapRank")));
});

test("cheap-pruned audit finds hidden improvements and warns on small samples", () => {
  const baseline = entry(0, 0);
  const pruned = entry(2, -5, { cheapPruned: true });
  const regular = entry(3, 5);
  const diagnostics = scorerDiagnostics({
    shortlist: [baseline, pruned, regular],
    results: [
      {
        canonicalKey: baseline.canonicalKey,
        status: "success",
        objectives: { damage: 100, life: 100 },
      },
      {
        canonicalKey: pruned.canonicalKey,
        status: "success",
        objectives: { damage: 110, life: 105 },
      },
      {
        canonicalKey: regular.canonicalKey,
        status: "success",
        objectives: { damage: 90, life: 95 },
      },
    ],
    baselineObjectives: { damage: 100, life: 100 },
    objectiveSet: SIMPLE_OBJECTIVES,
    cheapParetoKeys: [baseline.canonicalKey, regular.canonicalKey],
    pobCalls: 2,
    minimumSample: 8,
  });
  assert.equal(diagnostics.falseNegativePruning.count, 1);
  assert.equal(diagnostics.falseNegativePruning.audited, 1);
  assert.ok(diagnostics.falseNegativePruning.confidenceInterval);
  assert.ok(diagnostics.warnings.some(
    (warning) => warning.code === "MINIMUM_SAMPLE_NOT_MET",
  ));
  assert.equal(diagnostics.limitationDiagnosis.primary, "insufficient_sample");
});

test("false-negative reporting exposes unaudited coverage instead of a global zero", () => {
  const baseline = entry(0, 0);
  const pruned = Array.from({ length: 100 }, (_, index) =>
    entry(index + 10, 100 - index, { cheapPruned: true }));
  const audited = pruned.slice(0, 10).map((value) => ({
    canonicalKey: value.canonicalKey,
    status: "success",
    objectives: { damage: 100, life: 100 },
  }));
  const diagnostics = scorerDiagnostics({
    shortlist: [baseline, ...pruned],
    results: [
      {
        canonicalKey: baseline.canonicalKey,
        status: "success",
        objectives: { damage: 100, life: 100 },
      },
      ...audited,
    ],
    baselineObjectives: { damage: 100, life: 100 },
    objectiveSet: SIMPLE_OBJECTIVES,
    cheapParetoKeys: [baseline.canonicalKey],
    pobCalls: 10,
    minimumSample: 8,
  });

  assert.equal(diagnostics.falseNegativePruning.auditedCheapPruned, 10);
  assert.equal(diagnostics.falseNegativePruning.unevaluatedCheapPruned, 90);
  assert.equal(diagnostics.falseNegativePruning.coverage, 0.1);
  assert.equal(diagnostics.falseNegativePruning.scope, "audited_sample");
  assert.equal(diagnostics.falseNegativePruning.globalRate, null);
  assert.equal(diagnostics.falseNegativePruning.confidence, "low");
  assert.ok(diagnostics.warnings.some(
    (warning) => warning.code === "CHEAP_PRUNED_AUDIT_COVERAGE_LOW",
  ));
});

test("rescue selection is deterministic, distinct, stratified, and capped", () => {
  const shortlist = Array.from({ length: 12 }, (_, index) =>
    entry(index + 10, 100 - index, {
      changedNodeCount: index % 4 + 1,
      cheapPruned: index % 2 === 0,
      needsPoB: index % 3 === 0,
      objectives: {
        uncertainty: index,
        respecCost: index % 4,
      },
      families: index % 2
        ? ["defense@travel_corridor:100.200"]
        : ["damage.attack@travel_corridor:300.400"],
      moveHistory: [{ type: index % 3 ? "add" : "reroute" }],
    }));
  const excluded = shortlist.slice(0, 4).map((value) => value.canonicalKey);
  const first = selectRescueCandidates({
    shortlist,
    excludedKeys: excluded,
    limit: 5,
    seed: 42,
  });
  const second = selectRescueCandidates({
    shortlist,
    excludedKeys: excluded,
    limit: 5,
    seed: 42,
  });

  assert.equal(stableStringify(first), stableStringify(second));
  assert.equal(first.selected.length, 5);
  assert.equal(new Set(first.selected.map((value) => value.canonicalKey)).size, 5);
  assert.ok(first.selected.every((value) =>
    !excluded.includes(value.canonicalKey)));
  assert.ok(new Set(first.selected.map((value) => value.structuralBucket)).size > 1);
  assert.ok(first.selected.some((value) => value.cheapPruned));
  assert.ok(first.selected.every((value) => value.evaluationPhase === "rescue"));
});

test("quality gate requests rescue for a weak sample and remains explicit", () => {
  const failed = scorerQualityGate({
    evaluatedPairs: 10,
    topK: 5,
    topKRecall: 0.4,
    cheapVsPobSpearmanConfidenceInterval: { low: -0.5, high: 0.1 },
    falseNegativePruning: { count: 0 },
  }, {
    minimumSample: 8,
    minimumTopKRecall: 0.6,
  });
  assert.equal(failed.passed, false);
  assert.deepEqual(failed.reasons, ["top_k_recall", "rank_correlation"]);

  const passed = scorerQualityGate({
    evaluatedPairs: 10,
    topK: 5,
    topKRecall: 0.8,
    cheapVsPobSpearmanConfidenceInterval: { low: -0.2, high: 0.5 },
    falseNegativePruning: { count: 0 },
  }, {
    minimumSample: 8,
    minimumTopKRecall: 0.6,
  });
  assert.equal(passed.passed, true);

  const falseNegative = scorerQualityGate({
    evaluatedPairs: 10,
    topK: 5,
    topKRecall: 0.8,
    cheapVsPobSpearmanConfidenceInterval: { low: 0.2, high: 0.8 },
    falseNegativePruning: {
      count: 1,
      totalCheapPruned: 10,
      confidence: "moderate",
    },
  }, {
    minimumSample: 8,
    minimumTopKRecall: 0.6,
  });
  assert.equal(falseNegative.passed, false);
  assert.deepEqual(falseNegative.reasons, ["false_negatives"]);
});

test("objective extraction selects configured skills and derives costs", async () => {
  let selectedGroup = 1;
  let selectedActive = 1;
  const calls = [];
  const client = {
    async call(action, params) {
      calls.push({ action, params });
      if (action === "set_main_selection") {
        selectedGroup = params.mainSocketGroup;
        selectedActive = params.mainActiveSkill;
        return {};
      }
      if (action === "get_stats") {
        const source = selectedGroup === 2 && selectedActive === 2
          ? { TotalDPS: 250, ActiveTotemLimit: 3, TotemPlacementTime: 0.42 }
          : selectedGroup === 2
            ? { TotalDPS: 0, ActiveTotemLimit: 3, TotemPlacementTime: 0.42 }
          : { TotalDPS: 400, HitChance: 96, Life: 1000 };
        return {
          stats: Object.fromEntries(
            params.fields
              .filter((field) => field in source)
              .map((field) => [field, source[field]]),
          ),
        };
      }
      throw new Error(action);
    },
  };
  const objectives = normalizeObjectiveSet({
    objectives: [
      {
        name: "crossbow_damage",
        field: "TotalDPS",
        skill: "Crossbow Shot",
        role: "damage.crossbow",
      },
      {
        name: "crossbow_accuracy",
        field: "HitChance",
        skill: "Crossbow Shot",
        role: "accuracy",
      },
      {
        name: "ballista_damage",
        field: "TotalDPS",
        skill: {
          names: ["Ballista Bolt", "Artillery Ballista"],
        },
        role: "damage.ballista",
      },
      {
        name: "totem_limit",
        field: "ActiveTotemLimit",
        skill: "Ballista",
        role: "totem.limit",
      },
      {
        name: "point_cost",
        field: "pointCost",
        source: "candidate",
        direction: "min",
      },
    ],
  });
  const measured = await extractObjectives({
    client,
    skills: {
      mainSocketGroup: 1,
      groups: [
        {
          index: 1,
          mainActiveSkill: 1,
          skills: ["Crossbow Shot"],
          gems: [{ name: "Crossbow Shot" }],
        },
        {
          index: 2,
          mainActiveSkill: 1,
          skills: ["Artillery Ballista", "Ballista Bolt"],
          gems: [{ name: "Artillery Ballista" }],
        },
      ],
    },
    objectiveSet: objectives,
    entry: entry(2, 1),
  });
  assert.deepEqual(measured.metrics, {
    ballista_damage: 250,
    crossbow_accuracy: 96,
    crossbow_damage: 400,
    point_cost: 1,
    totem_limit: 3,
  });
  assert.equal(measured.missingRequired.length, 0);
  assert.ok(calls.some((call) =>
    call.action === "set_main_selection" &&
    call.params.mainSocketGroup === 2));
});

test("scorer and profile versions invalidate exact-evaluation cache keys", () => {
  const value = entry(2, 1);
  const base = {
    candidate: value.candidate,
    scoring: {
      scorerVersion: 2,
      buildProfileSchemaVersion: 2,
      profileVersion: 1,
      profileId: "test",
    },
    buildHash: "build",
    baseline: {
      info: {},
      config: {},
      items: [],
      skills: { mainSocketGroup: 1, groups: [] },
    },
    runtime: {
      version: "runtime",
      apiVersion: 2,
      apiPatchVersion: 4,
      runtime: "fake",
    },
    objectiveSet: SIMPLE_OBJECTIVES,
    enemyProfile: {},
    treeData: { hash: "tree", treeVersion: "test" },
  };
  const original = cacheKeyFor(base);
  assert.notEqual(cacheKeyFor({
    ...base,
    scoring: { ...base.scoring, scorerVersion: 3 },
  }), original);
  assert.notEqual(cacheKeyFor({
    ...base,
    scoring: { ...base.scoring, profileVersion: 2 },
  }), original);
});

test("representative selection emits all six build-specific roles", () => {
  const objectives = normalizeObjectiveSet({
    objectives: [
      { name: "damage", field: "TotalDPS", role: "damage.crossbow" },
      { name: "life", field: "Life", role: "defense.life" },
      { name: "accuracy", field: "HitChance", role: "accuracy" },
      { name: "recovery", field: "LifeRegenRecovery", role: "recovery" },
      { name: "totem", field: "ActiveTotemLimit", role: "totem.limit" },
      {
        name: "respec_cost",
        field: "respecCost",
        source: "candidate",
        direction: "min",
        role: "cost.respec",
      },
    ],
  });
  const results = [
    {
      canonicalKey: "damage",
      status: "success",
      calibrationKind: "candidate",
      objectives: {
        damage: 150, life: 100, accuracy: 90, recovery: 0, totem: 1,
        respec_cost: 5,
      },
      candidateSummary: { respecCost: 5, uncertainty: 0 },
    },
    {
      canonicalKey: "tank",
      status: "success",
      calibrationKind: "candidate",
      objectives: {
        damage: 100, life: 150, accuracy: 95, recovery: 10, totem: 1,
        respec_cost: 2,
      },
      candidateSummary: { respecCost: 2, uncertainty: 0 },
    },
    {
      canonicalKey: "totem",
      status: "success",
      calibrationKind: "candidate",
      objectives: {
        damage: 110, life: 110, accuracy: 92, recovery: 5, totem: 3,
        respec_cost: 8,
      },
      candidateSummary: { respecCost: 8, uncertainty: 4 },
    },
  ];
  const representatives = representativeRealPareto(
    results,
    objectives,
    {
      damage: 100,
      life: 100,
      accuracy: 90,
      recovery: 0,
      totem: 1,
      respec_cost: 0,
    },
  );
  const labels = new Set(
    representatives.flatMap((value) => value.representativeLabels),
  );
  assert.deepEqual([...labels].sort(), [
    "accuracy_recovery_fix",
    "balanced",
    "damage",
    "experimental_totem",
    "low_respec",
    "tanky",
  ]);
});

test("calibration evaluation restores baseline and leaves build hash unchanged", async () => {
  const root = path.join(os.tmpdir(), `poe2-forge-slice6-${process.pid}`);
  fs.mkdirSync(root, { recursive: true });
  const buildPath = path.join(root, "Build.xml");
  const xml = "<PathOfBuilding><Build level=\"90\"/></PathOfBuilding>";
  fs.writeFileSync(buildPath, xml);
  const baseline = entry(0, 0);
  const near = entry(2, 1, { calibrationKind: "near-baseline" });
  const snapshot = {
    info: {
      className: "Test",
      ascendClassName: null,
      level: 90,
      treeVersion: "test",
    },
    tree: {
      classId: 1,
      ascendClassId: 0,
      secondaryAscendClassId: 0,
      treeVersion: "test",
      nodes: [1],
      masteryEffects: [],
    },
    config: {},
    items: [],
    skills: {
      mainSocketGroup: 1,
      groups: [{
        index: 1,
        enabled: true,
        mainActiveSkill: 1,
        skills: ["Skill"],
        gems: [{ name: "Skill", enabled: true }],
      }],
    },
  };
  const clientFactory = () => {
    let tree = snapshot.tree;
    return {
      async ready() {},
      async loadXml() {
        tree = snapshot.tree;
      },
      async call(action, params) {
        if (action === "set_tree") throw new Error("set_tree must not be called");
        if (action === "calc_with_stats") return { stats: {} };
        if (action === "get_tree") return { tree };
        if (action === "get_build_info") return { info: snapshot.info };
        if (action === "get_config") return { config: snapshot.config };
        if (action === "get_items") return { items: snapshot.items };
        if (action === "get_skills") return { skills: snapshot.skills };
        if (action === "get_stats") {
          return { stats: { Life: 1000, TotalEHP: 2000 } };
        }
        throw new Error(action);
      },
      async close() {},
    };
  };
  const result = await evaluateSelectiveCandidates({
    buildPath,
    shortlist: [baseline, near],
    objectiveSet: normalizeObjectiveSet({
      objectives: [{
        name: "point_cost",
        field: "pointCost",
        source: "candidate",
        direction: "min",
      }],
    }),
    enemyProfile: {},
    treeData: { hash: "tree", treeVersion: "test" },
    runtimeMeta: {
      version: "test",
      apiVersion: 2,
      apiPatchVersion: 4,
      runtime: "fake",
    },
    clientFactory,
    evaluationLimit: 2,
    nearBaselineCount: 1,
    minimumSample: 2,
  });
  assert.equal(result.selection.mandatory.baselineIncluded, true);
  assert.equal(result.selection.mandatory.nearBaselineIncluded, 1);
  assert.equal(result.baseline.finalBaselineRestored, true);
  assert.equal(result.baseline.buildUnchanged, true);
  assert.equal(fs.readFileSync(buildPath, "utf8"), xml);
  fs.rmSync(root, { recursive: true, force: true });
});
