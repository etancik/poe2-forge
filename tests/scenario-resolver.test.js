"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

require("./scenario-resolver-core.test");

const {
  clampEnemyLevel,
  parseEnemyLevelLimit,
} = require("../scripts/lib/scenario-resolver");

test("enemy level is clamped to the limit declared by the runtime", () => {
  const text = "The maximum level for normal enemies and all bosses is 85.";
  const limit = parseEnemyLevelLimit(text);
  assert.equal(limit, 85);
  assert.deepEqual(clampEnemyLevel(91, limit), {
    requested: 91,
    applied: 85,
    limit: 85,
    clamped: true,
  });
});
