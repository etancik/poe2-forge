#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { PobClient, resolveRuntime } = require("./lib/pob-client");
const { resolveScenario } = require("./lib/scenario-resolver");
const {
  activeSavedScenario,
  effectiveScenario,
  parseSavedScenario,
  scenarioChecks,
} = require("./lib/passive-optimizer/scenario");

const METRICS = [
  "Life",
  "Armour",
  "Evasion",
  "EvadeChance",
  "TotalEHP",
  "FireResist",
  "ColdResist",
  "LightningResist",
  "ChaosResist",
  "PhysicalMaximumHitTaken",
  "FireMaximumHitTaken",
  "ColdMaximumHitTaken",
  "LightningMaximumHitTaken",
  "ChaosMaximumHitTaken",
  "TotalDPS",
  "AccuracyHitChance",
  "LifeLeechGainRate",
];

function parseArgs(argv) {
  const args = { goals: ["survival"], enemyDistance: 20 };
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--build") args.build = path.resolve(argv[++index]);
    else if (arg === "--baseline") args.baseline = path.resolve(argv[++index]);
    else if (arg === "--goals") args.goals = argv[++index].split(",");
    else if (arg === "--act") args.act = Number(argv[++index]);
    else if (arg === "--area-level") args.areaLevel = Number(argv[++index]);
    else if (arg === "--enemy-level") args.enemyLevel = Number(argv[++index]);
    else if (arg === "--enemy-distance") args.enemyDistance = Number(argv[++index]);
    else if (arg === "--resistance-penalty") {
      args.resistancePenalty = Number(argv[++index]);
    } else if (arg === "--current-runtime") args.currentRuntime = argv[++index];
    else if (arg === "--output") args.output = path.resolve(argv[++index]);
    else if (arg === "--full-stdout") args.fullStdout = true;
    else if (arg === "--quiet") args.quiet = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!args.build) throw new Error("Missing --build");
  return args;
}

function fileMetadata(file) {
  const bytes = fs.readFileSync(file);
  const text = bytes.toString("utf8");
  const buildTag = text.match(/<Build\b[^>]*>/i)?.[0] || "";
  const attributes = {};
  for (const match of buildTag.matchAll(/([A-Za-z][\w]*)="([^"]*)"/g)) {
    if (/^(level|className|ascendClassName|targetVersion|mainSocketGroup)$/i.test(match[1])) {
      attributes[match[1]] = match[2];
    }
  }
  return {
    path: file,
    bytes: bytes.length,
    modified: fs.statSync(file).mtime.toISOString(),
    sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
    buildAttributes: attributes,
    savedScenario: activeSavedScenario(parseSavedScenario(text)),
  };
}

function compactItems(items) {
  return (items || [])
    .filter((item) => item.id && item.slot)
    .map((item) => ({
      id: item.id,
      slot: item.slot,
      name: item.name,
      baseName: item.baseName,
      rarity: item.rarity,
      type: item.type,
      active: item.active,
      raw: item.raw,
    }));
}

function parseItem(item) {
  const raw = item.raw || "";
  const socketText = raw.match(/^Sockets:\s*(.+)$/m)?.[1] || "";
  const socketCount = (socketText.match(/\bS\b/g) || []).length;
  const runeLines = [...raw.matchAll(/^Rune:\s*(.+)$/gm)].map((match) =>
    match[1].trim(),
  );
  const explicitEmpty = runeLines.filter((rune) => rune === "None").length;
  const hasRuneEnchant = /^\{enchant\}\{rune\}/m.test(raw);
  const emptySockets = explicitEmpty ||
    (socketCount && !runeLines.length && !hasRuneEnchant ? socketCount : 0);
  const quality = Number(raw.match(/^Quality:\s*(\d+)/m)?.[1]);
  return {
    slot: item.slot,
    item: item.name,
    type: item.type,
    emptySockets,
    quality: Number.isFinite(quality) ? quality : null,
    corrupted: /^Corrupted$/m.test(raw),
    enchantState: /^\{enchant\}(?!\{rune\}).+$/m.test(raw)
      ? "present"
      : /^Corrupted$/m.test(raw)
        ? "locked-or-limited"
        : "none-detected",
  };
}

