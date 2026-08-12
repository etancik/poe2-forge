#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { compactError, parseJsonOutput, stringifyPacket } = require("./lib/packet-output");

const HELP = `PoE2 Forge calculator dispatcher

Usage: node scripts/poe2-forge.js <command> [arguments]

Commands:
  refresh      Validate scenario and write a trusted baseline
  inspect      Read selected build sections and metrics
  tree         Find nearby passive nodes and removable leaves
  items        Inspect bounded item completion opportunities
  experiment   Run controlled non-persistent variants
  directed     Measure explicit legal passive deltas non-mutating
  passive      Run or report passive optimizer work

Shared options:
  --stdout-mode packet|silent|debug   Default: packet
  --purpose preflight|passive|gear|layers|survival

Packet output is bounded. Raw artifacts are machine-only: never open them in
full; query them through a report command. Debug output must be explicit.
All output/cache paths must stay below the current working directory.`;

const COMMANDS = {
  refresh: "refresh-build.js",
  inspect: "inspect-build.js",
  tree: "inspect-tree.js",
  items: "inspect-item-opportunities.js",
  experiment: "run-experiment.js",
  directed: "directed-passive.js",
  passive: "passive-optimizer.js",
};
const PURPOSES = new Set(["preflight", "passive", "gear", "layers", "survival"]);
const WRITE_FLAGS = new Set(["--output", "--raw", "--cache", "--checkpoint", "--summary"]);
const PURPOSE_METRICS = {
  preflight: ["Life", "TotalEHP", "TotalDPS"],
  passive: ["Life", "TotalEHP", "Armour", "Evasion", "TotalDPS", "PhysicalMaximumHitTaken"],
  gear: ["Life", "TotalEHP", "Armour", "Evasion", "FireResist", "ColdResist", "LightningResist", "ChaosResist"],
  layers: ["Life", "TotalEHP", "TotalDPS"],
  survival: ["Life", "TotalEHP", "Armour", "Evasion", "PhysicalMaximumHitTaken", "FireMaximumHitTaken", "ColdMaximumHitTaken", "LightningMaximumHitTaken", "ChaosMaximumHitTaken"],
};
const PURPOSE_SECTIONS = {
  preflight: "info,stats",
  passive: "info,stats,tree",
  gear: "info,stats,items",
  layers: "info,stats,skills,items,tree",
  survival: "info,stats",
};

function parseWrapperArgs(argv) {
  if (argv.includes("--help") || argv.includes("-h") || !argv[2]) return { help: true };
  const command = argv[2];
  if (!COMMANDS[command]) throw new Error(`Unknown command: ${command}`);
  let mode = "packet";
  let purpose = command === "refresh" ? "preflight" : null;
  const args = [];
  for (let index = 3; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--stdout-mode") mode = argv[++index];
    else if (arg === "--purpose") purpose = argv[++index];
    else if (arg === "--quiet") mode = "silent";
    else if (arg === "--full-stdout") mode = "debug";
    else args.push(arg);
  }
  if (!["packet", "silent", "debug"].includes(mode)) throw new Error(`Invalid stdout mode: ${mode}`);
  if (purpose && !PURPOSES.has(purpose)) throw new Error(`Invalid purpose: ${purpose}`);
  return { command, args, mode, purpose };
}

function hasFlag(args, flag) {
  return args.includes(flag);
}

function applyPurpose(command, args, purpose) {
  if (command !== "inspect" || !purpose) return [...args];
  const result = [...args];
  if (!hasFlag(result, "--metrics")) result.push("--metrics", PURPOSE_METRICS[purpose].join(","));
  if (!hasFlag(result, "--sections")) result.push("--sections", PURPOSE_SECTIONS[purpose]);
  return result;
}

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function validateWritePaths(args, cwd) {
  for (let index = 0; index < args.length; index += 1) {
    if (!WRITE_FLAGS.has(args[index])) continue;
    const value = args[index + 1];
    if (!value) throw new Error(`${args[index]} requires a path`);
    if (!inside(cwd, path.resolve(cwd, value))) {
      throw new Error(`${args[index]} must stay below the current working directory`);
    }
    index += 1;
  }
}

function validateExperiment(command, args) {
  if (command !== "experiment") return;
  const specArg = args.find((arg) => !arg.startsWith("-"));
  if (!specArg || !fs.existsSync(path.resolve(specArg))) return;
  const spec = JSON.parse(fs.readFileSync(path.resolve(specArg), "utf8"));
  const actions = [
    ...(spec.scenarioActions || []),
    ...(spec.variants || []).flatMap((variant) => variant.actions || []),
  ];
  for (const entry of actions) {
    const action = String(entry.action || "");
    if (["update_tree_delta", "set_tree"].includes(action)) {
      throw new Error("Passive tree actions require the directed command");
    }
    if (!/^(set|update)_/.test(action) || /(file|path|save|write|export|delete)/i.test(action)) {
      throw new Error(`Experiment action is not approved for the safe dispatcher: ${action}`);
    }
  }
}

function childArgsFor(parsed) {
  const args = applyPurpose(parsed.command, parsed.args, parsed.purpose);
  if (parsed.command === "tree" && !hasFlag(args, "--top")) args.push("--top", "3");
  if (parsed.command === "items" && !hasFlag(args, "--top")) args.push("--top", "3");
  if (parsed.command === "passive") {
    args.push("--stdout-mode", parsed.mode === "debug" ? "debug" : parsed.mode === "silent" ? "silent" : "compact");
  } else if (parsed.mode === "debug") args.push("--full-stdout");
  else if (parsed.mode === "silent") args.push("--quiet");
  return args;
}

function run(argv = process.argv, options = {}) {
  const parsed = parseWrapperArgs(argv);
  if (parsed.help) {
    process.stdout.write(`${HELP}\n`);
    return 0;
  }
  const cwd = path.resolve(options.cwd || process.cwd());
  const childArgs = childArgsFor(parsed);
  validateWritePaths(childArgs, cwd);
  validateExperiment(parsed.command, childArgs);
  const script = path.join(__dirname, COMMANDS[parsed.command]);
  const result = spawnSync(process.execPath, [script, ...childArgs], {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    env: process.env,
  });
  if (parsed.mode === "debug") {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    return result.status ?? 1;
  }
  if (parsed.mode === "silent") return result.status ?? 1;
  const value = parseJsonOutput(result.stdout);
  if (result.status === 0 || value?.requiresInput || value?.requiresApproval) {
    process.stdout.write(
      value
        ? stringifyPacket(parsed.command, value, { purpose: parsed.purpose })
        : stringifyPacket(parsed.command, { ok: true, output: String(result.stdout || "").trim() }),
    );
    return result.status ?? 0;
  }
  process.stdout.write(stringifyPacket(
    parsed.command,
    compactError(parsed.command, result.stderr, result.stdout),
  ));
  return result.status ?? 1;
}

if (require.main === module) {
  try {
    process.exitCode = run();
  } catch (error) {
    process.stdout.write(stringifyPacket("dispatcher", {
      ok: false,
      command: "dispatcher",
      error: error.message,
    }));
    process.exitCode = 1;
  }
}

module.exports = {
  HELP,
  applyPurpose,
  parseWrapperArgs,
  run,
  validateExperiment,
  validateWritePaths,
};
