"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { candidateKey, withCandidateKey } = require("../scripts/lib/passive-optimizer/model");
const { runReroute } = require("../scripts/lib/passive-optimizer/reroute");
const { validateCandidate } = require("../scripts/lib/passive-optimizer/validator");

function node(id, adjacency, extra = {}) {
  return {
    id,
    name: `Node ${id}`,
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
    ...extra,
  };
}

function syntheticGraph() {
  const nodes = new Map([
    [1, node(1, [2, 5, 20, 30], { classStarts: [0] })],
    [2, node(2, [1, 3, 7, 8, 6])],
    [3, node(3, [2, 4])],
    [4, node(4, [3, 5], { isNotable: true })],
    [5, node(5, [1, 4])],
    [6, node(6, [2], { isOnlyImage: true })],
    [7, node(7, [2], { unlockConstraint: { nodes: [4] } })],
    [8, node(8, [2, 10, 11], { isMultipleChoice: true })],
    [
      10,
      node(10, [8], {
        isMultipleChoiceOption: true,
        multipleChoiceParent: 8,
      }),
    ],
    [
      11,
      node(11, [8], {
        isMultipleChoiceOption: true,
        multipleChoiceParent: 8,
      }),
    ],
    [12, node(12, [2], { isAttribute: true, isSwitchable: true })],
    [13, node(13, [2], { isJewelSocket: true })],
    [14, node(14, [2], { isMastery: true })],
    [
      20,
      node(20, [1, 21], {
        ascendancyId: "Class0A",
        ascendancyName: "Alpha",
        isAscendancyStart: true,
      }),
    ],
    [
      21,
      node(21, [20], {
        ascendancyId: "Class0A",
        ascendancyName: "Alpha",
        isNotable: true,
      }),
    ],
    [
      30,
      node(30, [1, 31], {
        ascendancyId: "Class0B",
        ascendancyName: "Beta",
        isAscendancyStart: true,
      }),
    ],
    [
      31,
      node(31, [30], {
        ascendancyId: "Class0B",
        ascendancyName: "Beta",
      }),
    ],
    [40, node(40, [], { classStarts: [1] })],
  ]);
  return {
    source: {
      hash: "tree-hash",
      treeVersion: "test",
    },
    nodes,
    classes: [
      {
        classId: 0,
        name: "Test",
        ascendancies: [
          { ascendClassId: 1, id: "Class0A", name: "Alpha" },
          { ascendClassId: 2, id: "Class0B", name: "Beta" },
        ],
      },
      { classId: 1, name: "Other", ascendancies: [] },
    ],
    classStarts: new Map([
      [0, 1],
      [1, 40],
    ]),
    ascendancyStarts: new Map([
      ["Class0A", 20],
      ["Class0B", 30],
    ]),
    articulationPoints: new Set([1, 2, 20]),
  };
}

function baseCandidate(extra = {}) {
  return withCandidateKey({
    treeDataHash: "tree-hash",
    treeVersion: "test",
    classId: 0,
    className: "Test",
    classStart: 1,
    primaryAscendancy: {
      ascendClassId: 1,
      id: "Class0A",
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
      ordinary: 3,
      primaryAscendancy: 1,
      secondaryAscendancy: 0,
      weaponSets: {},
      total: 4,
      respec: null,
    },
    requiredNodeIds: [],
    forbiddenNodeIds: [],
    generatedNodeIds: [],
    importedPobIdentity: { name: "fixture" },
    configRelevantState: { enemyLevel: 80 },
    ...extra,
  });
}

test("canonical key ignores input node order", () => {
  const left = baseCandidate({ allocatedNodeIds: [21, 4, 3, 2, 20, 1] });
  const right = baseCandidate({ allocatedNodeIds: [1, 2, 3, 4, 20, 21] });
  assert.equal(left.canonicalKey, right.canonicalKey);
});

