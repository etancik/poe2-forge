"use strict";

const fs = require("node:fs");
const path = require("node:path");

const LEVEL_STAGES = Object.freeze([
  { key: "act1", min: 1, max: 15, act: 1 },
  { key: "act2", min: 16, max: 32, act: 2 },
  { key: "act3", min: 33, max: 45, act: 3 },
  { key: "act4", min: 46, max: 53, act: 4 },
  { key: "act5", min: 54, max: 59, act: 5 },
  { key: "act6", min: 60, max: 64, act: 6 },
  { key: "endgame", min: 65, max: Infinity, act: null },
]);

const TRANSITION_LEVELS = Object.freeze(
  LEVEL_STAGES.slice(1).map((stage) => stage.min),
);

function finiteInteger(value, label) {
  const number = Number(value);
  if (!Number.isInteger(number)) {
    throw new Error(`${label} must be an integer, got ${value}`);
  }
  return number;
}

function parseLevelTable(text, name) {
  const match = String(text).match(
    new RegExp(`data\\.${name}\\s*=\\s*\\{([^}]*)\\}`),
  );
  if (!match) throw new Error(`Missing ${name} in runtime Data/Misc.lua`);
  const values = [...match[1].matchAll(/-?\d+(?:\.\d+)?/g)].map((entry) =>
    Number(entry[0]),
  );
  if (!values.length || values.some((value) => !Number.isFinite(value))) {
    throw new Error(`Invalid ${name} in runtime Data/Misc.lua`);
  }
  return values;
}

function parseResistancePenalties(text) {
  const penalties = {};
  for (const match of String(text).matchAll(
    /\{\s*val\s*=\s*(-?\d+)\s*,\s*label\s*=\s*"([^"]+)"\s*\}/g,
  )) {
    const value = Number(match[1]);
    const label = match[2];
    const act = label.match(/\bAct\s+([1-6])\b/i)?.[1];
    if (act) penalties[`act${act}`] = value;
    if (/\bEndgame\b/i.test(label)) penalties.endgame = value;
  }
  for (const stage of LEVEL_STAGES) {
    if (!Number.isFinite(penalties[stage.key])) {
      throw new Error(
        `Runtime ConfigOptions.lua has no resistance penalty for ${stage.key}`,
      );
    }
  }
  return penalties;
}

function loadRuntimeScenarioData(runtimeDir) {
  const runtime = path.resolve(runtimeDir);
  const misc = fs.readFileSync(path.join(runtime, "Data", "Misc.lua"), "utf8");
  const configOptions = fs.readFileSync(
    path.join(runtime, "Modules", "ConfigOptions.lua"),
    "utf8",
  );
  return {
    armourTable: parseLevelTable(misc, "monsterArmourTable"),
    evasionTable: parseLevelTable(misc, "monsterEvasionTable"),
    penalties: parseResistancePenalties(configOptions),
  };
}

function stageForLevel(level) {
  const numeric = finiteInteger(level, "Progression level");
  if (numeric < 1) throw new Error("Progression level must be at least 1");
  return LEVEL_STAGES.find(
    (stage) => numeric >= stage.min && numeric <= stage.max,
  );
}

function transitionForLevel(level) {
  const numeric = finiteInteger(level, "Character level");
  const boundary = TRANSITION_LEVELS.find(
    (candidate) => Math.abs(numeric - candidate) <= 1,
  );
  if (!boundary) return null;
  const nextIndex = LEVEL_STAGES.findIndex((stage) => stage.min === boundary);
  const previous = LEVEL_STAGES[nextIndex - 1];
  const next = LEVEL_STAGES[nextIndex];
  return {
    code: "PROGRESSION_CONFIRMATION_REQUIRED",
    message:
      `Character level ${numeric} is near the ${previous.key}/${next.key} ` +
      "transition; confirm the current Act or area level.",
    characterLevel: numeric,
    boundary,
    choices: [previous.key, next.key],
  };
}

function stageForAct(act) {
  const numeric = finiteInteger(act, "Act");
  if (numeric < 1 || numeric > 6) {
    throw new Error(`Act must be between 1 and 6, got ${act}`);
  }
  return LEVEL_STAGES.find((stage) => stage.act === numeric);
}

