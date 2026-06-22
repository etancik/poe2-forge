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
  declaredPassiveDelta,
  evaluateSelectiveCandidates,
  normalizeObjectiveSet,
} = require(
  "../scripts/lib/passive-optimizer/selective-evaluation",
);
const {
  parseSavedScenario,
  verifySavedScenario,
} = require(
  "../scripts/lib/passive-optimizer/scenario",
);

const SCENARIO = {
  enemyLevel: 42,
  enemyEvasion: 369,
  enemyArmour: 479,
  resistancePenalty: -20,
  enemyDistance: 20,
};

function scenarioXml(inputOverrides = {}, placeholderOverrides = {}) {
  const inputs = { ...SCENARIO, ...inputOverrides };
  const placeholders = { ...SCENARIO, ...placeholderOverrides };
  return `<PathOfBuilding>
  <Build level="42"/>
  <Config>
    <Input number="${inputs.enemyLevel}" name="enemyLevel"/>
    <Input number="${inputs.enemyEvasion}" name="enemyEvasion"/>
    <Input number="${inputs.enemyArmour}" name="enemyArmour"/>
    <Input number="${inputs.resistancePenalty}" name="resistancePenalty"/>
    <Placeholder number="${placeholders.enemyLevel}" name="enemyLevel"/>
    <Placeholder number="${placeholders.enemyEvasion}" name="enemyEvasion"/>
    <Placeholder number="${placeholders.enemyArmour}" name="enemyArmour"/>
    <Placeholder number="${placeholders.enemyDistance}" name="enemyDistance"/>
  </Config>
</PathOfBuilding>`;
}

function candidate(nodes, overrides = {}) {
  return withCandidateKey({
    treeDataHash: "a".repeat(64),
    treeVersion: "test",
    classId: 1,
    className: "Test",
    classStart: 1,
    primaryAscendancy: null,
    secondaryAscendancy: null,
    allocatedNodeIds: nodes,
    freeStartNodeIds: [1],
    weaponSetAllocations: {},
    attributeOverrides: { 1: "str" },
    switchableOverrides: { 1: "alpha" },
    multipleChoiceSelections: { 1: [2] },
    masterySelections: {},
    jewelState: { 1: { itemId: 7, active: true } },
    budgets: {
      ordinary: 2,
      primaryAscendancy: 0,
      secondaryAscendancy: 0,
      weaponSets: {},
      total: 2,
      respec: 2,
    },
    requiredNodeIds: [],
    forbiddenNodeIds: [],
    generatedNodeIds: [],
    importedPobIdentity: { name: "Build", sha256: "b".repeat(64) },
    configRelevantState: SCENARIO,
    ...overrides,
  });
}

function shortlistEntry(nodes, calibrationKind = "candidate") {
  const value = candidate(nodes);
  const added = nodes.filter((id) => id !== 1);
  return {
    canonicalKey: value.canonicalKey,
    candidate: value,
    rankScore: added.length,
    changedNodeCount: added.length,
    calibrationKind,
    components: { uncertainty: 0 },
    objectives: { uncertainty: 0, respecCost: 0 },
    costs: { marginal: { add: added.length, remove: 0 }, respec: 0 },
    delta: { addNodeIds: added, removeNodeIds: [] },
  };
}

test("saved scenario parser uses active inputs and warns on shadowed placeholders", () => {
  const valid = scenarioXml();
  assert.deepEqual(parseSavedScenario(valid), {
    inputs: {
      enemyArmour: 479,
      enemyEvasion: 369,
      enemyLevel: 42,
      resistancePenalty: -20,
    },
    placeholders: {
      enemyArmour: 479,
      enemyDistance: 20,
      enemyEvasion: 369,
      enemyLevel: 42,
    },
  });
  assert.equal(verifySavedScenario(valid, SCENARIO).valid, true);
  const stale = scenarioXml({}, { enemyLevel: 82 });
  const report = verifySavedScenario(stale, SCENARIO);
  assert.equal(report.valid, true);
  assert.deepEqual(report.active, SCENARIO);
  assert.ok(report.warnings.some(
    (entry) =>
      entry.code === "SHADOWED_PLACEHOLDER_DIFFERS" &&
      entry.field === "enemyLevel",
  ));
  assert.equal(stale.includes('number="82"'), true);
  const badInput = scenarioXml({ enemyLevel: 82 }, { enemyLevel: 42 });
  const badReport = verifySavedScenario(badInput, SCENARIO);
  assert.equal(badReport.valid, false);
  assert.ok(badReport.mismatches.some(
    (entry) => entry.field === "saved.active.enemyLevel",
  ));
});

