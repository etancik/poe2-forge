"use strict";

const { sha256, stableStringify } = require("./stable");

const SCENARIO_FIELDS = Object.freeze([
  "enemyLevel",
  "enemyEvasion",
  "enemyArmour",
  "resistancePenalty",
  "enemyDistance",
]);

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeScenario(input = {}) {
  return Object.fromEntries(
    SCENARIO_FIELDS.flatMap((field) => {
      const value = finiteNumber(input?.[field]);
      return value === null ? [] : [[field, value]];
    }),
  );
}

function parseSavedScenario(xml) {
  const inputs = {};
  const placeholders = {};
  for (const match of String(xml).matchAll(
    /<(Input|Placeholder)\b([^>]*)\/>/gi,
  )) {
    const target = match[1].toLowerCase() === "input" ? inputs : placeholders;
    const attributes = match[2];
    const field = attributes.match(/\bname="([^"]+)"/i)?.[1];
    const number = attributes.match(/\bnumber="([^"]+)"/i)?.[1];
    if (SCENARIO_FIELDS.includes(field) && number !== undefined) {
      target[field] = finiteNumber(number);
    }
  }
  return {
    inputs: normalizeScenario(inputs),
    placeholders: normalizeScenario(placeholders),
  };
}

function effectiveScenario(config = {}) {
  return normalizeScenario({
    enemyLevel: config.enemyLevel,
    enemyEvasion: config.enemyEvasion,
    enemyArmour: config.enemyArmour,
    resistancePenalty: config.resistancePenalty,
    enemyDistance: config.enemyDistance,
  });
}

function activeSavedScenario(saved = {}) {
  return normalizeScenario(Object.fromEntries(
    SCENARIO_FIELDS.flatMap((field) => {
      const value = saved.inputs?.[field] ?? saved.placeholders?.[field];
      return value === undefined ? [] : [[field, value]];
    }),
  ));
}

function compareScenario(expectedInput, actualInput, prefix) {
  const expected = normalizeScenario(expectedInput);
  const actual = normalizeScenario(actualInput);
  return Object.entries(expected).flatMap(([field, value]) =>
    actual[field] === value
      ? []
      : [{
          field: `${prefix}.${field}`,
          expected: value,
          actual: actual[field] ?? null,
        }],
  );
}

function verifySavedScenario(xml, expectedInput) {
  const expected = normalizeScenario(expectedInput);
  const saved = parseSavedScenario(xml);
  const active = activeSavedScenario(saved);
  const mismatches = compareScenario(expected, active, "saved.active");
  const warnings = SCENARIO_FIELDS.flatMap((field) => {
    if (
      Object.hasOwn(saved.inputs, field) &&
      Object.hasOwn(saved.placeholders, field) &&
      saved.inputs[field] !== saved.placeholders[field]
    ) {
      return [{
        code: "SHADOWED_PLACEHOLDER_DIFFERS",
        field,
        active: saved.inputs[field],
        placeholder: saved.placeholders[field],
      }];
    }
    return [];
  });
  return {
    expected,
    saved,
    active,
    mismatches,
    warnings,
    valid: mismatches.length === 0,
  };
}

async function applyAndVerifyScenario(client, xml, expectedInput) {
  const savedReport = verifySavedScenario(xml, expectedInput);
  if (!savedReport.valid) {
    const error = new Error(
      `Saved scenario mismatch: ${savedReport.mismatches
        .map((entry) =>
          `${entry.field} expected ${entry.expected}, got ${entry.actual}`)
        .join("; ")}`,
    );
    error.code = "SAVED_SCENARIO_MISMATCH";
    error.scenario = savedReport;
    throw error;
  }
  const expected = savedReport.expected;
  if (Object.keys(expected).length) {
    await client.call("set_config", expected);
  }
  const config = (await client.call("get_config")).config;
  const effective = effectiveScenario(config);
  const mismatches = compareScenario(expected, effective, "effective");
  if (mismatches.length) {
    const error = new Error(
      `Effective scenario mismatch: ${mismatches
        .map((entry) =>
          `${entry.field} expected ${entry.expected}, got ${entry.actual}`)
        .join("; ")}`,
    );
    error.code = "EFFECTIVE_SCENARIO_MISMATCH";
    error.scenario = { ...savedReport, effective, mismatches };
    throw error;
  }
  const normalized = { saved: savedReport.active, effective };
  return {
    ...savedReport,
    effective,
    scenarioHash: sha256(stableStringify(normalized)),
  };
}

module.exports = {
  SCENARIO_FIELDS,
  applyAndVerifyScenario,
  activeSavedScenario,
  effectiveScenario,
  normalizeScenario,
  parseSavedScenario,
  verifySavedScenario,
};
