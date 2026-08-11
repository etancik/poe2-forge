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

function parseArgs(argv) {
  const args = {
    sections: ["info", "stats"],
    metrics: [],
    enemyDistance: 20,
  };
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--build") args.build = path.resolve(argv[++index]);
    else if (arg === "--sections") args.sections = argv[++index].split(",");
    else if (arg === "--metrics") args.metrics = argv[++index].split(",");
    else if (arg === "--metadata-only") args.metadataOnly = true;
    else if (arg === "--raw-items") args.rawItems = true;
    else if (arg === "--full-stdout") args.fullStdout = true;
    else if (arg === "--quiet") args.quiet = true;
    else if (arg === "--current-runtime") args.currentRuntime = argv[++index];
    else if (arg === "--output") args.output = path.resolve(argv[++index]);
    else if (arg === "--act") args.act = Number(argv[++index]);
    else if (arg === "--area-level") args.areaLevel = Number(argv[++index]);
    else if (arg === "--enemy-level") args.enemyLevel = Number(argv[++index]);
    else if (arg === "--enemy-distance") args.enemyDistance = Number(argv[++index]);
    else if (arg === "--resistance-penalty") {
      args.resistancePenalty = Number(argv[++index]);
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!args.build) throw new Error("Missing --build");
  return args;
}

function skillSummary(skills) {
  return (skills?.groups || [])
    .filter((group) => group.enabled)
    .map((group) => ({
      index: group.index,
      active: group.skills?.[group.mainActiveSkill - 1] || group.skills?.[0],
      gems: (group.gems || [])
        .filter((gem) => gem.enabled)
        .map((gem) => gem.name),
    }));
}

function staleSavedScenario(saved, expected) {
  return Object.entries(saved || {}).flatMap(([field, value]) =>
    expected[field] === undefined || Number(value) === Number(expected[field])
      ? []
      : [{ field, saved: Number(value), applied: Number(expected[field]) }],
  );
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
    progression: result.progression,
    scenarioValid: (result.scenarioValidation || []).every(
      (check) => check.passed,
    ),
    correctedSavedFields: staleSavedScenario(
      result.file?.savedScenario,
      result.appliedScenario,
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
                !item.type || !["Charm", "Flask", "Jewel"].includes(item.type),
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
  if (args.output) {
    fs.mkdirSync(path.dirname(args.output), { recursive: true });
    fs.writeFileSync(args.output, text);
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
  return {
    file: path.basename(file),
    bytes: stat.size,
    modified: stat.mtime.toISOString(),
    sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
    buildAttributes: attributes,
    savedScenario: activeSavedScenario(parseSavedScenario(text)),
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
  const level = Number(result.file.buildAttributes.level);
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

  const client = new PobClient(runtime);
  try {
    result.ready = await client.ready();
    await client.loadBuild(args.build, scenario.xmlScenario);
    await client.call("set_config", scenario.expected);
    const effectiveConfig = (await client.call("get_config")).config;
    result.appliedScenario = scenario.expected;
    result.progression = scenario.progression;
    result.scenarioValidation = scenarioChecks(
      scenario.expected,
      effectiveScenario(effectiveConfig),
    );
    const failures = result.scenarioValidation.filter((check) => !check.passed);
    if (failures.length) {
      throw new Error(
        `Effective scenario mismatch: ${failures
          .map((check) => `${check.field} expected ${check.expected}, got ${check.actual}`)
          .join("; ")}`,
      );
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
        result.config = effectiveConfig;
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

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  compactSummary,
  fileMetadata,
  main,
  parseArgs,
  staleSavedScenario,
};
