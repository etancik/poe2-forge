#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const { resolveRuntime } = require("./lib/pob-client");

function parseArgs(argv) {
  const args = {
    pattern:
      "maximum Life|Armour|Evasion|Resistance|Damage taken|Totem|Movement Speed",
    maxCost: 6,
    top: 6,
  };
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--baseline") args.baseline = path.resolve(argv[++index]);
    else if (arg === "--pattern") args.pattern = argv[++index];
    else if (arg === "--max-cost") args.maxCost = Number(argv[++index]);
    else if (arg === "--top") args.top = Number(argv[++index]);
    else if (arg === "--output") args.output = path.resolve(argv[++index]);
    else if (arg === "--current-runtime") args.currentRuntime = argv[++index];
    else if (arg === "--full-stdout") args.fullStdout = true;
    else if (arg === "--quiet") args.quiet = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!args.baseline) throw new Error("Missing --baseline");
  return args;
}

function main() {
  const args = parseArgs(process.argv);
  const baseline = JSON.parse(fs.readFileSync(args.baseline, "utf8"));
  const runtime = resolveRuntime(args.currentRuntime);
  const treeVersion = baseline.tree?.treeVersion;
  if (!treeVersion) throw new Error("Baseline has no tree version");
  const treeFile = path.join(
    runtime.runtime,
    "TreeData",
    treeVersion,
    "tree.json",
  );
  const tree = JSON.parse(fs.readFileSync(treeFile, "utf8"));
  const current = new Set((baseline.tree.nodes || []).map(Number));
  const nodes = new Map(
    Object.entries(tree.nodes).map(([id, node]) => [Number(id), node]),
  );
  const adjacency = new Map();
  for (const [id, node] of nodes) {
    if (!adjacency.has(id)) adjacency.set(id, new Set());
    for (const connection of node.connections || []) {
      const next = Number(connection.id);
      if (!adjacency.has(next)) adjacency.set(next, new Set());
      adjacency.get(id).add(next);
      adjacency.get(next).add(id);
    }
  }
  const shortestPath = (target) => {
    if (current.has(target)) return [];
    const queue = [...current];
    const previous = new Map();
    const seen = new Set(queue);
    while (queue.length) {
      const id = queue.shift();
      for (const next of adjacency.get(id) || []) {
        if (seen.has(next)) continue;
        const node = nodes.get(next);
        if (!node || node.ascendancyName || node.isOnlyImage) continue;
        seen.add(next);
        previous.set(next, id);
        if (next === target) {
          const pathIds = [];
          let step = next;
          while (!current.has(step)) {
            pathIds.push(step);
            step = previous.get(step);
          }
          return pathIds.reverse();
        }
        queue.push(next);
      }
    }
    return null;
  };
  const regex = new RegExp(args.pattern, "i");
  const candidates = [];
  for (const [id, node] of nodes) {
    if (current.has(id) || node.ascendancyName || node.isOnlyImage) continue;
    const text = `${node.name || ""}\n${(node.stats || []).join("\n")}`;
    if (!regex.test(text)) continue;
    const route = shortestPath(id);
    if (!route || route.length > args.maxCost) continue;
    candidates.push({
      id,
      name: node.name,
      cost: route.length,
      notable: Boolean(node.isNotable),
      keystone: Boolean(node.isKeystone),
      stats: node.stats || [],
      path: route.map((pathId) => ({
        id: pathId,
        name: nodes.get(pathId)?.name,
        stats: nodes.get(pathId)?.stats || [],
      })),
    });
  }
  candidates.sort(
    (left, right) =>
      left.cost - right.cost ||
      Number(right.notable) - Number(left.notable) ||
      left.name.localeCompare(right.name),
  );
  const leaves = [...current]
    .map((id) => {
      const node = nodes.get(id);
      const degree = [...(adjacency.get(id) || [])].filter((next) =>
        current.has(next),
      ).length;
      return {
        id,
        name: node?.name,
        degree,
        notable: Boolean(node?.isNotable),
        stats: node?.stats || [],
      };
    })
    .filter((node) => node.degree <= 1)
    .sort(
      (left, right) =>
        left.degree - right.degree ||
        Number(left.notable) - Number(right.notable) ||
        left.name.localeCompare(right.name),
    );
  const result = {
    baseline: path.basename(args.baseline),
    treeVersion,
    currentNodeCount: current.size,
    pattern: args.pattern,
    maxCost: args.maxCost,
    leaves,
    candidates,
  };
  if (args.output) {
    fs.mkdirSync(path.dirname(args.output), { recursive: true });
    fs.writeFileSync(args.output, `${JSON.stringify(result, null, 2)}\n`);
  }
  if (!args.quiet) {
    const stdoutValue = args.fullStdout
      ? result
      : {
          currentNodeCount: current.size,
          removableLeaves: leaves.slice(0, 6).map((leaf) => ({
            id: leaf.id,
            name: leaf.name,
            notable: leaf.notable,
            stats: leaf.stats.join(" | "),
          })),
          candidates: candidates.slice(0, args.top).map((candidate) => ({
            id: candidate.id,
            name: candidate.name,
            cost: candidate.cost,
            notable: candidate.notable,
            stats: candidate.stats.join(" | "),
          })),
          omittedCandidates: Math.max(0, candidates.length - args.top),
          output: args.output ? path.basename(args.output) : null,
        };
    process.stdout.write(`${JSON.stringify(stdoutValue, null, 2)}\n`);
  }
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
}