test("exact evaluation uses scalar passive deltas and preserves baseline state", async () => {
  const root = path.join(os.tmpdir(), `poe2-forge-slice7-${process.pid}`);
  fs.mkdirSync(root, { recursive: true });
  const buildPath = path.join(root, "Build.xml");
  fs.writeFileSync(
    buildPath,
    scenarioXml().replace(
      /\s*<Input number="-20" name="resistancePenalty"\/>/,
      "",
    ),
  );
  const baseline = shortlistEntry([1], "baseline");
  const changed = shortlistEntry([1, 2]);
  const calls = [];
  const loadedXml = [];
  const tree = {
    classId: 1,
    ascendClassId: 0,
    secondaryAscendClassId: 0,
    treeVersion: "test",
    nodes: [1],
    masteryEffects: [],
  };
  const skills = {
    mainSocketGroup: 1,
    groups: [{
      index: 1,
      enabled: true,
      mainActiveSkill: 1,
      skills: ["Crossbow Shot"],
      gems: [{ name: "Crossbow Shot", enabled: true }],
    }],
  };
  const clientFactory = () => ({
    async ready() {},
    async loadXml(xml) {
      loadedXml.push(xml);
    },
    async call(action, params) {
      calls.push({ action, params });
      if (action === "set_tree") throw new Error("set_tree must not be called");
      if (action === "set_config") return { config: SCENARIO };
      if (action === "get_config") return { config: SCENARIO };
      if (action === "get_tree") return { tree };
      if (action === "get_build_info") {
        return {
          info: {
            className: "Test",
            ascendClassName: null,
            level: 42,
            treeVersion: "test",
          },
        };
      }
      if (action === "get_items") return { items: [] };
      if (action === "get_skills") return { skills };
      if (action === "set_main_selection") return {};
      if (action === "get_stats") {
        return { stats: { TotalDPS: 100, Life: 1000, TotalEHP: 2000 } };
      }
      if (action === "calc_with_stats") {
        assert.deepEqual(params.addNodes, [2]);
        assert.deepEqual(params.removeNodes, []);
        return { stats: { TotalDPS: 110, Life: 1050 } };
      }
      throw new Error(action);
    },
    async close() {},
  });
  const result = await evaluateSelectiveCandidates({
    buildPath,
    shortlist: [baseline, changed],
    objectiveSet: normalizeObjectiveSet({
      objectives: [
        { name: "damage", field: "TotalDPS", skill: "Crossbow Shot" },
        { name: "life", field: "Life" },
      ],
    }),
    enemyProfile: {},
    treeData: { hash: "tree", treeVersion: "test" },
    scenario: SCENARIO,
    runtimeMeta: {
      version: "test",
      apiVersion: 2,
      apiPatchVersion: 7,
      runtime: "fake",
    },
    clientFactory,
    evaluationLimit: 2,
    selectionMix: { predictedBest: 1 },
  });
  const measured = result.results.find(
    (entry) => entry.canonicalKey === changed.canonicalKey,
  );
  assert.equal(measured.status, "success");
  assert.deepEqual(measured.objectives, { damage: 110, life: 1050 });
  assert.equal(measured.drift.length, 0);
  assert.equal(measured.parity.nonMutating, true);
  assert.equal(calls.some((call) => call.action === "set_tree"), false);
  assert.ok(calls.some((call) => call.action === "calc_with_stats"));
  assert.ok(loadedXml.every((xml) =>
    xml.includes('<Input name="resistancePenalty" number="-20"/>') ||
    xml.includes('<Input number="-20" name="resistancePenalty"/>')));
  assert.deepEqual(tree.nodes, [1]);
  assert.equal(result.baseline.finalBaselineRestored, true);

  const stale = {
    ...changed,
    delta: { addNodeIds: [99], removeNodeIds: [] },
  };
  const callsBeforeStaleEvaluation = calls.length;
  const staleResult = await evaluateSelectiveCandidates({
    buildPath,
    shortlist: [baseline, stale],
    objectiveSet: normalizeObjectiveSet({
      objectives: [
        { name: "damage", field: "TotalDPS", skill: "Crossbow Shot" },
        { name: "life", field: "Life" },
      ],
    }),
    enemyProfile: {},
    treeData: { hash: "tree", treeVersion: "test" },
    scenario: SCENARIO,
    runtimeMeta: {
      version: "test",
      apiVersion: 2,
      apiPatchVersion: 7,
      runtime: "fake",
    },
    clientFactory,
    evaluationLimit: 2,
    selectionMix: { predictedBest: 1 },
  });
  const rejectedStale = staleResult.results.find(
    (entry) => entry.canonicalKey === stale.canonicalKey,
  );
  assert.equal(rejectedStale.status, "drift");
  assert.equal(rejectedStale.accepted, false);
  assert.deepEqual(rejectedStale.drift, [{
    field: "candidateDelta",
    before: { addNodes: [99], removeNodes: [] },
    after: { addNodes: [2], removeNodes: [] },
  }]);
  assert.equal(
    calls.slice(callsBeforeStaleEvaluation).some(
      (call) => call.action === "calc_with_stats",
    ),
    false,
  );
  fs.rmSync(root, { recursive: true, force: true });
});

