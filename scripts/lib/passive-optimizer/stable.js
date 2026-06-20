"use strict";

const crypto = require("crypto");

function normalizeScalar(value) {
  if (value === undefined) return null;
  if (typeof value === "number" && !Number.isFinite(value)) return null;
  return value;
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stableValue(value[key])]),
    );
  }
  return normalizeScalar(value);
}

function stableStringify(value) {
  return JSON.stringify(stableValue(value));
}

function sha256(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function sortedUniqueNumbers(values) {
  return [
    ...new Set([...values || []].map(Number).filter(Number.isFinite)),
  ].sort(
    (left, right) => left - right,
  );
}

function sortedObject(value, normalizeValue = (entry) => entry) {
  return Object.fromEntries(
    Object.entries(value || {})
      .sort(([left], [right]) => String(left).localeCompare(String(right)))
      .map(([key, entry]) => [key, normalizeValue(entry)]),
  );
}

module.exports = {
  sha256,
  sortedObject,
  sortedUniqueNumbers,
  stableStringify,
  stableValue,
};
