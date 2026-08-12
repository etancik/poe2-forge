"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
const { MAX_PACKET_BYTES, stringifyPacket } = require("../scripts/lib/packet-output");
const {
  applyPurpose,
  parseWrapperArgs,
  validateWritePaths,
} = require("../scripts/poe2-forge");

test("dispatcher help is available without runtime or build", () => {
  const root = path.resolve(__dirname, "..");
  const result = spawnSync(
    process.execPath,
    [path.join(root, "scripts", "poe2-forge.js"), "--help"],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /packet\|silent\|debug/);
  assert.match(result.stdout, /machine-only/);
});

test("packet output is minified and byte bounded", () => {
  const output = stringifyPacket("tree", {
    currentNodeCount: 100,
    removableLeaves: Array.from({ length: 20 }, (_, id) => ({
      id,
      name: `leaf-${id}`,
      stats: "x".repeat(500),
    })),
    candidates: Array.from({ length: 100 }, (_, id) => ({
      id,
      name: `candidate-${id}`,
      cost: 1,
      stats: "y".repeat(500),
    })),
    omittedCandidates: 97,
  });
  assert.ok(Buffer.byteLength(output) <= MAX_PACKET_BYTES);
  assert.equal(output.split("\n").length, 2);
  const value = JSON.parse(output);
  assert.ok((value.candidates || []).length <= 3);
  assert.ok(value.status === "packet-truncated" || value.removableLeaves.length <= 3);
});

test("purpose adds targeted inspect fields only when absent", () => {
  const args = applyPurpose("inspect", ["--build", "x.xml"], "passive");
  assert.ok(args.includes("--metrics"));
  assert.ok(args.includes("--sections"));
  const explicit = applyPurpose(
    "inspect",
    ["--build", "x.xml", "--metrics", "Life"],
    "survival",
  );
  assert.equal(explicit.filter((entry) => entry === "--metrics").length, 1);
});

test("safe dispatcher rejects output paths above its cwd", () => {
  const cwd = path.resolve("C:\\safe-work");
  assert.throws(
    () => validateWritePaths(["--output", "..\\outside.json"], cwd),
    /current working directory/,
  );
  assert.doesNotThrow(
    () => validateWritePaths(["--output", "artifacts\\result.json"], cwd),
  );
});

test("act confirmation remains a normal calculator argument", () => {
  const parsed = parseWrapperArgs([
    "node",
    "poe2-forge.js",
    "refresh",
    "--build",
    "x.xml",
    "--act",
    "2",
  ]);
  assert.deepEqual(parsed.args.slice(-2), ["--act", "2"]);
});
