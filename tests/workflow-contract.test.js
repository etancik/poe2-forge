"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

require("./workflow-contract-core.test");

test("refresh help is available without a build or runtime", () => {
  const root = path.resolve(__dirname, "..");
  const result = spawnSync(
    process.execPath,
    [path.join(root, "scripts", "refresh-build.js"), "--help"],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Usage: node scripts\/refresh-build\.js/);
  assert.match(result.stdout, /--act <1-6>/);
});
