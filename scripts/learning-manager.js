#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

const MAX_ENTRIES = 12;

function parseArgs(argv) {
  const args = {};
  for (let index = 3; index < argv.length; index += 1) {
    const key = argv[index].replace(/^--/, "");
    args[key] = argv[++index];
  }
  return { command: argv[2], ...args };
}

function load(file) {
  if (!fs.existsSync(file)) return { version: 1, entries: [] };
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function save(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`);
}

function validateEntry(entry) {
  for (const field of ["id", "category", "rule", "evidence"]) {
    if (!entry[field] || typeof entry[field] !== "string") {
      throw new Error(`Learning entry requires string field: ${field}`);
    }
  }
  if (entry.rule.length > 240 || entry.evidence.length > 320) {
    throw new Error("Learning rule/evidence is too long");
  }
}

function main() {
  const args = parseArgs(process.argv);
  if (!args.command || !args.root) {
    throw new Error(
      "Usage: learning-manager.js <add|summary|validate> --root DIR [--input entry.json]",
    );
  }
  const file = path.join(path.resolve(args.root), "learning.json");
  const state = load(file);
  state.entries = state.entries || [];

  if (args.command === "add") {
    if (!args.input) throw new Error("add requires --input");
    const entry = JSON.parse(fs.readFileSync(path.resolve(args.input), "utf8"));
    validateEntry(entry);
    const today = new Date().toISOString().slice(0, 10);
    const existing = state.entries.find((item) => item.id === entry.id);
    if (existing) {
      Object.assign(existing, entry, {
        firstSeen: existing.firstSeen || today,
        lastSeen: today,
        hits: Number(existing.hits || 1) + 1,
      });
    } else {
      state.entries.push({
        ...entry,
        firstSeen: today,
        lastSeen: today,
        hits: 1,
      });
    }
    state.entries.sort(
      (left, right) =>
        Number(right.pinned) - Number(left.pinned) ||
        Number(right.hits || 1) - Number(left.hits || 1) ||
        String(right.lastSeen).localeCompare(String(left.lastSeen)),
    );
    state.entries = state.entries.slice(0, MAX_ENTRIES);
    save(file, state);
    process.stdout.write(
      `${JSON.stringify({ ok: true, entries: state.entries.length, file }, null, 2)}\n`,
    );
  } else if (args.command === "summary") {
    const limit = Math.max(1, Math.min(5, Number(args.limit) || 5));
    process.stdout.write(
      `${JSON.stringify(
        {
          count: state.entries.length,
          rules: state.entries.slice(0, limit).map((entry) => ({
            id: entry.id,
            category: entry.category,
            rule: entry.rule,
            hits: entry.hits,
          })),
        },
        null,
        2,
      )}\n`,
    );
  } else if (args.command === "validate") {
    for (const entry of state.entries) validateEntry(entry);
    const ids = state.entries.map((entry) => entry.id);
    const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
    const errors = [];
    if (duplicates.length) errors.push(`duplicate ids: ${duplicates.join(", ")}`);
    if (state.entries.length > MAX_ENTRIES) errors.push("too many entries");
    process.stdout.write(
      `${JSON.stringify(
        { ok: errors.length === 0, errors, entries: state.entries.length },
        null,
        2,
      )}\n`,
    );
    if (errors.length) process.exitCode = 1;
  } else {
    throw new Error(`Unknown command: ${args.command}`);
  }
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
}