function completion(items, stats) {
  const needs = ["Fire", "Cold", "Lightning", "Chaos"]
    .map((element) => ({
      id: `${element.toLowerCase()}-resistance`,
      deficit: Math.max(0, 75 - Number(stats[`${element}Resist`])),
    }))
    .filter((need) => need.deficit > 0)
    .sort((left, right) => right.deficit - left.deficit);
  const opportunities = items
    .filter((item) => item.id && item.raw)
    .map(parseItem)
    .map((item) => ({
      ...item,
      qualityOpportunity:
        item.quality !== null &&
        item.quality < 20 &&
        !item.corrupted &&
        !["Ring", "Amulet", "Belt"].includes(item.type),
    }))
    .filter((item) => item.emptySockets || item.qualityOpportunity)
    .slice(0, 8);
  return { needs, opportunities };
}

function readBaseline(file) {
  if (!file) return null;
  if (!fs.existsSync(file)) throw new Error(`Baseline not found: ${file}`);
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function itemMap(items) {
  return new Map((items || []).map((item) => [item.slot, item.name]));
}

function buildDelta(previous, current, treeData) {
  if (!previous) return null;
  const metrics = {};
  for (const metric of METRICS) {
    const before = Number(previous.stats?.[metric] ?? previous.metrics?.[metric]);
    const after = Number(current.stats?.[metric]);
    if (!Number.isFinite(before) || !Number.isFinite(after) || before === after) continue;
    metrics[metric] = {
      before: Math.round(before * 100) / 100,
      after: Math.round(after * 100) / 100,
      delta: Math.round((after - before) * 100) / 100,
      percent: before === 0 ? null : Math.round((after / before - 1) * 1000) / 10,
    };
  }
  const oldNodes = new Set((previous.tree?.nodes || []).map(Number));
  const newNodes = new Set((current.tree?.nodes || []).map(Number));
  const describe = (id) => {
    const node = treeData.nodes?.[id];
    return {
      id,
      name: node?.name,
      ascendancy: node?.ascendancyName || null,
      stats: node?.stats || [],
    };
  };
  const oldItems = itemMap(previous.items);
  const newItems = itemMap(current.items);
  const changedItems = [];
  for (const slot of new Set([...oldItems.keys(), ...newItems.keys()])) {
    if (oldItems.get(slot) !== newItems.get(slot)) {
      changedItems.push({
        slot,
        before: oldItems.get(slot) || null,
        after: newItems.get(slot) || null,
      });
    }
  }
  return {
    level: {
      before: Number(previous.info?.level),
      after: Number(current.info?.level),
    },
    ascendancy: {
      before: previous.info?.ascendClassName,
      after: current.info?.ascendClassName,
    },
    metrics,
    tree: {
      added: [...newNodes].filter((id) => !oldNodes.has(id)).map(describe),
      removed: [...oldNodes].filter((id) => !newNodes.has(id)).map(describe),
    },
    items: changedItems,
  };
}

function compactDelta(delta) {
  if (!delta) return null;
  return {
    level: delta.level,
    ascendancy: delta.ascendancy,
    metrics: delta.metrics,
    tree: {
      addedCount: delta.tree.added.length,
      removedCount: delta.tree.removed.length,
      addedIds: delta.tree.added.map((node) => node.id),
      removedIds: delta.tree.removed.map((node) => node.id),
    },
    items: {
      changedCount: delta.items.length,
      slots: delta.items.map((item) => item.slot),
    },
  };
}

function staleSavedScenario(saved, expected) {
  return Object.entries(saved || {}).flatMap(([field, value]) =>
    expected[field] === undefined || Number(value) === Number(expected[field])
      ? []
      : [{ field, saved: Number(value), applied: Number(expected[field]) }],
  );
}

async function main() {
  const args = parseArgs(process.argv);
  const metadata = fileMetadata(args.build);
  const level = Number(metadata.buildAttributes.level);
  if (!Number.isFinite(level) || level < 1) throw new Error("Invalid build level");

  const runtime = resolveRuntime(args.currentRuntime);
  const scenario = resolveScenario({
    runtimeDir: runtime.runtime,
    characterLevel: level,
    act: args.act,
    areaLevel: args.areaLevel,
    enemyLevel: args.enemyLevel,
    enemyDistance: args.enemyDistance,
    resistancePenalty: args.resistancePenalty,
  });
  if (scenario.progression.confirmationRequired) {
    if (!args.quiet) {
      process.stdout.write(`${JSON.stringify({
        ok: false,
        requiresInput: true,
        input: "current-act-or-area-level",
        ...scenario.progression.confirmationRequired,
      }, null, 2)}\n`);
    }
    process.exitCode = 2;
    return;
  }

  const previous = readBaseline(args.baseline);
  const client = new PobClient(runtime);
  let result;
  try {
    await client.ready();
    await client.loadBuild(args.build, scenario.xmlScenario);
    await client.call("set_config", scenario.expected);
    const config = (await client.call("get_config")).config;
    const validation = scenarioChecks(
      scenario.expected,
      effectiveScenario(config),
    );
    const failures = validation.filter((check) => !check.passed);
    if (failures.length) {
      const error = new Error(
        `Effective scenario mismatch: ${failures
          .map((check) => `${check.field} expected ${check.expected}, got ${check.actual}`)
          .join("; ")}`,
      );
      error.code = "EFFECTIVE_SCENARIO_MISMATCH";
      throw error;
    }
    const info = (await client.call("get_build_info")).info;
    const stats = (await client.call("get_stats", { fields: METRICS })).stats;
    const tree = (await client.call("get_tree")).tree;
    const items = compactItems((await client.call("get_items")).items);
    const skills = (await client.call("get_skills")).skills;
    result = {
      trusted: true,
      file: metadata,
      info,
      stats,
      metrics: stats,
      config,
      tree,
      items,
      skills,
      scenario: scenario.expected,
      appliedScenario: scenario.expected,
      progression: scenario.progression,
      scenarioValidation: validation,
      runtime: {
        version: runtime.version,
        apiVersion: runtime.apiVersion,
        apiPatchVersion: runtime.apiPatchVersion,
      },
    };
  } finally {
    await client.close();
  }

  const date = new Date().toISOString().slice(0, 10);
  const snapshotId = `${date}-${metadata.sha256.slice(0, 8)}`;
  const outputFile = args.output || path.join(
    process.cwd(),
    "artifacts",
    `refresh-${snapshotId}.json`,
  );
  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  fs.writeFileSync(outputFile, `${JSON.stringify(result, null, 2)}\n`);

  let treeData = { nodes: {} };
  if (previous) {
    const treeFile = path.join(
      runtime.runtime,
      "TreeData",
      result.tree.treeVersion,
      "tree.json",
    );
    treeData = JSON.parse(fs.readFileSync(treeFile, "utf8"));
  }
  const delta = buildDelta(previous, result, treeData);
  const itemCompletion = completion(result.items, result.stats);
  const summary = {
    ok: true,
    changed: previous ? previous.file?.sha256 !== metadata.sha256 : null,
    snapshot: snapshotId,
    previousSnapshot: args.baseline ? path.basename(args.baseline) : null,
    build: {
      hash: metadata.sha256.slice(0, 12),
      level: result.info.level,
      class: result.info.className,
      ascendancy: result.info.ascendClassName,
    },
    scenario: result.appliedScenario,
    progression: result.progression,
    scenarioValid: true,
    correctedSavedFields: staleSavedScenario(
      metadata.savedScenario,
      result.appliedScenario,
    ),
    delta: compactDelta(delta),
    itemCompletion: {
      needs: itemCompletion.needs,
      opportunityCount: itemCompletion.opportunities.length,
      opportunitySlots: itemCompletion.opportunities.map((item) => item.slot),
    },
    artifact: outputFile,
  };
  if (!args.quiet) {
    process.stdout.write(
      `${JSON.stringify(args.fullStdout ? { summary, result } : summary, null, 2)}\n`,
    );
  }
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  METRICS,
  buildDelta,
  compactDelta,
  completion,
  fileMetadata,
  main,
  parseArgs,
  staleSavedScenario,
};
