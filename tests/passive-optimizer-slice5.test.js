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
  normalizeObjectiveSet,
  realParetoArchive,
  selectPobCandidates,
} = require(
  "../scripts/lib/passive-optimizer/selective-evaluation",
);
const { stableStringify } = require(
  "../scripts/lib/passive-optimizer/stable",
);

const OBJECTIVE_SET = normalizeObjectiveSet({
  name: "offense-defense",
  version: 1,
  objectives: [
    { name: "dps", field: "TotalDPS", direction: "max" },
    { name: "life", field: "Life", direction: "max" },
  ],
});

function candidateFixture(id = 0, overrides = {}) {
  return withCandidateKey({
    treeDataHash: "a".repeat(64),
    treeVersion: "test",
    classId: 1,
    className: "TestClass",
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
      respec: 30,
    },
    requiredNodeIds: [],
    forbiddenNodeIds: [],
    generatedNodeIds: [],
    importedPobIdentity: {
      file: "TestBuild.xml",
      sha256: "b".repeat(64),
      name: "TestBuild",
    },
    configRelevantState: { enemyLevel: 80 },
    ...overrides,
  });
}

function shortlistEntry(id, rankScore, cheap = rankScore, overrides = {}) {
  const candidate = candidateFixture(id);
  return {
    canonicalKey: candidate.canonicalKey,
    candidate,
    rankScore,
    status: overrides.status || "valid",
    needsPoB: Boolean(overrides.needsPoB),
    changedNodeIds: id ? [id] : [],
    changedNodeCount: id ? 1 : 0,
    families: overrides.families || [`family-${id % 3}`],
    components: {
      offense: cheap,
      defense: cheap,
      accuracy: 0,
      recovery: 0,
      mobility: 0,
      resource: 0,
      travel: 0,
      synergy: 0,
      uncertainty: overrides.uncertainty || 0,
      exploration: overrides.exploration || 0,
    },
    objectives: {
      offense: cheap,
      defense: cheap,
      accuracy: cheap,
      recovery: cheap,
      mobilityResources: cheap,
      travelEfficiency: cheap,
      respecCost: 1,
      uncertainty: overrides.uncertainty || 0,
    },
    ...overrides,
  };
}

