"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
const {
  resolveTreeSnapshot,
} = require("../scripts/lib/portable-config");

test("explicit tree path wins over config and environment", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "optimizer-config-"));
  const explicit = path.join(root, "explicit");
  const configured = path.join(root, "configured");
  const environment = path.join(root, "environment");
  for (const directory of [explicit, configured, environment]) {
    fs.mkdirSync(directory);
  }
  const configPath = path.join(root, "config.json");
  fs.writeFileSync(configPath, JSON.stringify({ treeSnapshot: "configured" }));
  const previous = process.env.POE2_TREE_SNAPSHOT;
  process.env.POE2_TREE_SNAPSHOT = environment;
  try {
    assert.equal(
      resolveTreeSnapshot(explicit, { configPath }),
      path.resolve(explicit),
    );
    assert.equal(
      resolveTreeSnapshot(null, { configPath }),
      path.resolve(configured),
    );
  } finally {
    if (previous === undefined) delete process.env.POE2_TREE_SNAPSHOT;
    else process.env.POE2_TREE_SNAPSHOT = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("CLI help does not require local runtime, tree, or config", () => {
  const script = path.resolve(__dirname, "../scripts/passive-optimizer.js");
  const result = spawnSync(process.execPath, [script, "--help"], {
    encoding: "utf8",
    env: {
      ...process.env,
      CBB_OPTIMIZER_CONFIG: "",
      POB2_RUNTIME: "",
      POB2_RUNTIME_MANIFEST: "",
      POE2_TREE_SNAPSHOT: "",
    },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Passive tree optimizer/);
  assert.match(result.stdout, /CLI argument -> explicit config/);
});
