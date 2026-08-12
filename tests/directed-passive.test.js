"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  budgetFor,
  buildVariantCandidate,
  metricDeltas,
  normalizeVariant,
} = require("../scripts/directed-passive");

test("directed passive keeps ordinary and large calculation gates", () => {
  assert.equal(budgetFor({ variants: Array(12) }), "small");
  assert.equal(budgetFor({ variants: Array(13) }), "medium");
  assert.equal(budgetFor({ variants: Array(40) }), "medium");
  assert.equal(budgetFor({ variants: Array(41) }), "large");
});

test("directed passive normalizes node deltas deterministically", () => {
  assert.deepEqual(normalizeVariant({
    id: "swap",
    addNodes: [3, 2, 3],
    removeNodes: [8, 7],
  }), {
    id: "swap",
    label: "swap",
    addNodes: [2, 3],
    removeNodes: [7, 8],
  });
});

test("directed candidate preserves attribute overrides and replaces allocations", () => {
  const candidate = buildVariantCandidate({
    treeDataHash: "abc",
    treeVersion: "test",
    classId: 1,
    className: "Test",
    classStart: 1,
    primaryAscendancy: null,
    secondaryAscendancy: null,
    allocatedNodeIds: [1, 2, 3],
    attributeOverrides: { 2: "str" },
    switchableOverrides: {},
    multipleChoiceSelections: {},
    weaponSetAllocations: {},
    freeStartNodeIds: [1],
    budgets: { ordinary: 2, primaryAscendancy: 0, secondaryAscendancy: 0, weaponSets: {}, total: 2, respec: null },
    requiredNodeIds: [],
    forbiddenNodeIds: [],
    generatedNodeIds: [],
    masterySelections: {},
    jewelState: {},
    importedPobIdentity: null,
    configRelevantState: {},
  }, normalizeVariant({ id: "swap", addNodes: [4], removeNodes: [3] }));
  assert.deepEqual(candidate.allocatedNodeIds, [1, 2, 4]);
  assert.deepEqual(candidate.attributeOverrides, { 2: "str" });
});

test("directed result reports exact percentage deltas", () => {
  assert.deepEqual(metricDeltas({ damage: 100 }, { damage: 110 }), {
    damage: { before: 100, after: 110, absolute: 10, percent: 10 },
  });
});