function baselineSnapshot() {
  return {
    info: {
      className: "TestClass",
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
    config: { enemyLevel: 80 },
    items: [{ slot: "Weapon 1", name: "Crossbow", baseName: "Crossbow", active: true }],
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
}

function runtimeMeta(overrides = {}) {
  return {
    version: "test-runtime",
    apiVersion: 2,
    apiPatchVersion: 4,
    runtime: "fake-runtime",
    ...overrides,
  };
}

function fakeClientFactory({
  metricsByNode = {},
  timeoutNode = null,
  failureNode = null,
  driftNode = null,
  counters = {},
} = {}) {
  return () => {
    let tree = null;
    let lastNode = 1;
    function reset() {
      tree = {
        classId: 1,
        ascendClassId: 0,
        secondaryAscendClassId: 0,
        treeVersion: "test",
        nodes: [1],
        masteryEffects: [],
      };
      lastNode = 1;
    }
    reset();
    return new class FakeClient {
      async ready() {
        counters.ready = (counters.ready || 0) + 1;
      }
      async loadXml() {
        counters.loads = (counters.loads || 0) + 1;
        reset();
      }
      async call(action, params) {
        if (action === "set_tree") {
          throw new Error("set_tree must not be called");
        }
        if (action === "calc_with_stats") {
          const node = Math.max(1, ...(params.addNodes || []));
          lastNode = node;
          counters.calcWithStats = (counters.calcWithStats || 0) + 1;
          if (node === timeoutNode) {
            throw new Error("PoB2 response timed out after 10 ms");
          }
          if (node === failureNode) {
            throw new Error("calc_with_stats: synthetic failure");
          }
          return {
            stats: metricsByNode[node] || { TotalDPS: 100, Life: 100 },
          };
        }
        if (action === "get_tree") return { tree };
        if (action === "get_build_info") {
          return { info: baselineSnapshot().info };
        }
        if (action === "get_config") {
          return {
            config: lastNode === driftNode
              ? { enemyLevel: 84 }
              : baselineSnapshot().config,
          };
        }
        if (action === "get_items") {
          return { items: baselineSnapshot().items };
        }
        if (action === "get_skills") {
          return { skills: baselineSnapshot().skills };
        }
        if (action === "get_stats") {
          return {
            stats: { TotalDPS: 100, Life: 100, TotalEHP: 200 },
          };
        }
        throw new Error(action);
      }
      async close() {
        counters.close = (counters.close || 0) + 1;
      }
    }();
  };
}

function temporaryFiles(name) {
  const root = path.join(os.tmpdir(), `poe2-forge-${name}-${process.pid}`);
  fs.mkdirSync(root, { recursive: true });
  const buildPath = path.join(root, "TestBuild.xml");
  fs.writeFileSync(buildPath, "<PathOfBuilding><Build level=\"90\"/></PathOfBuilding>");
  return {
    root,
    buildPath,
    cachePath: path.join(root, "cache.json"),
    checkpointPath: path.join(root, "checkpoint.json"),
  };
}

test("selective PoB mix is deterministic across all five sources", () => {
  const shortlist = Array.from({ length: 10 }, (_, index) =>
    shortlistEntry(
      index + 10,
      100 - index,
      10 - index,
      {
        uncertainty: index,
        needsPoB: index % 2 === 0,
        exploration: index / 10,
      },
    ));
  const first = selectPobCandidates({
    shortlist,
    limit: 10,
    seed: 42,
  });
  const second = selectPobCandidates({
    shortlist,
    limit: 10,
    seed: 42,
  });
  assert.equal(stableStringify(first), stableStringify(second));
  assert.deepEqual(first.allocation, {
    predictedBest: 4,
    highUncertainty: 2,
    structurallyDiverse: 2,
    incumbentAdjacent: 1,
    randomSanity: 1,
  });
  assert.equal(first.selected.length, 10);
  for (const source of Object.keys(first.allocation)) {
    assert.ok(
      first.selected.some((entry) => entry.selectionReasons.includes(source)),
      source,
    );
  }
});

test("complete cache key invalidates every authoritative identity layer", () => {
  const candidate = candidateFixture(10);
  const base = {
    candidate,
    buildHash: "build-a",
    baseline: baselineSnapshot(),
    runtime: runtimeMeta(),
    objectiveSet: OBJECTIVE_SET,
    enemyProfile: { enemy: "boss", level: 82 },
    treeData: { hash: "tree-a", treeVersion: "test", schemaVersion: 1 },
  };
  const original = cacheKeyFor(base);
  const variants = [
    { ...base, candidate: candidateFixture(11) },
    { ...base, buildHash: "build-b" },
    {
      ...base,
      baseline: {
        ...base.baseline,
        items: [{ ...base.baseline.items[0], name: "Different Crossbow" }],
      },
    },
    {
      ...base,
      baseline: {
        ...base.baseline,
        skills: { ...base.baseline.skills, mainSocketGroup: 2 },
      },
    },
    {
      ...base,
      candidate: candidateFixture(10, {
        jewelState: { 10: { itemId: 1, name: "Jewel", active: true } },
      }),
    },
    {
      ...base,
      candidate: candidateFixture(10, {
        masterySelections: { 10: 99 },
      }),
    },
    {
      ...base,
      candidate: candidateFixture(10, {
        configRelevantState: { enemyLevel: 84 },
      }),
    },
    { ...base, enemyProfile: { enemy: "boss", level: 84 } },
    { ...base, treeData: { ...base.treeData, hash: "tree-b" } },
    { ...base, runtime: runtimeMeta({ apiPatchVersion: 5 }) },
    {
      ...base,
      objectiveSet: normalizeObjectiveSet({
        ...OBJECTIVE_SET,
        version: 2,
      }),
    },
  ];
  for (const variant of variants) {
    assert.notEqual(cacheKeyFor(variant), original);
  }
});

test("checkpoint resume is idempotent and does not repeat candidate jobs", async () => {
  const files = temporaryFiles("resume");
  const shortlist = [
    shortlistEntry(10, 3),
    shortlistEntry(20, 2),
  ];
  const firstCounters = {};
  const options = {
    buildPath: files.buildPath,
    shortlist,
    objectiveSet: OBJECTIVE_SET,
    enemyProfile: { enemy: "boss" },
    treeData: { hash: "tree-a", treeVersion: "test" },
    runtimeMeta: runtimeMeta(),
    evaluationLimit: 2,
    batchSize: 1,
    selectionMix: { predictedBest: 1 },
    checkpointPath: files.checkpointPath,
  };
  const first = await evaluateSelectiveCandidates({
    ...options,
    clientFactory: fakeClientFactory({ counters: firstCounters }),
  });
  assert.equal(first.budget.pobCalls, 2);
  assert.equal(first.accepted, 2);
  const resumedCounters = {};
  const resumed = await evaluateSelectiveCandidates({
    ...options,
    resume: true,
    clientFactory: fakeClientFactory({ counters: resumedCounters }),
  });
  assert.equal(resumed.budget.pobCalls, 0);
  assert.equal(resumed.resumed, 2);
  assert.equal(resumedCounters.calcWithStats || 0, 0);
  fs.rmSync(files.root, { recursive: true, force: true });
});

test("timeout, failure, and drift are rejected from the real archive", async () => {
  const files = temporaryFiles("rejection");
  const result = await evaluateSelectiveCandidates({
    buildPath: files.buildPath,
    shortlist: [
      shortlistEntry(10, 3),
      shortlistEntry(20, 2),
      shortlistEntry(30, 1),
    ],
    objectiveSet: OBJECTIVE_SET,
    enemyProfile: { enemy: "boss" },
    treeData: { hash: "tree-a", treeVersion: "test" },
    runtimeMeta: runtimeMeta(),
    clientFactory: fakeClientFactory({
      timeoutNode: 10,
      failureNode: 20,
      driftNode: 30,
    }),
    evaluationLimit: 3,
    selectionMix: { predictedBest: 1 },
  });
  assert.equal(result.timeouts, 1);
  assert.equal(result.failures, 1);
  assert.equal(result.drifted, 1);
  assert.equal(result.accepted, 0);
  assert.equal(result.realArchive.candidates.length, 0);
  fs.rmSync(files.root, { recursive: true, force: true });
});

test("real Pareto updates remain separate from cheap dominance", async () => {
  const files = temporaryFiles("pareto");
  const candidateA = shortlistEntry(10, 2, 0);
  const candidateB = shortlistEntry(20, 1, 0);
  const cheapWinner = shortlistEntry(30, 3, 10);
  const result = await evaluateSelectiveCandidates({
    buildPath: files.buildPath,
    shortlist: [cheapWinner, candidateA, candidateB],
    objectiveSet: OBJECTIVE_SET,
    enemyProfile: { enemy: "boss" },
    treeData: { hash: "tree-a", treeVersion: "test" },
    runtimeMeta: runtimeMeta(),
    clientFactory: fakeClientFactory({
      metricsByNode: {
        10: { TotalDPS: 120, Life: 100 },
        20: { TotalDPS: 100, Life: 120 },
        30: { TotalDPS: 90, Life: 90 },
      },
    }),
    evaluationLimit: 3,
    selectionMix: { predictedBest: 1 },
  });
  assert.deepEqual(result.cheapArchive.canonicalKeys, [cheapWinner.canonicalKey]);
  assert.deepEqual(
    result.realArchive.candidates.map((entry) => entry.canonicalKey).sort(),
    [candidateA.canonicalKey, candidateB.canonicalKey].sort(),
  );
  assert.equal(result.diagnostics.falseNegativePruning.count, 2);
  assert.equal(result.diagnostics.realImprovements, 2);
  assert.equal(result.baseline.finalBaselineRestored, true);
  assert.equal(result.baseline.buildUnchanged, true);
  fs.rmSync(files.root, { recursive: true, force: true });
});

test("adaptive rescue expands a failed initial sample without exceeding hard cap", async () => {
  const files = temporaryFiles("adaptive-rescue");
  const baseline = shortlistEntry(0, 1000, 0, {
    calibrationKind: "baseline",
    calibrationTier: "baseline",
    cheapPruned: false,
    families: [],
  });
  const candidates = Array.from({ length: 15 }, (_, index) => {
    const node = index + 10;
    return shortlistEntry(node, 100 - index, 0, {
      calibrationKind: index < 2 ? "near-baseline" : "candidate",
      calibrationTier: index < 2 ? "adjacent" : "ordinary",
      changedNodeCount: index < 2 ? index + 1 : 3 + index % 2,
      cheapPruned: index >= 5,
      families: index % 2
        ? ["defense@travel_corridor:100.200"]
        : ["damage.attack@travel_corridor:300.400"],
      moveHistory: [{ type: index % 3 ? "add" : "reroute" }],
      uncertainty: index,
    });
  });
  const metricsByNode = Object.fromEntries(candidates.map((value, index) => [
    value.changedNodeIds[0],
    { TotalDPS: 90 + Math.min(index, 9), Life: 100 },
  ]));
  const result = await evaluateSelectiveCandidates({
    buildPath: files.buildPath,
    shortlist: [baseline, ...candidates],
    objectiveSet: OBJECTIVE_SET,
    enemyProfile: { enemy: "boss" },
    treeData: { hash: "tree-a", treeVersion: "test" },
    runtimeMeta: runtimeMeta(),
    clientFactory: fakeClientFactory({ metricsByNode }),
    evaluationLimit: 11,
    rescueLimit: 4,
    minimumSample: 8,
    selectionMix: { predictedBest: 1 },
    seed: 42,
  });

  assert.equal(result.adaptiveRescue.triggered, true);
  assert.equal(result.adaptiveRescue.initialGate.passed, false);
  assert.equal(result.adaptiveRescue.finalGate.passed, false);
  assert.equal(result.adaptiveRescue.confidence, "low");
  assert.equal(result.budget.initialPobCalls, 10);
  assert.equal(result.budget.rescuePobCalls, 4);
  assert.equal(result.budget.pobCalls, 14);
  assert.equal(result.budget.hardCap, 15);
  assert.equal(result.selection.rescueSelected.length, 4);
  assert.equal(new Set(result.results.map((entry) => entry.canonicalKey)).size, 15);
  assert.equal(result.diagnostics.realImprovements, 0);
  assert.equal(result.userReport.noImprovementFound, false);
  fs.rmSync(files.root, { recursive: true, force: true });
});

test("real Pareto helper rejects failed results and preserves tradeoffs", () => {
  const archive = realParetoArchive([
    {
      canonicalKey: "a",
      status: "success",
      objectives: { dps: 120, life: 100 },
    },
    {
      canonicalKey: "b",
      status: "success",
      objectives: { dps: 100, life: 120 },
    },
    {
      canonicalKey: "c",
      status: "success",
      objectives: { dps: 90, life: 90 },
    },
    {
      canonicalKey: "failed",
      status: "failure",
      objectives: { dps: 999, life: 999 },
    },
  ], OBJECTIVE_SET);
  assert.deepEqual(archive.map((entry) => entry.canonicalKey), ["a", "b"]);
});

test("repeated selective measurements are equal and never mutate baseline XML", async () => {
  const files = temporaryFiles("repeat");
  const originalXml = fs.readFileSync(files.buildPath, "utf8");
  const shortlist = [shortlistEntry(10, 1)];
  const options = {
    buildPath: files.buildPath,
    shortlist,
    objectiveSet: OBJECTIVE_SET,
    enemyProfile: { enemy: "boss" },
    treeData: { hash: "tree-a", treeVersion: "test" },
    runtimeMeta: runtimeMeta(),
    evaluationLimit: 1,
    selectionMix: { predictedBest: 1 },
  };
  const first = await evaluateSelectiveCandidates({
    ...options,
    clientFactory: fakeClientFactory({
      metricsByNode: { 10: { TotalDPS: 123, Life: 456 } },
    }),
  });
  const second = await evaluateSelectiveCandidates({
    ...options,
    clientFactory: fakeClientFactory({
      metricsByNode: { 10: { TotalDPS: 123, Life: 456 } },
    }),
  });
  assert.deepEqual(first.results[0].metrics, second.results[0].metrics);
  assert.equal(first.baseline.finalBaselineRestored, true);
  assert.equal(second.baseline.finalBaselineRestored, true);
  assert.equal(fs.readFileSync(files.buildPath, "utf8"), originalXml);
  fs.rmSync(files.root, { recursive: true, force: true });
});
