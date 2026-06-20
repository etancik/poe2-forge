"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { withCandidateKey } = require("../scripts/lib/passive-optimizer/model");
const { evaluateCandidates } = require("../scripts/lib/passive-optimizer/pob-smoke");
const {
  applyDiversityCaps,
  epsilonParetoArchive,
  makeMoves,
  repairConnectivity,
  runPackageSearch,
} = require("../scripts/lib/passive-optimizer/search");
const { parseStatLines } = require("../scripts/lib/passive-optimizer/stat-taxonomy");
const { stableStringify } = require("../scripts/lib/passive-optimizer/stable");

function node(id, adjacency, extra = {}) {
  return {
    id,
    name: `Node ${id}`,
    rawStats: [],
    stats: [],
    adjacency,
    classStarts: [],
    ascendancyId: null,
    ascendancyName: null,
    isAscendancyStart: false,
    isNotable: false,
    isKeystone: false,
    isJewelSocket: false,
    isAttribute: false,
    isOnlyImage: false,
    isSwitchable: false,
    isMultipleChoice: false,
    isMultipleChoiceOption: false,
    multipleChoiceParent: null,
    isMastery: false,
    unlockConstraint: null,
    options: [],
    group: id,
    ...extra,
  };
}

function graphFixture() {
  const nodes = new Map([
    [1, node(1, [2, 5, 6, 8, 9, 10, 11, 12, 20], { classStarts: [0] })],
    [2, node(2, [1, 3])],
    [3, node(3, [2, 4])],
    [4, node(4, [3, 5], { isNotable: true })],
    [5, node(5, [1, 4])],
    [6, node(6, [1, 7])],
    [7, node(7, [6], { isNotable: true })],
    [8, node(8, [1], { isNotable: true })],
    [9, node(9, [1], { isNotable: true })],
    [10, node(10, [1], { isNotable: true })],
    [11, node(11, [1], { isKeystone: true })],
    [12, node(12, [1], { isNotable: true })],
    [
      20,
      node(20, [1, 21], {
        ascendancyId: "A",
        ascendancyName: "Alpha",
        isAscendancyStart: true,
      }),
    ],
    [
      21,
      node(21, [20], {
        ascendancyId: "A",
        ascendancyName: "Alpha",
        isNotable: true,
      }),
    ],
  ]);
  return {
    source: { hash: "tree-hash", treeVersion: "test" },
    nodes,
    classes: [{
      classId: 0,
      name: "TestClass",
      ascendancies: [{ ascendClassId: 1, id: "A", name: "Alpha" }],
    }],
    classStarts: new Map([[0, 1]]),
    ascendancyStarts: new Map([["A", 20]]),
    articulationPoints: new Set([1, 2, 3, 6, 20]),
    landmarks: {
      classStarts: [1],
      ascendancyStarts: [20],
      notables: [4, 7, 8, 9, 10, 12, 21],
      keystones: [11],
      jewelSockets: [],
    },
    biconnectedComponents: [],
    biconnectedComponentIds: new Map(),
  };
}

function candidateFixture(extra = {}) {
  return withCandidateKey({
    treeDataHash: "tree-hash",
    treeVersion: "test",
    classId: 0,
    className: "TestClass",
    classStart: 1,
    primaryAscendancy: {
      ascendClassId: 1,
      id: "A",
      name: "Alpha",
      startNodeId: 20,
    },
    secondaryAscendancy: null,
    allocatedNodeIds: [1, 2, 3, 4, 20, 21],
    freeStartNodeIds: [1, 20],
    weaponSetAllocations: {},
    attributeOverrides: {},
    switchableOverrides: {},
    multipleChoiceSelections: {},
    masterySelections: {},
    jewelState: {},
    budgets: {
      ordinary: 7,
      primaryAscendancy: 1,
      secondaryAscendancy: 0,
      weaponSets: {},
      total: 8,
      respec: 8,
    },
    requiredNodeIds: [],
    forbiddenNodeIds: [],
    generatedNodeIds: [],
    importedPobIdentity: { name: "fixture", sha256: "build-hash" },
    configRelevantState: { enemyLevel: 80 },
    ...extra,
  });
}

