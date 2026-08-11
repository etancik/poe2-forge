"use strict";

const fs = require("node:fs");
const path = require("node:path");
const core = require("./scenario-resolver-core");

function parseEnemyLevelLimit(text) {
  const source = String(text);
  const match = source.match(
    /maximum level for normal enemies and all bosses is\s+(\d+)/i,
  ) || source.match(/normal monster level[^\n]*(?:capped|max(?:imum)?)\D+(\d+)/i);
  if (!match) {
    throw new Error("Runtime ConfigOptions.lua has no enemy-level limit");
  }
  const limit = Number(match[1]);
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(`Invalid runtime enemy-level limit: ${match[1]}`);
  }
  return limit;
}

function runtimeEnemyLevelLimit(runtimeDir) {
  const configFile = path.join(
    path.resolve(runtimeDir),
    "Modules",
    "ConfigOptions.lua",
  );
  return parseEnemyLevelLimit(fs.readFileSync(configFile, "utf8"));
}

function clampEnemyLevel(requested, limit) {
  const numeric = Number(requested);
  if (!Number.isInteger(numeric) || numeric < 1) {
    throw new Error(`Enemy level must be a positive integer, got ${requested}`);
  }
  return {
    requested: numeric,
    applied: Math.min(numeric, limit),
    limit,
    clamped: numeric > limit,
  };
}

function resolveScenario(input) {
  if (!input.runtimeDir) return core.resolveScenario(input);
  const requested = input.enemyLevel ?? input.areaLevel ?? input.characterLevel;
  const enemyLevel = clampEnemyLevel(
    requested,
    runtimeEnemyLevelLimit(input.runtimeDir),
  );
  const result = core.resolveScenario({
    ...input,
    enemyLevel: enemyLevel.applied,
  });
  return {
    ...result,
    progression: {
      ...result.progression,
      enemyLevel,
    },
  };
}

module.exports = {
  ...core,
  clampEnemyLevel,
  parseEnemyLevelLimit,
  resolveScenario,
  runtimeEnemyLevelLimit,
};
