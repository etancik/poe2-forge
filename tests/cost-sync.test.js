"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const installer = require("../tools/sync-cost-estimator.js");

test("cost installer preserves local configuration across an atomic replacement", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cost-sync-"));
  const target = path.join(root, "estimate-poe2-build-costs");
  fs.mkdirSync(target);
  const config = '{"market":"personal"}\n';
  fs.writeFileSync(path.join(target, "config.local.json"), config);
  fs.writeFileSync(path.join(target, "stale.txt"), "stale\n");
  try {
    const result = installer.apply({ target });
    assert.equal(result.clean, true);
    assert.equal(fs.readFileSync(path.join(target, "config.local.json"), "utf8"), config);
    assert.equal(fs.existsSync(path.join(target, "stale.txt")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("cost installer rejects irrelevant calculator configuration flags", () => {
  assert.throws(
    () => installer.parseArgs(["node", "sync", "--runtime-manifest", "runtime.json"]),
    /Unknown argument/,
  );
});