function pkg(id, input = {}) {
  const stats = parseStatLines(input.lines || []);
  return {
    id,
    structuralType: input.structuralType || "notable_cluster",
    addNodeIds: input.addNodeIds || [],
    removeNodeIds: input.removeNodeIds || [],
    normalizedTags: stats.normalizedTags,
    stats,
    uncertainty: input.uncertainty || stats.uncertainty || "low",
    needsPoB: Boolean(input.needsPoB || stats.needsPoB),
    reasonCodes: input.reasonCodes || stats.reasonCodes || [],
    dependencies: input.dependencies || [],
    conflicts: input.conflicts || [],
    overlaps: [],
    context: { groups: input.groups || [1] },
    costs: {
      intrinsic: { add: 0, remove: 0, changed: 0 },
      marginal: { add: 0, remove: 0, changed: 0 },
      respec: 0,
    },
  };
}

function packageFixture() {
  return [
    pkg("active-offense", {
      addNodeIds: [2, 3, 4],
      lines: ["20% increased Crossbow Damage"],
      groups: [10],
    }),
    pkg("defense-connector", {
      structuralType: "travel_corridor",
      addNodeIds: [6],
      groups: [20],
    }),
    pkg("defense", {
      addNodeIds: [7],
      dependencies: ["defense-connector"],
      lines: ["10% increased maximum Life"],
      groups: [20],
    }),
    pkg("accuracy", {
      addNodeIds: [8],
      lines: ["+100 to Accuracy Rating"],
      groups: [30],
    }),
    pkg("recovery", {
      addNodeIds: [9],
      lines: ["10% increased Life Regeneration rate"],
      groups: [40],
    }),
    pkg("mobility", {
      addNodeIds: [10],
      lines: ["5% increased Movement Speed"],
      groups: [50],
    }),
    pkg("experimental", {
      addNodeIds: [11],
      lines: ["A strange transformed mechanic"],
      uncertainty: "high",
      needsPoB: true,
      groups: [60],
    }),
    pkg("offense-swap", {
      addNodeIds: [12],
      conflicts: ["active-offense"],
      lines: ["25% increased Crossbow Damage"],
      groups: [10],
    }),
    pkg("reroute", {
      structuralType: "bridge_reroute_patch",
      addNodeIds: [5],
      removeNodeIds: [2, 3],
      groups: [70],
    }),
  ];
}

const PROFILE = {
  id: "test",
  weaponTags: ["role.crossbow"],
  desiredTags: [
    "accuracy",
    "defense.life",
    "recovery.life",
    "mobility",
  ],
};

test("move generation covers add, remove, same-role swap, and reroute", () => {
  const moves = makeMoves(
    graphFixture(),
    candidateFixture(),
    packageFixture(),
    { maxChanges: 8, seed: 42 },
  );
  for (const type of ["add", "remove", "swap", "reroute"]) {
    assert.ok(moves.some((move) => move.type === type), type);
  }
  const defense = moves.find(
    (move) => move.type === "add" && move.packageIds.includes("defense"),
  );
  assert.ok(defense.packageIds.includes("defense-connector"));
  const conflict = moves.find(
    (move) => move.type === "add" && move.packageIds.includes("offense-swap"),
  );
  assert.ok(conflict.delta.removeNodeIds.includes(4));
});

test("safe repair reconnects ordinary nodes without changing protected state", () => {
  const graph = graphFixture();
  const incumbent = candidateFixture({
    requiredNodeIds: [4],
    jewelState: { 4: { active: true, itemId: 1 } },
  });
  const disconnected = withCandidateKey({
    ...incumbent,
    allocatedNodeIds: [1, 3, 4, 20, 21],
  });
  const repaired = repairConnectivity(graph, incumbent, disconnected, {
    maxChanges: 8,
  });
  assert.ok(repaired);
  assert.ok(repaired.candidate.allocatedNodeIds.includes(4));
  assert.deepEqual(repaired.candidate.primaryAscendancy, incumbent.primaryAscendancy);
  assert.deepEqual(repaired.candidate.jewelState, incumbent.jewelState);
  assert.deepEqual(repaired.candidate.weaponSetAllocations, incumbent.weaponSetAllocations);
});

