"use strict";

const fs = require("fs");
const { PobClient, resolveRuntime } = require("../pob-client");
const {
  sha256,
  sortedUniqueNumbers,
  stableStringify,
} = require("./stable");

function masteryEffectsForPob(candidate) {
  return Object.entries(candidate.masterySelections || {}).map(
    ([nodeId, effectId]) => [Number(nodeId), Number(effectId)],
  );
}

function compactItems(items) {
  return (items || [])
    .filter((item) => item.slot)
    .map((item) => ({
      slot: item.slot,
      name: item.name,
      baseName: item.baseName,
      active: item.active,
    }))
    .sort((left, right) => left.slot.localeCompare(right.slot));
}

function compactSkills(skills) {
  return {
    mainSocketGroup: skills?.mainSocketGroup ?? null,
    groups: (skills?.groups || []).map((group) => ({
      index: group.index,
      enabled: group.enabled,
      mainActiveSkill: group.mainActiveSkill,
      skills: group.skills,
      gems: (group.gems || []).map((gem) => ({
        name: gem.name,
        enabled: gem.enabled,
      })),
    })),
  };
}

async function observableSnapshot(client) {
  const info = await client.call("get_build_info");
  const tree = await client.call("get_tree");
  const config = await client.call("get_config");
  const items = await client.call("get_items");
  const skills = await client.call("get_skills");
  return {
    info: {
      className: info.info.className,
      ascendClassName: info.info.ascendClassName,
      level: info.info.level,
      treeVersion: info.info.treeVersion,
    },
    tree: {
      classId: tree.tree.classId,
      ascendClassId: tree.tree.ascendClassId,
      secondaryAscendClassId: tree.tree.secondaryAscendClassId,
      treeVersion: tree.tree.treeVersion,
      nodes: sortedUniqueNumbers(tree.tree.nodes),
      masteryEffects: tree.tree.masteryEffects || [],
    },
    config: config.config,
    items: compactItems(items.items),
    skills: compactSkills(skills.skills),
  };
}

function drift(before, after) {
  const fields = ["info", "config", "items", "skills"];
  const changes = [];
  for (const field of fields) {
    if (stableStringify(before[field]) !== stableStringify(after[field])) {
      changes.push({
        field,
        before: before[field],
        after: after[field],
      });
    }
  }
  for (const field of [
    "classId",
    "ascendClassId",
    "secondaryAscendClassId",
    "treeVersion",
  ]) {
    if (before.tree[field] !== after.tree[field]) {
      changes.push({
        field: `tree.${field}`,
        before: before.tree[field],
        after: after.tree[field],
      });
    }
  }
  return changes;
}

function parity(candidate, acceptedTree) {
  const expected = {
    classId: candidate.classId,
    ascendClassId: candidate.primaryAscendancy?.ascendClassId || 0,
    secondaryAscendClassId:
      candidate.secondaryAscendancy?.ascendClassId || 0,
    treeVersion: candidate.treeVersion,
    nodes: candidate.allocatedNodeIds,
    masteryEffects: masteryEffectsForPob(candidate),
  };
  const actual = {
    classId: acceptedTree.classId,
    ascendClassId: acceptedTree.ascendClassId,
    secondaryAscendClassId: acceptedTree.secondaryAscendClassId,
    treeVersion: acceptedTree.treeVersion,
    nodes: sortedUniqueNumbers(acceptedTree.nodes),
    masteryEffects: acceptedTree.masteryEffects || [],
  };
  return {
    exact: stableStringify(expected) === stableStringify(actual),
    expected,
    actual,
  };
}

function treeParams(candidate) {
  return {
    classId: candidate.classId,
    ascendClassId: candidate.primaryAscendancy?.ascendClassId || 0,
    secondaryAscendClassId:
      candidate.secondaryAscendancy?.ascendClassId || 0,
    treeVersion: candidate.treeVersion,
    masteryEffects: masteryEffectsForPob(candidate),
    nodes: candidate.allocatedNodeIds,
  };
}

function runtimeIdentity(runtime) {
  return {
    version: runtime.version,
    apiVersion: runtime.apiVersion,
    apiPatchVersion: runtime.apiPatchVersion,
    locationHash: sha256(runtime.runtime),
  };
}

