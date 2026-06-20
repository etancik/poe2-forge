"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { withCandidateKey } = require("../scripts/lib/passive-optimizer/model");
const {
  articulationBranches,
  createTransactionSpecs,
  executeMediumTransaction,
  runMediumRebuildSearch,
} = require("../scripts/lib/passive-optimizer/medium-search");
const { evaluateCandidates } = require("../scripts/lib/passive-optimizer/pob-smoke");
const {
  deterministicBenchmarkPlan,
  resolveSearchPreset,
  selectAdaptivePreset,
} = require("../scripts/lib/passive-optimizer/presets");
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
    group: id < 20 ? 1 : 2,
    ...extra,
  };
}

function graphFixture() {
  const nodes = new Map();
  const addChain = (ids, root) => {
    ids.forEach((id, index) => {
      const previous = index === 0 ? root : ids[index - 1];
      const next = index === ids.length - 1 ? null : ids[index + 1];
      nodes.set(id, node(id, [previous, ...(next ? [next] : [])], {
        isNotable: index === ids.length - 1,
      }));
    });
  };
  nodes.set(1, node(1, [2, 20], { classStarts: [0] }));
  addChain(Array.from({ length: 12 }, (_, index) => index + 2), 1);
  addChain(Array.from({ length: 12 }, (_, index) => index + 20), 1);
  return {
    source: { hash: "tree-hash", treeVersion: "test" },
    nodes,
    classes: [{ classId: 0, name: "TestClass", ascendancies: [] }],
    classStarts: new Map([[0, 1]]),
    ascendancyStarts: new Map(),
    articulationPoints: new Set([
      1,
      ...Array.from({ length: 11 }, (_, index) => index + 2),
      ...Array.from({ length: 11 }, (_, index) => index + 20),
    ]),
    landmarks: {
      classStarts: [1],
      ascendancyStarts: [],
      notables: [13, 31],
      keystones: [],
      jewelSockets: [],
    },
    biconnectedComponents: [
      [1, 2], [2, 3], [3, 4], [4, 5], [5, 6], [6, 7],
      [7, 8], [8, 9], [9, 10], [10, 11], [11, 12], [12, 13],
      [1, 20], [20, 21], [21, 22], [22, 23], [23, 24], [24, 25],
      [25, 26], [26, 27], [27, 28], [28, 29], [29, 30], [30, 31],
    ],
    biconnectedComponentIds: new Map(
      Array.from(nodes.keys(), (id) => [
        id,
        id === 1 ? [0, 12] : [id < 20 ? id - 2 : id - 8],
      ]),
    ),
  };
}

function candidateFixture(extra = {}) {
  return withCandidateKey({
    treeDataHash: "tree-hash",
    treeVersion: "test",
    classId: 0,
    className: "TestClass",
    classStart: 1,
    primaryAscendancy: null,
    secondaryAscendancy: null,
    allocatedNodeIds: [1, ...Array.from({ length: 12 }, (_, index) => index + 2)],
    freeStartNodeIds: [1],
    weaponSetAllocations: {},
    attributeOverrides: {},
    switchableOverrides: {},
    multipleChoiceSelections: {},
    masterySelections: {},
    jewelState: {},
    budgets: {
      ordinary: 12,
      primaryAscendancy: 0,
      secondaryAscendancy: 0,
      weaponSets: {},
      total: 12,
      respec: 30,
    },
    requiredNodeIds: [],
    forbiddenNodeIds: [],
    generatedNodeIds: [],
    importedPobIdentity: { name: "fixture", sha256: "build-hash" },
    configRelevantState: {},
    ...extra,
  });
}

function pkg(id, addNodeIds, extra = {}) {
  return {
    id,
    structuralType: "notable_cluster",
    addNodeIds,
    removeNodeIds: [],
    coreNodeIds: [addNodeIds.at(-1)],
    terminalLandmarkIds: [addNodeIds.at(-1)],
    normalizedTags: ["damage.crossbow"],
    stats: {
      normalizedTags: ["damage.crossbow"],
      tagMagnitudes: { "damage.crossbow": 20 },
      unknownLines: [],
    },
    uncertainty: "low",
    needsPoB: false,
    reasonCodes: [],
    dependencies: [],
    conflicts: [],
    overlaps: [],
    context: {
      groups: [extra.group ?? 1],
      componentIds: extra.componentIds || [],
    },
    scopes: { tree: "ordinary" },
    costs: {},
  };
}

function packagesFixture() {
  return [
    pkg("old-cluster", Array.from({ length: 12 }, (_, index) => index + 2), {
      group: 1,
      componentIds: [0],
    }),
    pkg("remote-cluster", Array.from({ length: 12 }, (_, index) => index + 20), {
      group: 2,
      componentIds: [12],
    }),
  ];
}

const PROFILE = {
  id: "slice4",
  weaponTags: ["damage.crossbow"],
  desiredTags: ["damage.crossbow"],
};

test("benchmark sampling and preset selection are deterministic", () => {
  const ids = ["c", "a", "b", "d"];
  assert.deepEqual(
    deterministicBenchmarkPlan({ packageIds: ids, seed: 42, sampleSize: 3 }),
    deterministicBenchmarkPlan({ packageIds: [...ids].reverse(), seed: 42, sampleSize: 3 }),
  );
  const measured = {
    candidatesPerSecond: { repair: 778.7754 },
    pob: { persistentEvaluationsPerSecond: 1.428 },
  };
  assert.equal(selectAdaptivePreset(measured), "moderate");
  const first = resolveSearchPreset({
    name: "auto",
    benchmark: measured,
    runtimeLimitMs: 60000,
  });
  const second = resolveSearchPreset({
    name: "auto",
    benchmark: measured,
    runtimeLimitMs: 60000,
  });
  assert.deepEqual(first, second);
  assert.equal(first.evaluationLimit, 10);
});

