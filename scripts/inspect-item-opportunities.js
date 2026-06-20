#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const { PobClient, resolveRuntime } = require("./lib/pob-client");

function parseArgs(argv) {
  const args = { goals: ["survival"], top: 3 };
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--build") args.build = path.resolve(argv[++index]);
    else if (arg === "--baseline") args.baseline = path.resolve(argv[++index]);
    else if (arg === "--goals") args.goals = argv[++index].split(",");
    else if (arg === "--output") args.output = path.resolve(argv[++index]);
    else if (arg === "--current-runtime") args.currentRuntime = argv[++index];
    else if (arg === "--top") args.top = Number(argv[++index]);
    else if (arg === "--full-stdout") args.fullStdout = true;
    else if (arg === "--quiet") args.quiet = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!args.build) throw new Error("Missing --build");
  return args;
}

function parseRuneCatalog(file) {
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  const entries = [];
  let rune = null;
  let slot = null;
  let effects = [];
  let rank = null;
  const flushSlot = () => {
    if (rune && slot) {
      entries.push({ name: rune, slot, effects, rank });
    }
    slot = null;
    effects = [];
    rank = null;
  };
  for (const line of lines) {
    const runeMatch = line.match(/^\t\["([^"]+)"\] = \{$/);
    if (runeMatch) {
      flushSlot();
      rune = runeMatch[1];
      continue;
    }
    const slotMatch = line.match(/^\t\t\["([^"]+)"\] = \{$/);
    if (slotMatch) {
      flushSlot();
      slot = slotMatch[1].toLowerCase();
      continue;
    }
    if (slot) {
      const effect = line.match(/^\s+"([^"]+)",\s*$/);
      if (effect && !effect[1].startsWith("Bonded:")) effects.push(effect[1]);
      const rankMatch = line.match(/rank = \{\s*(\d+)/);
      if (rankMatch) rank = Number(rankMatch[1]);
      if (/^\t\t},\s*$/.test(line)) flushSlot();
    }
  }
  flushSlot();
  return entries;
}

function parseItem(item) {
  const raw = item.raw || "";
  const socketText = raw.match(/^Sockets:\s*(.+)$/m)?.[1] || "";
  const socketCount = (socketText.match(/\bS\b/g) || []).length;
  const runeLines = [...raw.matchAll(/^Rune:\s*(.+)$/gm)].map((match) =>
    match[1].trim(),
  );
  const explicitEmptySockets = runeLines.filter((rune) => rune === "None").length;
  const hasRuneEnchant = /^\{enchant\}\{rune\}/m.test(raw);
  const inferredEmptySockets =
    explicitEmptySockets ||
    (socketCount && !runeLines.length && !hasRuneEnchant ? socketCount : 0);
  const quality = Number(raw.match(/^Quality:\s*(\d+)/m)?.[1]);
  const corrupted = /^Corrupted$/m.test(raw);
  const nonRuneEnchantCount = (
    raw.match(/^\{enchant\}(?!\{rune\}).+$/gm) || []
  ).length;
  return {
    slot: item.slot,
    name: item.name,
    type: item.type,
    socketCount,
    emptySockets: inferredEmptySockets,
    runes: runeLines.filter((rune) => rune !== "None"),
    quality: Number.isFinite(quality) ? quality : null,
    corrupted,
    nonRuneEnchantCount,
  };
}

function runeSlots(item) {
  const type = String(item.type || "").toLowerCase();
  if (["helmet", "gloves", "boots", "body armour"].includes(type)) {
    return [type, "armour"];
  }
  if (["crossbow", "bow", "spear", "mace", "axe", "sword", "quarterstaff"].includes(type)) {
    return [type, "weapon"];
  }
  return [type];
}

function needPatterns(stats, goals) {
  const needs = [];
  for (const element of ["Fire", "Cold", "Lightning", "Chaos"]) {
    const value = Number(stats[`${element}Resist`]);
    if (Number.isFinite(value) && value < 75) {
      needs.push({
        id: `${element.toLowerCase()}-resistance`,
        deficit: 75 - value,
        regex: new RegExp(`\\+([0-9]+)% to ${element} Resistance`, "i"),
      });
    }
  }
  if (goals.includes("survival")) {
    needs.push({
      id: "maximum-life",
      deficit: 1,
      regex: /\+([0-9]+) to maximum Life|([0-9]+)% increased maximum Life/i,
    });
  }
  if (goals.includes("self-curse")) {
    needs.push({
      id: "reduced-curse-effect",
      deficit: 1,
      regex: /reduced effect of Curses on you/i,
    });
  }
  if (goals.includes("mobility")) {
    needs.push({
      id: "movement-speed",
      deficit: 1,
      regex: /increased Movement Speed/i,
    });
  }
  return needs;
}

