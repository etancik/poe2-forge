#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const SKILL_NAME = "calculator-backed-build-optimizer";
const INSTALL_ROOTS = [
  "SKILL.md",
  "agents",
  "data",
  "examples",
  "references",
  "scripts",
];
const PRESERVED_TARGET_FILES = new Set([
  "config.local.json",
  ".install-manifest.json",
]);

function parseArgs(argv) {
  const args = { mode: "check" };
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--check") args.mode = "check";
    else if (arg === "--apply") args.mode = "apply";
    else if (arg === "--target") args.target = path.resolve(argv[++index]);
    else if (arg === "--runtime-manifest") {
      args.runtimeManifest = path.resolve(argv[++index]);
    } else if (arg === "--tree-snapshot") {
      args.treeSnapshot = path.resolve(argv[++index]);
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  args.target ||= path.join(os.homedir(), ".codex", "skills", SKILL_NAME);
  if (path.basename(args.target).toLowerCase() !== SKILL_NAME) {
    throw new Error(
      `Refusing target whose final directory is not ${SKILL_NAME}: ${args.target}`,
    );
  }
  return args;
}

function hash(file) {
  return crypto
    .createHash("sha256")
    .update(fs.readFileSync(file))
    .digest("hex");
}

function walk(root, relative = "") {
  const directory = path.join(root, relative);
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) return walk(root, child);
    return [child.replaceAll("\\", "/")];
  });
}

function sourceFiles() {
  return INSTALL_ROOTS.flatMap((entry) => {
    const full = path.join(ROOT, entry);
    if (!fs.existsSync(full)) return [];
    if (fs.statSync(full).isFile()) return [entry];
    return walk(ROOT, entry);
  }).filter((file) => !file.endsWith(".stage-original"));
}

function compare(target) {
  const source = sourceFiles();
  const targetFiles = fs.existsSync(target) ? walk(target) : [];
  const missing = [];
  const changed = [];
  for (const file of source) {
    const installed = path.join(target, file);
    if (!fs.existsSync(installed)) missing.push(file);
    else if (hash(path.join(ROOT, file)) !== hash(installed)) changed.push(file);
  }
  const expected = new Set(source);
  const extra = targetFiles.filter(
    (file) =>
      !expected.has(file) &&
      !PRESERVED_TARGET_FILES.has(file.replaceAll("\\", "/")),
  );
  return { clean: !missing.length && !changed.length && !extra.length, missing, changed, extra };
}

function ensureConfig(args, stage) {
  const existing = path.join(args.target, "config.local.json");
  const staged = path.join(stage, "config.local.json");
  if (args.runtimeManifest || args.treeSnapshot) {
    if (!args.runtimeManifest || !args.treeSnapshot) {
      throw new Error(
        "Pass both --runtime-manifest and --tree-snapshot when creating config.local.json",
      );
    }
    for (const [label, value] of [
      ["Runtime manifest", args.runtimeManifest],
      ["Tree snapshot", args.treeSnapshot],
    ]) {
      if (!fs.existsSync(value)) throw new Error(`${label} not found: ${value}`);
    }
    fs.writeFileSync(staged, `${JSON.stringify({
      pobRuntimeManifest: args.runtimeManifest,
      treeSnapshot: args.treeSnapshot,
    }, null, 2)}\n`);
    return;
  }
  if (fs.existsSync(existing)) {
    fs.copyFileSync(existing, staged);
    return;
  }
  throw new Error(
    "Installed config is missing. Pass --runtime-manifest and --tree-snapshot.",
  );
}

function apply(args) {
  const parent = path.dirname(args.target);
  fs.mkdirSync(parent, { recursive: true });
  const stage = path.join(parent, `.${SKILL_NAME}.stage-${process.pid}`);
  const backup = path.join(parent, `.${SKILL_NAME}.backup-${process.pid}`);
  if (fs.existsSync(stage) || fs.existsSync(backup)) {
    throw new Error("Refusing to reuse an existing install stage or backup");
  }
  fs.mkdirSync(stage);
  try {
    for (const file of sourceFiles()) {
      const destination = path.join(stage, file);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(path.join(ROOT, file), destination);
    }
    ensureConfig(args, stage);
    fs.writeFileSync(
      path.join(stage, ".install-manifest.json"),
      `${JSON.stringify({
        skill: SKILL_NAME,
        installedAt: new Date().toISOString(),
        files: sourceFiles(),
      }, null, 2)}\n`,
    );
    if (fs.existsSync(args.target)) fs.renameSync(args.target, backup);
    try {
      fs.renameSync(stage, args.target);
    } catch (error) {
      if (fs.existsSync(backup)) fs.renameSync(backup, args.target);
      throw error;
    }
    if (fs.existsSync(backup)) fs.rmSync(backup, { recursive: true, force: true });
  } catch (error) {
    if (fs.existsSync(stage)) fs.rmSync(stage, { recursive: true, force: true });
    throw error;
  }
  return compare(args.target);
}

function main() {
  const args = parseArgs(process.argv);
  const report = args.mode === "apply" ? apply(args) : compare(args.target);
  process.stdout.write(`${JSON.stringify({
    ok: report.clean,
    mode: args.mode,
    target: args.target,
    ...report,
  }, null, 2)}\n`);
  if (!report.clean) process.exitCode = 1;
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { compare, parseArgs, sourceFiles };