test("canonical key includes all legality and meaning state", () => {
  const base = baseCandidate();
  const variants = [
    { multipleChoiceSelections: { 8: 10 } },
    { jewelState: { 13: { itemId: 7, active: true } } },
    { weaponSetAllocations: { 1: [2] } },
    { classId: 1 },
    {
      primaryAscendancy: {
        ascendClassId: 2,
        id: "Class0B",
        name: "Beta",
        startNodeId: 30,
      },
    },
    { configRelevantState: { enemyLevel: 81 } },
  ];
  for (const variant of variants) {
    assert.notEqual(candidateKey({ ...base, ...variant }), base.canonicalKey);
  }
});

test("connected valid tree passes and point classes are separate", () => {
  const report = validateCandidate(syntheticGraph(), baseCandidate());
  assert.equal(report.status, "valid");
  assert.deepEqual(report.counts, {
    allocated: 6,
    ordinaryPoints: 3,
    primaryAscendancyPoints: 1,
    secondaryAscendancyPoints: 0,
    weaponSetPoints: {},
    totalPoints: 4,
    freeStarts: 2,
    errors: 0,
    warnings: 0,
    needsPob: 0,
    respec: 0,
  });
});

test("validator emits stable error codes", () => {
  const graph = syntheticGraph();
  const cases = [
    [
      "DISCONNECTED_ORDINARY",
      baseCandidate({ allocatedNodeIds: [1, 4, 20, 21] }),
    ],
    [
      "ORDINARY_BUDGET_EXCEEDED",
      baseCandidate({
        allocatedNodeIds: [1, 2, 3, 4, 5, 20, 21],
        budgets: {
          ordinary: 3,
          primaryAscendancy: 1,
          secondaryAscendancy: 0,
          weaponSets: {},
          total: 5,
        },
      }),
    ],
    [
      "FOREIGN_ASCENDANCY",
      baseCandidate({ allocatedNodeIds: [1, 2, 3, 4, 20, 21, 30] }),
    ],
    [
      "VISUAL_ONLY_NODE",
      baseCandidate({ allocatedNodeIds: [1, 2, 3, 4, 6, 20, 21] }),
    ],
    [
      "MISSING_UNLOCK",
      baseCandidate({ allocatedNodeIds: [1, 2, 7, 20, 21] }),
    ],
    [
      "MULTIPLE_CHOICE_CONFLICT",
      baseCandidate({
        allocatedNodeIds: [1, 2, 8, 10, 11, 20, 21],
        multipleChoiceSelections: { 8: [10, 11] },
      }),
    ],
    [
      "FORBIDDEN_NODE_PRESENT",
      baseCandidate({ forbiddenNodeIds: [4] }),
    ],
  ];
  for (const [code, candidate] of cases) {
    const report = validateCandidate(graph, candidate);
    assert.ok(
      report.errors.some((entry) => entry.code === code),
      `${code}: ${report.errors.map((entry) => entry.code).join(", ")}`,
    );
  }
});

test("reroute preserves terminals, saves a point, and deduplicates", () => {
  const graph = syntheticGraph();
  const first = runReroute(graph, baseCandidate(), {
    mode: "standard",
    resultLimit: 5,
  });
  const second = runReroute(graph, baseCandidate(), {
    mode: "standard",
    resultLimit: 5,
  });
  assert.equal(first.results.length, 1, JSON.stringify(first, null, 2));
  assert.equal(first.results[0].pointsSaved, 1);
  assert.deepEqual(first.results[0].candidate.allocatedNodeIds, [
    1, 4, 5, 20, 21,
  ]);
  assert.ok(first.results[0].preservedTerminals.includes(4));
  assert.equal(first.results[0].validation.valid, true);
  assert.ok(first.search.duplicate > 0);
  assert.deepEqual(
    first.results.map((entry) => entry.canonicalKey),
    second.results.map((entry) => entry.canonicalKey),
  );
});
