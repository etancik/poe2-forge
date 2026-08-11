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

function scenarioChecks(expectedInput, actualInput, prefix = "effective") {
  const expected = normalizeScenario(expectedInput);
  const actual = normalizeScenario(actualInput);
  return Object.entries(expected).map(([field, value]) => ({
    field: `${prefix}.${field}`,
    expected: value,
    actual: actual[field] ?? null,
    passed: actual[field] === value,
  }));
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

function scenarioFromValidatedBaseline(baseline, buildIdentity = {}) {
  if (!baseline || baseline.trusted !== true) {
    throw new Error(
      "Exact passive evaluation requires a trusted refresh-build baseline.",
    );
  }
  const baselineHash = baseline.file?.sha256;
  const buildHash = buildIdentity?.sha256;
  if (baselineHash && buildHash && baselineHash !== buildHash) {
    throw new Error(
      `Baseline build hash ${baselineHash} does not match imported build ${buildHash}.`,
    );
  }
  const scenario = normalizeScenario(baseline.config);
  const required = [
    "enemyLevel",
    "enemyEvasion",
    "enemyArmour",
    "resistancePenalty",
    "enemyDistance",
  ];
  const missing = required.filter((field) => !Object.hasOwn(scenario, field));
  if (missing.length) {
    throw new Error(
      `Trusted baseline is missing scenario fields: ${missing.join(", ")}.`,
    );
  }
  return scenario;
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
  const checks = scenarioChecks(expected, effective, "effective");
  const mismatches = checks.filter((check) => !check.passed);
  if (mismatches.length) {
    const error = new Error(
      `Effective scenario mismatch: ${mismatches
        .map((entry) =>
          `${entry.field} expected ${entry.expected}, got ${entry.actual}`)
        .join("; ")}`,
    );
    error.code = "EFFECTIVE_SCENARIO_MISMATCH";
    error.scenario = { ...savedReport, effective, checks, mismatches };
    throw error;
  }
  const normalized = { saved: savedReport.active, effective };
  return {
    ...savedReport,
    effective,
    checks,
    scenarioHash: sha256(stableStringify(normalized)),
  };
}

module.exports = {
  SCENARIO_FIELDS,
  applyAndVerifyScenario,
  activeSavedScenario,
  compareScenario,
  effectiveScenario,
  normalizeScenario,
  parseSavedScenario,
  scenarioChecks,
  scenarioFromValidatedBaseline,
  verifySavedScenario,
};
