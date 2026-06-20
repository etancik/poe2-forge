"use strict";

const fs = require("node:fs");
const path = require("node:path");

const REPOSITORY_ROOT = path.resolve(__dirname, "../..");
const LOCAL_CONFIG = path.join(REPOSITORY_ROOT, "config.local.json");

function readJson(file, label) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`Cannot read ${label} at ${file}: ${error.message}`);
  }
}

function loadPortableConfig(explicitPath) {
  const explicit = explicitPath ? path.resolve(explicitPath) : null;
  const environment = process.env.CBB_OPTIMIZER_CONFIG
    ? path.resolve(process.env.CBB_OPTIMIZER_CONFIG)
    : null;
  const selected = explicit || environment ||
    (fs.existsSync(LOCAL_CONFIG) ? LOCAL_CONFIG : null);
  if (!selected) return { data: {}, path: null, source: "none" };
  if (!fs.existsSync(selected)) {
    throw new Error(
      `Optimizer config not found: ${selected}. ` +
      "Set --config/CBB_OPTIMIZER_CONFIG to an existing JSON file.",
    );
  }
  return {
    data: readJson(selected, "optimizer config"),
    path: selected,
    source: explicit ? "explicit" : environment ? "environment" : "default",
  };
}

function configPathValue(config, key) {
  const value = config.data?.[key];
  if (!value) return null;
  const base = config.path ? path.dirname(config.path) : process.cwd();
  return path.resolve(base, value);
}

function firstValue(values) {
  return values.find((value) =>
    value !== undefined && value !== null && String(value).trim() !== ""
  );
}

function orderedValue({ explicit, config, configKey, environment }) {
  const configValue = configPathValue(config, configKey);
  return config.source === "explicit"
    ? firstValue([explicit, configValue, environment])
    : firstValue([explicit, environment, configValue]);
}

function existingDirectory(value, label) {
  if (!value) return null;
  const resolved = path.resolve(value);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw new Error(`${label} is not a directory: ${resolved}`);
  }
  return resolved;
}

function discoverFirst(candidates, predicate) {
  return candidates.find((candidate) => {
    try {
      return predicate(candidate);
    } catch {
      return false;
    }
  }) || null;
}

function resolveTreeSnapshot(explicitPath, options = {}) {
  const config = loadPortableConfig(options.configPath);
  const configured = orderedValue({
    explicit: explicitPath,
    config,
    configKey: "treeSnapshot",
    environment: process.env.POE2_TREE_SNAPSHOT,
  });
  if (configured) return existingDirectory(configured, "PoE2 tree snapshot");
  const discovered = discoverFirst([
    path.join(REPOSITORY_ROOT, "external", "poe2-tree", "current"),
    path.join(process.cwd(), "external", "poe2-tree", "current"),
  ], (candidate) =>
    fs.existsSync(path.join(candidate, "manifest.json")) &&
    fs.existsSync(path.join(candidate, "data.json"))
  );
  if (discovered) return discovered;
  throw new Error(
    "PoE2 tree data was not found. Pass --snapshot, set " +
    "POE2_TREE_SNAPSHOT, add treeSnapshot to config.local.json, or place " +
    "manifest.json and data.json under external/poe2-tree/current.",
  );
}

module.exports = {
  LOCAL_CONFIG,
  REPOSITORY_ROOT,
  configPathValue,
  loadPortableConfig,
  orderedValue,
  resolveTreeSnapshot,
};
