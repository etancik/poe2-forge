"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  deriveActiveMechanics,
  explainAddedNodes,
  packageRelevance,
} = require(
  "../scripts/lib/passive-optimizer/mechanic-relevance",
);
const { makeMoves } = require(
  "../scripts/lib/passive-optimizer/search",
);

test("active mechanics are derived from enabled skills", () => {
  assert.deepEqual(deriveActiveMechanics({
    groups: [
      {
        enabled: true,
        skills: ["Crossbow Shot", "Basic Bolt"],
        gems: [{ name: "Crossbow Shot", enabled: true, isSupport: false }],
      },
      {
        enabled: true,
        skills: ["Artillery Ballista", "Ballista Bolt"],
        gems: [{ name: "Artillery Ballista", enabled: true, isSupport: false }],
      },
    ],
  }), ["crossbow", "projectile", "totem"]);
});

test("mechanic preference changes re-enable grenade packages without code changes", () => {
  const grenade = {
    normalizedTags: ["mechanic.grenade", "damage.grenade"],
    stats: { normalizedTags: ["mechanic.grenade", "damage.grenade"] },
  };
  assert.deepEqual(
    packageRelevance(grenade, {
      mechanicPreferences: { grenade: "inactive" },
    }).reason,
    "INACTIVE_MECHANIC_REJECTED",
  );
  assert.equal(
    packageRelevance(grenade, {
      mechanicPreferences: { grenade: "experimental" },
    }).reason,
    "EXPERIMENTAL_ALLOWED",
  );
});

test("node explanations distinguish active value from required connectors", () => {
  const graph = {
    nodes: new Map([
      [1, { id: 1, name: "Start", rawStats: [], adjacency: new Set([2]) }],
      [2, { id: 2, name: "Travel", rawStats: [], adjacency: new Set([1, 3]) }],
      [3, {
        id: 3,
        name: "Projectile Damage",
        rawStats: ["12% increased Projectile Damage"],
        adjacency: new Set([2]),
      }],
    ]),
  };
  const explanations = explainAddedNodes(
    graph,
    { allocatedNodeIds: [1] },
    { allocatedNodeIds: [1, 2, 3] },
    { mechanicPreferences: { projectile: "required" } },
  );
  assert.equal(explanations[0].reason, "REQUIRED_CONNECTOR");
  assert.equal(explanations[1].reason, "ACTIVE_MECHANIC");
  assert.ok(explanations.every((entry) => entry.accepted));
});

test("add-only move generation excludes every move with removals", () => {
  const graph = { nodes: new Map() };
  const candidate = {
    allocatedNodeIds: [1, 2],
    freeStartNodeIds: [1],
    requiredNodeIds: [],
    attributeOverrides: {},
    switchableOverrides: {},
    multipleChoiceSelections: {},
    masterySelections: {},
    jewelState: {},
    weaponSetAllocations: {},
  };
  const packages = [
    {
      id: "active",
      addNodeIds: [2],
      removeNodeIds: [],
      dependencies: [],
      conflicts: [],
      normalizedTags: ["damage.crossbow"],
      structuralType: "notable_cluster",
      context: {},
    },
    {
      id: "conflicting",
      addNodeIds: [3],
      removeNodeIds: [],
      dependencies: [],
      conflicts: ["active"],
      normalizedTags: ["damage.crossbow"],
      structuralType: "notable_cluster",
      context: {},
    },
    {
      id: "clean",
      addNodeIds: [4],
      removeNodeIds: [],
      dependencies: [],
      conflicts: [],
      normalizedTags: ["damage.crossbow"],
      structuralType: "notable_cluster",
      context: {},
    },
  ];
  const moves = makeMoves(graph, candidate, packages, {
    maxChanges: 2,
    maxRemovals: 0,
  });
  assert.ok(moves.some((move) => move.packageIds.includes("clean")));
  assert.ok(moves.every((move) => move.delta.removeNodeIds.length === 0));
  assert.ok(moves.every((move) => move.type === "add"));
});