test("articulation branch removal protects required terminals", () => {
  const graph = graphFixture();
  const removable = articulationBranches(graph, candidateFixture());
  assert.ok(removable.some((branch) => branch.removeNodeIds.includes(13)));
  const protectedCandidate = candidateFixture({ requiredNodeIds: [13] });
  const protectedBranches = articulationBranches(graph, protectedCandidate);
  assert.ok(!protectedBranches.some((branch) => branch.removeNodeIds.includes(13)));
});

test("transaction rollback preserves the complete incumbent", () => {
  const graph = graphFixture();
  const incumbent = candidateFixture({ requiredNodeIds: [13] });
  const before = stableStringify(incumbent);
  const result = executeMediumTransaction({
    graph,
    incumbent,
    spec: {
      type: "remove_articulation_branch",
      branch: {
        articulationId: 1,
        removeNodeIds: Array.from({ length: 12 }, (_, index) => index + 2),
      },
    },
  });
  assert.equal(result.committed, false);
  assert.equal(result.reason, "PROTECTED_NODE_REMOVAL");
  assert.equal(stableStringify(result.candidate), before);
});

test("grow-then-trim uses a temporary point bank and commits a legal final tree", () => {
  const graph = graphFixture();
  const incumbent = candidateFixture();
  const specs = createTransactionSpecs({
    graph,
    candidate: incumbent,
    packages: packagesFixture(),
    profile: PROFILE,
    branchLimit: 4,
    remotePackageLimit: 10,
    transactionLimit: 100,
    maxChanges: 30,
  });
  const spec = specs.find((entry) =>
    entry.type === "replace_equivalent_cluster" ||
    entry.type === "add_remote_branch",
  );
  for (const type of [
    "remove_articulation_branch",
    "add_remote_branch",
    "replace_equivalent_cluster",
    "reroute_biconnected_components",
    "prune_dead_travel",
  ]) {
    assert.ok(specs.some((entry) => entry.type === type), type);
  }
  assert.ok(spec);
  const result = executeMediumTransaction({
    graph,
    incumbent,
    spec,
    minChanges: 20,
    maxChanges: 30,
  });
  assert.equal(result.committed, true, result.reason);
  assert.equal(result.changed, 24);
  assert.equal(result.temporaryPointBank, 12);
  assert.equal(result.peakPointOverage, 12);
  assert.equal(result.validation.valid, true);
  assert.equal(result.validation.counts.totalPoints, 12);
  assert.ok(result.candidate.allocatedNodeIds.includes(31));
  assert.ok(!result.candidate.allocatedNodeIds.includes(13));
});

test("medium search is reproducible and enforces strict final budgets", () => {
  const input = {
    graph: graphFixture(),
    candidate: candidateFixture(),
    packages: packagesFixture(),
    profile: PROFILE,
    minChanges: 20,
    maxChanges: 30,
    branchLimit: 4,
    remotePackageLimit: 10,
    transactionLimit: 100,
    batchSize: 16,
    resultLimit: 10,
    seed: 7,
  };
  const first = runMediumRebuildSearch(input);
  const second = runMediumRebuildSearch(input);
  const stableResult = (result) => ({
    ...result,
    runtime: { ...result.runtime, elapsedMs: 0 },
  });
  assert.equal(
    stableStringify(stableResult(first)),
    stableStringify(stableResult(second)),
  );
  assert.ok(first.archive.length > 0, JSON.stringify(first.counts));
  for (const entry of first.archive) {
    assert.ok(entry.changedNodeCount >= 20);
    assert.ok(entry.changedNodeCount <= 30);
    assert.ok(entry.validation.counts.respec <= 30);
    assert.ok(entry.validation.counts.totalPoints <= 12);
  }
});

test("persistent PoB evaluation returns repeated metric equality", async () => {
  const buildPath = path.join(os.tmpdir(), `slice4-${process.pid}.xml`);
  fs.writeFileSync(buildPath, "<PathOfBuilding/>");
  const baseline = candidateFixture();
  const candidate = withCandidateKey({
    ...baseline,
    allocatedNodeIds: [1, ...Array.from({ length: 12 }, (_, index) => index + 20)],
  });
  const state = { tree: null };
  class FakeClient {
    async ready() {}
    async loadXml() {
      state.tree = {
        classId: baseline.classId,
        ascendClassId: 0,
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
          ascendClassName: null,
          level: 90,
          treeVersion: "test",
        } };
      }
      if (action === "get_config") return { config: {} };
      if (action === "get_items") return { items: [] };
      if (action === "get_skills") {
        return { skills: { mainSocketGroup: 1, groups: [] } };
      }
      if (action === "get_stats") {
        return { stats: { TotalDPS: 123, Life: 456 } };
      }
      throw new Error(action);
    }
    async close() {}
  }
  const result = await evaluateCandidates({
    buildPath,
    candidates: [candidate, candidate],
    metrics: ["TotalDPS", "Life"],
    count: 2,
    runtimeMeta: {
      version: "test",
      apiVersion: 2,
      apiPatchVersion: 1,
      runtime: "fake",
    },
    clientFactory: () => new FakeClient(),
  });
  assert.equal(result.checked, 2);
  assert.deepEqual(result.results[0].metrics, result.results[1].metrics);
  assert.equal(result.rejected, 0);
  fs.rmSync(buildPath, { force: true });
});
