"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { withCandidateKey } = require("../scripts/lib/passive-optimizer/model");
const {
  extractPackages,
  reroutePackages,
} = require("../scripts/lib/passive-optimizer/packages");
const {
  rankPackages,
  scoreDelta,
} = require("../scripts/lib/passive-optimizer/scorer");
const {
  parseStatLine,
  parseStatLines,
} = require("../scripts/lib/passive-optimizer/stat-taxonomy");
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
    group: 0,
    ...extra,
  };
}

function graphFixture() {
  const nodes = new Map([
    [1, node(1, [2, 5, 9, 20, 30], { classStarts: [0], group: 1 })],
    [2, node(2, [1, 3], { group: 2 })],
    [3, node(3, [2, 4], { group: 2 })],
    [4, node(4, [3, 6, 7], {
      group: 100,
      isNotable: true,
      name: "Crossbow Bastion",
      rawStats: ["20% increased Crossbow Damage", "+100 to Accuracy Rating"],
      stats: ["20% increased Crossbow Damage", "+100 to Accuracy Rating"],
    })],
    [5, node(5, [1, 6], { group: 3 })],
    [6, node(6, [5, 4], { group: 3 })],
    [7, node(7, [4, 8], {
      group: 100,
      rawStats: ["10% increased Reload Speed"],
      stats: ["10% increased Reload Speed"],
    })],
    [8, node(8, [7], {
      group: 100,
      isNotable: true,
      name: "Totem Wall",
      rawStats: ["Totems have 15% increased Life"],
      stats: ["Totems have 15% increased Life"],
    })],
    [9, node(9, [1, 10], { group: 4 })],
    [10, node(10, [9], { isJewelSocket: true, group: 4 })],
    [11, node(11, [1], {
      isKeystone: true,
      rawStats: ["A strange transformed mechanic"],
      stats: ["A strange transformed mechanic"],
    })],
    [12, node(12, [1, 13, 14], { isMultipleChoice: true })],
    [13, node(13, [12], {
      isMultipleChoiceOption: true,
      multipleChoiceParent: 12,
      rawStats: ["10% increased Projectile Speed"],
      stats: ["10% increased Projectile Speed"],
    })],
    [14, node(14, [12], {
      isMultipleChoiceOption: true,
      multipleChoiceParent: 12,
      rawStats: ["10% increased Movement Speed"],
      stats: ["10% increased Movement Speed"],
    })],
    [20, node(20, [1, 21], {
      ascendancyId: "A",
      ascendancyName: "Alpha",
      isAscendancyStart: true,
    })],
    [21, node(21, [20], {
      ascendancyId: "A",
      ascendancyName: "Alpha",
      isNotable: true,
      rawStats: ["20% increased Totem Damage"],
      stats: ["20% increased Totem Damage"],
    })],
    [30, node(30, [1, 31], {
      ascendancyId: "B",
      ascendancyName: "Beta",
      isAscendancyStart: true,
    })],
    [31, node(31, [30], {
      ascendancyId: "B",
      ascendancyName: "Beta",
      isNotable: true,
      rawStats: ["20% increased Spell Damage"],
      stats: ["20% increased Spell Damage"],
    })],
  ]);
  return {
    source: {
      hash: "tree-hash",
      treeVersion: "test",
      importerSchemaVersion: 1,
    },
    nodes,
    classes: [
      {
        classId: 0,
        name: "TestClass",
        ascendancies: [
          { ascendClassId: 1, id: "A", name: "Alpha" },
          { ascendClassId: 2, id: "B", name: "Beta" },
        ],
      },
    ],
    classStarts: new Map([[0, 1]]),
    ascendancyStarts: new Map([
      ["A", 20],
      ["B", 30],
    ]),
    landmarks: {
      classStarts: [1],
      ascendancyStarts: [20, 30],
      notables: [4, 8, 21, 31],
      keystones: [11],
      jewelSockets: [10],
      articulationPoints: [1, 4, 7, 12, 20, 30],
    },
    articulationPoints: new Set([1, 4, 7, 12, 20, 30]),
    biconnectedComponents: [
      [1, 2, 3, 4, 5, 6],
      [4, 7],
      [7, 8],
      [1, 9, 10],
    ],
    biconnectedComponentIds: new Map([
      [1, [0, 3]],
      [2, [0]],
      [3, [0]],
      [4, [0, 1]],
      [5, [0]],
      [6, [0]],
      [7, [1, 2]],
      [8, [2]],
      [9, [3]],
      [10, [3]],
    ]),
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
    allocatedNodeIds: [1],
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
    importedPobIdentity: { name: "fixture" },
    configRelevantState: {},
    ...extra,
  });
}

