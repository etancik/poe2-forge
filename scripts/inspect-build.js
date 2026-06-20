#!/usr/bin/env node
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { PobClient, resolveRuntime } = require("./lib/pob-client");

function parseArgs(argv) {
  const args = { sections: ["info", "stats"], metrics: [] };
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === "--build") args.build = path.resolve(argv[++i]);
    else if (argv[i] === "--sections") args.sections = argv[++i].split(",");
    else if (argv[i] === "--metrics") args.metrics = argv[++i].split(",");
    else if (argv[i] === "--metadata-only") args.metadataOnly = true;
    else if (argv[i] === "--raw-items") args.rawItems = true;
    else if (argv[i] === "--full-stdout") args.fullStdout = true;
    else if (argv[i] === "--quiet") args.quiet = true;
    else if (argv[i] === "--current-runtime") args.currentRuntime = argv[++i];
    else if (argv[i] === "--output") args.output = path.resolve(argv[++i]);
    else if (argv[i] === "--enemy-level") args.enemyLevel = Number(argv[++i]);
    else if (argv[i] === "--enemy-evasion") args.enemyEvasion = Number(argv[++i]);
    else if (argv[i] === "--enemy-armour") args.enemyArmour = Number(argv[++i]);
    else if (argv[i] === "--enemy-distance") args.enemyDistance = Number(argv[++i]);
    else if (argv[i] === "--resistance-penalty") args.resistancePenalty = Number(argv[++i]);
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  if (!args.build) throw new Error("Missing --build");
  return args;
}

function skillSummary(skills) {
  return (skills?.groups || [])
    .filter((group) => group.enabled)
    .map((group) => ({
      active: group.skills?.[group.mainActiveSkill - 1] || group.skills?.[0],
      gems: (group.gems || [])
        .filter((gem) => gem.enabled)
        .map((gem) => gem.name),
    }));
}

function compactSummary(result) {
  return {
    ok: true,
    build: {
      sha256: result.file?.sha256?.slice(0, 12),
      level: result.info?.level ?? Number(result.file?.buildAttributes?.level),
      class: result.info?.className || result.file?.buildAttributes?.className,
      ascendancy:
        result.info?.ascendClassName ||
        result.file?.buildAttributes?.ascendClassName,
    },
    scenario: result.appliedScenario,
    scenarioValid: (result.scenarioValidation || []).every(
      (check) => check.passed,
    ),
    stats: result.stats,
    tree: result.tree
      ? {
          nodeCount: result.tree.nodes?.length || 0,
          treeVersion: result.tree.treeVersion,
        }
      : undefined,
    items: result.items
      ? Object.fromEntries(
          result.items
            .filter(
              (item) =>
                !item.type ||
                !["Charm", "Flask", "Jewel"].includes(item.type),
            )
            .map((item) => [item.slot, item.name]),
        )
      : undefined,
    skills: result.skills ? skillSummary(result.skills) : undefined,
    runtime: result.runtime,
  };
}

function emit(result, args) {
  const text = `${JSON.stringify(result, null, 2)}\n`;
  const output = args.output;
  if (output) {
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, text);
  }
  if (!args.quiet) {
    const stdoutValue = args.fullStdout ? result : compactSummary(result);
    process.stdout.write(`${JSON.stringify(stdoutValue, null, 2)}\n`);
  }
}

function fileMetadata(file) {
  const bytes = fs.readFileSync(file);
  const stat = fs.statSync(file);
  const text = bytes.toString("utf8");
  const buildTag = text.match(/<Build\b[^>]*>/i)?.[0] || "";
  const attributes = {};
  for (const match of buildTag.matchAll(/([A-Za-z][\w]*)="([^"]*)"/g)) {
    if (/^(level|className|ascendClassName|targetVersion|mainSocketGroup)$/i.test(match[1])) {
      attributes[match[1]] = match[2];
    }
  }
  const savedScenario = {};
  for (const tag of text.matchAll(/<(Placeholder|Input)\b[^>]*\/>/g)) {
    const name = tag[0].match(/\bname="([^"]*)"/)?.[1];
    const number = tag[0].match(/\bnumber="([^"]*)"/)?.[1];
    if (
      name &&
      number !== undefined &&
      /^(enemyLevel|enemyDistance|enemyEvasion|enemyArmour|resistancePenalty)$/i.test(name)
    ) {
      savedScenario[name] = Number(number);
    }
  }
  return {
    file: path.basename(file),
    bytes: stat.size,
    modified: stat.mtime.toISOString(),
    sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
    buildAttributes: attributes,
    savedScenario,
  };
}