test("initial scenario failure closes the spawned PoB client", async () => {
  const root = path.join(os.tmpdir(), `poe2-forge-slice7-close-${process.pid}`);
  fs.mkdirSync(root, { recursive: true });
  const buildPath = path.join(root, "Build.xml");
  fs.writeFileSync(buildPath, scenarioXml());
  const baseline = shortlistEntry([1], "baseline");
  let closed = 0;
  const clientFactory = () => ({
    async ready() {},
    async loadXml() {},
    async call(action) {
      if (action === "set_config") return {};
      if (action === "get_config") {
        return { config: { ...SCENARIO, enemyLevel: 99 } };
      }
      throw new Error(action);
    },
    async close() {
      closed += 1;
    },
  });

  await assert.rejects(
    evaluateSelectiveCandidates({
      buildPath,
      shortlist: [baseline],
      objectiveSet: normalizeObjectiveSet({
        objectives: [{ name: "life", field: "Life" }],
      }),
      enemyProfile: {},
      treeData: { hash: "tree", treeVersion: "test" },
      scenario: SCENARIO,
      runtimeMeta: {
        version: "test",
        apiVersion: 2,
        apiPatchVersion: 8,
        runtime: "fake",
      },
      clientFactory,
      evaluationLimit: 1,
    }),
    /Effective scenario mismatch/,
  );
  assert.equal(closed, 1);
  fs.rmSync(root, { recursive: true, force: true });
});

test("scenario changes invalidate exact cache identity", () => {
  const value = candidate([1, 2]);
  const base = {
    candidate: value,
    scoring: null,
    buildHash: "build",
    baseline: {
      info: {},
      config: {},
      items: [],
      skills: { mainSocketGroup: 1, groups: [] },
    },
    runtime: {
      version: "test",
      apiVersion: 2,
      apiPatchVersion: 7,
      runtime: "fake",
    },
    objectiveSet: normalizeObjectiveSet({
      objectives: [{ name: "damage", field: "TotalDPS" }],
    }),
    enemyProfile: {},
    treeData: { hash: "tree", treeVersion: "test" },
    scenario: { effective: SCENARIO, scenarioHash: "one" },
  };
  assert.notEqual(
    cacheKeyFor(base),
    cacheKeyFor({
      ...base,
      scenario: {
        effective: { ...SCENARIO, enemyLevel: 43 },
        scenarioHash: "two",
      },
    }),
  );
});

test("declared exact delta is canonical and detects stale candidate pools", () => {
  assert.deepEqual(declaredPassiveDelta({
    delta: {
      addNodeIds: [4, 2],
      removeNodeIds: [9, 7],
    },
  }), {
    addNodes: [2, 4],
    removeNodes: [7, 9],
  });
  assert.notEqual(
    JSON.stringify(declaredPassiveDelta({
      delta: { addNodeIds: [], removeNodeIds: [25807] },
    })),
    JSON.stringify({
      addNodes: [54417],
      removeNodes: [6626, 8092, 25807],
    }),
  );
});