function readCache(file) {
  if (!file || !fs.existsSync(file)) return {};
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeCache(file, cache) {
  if (!file) return;
  fs.mkdirSync(require("path").dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(cache, null, 2)}\n`);
}

async function smokeCandidates({
  buildPath,
  candidates,
  currentRuntime,
  count = 1,
}) {
  const runtime = resolveRuntime(currentRuntime);
  const xml = fs.readFileSync(buildPath, "utf8");
  const client = new PobClient(runtime);
  const results = [];
  try {
    await client.ready();
    for (const candidate of candidates.slice(0, Math.max(0, Number(count)))) {
      await client.loadXml(xml, "Passive Optimizer Baseline");
      const baseline = await observableSnapshot(client);
      let setterError = null;
      try {
        await client.call("set_tree", treeParams(candidate));
      } catch (error) {
        setterError = error.message;
      }
      const accepted = setterError ? null : await observableSnapshot(client);
      const parityReport = accepted
        ? parity(candidate, accepted.tree)
        : { exact: false, expected: null, actual: null };
      const driftReport = accepted ? drift(baseline, accepted) : [];
      results.push({
        canonicalKey: candidate.canonicalKey,
        accepted:
          !setterError && parityReport.exact && driftReport.length === 0,
        setterError,
        parity: parityReport,
        drift: driftReport,
      });
      await client.loadXml(xml, "Passive Optimizer Baseline Restore");
    }
    await client.loadXml(xml, "Passive Optimizer Final Restore");
  } finally {
    await client.close();
  }
  return {
    runtime: {
      version: runtime.version,
      apiVersion: runtime.apiVersion,
      apiPatchVersion: runtime.apiPatchVersion,
    },
    checked: results.length,
    accepted: results.filter((entry) => entry.accepted).length,
    rejected: results.filter((entry) => !entry.accepted).length,
    results,
  };
}

async function evaluateCandidates({
  buildPath,
  candidates,
  metrics = [],
  currentRuntime,
  count = 10,
  cachePath,
  clientFactory,
  runtimeMeta,
  runtimeLimitMs,
}) {
  const limit = Math.max(0, Math.floor(Number(count) || 0));
  const selected = candidates.slice(0, limit);
  const runtime = runtimeMeta || resolveRuntime(currentRuntime);
  const xml = fs.readFileSync(buildPath, "utf8");
  const buildHash = sha256(xml);
  const fields = [...new Set(metrics.map(String).filter(Boolean))].sort();
  const cache = readCache(cachePath);
  const makeClient = clientFactory || ((meta) => new PobClient(meta));
  const client = makeClient(runtime);
  const results = [];
  const startedAt = Date.now();
  let runtimeLimited = false;
  try {
    await client.ready();
    for (const candidate of selected) {
      if (
        Number.isFinite(Number(runtimeLimitMs)) &&
        Date.now() - startedAt >= Number(runtimeLimitMs)
      ) {
        runtimeLimited = true;
        break;
      }
      const cacheKey = sha256(stableStringify({
        candidate,
        buildHash,
        config: candidate.configRelevantState,
        runtime: runtimeIdentity(runtime),
        metrics: fields,
      }));
      if (cache[cacheKey]) {
        results.push({ ...cache[cacheKey], cached: true });
        continue;
      }
      await client.loadXml(xml, "Passive Search Baseline");
      const baseline = await observableSnapshot(client);
      let setterError = null;
      try {
        await client.call("set_tree", treeParams(candidate));
      } catch (error) {
        setterError = error.message;
      }
      const accepted = setterError ? null : await observableSnapshot(client);
      const parityReport = accepted
        ? parity(candidate, accepted.tree)
        : { exact: false, expected: null, actual: null };
      const driftReport = accepted ? drift(baseline, accepted) : [];
      const exactAccepted =
        !setterError && parityReport.exact && driftReport.length === 0;
      let stats = null;
      let metricError = null;
      if (exactAccepted && fields.length > 0) {
        try {
          stats = (await client.call("get_stats", { fields })).stats;
        } catch (error) {
          metricError = error.message;
        }
      }
      const result = {
        cacheKey,
        canonicalKey: candidate.canonicalKey,
        accepted: exactAccepted,
        setterError,
        parity: parityReport,
        drift: driftReport,
        metrics: stats,
        metricError,
        cached: false,
      };
      cache[cacheKey] = result;
      results.push(result);
      await client.loadXml(xml, "Passive Search Baseline Restore");
    }
    await client.loadXml(xml, "Passive Search Final Restore");
  } finally {
    writeCache(cachePath, cache);
    await client.close();
  }
  return {
    runtime: runtimeIdentity(runtime),
    buildHash,
    requestedMetrics: fields,
    checked: results.length,
    accepted: results.filter((entry) => entry.accepted).length,
    rejected: results.filter((entry) => !entry.accepted).length,
    cacheHits: results.filter((entry) => entry.cached).length,
    runtimeLimited,
    elapsedMs: Date.now() - startedAt,
    results,
    note:
      "PoB metrics are authoritative measurements; cheap Pareto relations are not reused as PoB dominance.",
  };
}

module.exports = {
  evaluateCandidates,
  observableSnapshot,
  smokeCandidates,
};
