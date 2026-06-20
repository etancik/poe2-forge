#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const ignoredDirectories = new Set([
  ".git",
  "node_modules",
  "external",
  "outputs",
  "work",
]);
const findings = [];

const privatePatterns = [
  new RegExp("C:" + "[\\\\/]" + "Users" + "[\\\\/]", "i"),
  new RegExp("[\\\\/]" + "Users" + "[\\\\/]", "i"),
  new RegExp("[\\\\/]" + "home" + "[\\\\/]", "i"),
  new RegExp("eta" + "nc", "i"),
  new RegExp("Mercenar" + "y", "i"),
  new RegExp("0" + "\\.5\\.2"),
  new RegExp("0" + "\\.21\\.0"),
  new RegExp("poe2-build-" + "roadmaps", "i"),
];

const secretPatterns = [
  new RegExp("AK" + "IA[0-9A-Z]{16}"),
  new RegExp("AS" + "IA[0-9A-Z]{16}"),
  new RegExp("gh[pousr]_" + "[A-Za-z0-9_]{20,}"),
  new RegExp("github_pat_" + "[A-Za-z0-9_]{20,}"),
  new RegExp("sk-" + "[A-Za-z0-9]{20,}"),
  new RegExp("xox[baprs]-" + "[A-Za-z0-9-]{10,}"),
  new RegExp("-{5}BEGIN " + "(?:RSA |EC |OPENSSH )?PRIVATE KEY-{5}"),
  /api[_-]?key\s*[:=]\s*["']?[A-Za-z0-9_-]{12,}/i,
  /client[_-]?secret\s*[:=]\s*["']?[A-Za-z0-9_-]{12,}/i,
  /password\s*[:=]\s*["']?[^\s"']{8,}/i,
];

function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      walk(file);
      continue;
    }
    const relative = path.relative(root, file).replaceAll("\\", "/");
    const stat = fs.statSync(file);
    if (stat.size > 1024 * 1024) {
      findings.push(`${relative}: larger than 1 MiB (${stat.size} bytes)`);
      continue;
    }
    if (/\.(?:bak|tmp|orig|log)$/i.test(entry.name) || /~$/.test(entry.name)) {
      findings.push(`${relative}: backup or temporary filename`);
    }
    if (/cache.*\.json$/i.test(entry.name) ||
        /benchmark.*\.json$/i.test(entry.name)) {
      findings.push(`${relative}: generated cache/benchmark filename`);
    }
    const text = fs.readFileSync(file, "utf8");
    for (const pattern of [...privatePatterns, ...secretPatterns]) {
      if (pattern.test(text)) {
        findings.push(`${relative}: matched ${pattern}`);
      }
    }
  }
}

walk(root);
if (findings.length) {
  process.stderr.write(`${findings.join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(
    "Publication scan clean: no private paths/build labels, known secret " +
    "patterns, large data, caches, or backup files found.\n",
  );
}
