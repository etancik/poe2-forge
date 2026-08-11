"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  parseResistancePenalties,
  resolveScenario,
  transitionForLevel,
} = require("../scripts/lib/scenario-resolver");
const {
  scenarioChecks,
} = require("../scripts/lib/passive-optimizer/scenario");

const penalties = {
  act1: 0,
  act2: -10,
  act3: -20,
  act4: -30,
  act5: -40,
  act6: -50,
  endgame: -60,
};
const armourTable = Array.from({ length: 100 }, (_, index) => index * 10 + 3);
const evasionTable = Array.from({ length: 100 }, (_, index) => index * 5 + 24);

function resolve(input) {
  return resolveScenario({
    characterLevel: 40,
    penalties,
    armourTable,
    evasionTable,
    ...input,
  });
}

test("runtime resistance options are parsed instead of hard-coding -20", () => {
  const text = `
    { var = "resistancePenalty", type = "list", list = {
      {val=0,label="Act 1 (0%)"},{val=-10,label="Act 2 (-10%)"},
      {val=-20,label="Act 3 (-20%)"},{val=-30,label="Act 4 (-30%)"},
      {val=-40,label="Act 5 (-40%)"},{val=-50,label="Act 6 (-50%)"},
      {val=-60,label="Endgame (-60%)"}
    }}
  `;
  assert.deepEqual(parseResistancePenalties(text), penalties);
});

test("scenario derives every enemy field from the selected enemy level", () => {
  const scenario = resolve({ characterLevel: 40, act: 3, enemyLevel: 42 });
  assert.deepEqual(scenario.expected, {
    enemyLevel: 42,
    enemyEvasion: evasionTable[41],
    enemyArmour: armourTable[41],
    enemyDistance: 20,
    resistancePenalty: -20,
  });
  assert.equal(scenario.progression.source, "explicit-act");
});

test("area level selects interlude and endgame penalties", () => {
  assert.equal(resolve({ areaLevel: 54 }).expected.resistancePenalty, -40);
  assert.equal(resolve({ areaLevel: 60 }).expected.resistancePenalty, -50);
  assert.equal(resolve({ areaLevel: 65 }).expected.resistancePenalty, -60);
});

test("character level inference requests Act confirmation near boundaries", () => {
  assert.equal(transitionForLevel(31), null);
  assert.deepEqual(transitionForLevel(32).choices, ["act2", "act3"]);
  assert.deepEqual(transitionForLevel(33).choices, ["act2", "act3"]);
  assert.deepEqual(transitionForLevel(34).choices, ["act2", "act3"]);
  const scenario = resolve({ characterLevel: 33 });
  assert.equal(scenario.progression.confidence, "needs-confirmation");
  assert.equal(scenario.progression.confirmationRequired.boundary, 33);
});

test("explicit Act bypasses a boundary confirmation", () => {
  const scenario = resolve({ characterLevel: 33, act: 2 });
  assert.equal(scenario.expected.resistancePenalty, -10);
  assert.equal(scenario.progression.confirmationRequired, null);
});

test("effective validation covers level, armour, evasion, distance, and penalty", () => {
  const expected = resolve({ characterLevel: 40, act: 3 }).expected;
  const actual = { ...expected, enemyArmour: expected.enemyArmour + 1 };
  const checks = scenarioChecks(expected, actual);
  assert.equal(checks.length, 5);
  assert.deepEqual(
    checks.filter((check) => !check.passed).map((check) => check.field),
    ["effective.enemyArmour"],
  );
});