test("stat parsing preserves known, unknown, and uncertain raw lines", () => {
  const known = parseStatLine("20% increased Crossbow Damage");
  assert.equal(known.known, true);
  assert.ok(known.normalizedTags.includes("damage.crossbow"));
  const unknown = parseStatLine("A strange transformed mechanic");
  assert.equal(unknown.known, false);
  assert.equal(unknown.needsPoB, true);
  assert.equal(unknown.raw, "A strange transformed mechanic");
  const lifecycle = parseStatLine("Totems explode when they expire");
  assert.equal(lifecycle.needsPoB, true);
  assert.ok(lifecycle.reasonCodes.includes("UNCERTAIN_TOTEM_LIFECYCLE"));
});

test("extraction is stable and respects cluster, corridor, and articulation boundaries", () => {
  const graph = graphFixture();
  const candidate = candidateFixture();
  const first = extractPackages(graph, candidate);
  const second = extractPackages(graph, candidate);
  assert.equal(stableStringify(first), stableStringify(second));
  assert.deepEqual(
    first.packages.map((pkg) => pkg.id),
    [...first.packages.map((pkg) => pkg.id)].sort(),
  );
  const cluster = first.packages.find(
    (pkg) =>
      pkg.structuralType === "notable_cluster" &&
      pkg.coreNodeIds.includes(4),
  );
  assert.deepEqual(cluster.sourceNodeIds, [4]);
  assert.ok(!cluster.sourceNodeIds.includes(7), "articulation must stop cluster");
  const corridors = first.packages.filter(
    (pkg) =>
      pkg.structuralType === "travel_corridor" &&
      pkg.entryLandmarkIds.includes(1) &&
      pkg.exitLandmarkIds.includes(4),
  );
  assert.equal(corridors.length, 2);
  assert.deepEqual(
    corridors
      .map((pkg) => pkg.connectorNodeIds)
      .sort((left, right) => left[0] - right[0]),
    [
      [2, 3],
      [5, 6],
    ],
  );
});

test("terminal alternatives overlap, conflict, and retain connector choices", () => {
  const result = extractPackages(graphFixture(), candidateFixture());
  const alternatives = result.packages.filter(
    (pkg) =>
      pkg.structuralType === "terminal_connector" &&
      pkg.terminalLandmarkIds.includes(4),
  );
  assert.equal(alternatives.length, 2);
  assert.ok(alternatives.every((pkg) => pkg.conflicts.length === 1));
  assert.ok(alternatives.every((pkg) => pkg.dependencies.length === 1));
  assert.ok(alternatives.every((pkg) => pkg.overlaps.length > 0));
});

test("candidate-relative costs distinguish allocated and unallocated nodes", () => {
  const graph = graphFixture();
  const result = extractPackages(
    graph,
    candidateFixture({ allocatedNodeIds: [1, 2, 3, 4] }),
  );
  const packageForFour = result.packages.find(
    (pkg) =>
      pkg.structuralType === "notable_cluster" &&
      pkg.coreNodeIds.includes(4),
  );
  assert.equal(packageForFour.costs.intrinsic.add, 1);
  assert.equal(packageForFour.costs.marginal.add, 0);
});

test("slice-1 reroutes convert into deterministic reroute packages", () => {
  const graph = graphFixture();
  const candidate = candidateFixture();
  const reroute = {
    results: [
      {
        mode: "standard",
        preservedTerminals: [4],
        addedNodeIds: [5, 6],
        removedNodeIds: [2, 3],
        changedConnector: {
          articulationChanges: { added: [], removed: [] },
        },
        canonicalKey: "reroute-key",
        pointsSaved: 0,
        respecCount: 4,
        uncertainty: [],
      },
    ],
  };
  const packages = reroutePackages(graph, candidate, reroute);
  assert.equal(packages.length, 1);
  assert.equal(packages[0].structuralType, "bridge_reroute_patch");
  assert.deepEqual(packages[0].addNodeIds, [5, 6]);
  assert.deepEqual(packages[0].removeNodeIds, [2, 3]);
});