function resolveProgression({
  characterLevel,
  act,
  areaLevel,
  resistancePenalty,
  penalties,
}) {
  const level = finiteInteger(characterLevel, "Character level");
  if (Number.isFinite(Number(resistancePenalty))) {
    return {
      stage: act !== undefined
        ? stageForAct(act).key
        : stageForLevel(areaLevel ?? level).key,
      act: act === undefined ? null : finiteInteger(act, "Act"),
      areaLevel: areaLevel === undefined
        ? null
        : finiteInteger(areaLevel, "Area level"),
      resistancePenalty: Number(resistancePenalty),
      source: "explicit-resistance-penalty",
      confidence: "explicit",
      confirmationRequired: null,
    };
  }

  if (act !== undefined) {
    const stage = stageForAct(act);
    return {
      stage: stage.key,
      act: stage.act,
      areaLevel: areaLevel === undefined
        ? null
        : finiteInteger(areaLevel, "Area level"),
      resistancePenalty: penalties[stage.key],
      source: "explicit-act",
      confidence: "explicit",
      confirmationRequired: null,
    };
  }

  if (areaLevel !== undefined) {
    const numericArea = finiteInteger(areaLevel, "Area level");
    const stage = stageForLevel(numericArea);
    return {
      stage: stage.key,
      act: stage.act,
      areaLevel: numericArea,
      resistancePenalty: penalties[stage.key],
      source: "explicit-area-level",
      confidence: "explicit",
      confirmationRequired: null,
    };
  }

  const confirmationRequired = transitionForLevel(level);
  const stage = stageForLevel(level);
  return {
    stage: stage.key,
    act: stage.act,
    areaLevel: null,
    resistancePenalty: penalties[stage.key],
    source: "character-level-heuristic",
    confidence: confirmationRequired ? "needs-confirmation" : "inferred",
    confirmationRequired,
  };
}

function resolveScenario(input) {
  const characterLevel = finiteInteger(input.characterLevel, "Character level");
  if (characterLevel < 1) throw new Error("Character level must be at least 1");
  const data = input.runtimeDir
    ? loadRuntimeScenarioData(input.runtimeDir)
    : {
        armourTable: input.armourTable,
        evasionTable: input.evasionTable,
        penalties: input.penalties,
      };
  if (!Array.isArray(data.armourTable) || !Array.isArray(data.evasionTable)) {
    throw new Error("Scenario resolver requires runtime armour/evasion tables");
  }
  const progression = resolveProgression({
    characterLevel,
    act: input.act,
    areaLevel: input.areaLevel,
    resistancePenalty: input.resistancePenalty,
    penalties: data.penalties,
  });
  const enemyLevel = finiteInteger(
    input.enemyLevel ?? input.areaLevel ?? characterLevel,
    "Enemy level",
  );
  const maximumLevel = Math.min(
    data.armourTable.length,
    data.evasionTable.length,
  );
  if (enemyLevel < 1 || enemyLevel > maximumLevel) {
    throw new Error(
      `Enemy level ${enemyLevel} is outside runtime table range 1-${maximumLevel}`,
    );
  }
  const enemyDistance = Number(input.enemyDistance ?? 20);
  if (!Number.isFinite(enemyDistance) || enemyDistance < 0) {
    throw new Error(`Enemy distance must be a non-negative number, got ${enemyDistance}`);
  }
  const expected = {
    enemyLevel,
    enemyEvasion: data.evasionTable[enemyLevel - 1],
    enemyArmour: data.armourTable[enemyLevel - 1],
    enemyDistance,
    resistancePenalty: progression.resistancePenalty,
  };
  return {
    expected,
    xmlScenario: {
      placeholders: {
        enemyLevel: expected.enemyLevel,
        enemyEvasion: expected.enemyEvasion,
        enemyArmour: expected.enemyArmour,
      },
      inputs: {
        enemyLevel: expected.enemyLevel,
        enemyEvasion: expected.enemyEvasion,
        enemyArmour: expected.enemyArmour,
        enemyDistance: expected.enemyDistance,
        resistancePenalty: expected.resistancePenalty,
      },
    },
    progression,
    tableSource: input.runtimeDir ? "runtime" : "provided",
  };
}

module.exports = {
  LEVEL_STAGES,
  TRANSITION_LEVELS,
  loadRuntimeScenarioData,
  parseLevelTable,
  parseResistancePenalties,
  resolveProgression,
  resolveScenario,
  stageForAct,
  stageForLevel,
  transitionForLevel,
};
