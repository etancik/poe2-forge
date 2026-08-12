"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { validateExperiment } = require("../scripts/poe2-forge");

test("safe experiment dispatcher rejects passive tree mutation", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "forge-dispatcher-"));
  const spec = path.join(root, "spec.json");
  fs.writeFileSync(spec, JSON.stringify({
    variants: [{
      id: "bad-passive-wrapper",
      actions: [{ action: "update_tree_delta", params: { addNodes: [1] } }],
    }],
  }));
  try {
    assert.throws(
      () => validateExperiment("experiment", [spec]),
      /directed/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
