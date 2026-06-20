#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

const ACTIVE = new Set(["now", "planned", "watch"]);
const ARCHIVE = new Set(["completed", "rejected", "superseded"]);
const ALL = new Set([...ACTIVE, ...ARCHIVE]);

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function scalar(value) {
  const text = value.trim();
  if (text.startsWith("[") || text.startsWith("{")) {
    try {
      return JSON.parse(text);
    } catch {}
  }
  if (text === "true") return true;
  if (text === "false") return false;
  if (text === "null") return null;
  return text.replace(/^["']|["']$/g, "");
}

function frontmatter(text) {
  if (!text.startsWith("---\n")) return { data: {}, body: text };
  const end = text.indexOf("\n---\n", 4);
  if (end < 0) return { data: {}, body: text };
  const data = {};
  for (const line of text.slice(4, end).split(/\r?\n/)) {
    const match = line.match(/^([a-z_]+):\s*(.*)$/);
    if (match) data[match[1]] = scalar(match[2]);
  }
  return { data, body: text.slice(end + 5) };
}

function yaml(data) {
  return Object.entries(data)
    .map(([key, value]) => {
      if (Array.isArray(value) || (value && typeof value === "object")) {
        return `${key}: ${JSON.stringify(value)}`;
      }
      return `${key}: ${value == null ? "null" : String(value)}`;
    })
    .join("\n");
}

function listDecisions(root) {
  const files = [];
  for (const folder of ["active", "archive"]) {
    const dir = path.join(root, "decisions", folder);
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      if (name.endsWith(".md")) files.push(path.join(dir, name));
    }
  }
  return files.map((file) => {
    const parsed = frontmatter(fs.readFileSync(file, "utf8"));
    return { file, ...parsed.data };
  });
}

function readCharacter(root) {
  const file = path.join(root, "character.yaml");
  if (!fs.existsSync(file)) return {};
  return frontmatter(`---\n${fs.readFileSync(file, "utf8")}\n---\n`).data;
}

function baselineStatus(root, character) {
  if (!character.active_baseline) return { state: "missing" };
  const file = path.join(
    root,
    "baselines",
    `${character.active_baseline}.json`,
  );
  if (!fs.existsSync(file)) return { state: "missing", file };
  const baseline = JSON.parse(fs.readFileSync(file, "utf8"));
  const failed = (baseline.scenarioValidation || []).filter(
    (item) => !item.passed,
  );
  return {
    state: failed.length ? "needs-review" : "valid",
    file,
    failed,
  };
}

function parseLegacy(text) {
  const headerEnd = text.search(/^##\s+/m);
  const header = headerEnd >= 0 ? text.slice(0, headerEnd).trim() : text.trim();
  const decisions = [];
  const headingPattern = /^##\s+(\w+)\s+[^\r\n]*?`([^`]+)`[^\r\n]*$/gm;
  const headings = [];
  let heading;
  while ((heading = headingPattern.exec(text))) {
    headings.push({
      status: heading[1],
      id: heading[2],
      bodyStart: headingPattern.lastIndex,
    });
  }
  for (let index = 0; index < headings.length; index += 1) {
    const currentHeading = headings[index];
    const bodyEnd =
      index + 1 < headings.length
        ? text.lastIndexOf("##", headings[index + 1].bodyStart)
        : text.length;
    const body = text.slice(currentHeading.bodyStart, bodyEnd);
    const fields = {};
    let current = null;
    for (const line of body.trim().split(/\r?\n/)) {
      const field = line.match(/^([TDECV]):\s*(.*)$/);
      if (field) {
        current = field[1];
        fields[current] = field[2];
      } else if (current && line.trim()) {
        fields[current] += ` ${line.trim()}`;
      }
    }
    decisions.push({
      status: currentHeading.status,
      id: currentHeading.id,
      fields,
    });
  }
  return { header, decisions };
}

function inferTags(decision) {
  const text = `${decision.id} ${Object.values(decision.fields).join(" ")}`;
  const tags = [];
  const rules = {
    passives: /pact|reflex|passive|node|grasp/i,
    gear: /belt|ring|glove|body|chest|amulet|boot|rune|acuity|mantle|titanrot|goregirdle/i,
    skills: /font|attrition|sniper|ballista|support|gem/i,
    survival: /surviv|life|ehp|resist|armour|leech|recovery|maximum hit/i,
    damage: /dps|damage|crit|accuracy/i,
  };
  for (const [tag, regex] of Object.entries(rules)) if (regex.test(text)) tags.push(tag);
  return tags.length ? tags : ["general"];
}

function writeDecision(root, decision, options) {
  if (!ALL.has(decision.status)) throw new Error(`Invalid status: ${decision.status}`);
  const folder = ACTIVE.has(decision.status) ? "active" : "archive";
  const file = path.join(root, "decisions", folder, `${decision.id}.md`);
  const data = {
    id: decision.id,
    status: decision.status,
    updated: options.updated,
    scope: "focused",
    tags: inferTags(decision),
    dependencies: [],
    baseline: options.baseline || null,
    verified_with: options.verifiedWith || null,
  };
  const labels = {
    T: "Trigger",
    D: "Decision",
    E: "Evidence",
    C: "Constraints",
    V: "Revalidation",
  };
  const body = Object.entries(labels)
    .filter(([key]) => decision.fields[key])
    .map(([key, label]) => `## ${label}\n\n${decision.fields[key]}`)
    .join("\n\n");
  fs.writeFileSync(file, `---\n${yaml(data)}\n---\n\n${body}\n`);
}

function generateIndex(root) {
  const character = readCharacter(root);
  const baseline = baselineStatus(root, character);
  const decisions = listDecisions(root).sort((a, b) => {
    const rank = { now: 0, planned: 1, watch: 2, completed: 3, rejected: 4, superseded: 5 };
    return (rank[a.status] ?? 9) - (rank[b.status] ?? 9) || a.id.localeCompare(b.id);
  });
  const lines = [
    `# ${character.name || path.basename(root)} roadmap`,
    "",
    `Build: \`${character.build || "unknown"}\``,
    `Active baseline: \`${character.active_baseline || "none"}\``,
    `Baseline validation: ${baseline.state}`,
    `Last reviewed: ${character.last_reviewed || "unknown"}`,
    "",
  ];
  for (const status of ["now", "planned", "watch", "completed", "rejected", "superseded"]) {
    const group = decisions.filter((item) => item.status === status);
    if (!group.length) continue;
    lines.push(`## ${status}`, "");
    for (const item of group) {
      const relative = path.relative(root, item.file).replaceAll("\\", "/");
      lines.push(`- [${item.id}](${relative}) — ${(item.tags || []).join(", ")}`);
    }
    lines.push("");
  }
  fs.writeFileSync(path.join(root, "index.md"), `${lines.join("\n").trim()}\n`);
  return decisions;
}

function validate(root) {
  const errors = [];
  const seen = new Set();
  for (const item of listDecisions(root)) {
    if (!item.id) errors.push(`${item.file}: missing id`);
    if (!ALL.has(item.status)) errors.push(`${item.file}: invalid status ${item.status}`);
    if (item.id && seen.has(item.id)) errors.push(`${item.file}: duplicate id ${item.id}`);
    seen.add(item.id);
    const expectedFolder = ACTIVE.has(item.status) ? "active" : "archive";
    if (!item.file.includes(`${path.sep}${expectedFolder}${path.sep}`)) {
      errors.push(`${item.file}: status belongs in ${expectedFolder}`);
    }
    if (path.basename(item.file, ".md") !== item.id) {
      errors.push(`${item.file}: filename must equal id`);
    }
  }
  if (!fs.existsSync(path.join(root, "character.yaml"))) {
    errors.push("missing character.yaml");
  } else {
    const character = readCharacter(root);
    const baseline = baselineStatus(root, character);
    if (baseline.state === "missing" && character.active_baseline) {
      errors.push(`missing active baseline ${character.active_baseline}`);
    }
  }
  return { ok: errors.length === 0, errors, decisionCount: seen.size };
}

function parseOptions(argv) {
  const options = {};
  for (let i = 3; i < argv.length; i += 1) {
    const key = argv[i].replace(/^--/, "").replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    options[key] = argv[++i];
  }
  return options;
}

function main() {
  const command = process.argv[2];
  const options = parseOptions(process.argv);
  if (!command || !options.root) {
    throw new Error("Usage: roadmap-manager.js <migrate|summary|index|validate> --root DIR [...]");
  }
  const root = path.resolve(options.root);
  if (command === "migrate") {
    if (!options.source || !options.build) {
      throw new Error("migrate requires --source and --build");
    }
    ensureDir(path.join(root, "decisions", "active"));
    ensureDir(path.join(root, "decisions", "archive"));
    ensureDir(path.join(root, "baselines"));
    const legacy = parseLegacy(fs.readFileSync(path.resolve(options.source), "utf8"));
    const updated = options.updated || new Date().toISOString().slice(0, 10);
    const character = {
      name: options.name || path.basename(root),
      build: path.resolve(options.build),
      class: options.class || "unknown",
      ascendancy: options.ascendancy || "unknown",
      game_version: options.gameVersion || "unknown",
      tree_version: options.treeVersion || "unknown",
      runtime: options.verifiedWith || "unknown",
      active_baseline: options.baseline || null,
      last_reviewed: updated,
      legacy_header: legacy.header.replace(/\s+/g, " "),
    };
    fs.writeFileSync(path.join(root, "character.yaml"), `${yaml(character)}\n`);
    for (const decision of legacy.decisions) writeDecision(root, decision, {
      updated,
      baseline: options.baseline,
      verifiedWith: options.verifiedWith,
    });
    generateIndex(root);
    process.stdout.write(`${JSON.stringify({ migrated: legacy.decisions.length, root }, null, 2)}\n`);
  } else if (command === "index") {
    const decisions = generateIndex(root);
    process.stdout.write(`${JSON.stringify({ indexed: decisions.length, root }, null, 2)}\n`);
  } else if (command === "summary") {
    const result = validate(root);
    result.baseline = baselineStatus(root, readCharacter(root));
    result.decisions = listDecisions(root).map(({ file, ...item }) => item);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else if (command === "validate") {
    const result = validate(root);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!result.ok) process.exitCode = 1;
  } else {
    throw new Error(`Unknown command: ${command}`);
  }
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
}
