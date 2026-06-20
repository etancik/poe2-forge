"use strict";

const fs = require("fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const test = require("node:test");
const { PobClient, resolveRuntime } = require("../scripts/lib/pob-client");
const {
  buildStateFromPob,
  candidateFromBuildState,
} = require("../scripts/lib/passive-optimizer/build-state");
const { smokeCandidates } = require("../scripts/lib/passive-optimizer/pob-smoke");
const { extractPackages } = require("../scripts/lib/passive-optimizer/packages");
const { rankPackages } = require("../scripts/lib/passive-optimizer/scorer");
const { stableStringify } = require("../scripts/lib/passive-optimizer/stable");
const { loadTreeGraph } = require("../scripts/lib/passive-optimizer/tree-importer");
const { validateCandidate } = require("../scripts/lib/passive-optimizer/validator");

const BUILD = process.env.POB2_TEST_BUILD
  ? path.resolve(process.env.POB2_TEST_BUILD)
  : null;

function integrationAvailable() {
  if (!BUILD || !fs.existsSync(BUILD)) return false;
  try {
    loadTreeGraph();
    resolveRuntime();
    return true;
  } catch {
    return false;
  }
}

test(
  "explicit local build validates and PoB smoke confirms or usefully rejects",
  { skip: !integrationAvailable(), timeout: 120000 },
  async () => {
    const graph = loadTreeGraph();
    const runtime = resolveRuntime();
    const client = new PobClient(runtime);
    let candidate;
    try {
      await client.ready();
      await client.loadBuild(BUILD);
      const info = (await client.call("get_build_info")).info;
      const tree = (await client.call("get_tree")).tree;
      const config = (await client.call("get_config")).config;
      const state = buildStateFromPob({
        graph,
        tree,
        info,
        config,
        xml: fs.readFileSync(BUILD, "utf8"),
        buildPath: BUILD,
      });
      candidate = candidateFromBuildState(state);
      const report = validateCandidate(graph, candidate);
      assert.equal(
        report.valid,
        true,
        report.errors.map((entry) => entry.code).join(", "),
      );
    } finally {
      await client.close();
    }
    const firstPackages = extractPackages(graph, candidate);
    const secondPackages = extractPackages(graph, candidate);
    assert.equal(
      stableStringify(firstPackages),
      stableStringify(secondPackages),
      "local build package extraction must be reproducible",
    );
    assert.ok(firstPackages.packages.length > 0);
    const profile = JSON.parse(
      fs.readFileSync(
        require("path").resolve(
          __dirname,
          "../examples/synthetic-ranged-totem-profile.json",
        ),
        "utf8",
      ),
    );
    const ranked = rankPackages({
      graph,
      candidate,
      packages: firstPackages.packages,
      profile,
    });
    assert.equal(ranked.length, firstPackages.packages.length);
    assert.ok(Number.isFinite(ranked[0].rankScore));
    assert.ok(["valid", "risky", "needsPoB", "invalid"].includes(ranked[0].status));
    const smoke = await smokeCandidates({
      buildPath: BUILD,
      candidates: [candidate],
      count: 1,
    });
    assert.equal(smoke.checked, 1);
    const result = smoke.results[0];
    assert.ok(
      result.accepted ||
        result.setterError ||
        !result.parity.exact ||
        result.drift.length > 0,
    );
    if (!result.accepted) {
      assert.ok(
        result.setterError ||
          result.drift.length > 0 ||
          result.parity.actual !== null,
      );
    }
  },
);
