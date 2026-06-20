#!/usr/bin/env node
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const {
  PobClient,
  resolveRuntime,
} = require("./lib/pob-client");

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
  const args = {
    goals: ["survival"],
    enemyDistance: 20,
    resistancePenalty: -20,
    updateRoadmap: true,
  };
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--build") args.build = path.resolve(argv[++index]);
    else if (arg === "--root") args.root = path.resolve(argv[++index]);
    else if (arg === "--goals") args.goals = argv[++index].split(",");
    else if (arg === "--enemy-distance") args.enemyDistance = Number(argv[++index]);
    else if (arg === "--resistance-penalty") args.resistancePenalty = Number(argv[++index]);
    else if (arg === "--current-runtime") args.currentRuntime = argv[++index];
    else if (arg === "--output") args.output = path.resolve(argv[++index]);
    else if (arg === "--no-update-roadmap") args.updateRoadmap = false;
    else if (arg === "--full-stdout") args.fullStdout = true;
    else if (arg === "--quiet") args.quiet = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!args.build) throw new Error("Missing --build");
  if (!args.root) throw new Error("Missing --root");
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
  };
}

function parseLevelTable(file, name) {
  const text = fs.readFileSync(file, "utf8");
  const match = text.match(new RegExp(`data\\.${name}\\s*=\\s*\\{([^}]*)\\}`));
  if (!match) throw new Error(`Missing ${name} in ${file}`);
  return [...match[1].matchAll(/\d+/g)].map((entry) => Number(entry[0]));
}

function readCharacter(root) {
  const file = path.join(root, "character.yaml");
  const text = fs.readFileSync(file, "utf8");
  const field = (name) =>
    text.match(new RegExp(`^${name}:\\s*(.+)$`, "m"))?.[1]?.trim();
  return {
    file,
    text,
    activeBaseline: field("active_baseline"),
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
  const emptySockets =
    explicitEmpty ||
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

function readBaseline(root, id) {
  if (!id) return null;
  const file = path.join(root, "baselines", `${id}.json`);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function itemMap(items) {
  return new Map((items || []).map((item) => [item.slot, item.name]));
}

function buildDelta(previous, current, treeData) {
  if (!previous) return null;
  const metrics = {};
  for (const metric of METRICS) {
    const before = Number(previous.stats?.[metric]);
    const after = Number(current.stats?.[metric]);
    if (!Number.isFinite(before) || !Number.isFinite(after) || before === after) continue;
    metrics[metric] = {
      before: Math.round(before * 100) / 100,
      after: Math.round(after * 100) / 100,
      delta: Math.round((after - before) * 100) / 100,
      percent:
        before === 0 ? null : Math.round(((after / before - 1) * 1000)) / 10,
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

function updateCharacter(character, baselineId, date) {
  let text = character.text;
  text = /^active_baseline:.*$/m.test(text)
    ? text.replace(/^active_baseline:.*$/m, `active_baseline: ${baselineId}`)
    : `${text.trimEnd()}\nactive_baseline: ${baselineId}\n`;
  text = /^last_reviewed:.*$/m.test(text)
    ? text.replace(/^last_reviewed:.*$/m, `last_reviewed: ${date}`)
    : `${text.trimEnd()}\nlast_reviewed: ${date}\n`;
  fs.writeFileSync(character.file, text);
}

async function main() {
  const args = parseArgs(process.argv);
  const metadata = fileMetadata(args.build);
  const level = Number(metadata.buildAttributes.level);
  if (!Number.isFinite(level) || level < 1) throw new Error("Invalid build level");

  const runtime = resolveRuntime(args.currentRuntime);
  const misc = path.join(runtime.runtime, "Data", "Misc.lua");
  const enemyEvasion = parseLevelTable(misc, "monsterEvasionTable")[level - 1];
  const enemyArmour = parseLevelTable(misc, "monsterArmourTable")[level - 1];
  if (!Number.isFinite(enemyEvasion) || !Number.isFinite(enemyArmour)) {
    throw new Error(`No enemy scenario values for level ${level}`);
  }

  const character = readCharacter(args.root);
  const previous = readBaseline(args.root, character.activeBaseline);
  const client = new PobClient(runtime);
  let result;
  try {
    await client.ready();
    await client.loadBuild(args.build, {
      placeholders: { enemyLevel: level, enemyEvasion, enemyArmour },
      inputs: {
        enemyDistance: args.enemyDistance,
        resistancePenalty: args.resistancePenalty,
      },
    });
    await client.call("set_config", { enemyLevel: level, enemyEvasion, enemyArmour });
    const config = (await client.call("get_config")).config;
    const info = (await client.call("get_build_info")).info;
    const stats = (await client.call("get_stats", { fields: METRICS })).stats;
    const tree = (await client.call("get_tree")).tree;
    const items = compactItems((await client.call("get_items")).items);
    const skills = (await client.call("get_skills")).skills;
    result = {
      file: metadata,
      info,
      stats,
      config,
      tree,
      items,
      skills,
      appliedScenario: {
        enemyLevel: level,
        enemyEvasion,
        enemyArmour,
        enemyDistance: args.enemyDistance,
        resistancePenalty: args.resistancePenalty,
      },
      scenarioValidation: [
        {
          field: "enemyLevel",
          expected: level,
          actual: Number(config.enemyLevel),
          passed: Number(config.enemyLevel) === level,
        },
      ],
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
  const baselineId = `${date}-${metadata.sha256.slice(0, 8)}`;
  const baselineFile = args.output || path.join(args.root, "baselines", `${baselineId}.json`);
  fs.mkdirSync(path.dirname(baselineFile), { recursive: true });
  fs.writeFileSync(baselineFile, `${JSON.stringify(result, null, 2)}\n`);

  const treeFile = path.join(
    runtime.runtime,
    "TreeData",
    result.tree.treeVersion,
    "tree.json",
  );
  const treeData = JSON.parse(fs.readFileSync(treeFile, "utf8"));
  const delta = buildDelta(previous, result, treeData);
  const itemCompletion = completion(result.items, result.stats);
  const sameHash = previous?.file?.sha256 === metadata.sha256;
  if (args.updateRoadmap) updateCharacter(character, baselineId, date);

  const summary = {
    ok: true,
    changed: !sameHash,
    baseline: baselineId,
    previousBaseline: character.activeBaseline || null,
    build: {
      hash: metadata.sha256.slice(0, 12),
      level: result.info.level,
      class: result.info.className,
      ascendancy: result.info.ascendClassName,
    },
    scenario: result.appliedScenario,
    scenarioValid: result.scenarioValidation.every((check) => check.passed),
    delta,
    itemCompletion,
    roadmap: {
      activeBaselineUpdated: args.updateRoadmap,
      semanticDecisionReviewNeeded: Boolean(
        delta &&
          (delta.items.length ||
            delta.tree.added.length ||
            delta.tree.removed.length),
      ),
    },
    artifact: baselineFile,
  };
  if (!args.quiet) {
    process.stdout.write(
      `${JSON.stringify(args.fullStdout ? { summary, result } : summary, null, 2)}\n`,
    );
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