test("search is deterministic, deduplicated, legal, budgeted, and non-mutating", () => {
  const graph = graphFixture();
  const incumbent = candidateFixture({
    jewelState: {
      11: {
        itemId: null,
        itemPbURL: null,
        name: "Inactive jewel",
        active: false,
        state: null,
      },
    },
  });
  const before = stableStringify(incumbent);
  const input = {
    graph,
    candidate: incumbent,
    packages: packageFixture(),
    profile: PROFILE,
    maxChanges: 8,
    beamWidth: 20,
    beamDepth: 3,
    resultLimit: 8,
    relevantLimit: 20,
    seed: 1234,
  };
  const first = runPackageSearch(input);
  const second = runPackageSearch(input);
  assert.equal(stableStringify(first), stableStringify(second));
  assert.equal(stableStringify(incumbent), before);
  assert.equal(
    new Set(first.archive.map((entry) => entry.canonicalKey)).size,
    first.archive.length,
  );
  for (const entry of first.archive) {
    assert.equal(entry.validation.valid, true);
    assert.ok(entry.changedNodeCount <= 8);
    assert.ok(entry.validation.counts.respec <= 8);
    assert.deepEqual(entry.candidate.jewelState, incumbent.jewelState);
    assert.deepEqual(
      entry.candidate.weaponSetAllocations,
      incumbent.weaponSetAllocations,
    );
  }
  assert.ok(first.counts.moves.add > 0);
  assert.ok(first.counts.moves.remove > 0);
  assert.ok(first.counts.moves.swap > 0);
  assert.ok(first.counts.moves.reroute > 0);
});

test("epsilon Pareto prunes only dominated validated entries", () => {
  function entry(key, offense, defense, respecCost = 1) {
    return {
      canonicalKey: key,
      rankScore: offense + defense,
      objectives: {
        offense,
        defense,
        accuracy: 0,
        recovery: 0,
        mobilityResources: 0,
        travelEfficiency: -respecCost,
        respecCost,
        uncertainty: 0,
      },
    };
  }
  const archive = epsilonParetoArchive([
    entry("a", 5, 5),
    entry("b", 3, 3, 2),
    entry("c", 7, 2),
  ], {
    offense: 0,
    defense: 0,
    accuracy: 0,
    recovery: 0,
    mobilityResources: 0,
    travelEfficiency: 0,
    respecCost: 0,
    uncertainty: 0,
  });
  assert.deepEqual(archive.map((value) => value.canonicalKey).sort(), ["a", "c"]);
});

test("diversity caps retain distant families and uncertain exploration", () => {
  const base = {
    rankScore: 1,
    status: "valid",
    components: { exploration: 0 },
    objectives: {
      offense: 1,
      defense: 0,
      accuracy: 0,
      recovery: 0,
      mobilityResources: 0,
      travelEfficiency: -1,
      respecCost: 1,
      uncertainty: 0,
    },
  };
  const selected = applyDiversityCaps([
    { ...base, canonicalKey: "a", changedNodeIds: [2], families: ["offense"] },
    { ...base, canonicalKey: "b", changedNodeIds: [2, 3], families: ["offense"] },
    {
      ...base,
      canonicalKey: "c",
      changedNodeIds: [8],
      families: ["accuracy"],
      objectives: { ...base.objectives, accuracy: 2 },
    },
    {
      ...base,
      canonicalKey: "d",
      changedNodeIds: [11],
      families: ["experimental"],
      status: "needsPoB",
      objectives: { ...base.objectives, uncertainty: 2 },
    },
  ], { limit: 3, bucketCap: 1, minimumJaccardDistance: 0.2 });
  assert.equal(selected.length, 3);
  assert.ok(selected.some((entry) => entry.canonicalKey === "c"));
  assert.ok(selected.some((entry) => entry.canonicalKey === "d"));
});