function compactItems(items, includeRaw) {
  return (items || [])
    .filter((item) => item.id && item.slot)
    .map((item) => {
      const compact = {
        slot: item.slot,
        name: item.name,
        baseName: item.baseName,
        rarity: item.rarity,
        type: item.type,
      };
      if (item.active !== undefined) compact.active = item.active;
      if (includeRaw) compact.raw = item.raw;
      return compact;
    });
}

async function main() {
  const args = parseArgs(process.argv);
  const result = { file: fileMetadata(args.build) };
  if (args.metadataOnly) {
    emit(result, args);
    return;
  }
  const runtime = resolveRuntime(args.currentRuntime);
  const client = new PobClient(runtime);
  try {
    result.ready = await client.ready();
    const xmlScenario = { placeholders: {}, inputs: {} };
    if (Number.isFinite(args.enemyLevel)) {
      xmlScenario.placeholders.enemyLevel = args.enemyLevel;
    }
    if (Number.isFinite(args.enemyEvasion)) {
      xmlScenario.placeholders.enemyEvasion = args.enemyEvasion;
    }
    if (Number.isFinite(args.enemyArmour)) {
      xmlScenario.placeholders.enemyArmour = args.enemyArmour;
    }
    if (Number.isFinite(args.enemyDistance)) {
      xmlScenario.placeholders.enemyDistance = args.enemyDistance;
      xmlScenario.inputs.enemyDistance = args.enemyDistance;
    }
    if (Number.isFinite(args.resistancePenalty)) {
      xmlScenario.inputs.resistancePenalty = args.resistancePenalty;
    }
    await client.loadBuild(args.build, xmlScenario);
    result.loadedConfig = (await client.call("get_config")).config;
    if (Number.isFinite(args.enemyLevel)) {
      await client.call("set_config", {
        enemyLevel: args.enemyLevel,
        ...(Number.isFinite(args.enemyEvasion)
          ? { enemyEvasion: args.enemyEvasion }
          : {}),
        ...(Number.isFinite(args.enemyArmour)
          ? { enemyArmour: args.enemyArmour }
          : {}),
      });
    }
    result.appliedScenario = {
      ...(Number.isFinite(args.enemyLevel) ? { enemyLevel: args.enemyLevel } : {}),
      ...(Number.isFinite(args.enemyEvasion)
        ? { enemyEvasion: args.enemyEvasion }
        : {}),
      ...(Number.isFinite(args.enemyArmour)
        ? { enemyArmour: args.enemyArmour }
        : {}),
      ...(Number.isFinite(args.enemyDistance) ? { enemyDistance: args.enemyDistance } : {}),
      ...(Number.isFinite(args.resistancePenalty)
        ? { resistancePenalty: args.resistancePenalty }
        : {}),
    };
    const effectiveConfig = (await client.call("get_config")).config;
    result.scenarioValidation = [];
    if (Number.isFinite(args.enemyLevel)) {
      result.scenarioValidation.push({
        field: "enemyLevel",
        expected: args.enemyLevel,
        actual: Number(effectiveConfig.enemyLevel),
        passed: Number(effectiveConfig.enemyLevel) === args.enemyLevel,
      });
    }
    for (const section of args.sections) {
      if (section === "info") {
        result.info = (await client.call("get_build_info")).info;
      } else if (section === "stats") {
        result.stats = (
          await client.call("get_stats", {
            fields: args.metrics.length ? args.metrics : undefined,
          })
        ).stats;
      } else if (section === "items") {
        result.items = compactItems(
          (await client.call("get_items")).items,
          args.rawItems,
        );
      } else if (section === "skills") {
        result.skills = (await client.call("get_skills")).skills;
      } else if (section === "tree") {
        result.tree = (await client.call("get_tree")).tree;
      } else if (section === "config") {
        result.config = (await client.call("get_config")).config;
      } else {
        throw new Error(`Unknown section: ${section}`);
      }
    }
    result.runtime = {
      version: runtime.version,
      apiVersion: runtime.apiVersion,
      apiPatchVersion: runtime.apiPatchVersion,
    };
    emit(result, args);
  } finally {
    await client.close();
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