function recommendationsFor(item, catalog, needs, top) {
  if (!item.emptySockets) return [];
  const slots = new Set(runeSlots(item));
  const rows = [];
  for (const entry of catalog) {
    if (!slots.has(entry.slot)) continue;
    for (const effect of entry.effects) {
      for (const need of needs) {
        const match = effect.match(need.regex);
        if (!match) continue;
        const magnitude = Number(match[1] || match[2] || 1);
        rows.push({
          rune: entry.name,
          type: entry.slot,
          effect,
          need: need.id,
          rank: entry.rank,
          score: need.deficit * 100 + magnitude,
        });
      }
    }
  }
  rows.sort(
    (left, right) =>
      right.score - left.score ||
      Number(right.rank || 0) - Number(left.rank || 0) ||
      left.rune.localeCompare(right.rune),
  );
  const unique = [];
  const seen = new Set();
  for (const row of rows) {
    const key = `${row.rune}|${row.effect}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(row);
  }
  const selected = [];
  for (const need of [...needs].sort((a, b) => b.deficit - a.deficit)) {
    const match = unique.find(
      (row) =>
        row.need === need.id &&
        !selected.some((selectedRow) => selectedRow.rune === row.rune),
    );
    if (match) selected.push(match);
    if (selected.length >= top) break;
  }
  for (const row of unique) {
    if (selected.length >= top) break;
    if (!selected.some((selectedRow) => selectedRow.rune === row.rune)) {
      selected.push(row);
    }
  }
  return selected
    .map(({ score, ...row }) => row);
}

async function main() {
  const args = parseArgs(process.argv);
  const runtime = resolveRuntime(args.currentRuntime);
  const catalog = parseRuneCatalog(
    path.join(runtime.runtime, "Data", "ModRunes.lua"),
  );
  const client = new PobClient(runtime);
  try {
    await client.ready();
    await client.loadBuild(args.build);
    const measuredStats = (
      await client.call("get_stats", {
        fields: [
          "Life",
          "FireResist",
          "ColdResist",
          "LightningResist",
          "ChaosResist",
        ],
      })
    ).stats;
    const baseline = args.baseline
      ? JSON.parse(fs.readFileSync(args.baseline, "utf8"))
      : null;
    const stats = baseline?.stats || measuredStats;
    const items = (await client.call("get_items")).items
      .filter((item) => item.id && item.raw)
      .map(parseItem);
    const needs = needPatterns(stats, args.goals);
    const opportunities = items
      .map((item) => ({
        ...item,
        qualityOpportunity:
          item.quality !== null &&
          item.quality < 20 &&
          !item.corrupted &&
          !["Ring", "Amulet", "Belt"].includes(item.type),
        enchantState:
          item.nonRuneEnchantCount > 0
            ? "present"
            : item.corrupted
              ? "locked-or-limited"
              : "none-detected",
        runeRecommendations: recommendationsFor(
          item,
          catalog,
          needs,
          args.top,
        ),
      }))
      .filter((item) => item.emptySockets || item.qualityOpportunity);
    const result = {
      build: path.basename(args.build),
      runtime: {
        version: runtime.version,
        apiPatchVersion: runtime.apiPatchVersion,
      },
      goals: args.goals,
      baseline: args.baseline ? path.basename(args.baseline) : null,
      stats,
      needs: needs.map(({ regex, ...need }) => need),
      opportunities,
      cautions: [
        "Do not apply socket or enchant changes automatically.",
        "Verify in-game replacement, corruption, bonding, and crafting restrictions before committing.",
        "An empty socket is an upgrade opportunity before replacing the entire item.",
      ],
    };
    if (args.output) {
      fs.mkdirSync(path.dirname(args.output), { recursive: true });
      fs.writeFileSync(args.output, `${JSON.stringify(result, null, 2)}\n`);
    }
    if (!args.quiet) {
      const stdoutValue = args.fullStdout
        ? result
        : {
            needs: result.needs,
            opportunities: opportunities.slice(0, 8).map((item) => ({
              slot: item.slot,
              item: item.name,
              emptySockets: item.emptySockets,
              quality: item.quality,
              qualityOpportunity: item.qualityOpportunity,
              corrupted: item.corrupted,
              enchantState: item.enchantState,
              runeRecommendations: item.runeRecommendations,
            })),
            omittedOpportunities: Math.max(0, opportunities.length - 8),
            output: args.output ? path.basename(args.output) : null,
          };
      process.stdout.write(`${JSON.stringify(stdoutValue, null, 2)}\n`);
    }
  } finally {
    await client.close();
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
