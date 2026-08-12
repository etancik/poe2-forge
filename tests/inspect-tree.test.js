"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { unlockAvailable } = require("../scripts/inspect-tree");

test("tree inspection excludes hidden nodes from another ascendancy", () => {
  assert.equal(unlockAvailable({
    unlockConstraint: { ascendancy: "Oracle", nodes: [5571] },
  }, new Set([5571]), "Shaman"), false);
});

test("tree inspection requires every explicit unlock node", () => {
  const node = { unlockConstraint: { ascendancy: "Shaman", nodes: [10, 11] } };
  assert.equal(unlockAvailable(node, new Set([10]), "Shaman"), false);
  assert.equal(unlockAvailable(node, new Set([10, 11]), "Shaman"), true);
});
