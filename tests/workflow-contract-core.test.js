"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const refresh = require("../scripts/refresh-build");
const experiment = require("../scripts/run-experiment");

test("refresh no longer requires a roadmap root", () => {
  const args = refresh.parseArgs([
    "node",
    "refresh-build.js",
    "--build",
    "example.xml",
  ]);
  assert.ok(args.build.endsWith("example.xml"));
  assert.equal(Object.hasOwn(args, "root"), false);
  assert.equal(Object.hasOwn(args, "updateRoadmap"), false);
});

test("ordinary experiments run directly up to forty variants", () => {
  assert.equal(experiment.budgetFor({ variants: Array(12) }), "small");
  assert.equal(experiment.budgetFor({ variants: Array(13) }), "medium");
  assert.equal(experiment.budgetFor({ variants: Array(40) }), "medium");
  assert.equal(experiment.budgetFor({ variants: Array(41) }), "large");
});

test("experiment scenario must contain all five calibrated fields", () => {
  assert.throws(
    () => experiment.expectedScenario({
      xmlScenario: { placeholders: { enemyLevel: 42 } },
    }),
    /complete scenario/,
  );
  assert.deepEqual(experiment.expectedScenario({
    xmlScenario: {
      placeholders: { enemyLevel: 42, enemyEvasion: 369, enemyArmour: 479 },
      inputs: { enemyDistance: 20, resistancePenalty: -20 },
    },
  }), {
    enemyLevel: 42,
    enemyEvasion: 369,
    enemyArmour: 479,
    resistancePenalty: -20,
    enemyDistance: 20,
  });
});

test("saved default drift is reported as corrected rather than trusted", () => {
  assert.deepEqual(
    refresh.staleSavedScenario(
      { enemyLevel: 82, enemyArmour: 8063 },
      { enemyLevel: 42, enemyArmour: 479 },
    ),
    [
      { field: "enemyLevel", saved: 82, applied: 42 },
      { field: "enemyArmour", saved: 8063, applied: 479 },
    ],
  );
});