test("ascendancy packages remain separated by ascendancy identity", () => {
  const result = extractPackages(graphFixture(), candidateFixture());
  const ascendancies = result.packages.filter(
    (pkg) => pkg.structuralType === "ascendancy_package",
  );
  assert.equal(ascendancies.length, 2);
  assert.deepEqual(
    ascendancies
      .map((pkg) => pkg.context.ascendancyIds)
      .sort((left, right) => left[0].localeCompare(right[0])),
    [["A"], ["B"]],
  );
  assert.ok(
    ascendancies.every((pkg) => pkg.context.ascendancyIds.length === 1),
  );
});

test("needsPoB uncertainty never becomes invalid by itself", () => {
  const graph = graphFixture();
  const candidate = candidateFixture();
  const uncertainPackage = {
    id: "uncertain",
    addNodeIds: [],
    removeNodeIds: [],
    normalizedTags: [],
    stats: parseStatLines(["A strange transformed mechanic"]),
    uncertainty: "high",
    needsPoB: true,
    reasonCodes: ["UNKNOWN_STAT_LINE"],
  };
  const score = scoreDelta({
    graph,
    candidate,
    package: uncertainPackage,
    profile: {},
  });
  assert.equal(score.status, "needsPoB");
});

test("performance floors are hard only with trusted baseline metrics", () => {
  const graph = graphFixture();
  const candidate = candidateFixture();
  const pkg = {
    id: "floor-check",
    addNodeIds: [],
    removeNodeIds: [],
    normalizedTags: ["defense.life"],
    stats: parseStatLines(["10% increased maximum Life"]),
    uncertainty: "low",
    needsPoB: false,
    reasonCodes: [],
  };
  const profile = { floors: { life: 1000 } };
  const untrusted = scoreDelta({
    graph,
    candidate,
    package: pkg,
    profile,
    baselineMetrics: { trusted: false, metrics: { life: 500 } },
  });
  assert.equal(untrusted.status, "needsPoB");
  const trusted = scoreDelta({
    graph,
    candidate,
    package: pkg,
    profile,
    baselineMetrics: { trusted: true, metrics: { life: 500 } },
  });
  assert.equal(trusted.status, "invalid");
});

test("ranged-totem profile ranks relevant tags over spell/minion", () => {
  const graph = graphFixture();
  const candidate = candidateFixture();
  const relevant = {
    id: "relevant",
    addNodeIds: [],
    removeNodeIds: [],
    normalizedTags: parseStatLines([
      "20% increased Crossbow Damage",
      "+100 to Accuracy Rating",
      "Totems have 15% increased Life",
    ]).normalizedTags,
    stats: parseStatLines([
      "20% increased Crossbow Damage",
      "+100 to Accuracy Rating",
      "Totems have 15% increased Life",
    ]),
    uncertainty: "low",
    needsPoB: false,
    reasonCodes: [],
  };
  const irrelevant = {
    id: "irrelevant",
    addNodeIds: [],
    removeNodeIds: [],
    normalizedTags: parseStatLines([
      "20% increased Spell Damage",
      "Minions deal 20% increased Damage",
    ]).normalizedTags,
    stats: parseStatLines([
      "20% increased Spell Damage",
      "Minions deal 20% increased Damage",
    ]),
    uncertainty: "low",
    needsPoB: false,
    reasonCodes: [],
  };
  const ranked = rankPackages({
    graph,
    candidate,
    packages: [irrelevant, relevant],
    profile: {
      id: "synthetic-ranged-totem",
      archetypeTags: ["role.totem"],
      skillTags: ["role.projectile", "role.accuracy", "role.defensive"],
      weaponTags: ["role.crossbow"],
      forbiddenTags: ["mechanic.spell", "mechanic.minion"],
    },
  });
  assert.equal(ranked[0].packageId, "relevant");
  assert.ok(ranked[0].rankScore > ranked[1].rankScore);
});

test("scoring does not mutate candidate or package state", () => {
  const graph = graphFixture();
  const candidate = candidateFixture();
  const pkg = {
    id: "immutable",
    addNodeIds: [2],
    removeNodeIds: [],
    normalizedTags: ["accuracy"],
    stats: parseStatLines(["+50 to Accuracy Rating"]),
    uncertainty: "low",
    needsPoB: false,
    reasonCodes: [],
  };
  const beforeCandidate = stableStringify(candidate);
  const beforePackage = stableStringify(pkg);
  scoreDelta({ graph, candidate, package: pkg, profile: {} });
  assert.equal(stableStringify(candidate), beforeCandidate);
  assert.equal(stableStringify(pkg), beforePackage);
});