test("uncertain mechanics remain usable in the needs-PoB representative bucket", () => {
  const result = runPackageSearch({
    graph: graphFixture(),
    candidate: candidateFixture(),
    packages: packageFixture(),
    profile: PROFILE,
    maxChanges: 8,
    beamWidth: 30,
    beamDepth: 2,
    resultLimit: 10,
    relevantLimit: 20,
    seed: 7,
  });
  assert.ok(
    result.archive.some(
      (entry) =>
        entry.status === "needsPoB" &&
        entry.moveHistory.some((move) =>
          move.packageIds.includes("experimental"),
        ),
    ),
  );
  assert.ok(
    result.representatives.some((entry) =>
      entry.representativeLabels.includes("experimental_needs_pob"),
    ),
  );
});

test("optional PoB evaluation reloads baseline, verifies parity, and caches", async () => {
  const buildPath = path.join(os.tmpdir(), `slice3-${process.pid}.xml`);
  const cachePath = path.join(os.tmpdir(), `slice3-${process.pid}-cache.json`);
  fs.writeFileSync(buildPath, "<PathOfBuilding/>");
  fs.rmSync(cachePath, { force: true });
  const baseline = candidateFixture();
  const candidate = withCandidateKey({
    ...baseline,
    allocatedNodeIds: [...baseline.allocatedNodeIds, 8],
  });
  const state = {
    tree: {
      classId: baseline.classId,
      ascendClassId: 1,
      secondaryAscendClassId: 0,
      treeVersion: baseline.treeVersion,
      nodes: baseline.allocatedNodeIds,
      masteryEffects: [],
    },
    loadCount: 0,
  };
  class FakeClient {
    async ready() {}
    async loadXml() {
      state.loadCount += 1;
      state.tree = {
        classId: baseline.classId,
        ascendClassId: 1,
        secondaryAscendClassId: 0,
        treeVersion: baseline.treeVersion,
        nodes: baseline.allocatedNodeIds,
        masteryEffects: [],
      };
    }
    async call(action, params) {
      if (action === "set_tree") {
        state.tree = { ...params };
        return {};
      }
      if (action === "get_tree") return { tree: state.tree };
      if (action === "get_build_info") {
        return { info: {
          className: "TestClass",
          ascendClassName: "Alpha",
          level: 90,
          treeVersion: "test",
        } };
      }
      if (action === "get_config") return { config: { enemyLevel: 80 } };
      if (action === "get_items") return { items: [] };
      if (action === "get_skills") {
        return { skills: { mainSocketGroup: 1, groups: [] } };
      }
      if (action === "get_stats") return { stats: { TotalDPS: 123 } };
      throw new Error(action);
    }
    async close() {}
  }
  const options = {
    buildPath,
    candidates: [candidate],
    metrics: ["TotalDPS"],
    count: 1,
    cachePath,
    runtimeMeta: {
      version: "test",
      apiVersion: 2,
      apiPatchVersion: 1,
      runtime: "fake",
    },
    clientFactory: () => new FakeClient(),
  };
  const first = await evaluateCandidates(options);
  assert.equal(first.results[0].accepted, true);
  assert.deepEqual(first.results[0].metrics, { TotalDPS: 123 });
  assert.ok(state.loadCount >= 3);
  assert.deepEqual(state.tree.nodes, baseline.allocatedNodeIds);
  const loadsBeforeCache = state.loadCount;
  const second = await evaluateCandidates(options);
  assert.equal(second.cacheHits, 1);
  assert.equal(state.loadCount, loadsBeforeCache + 1);
  fs.rmSync(buildPath, { force: true });
  fs.rmSync(cachePath, { force: true });
});
