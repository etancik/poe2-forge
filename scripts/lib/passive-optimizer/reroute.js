"use strict";

const { withCandidateKey } = require("./model");
const { sortedUniqueNumbers } = require("./stable");
const { validateCandidate } = require("./validator");

const MODES = ["conservative", "standard", "rebuild"];

function isStateful(candidate, id) {
  return (
    candidate.attributeOverrides[id] !== undefined ||
    candidate.switchableOverrides[id] !== undefined ||
    candidate.multipleChoiceSelections[id] !== undefined ||
    candidate.masterySelections[id] !== undefined ||
    candidate.jewelState[id]?.active
  );
}

function allocatedDegree(graph, allocated, id) {
  return (graph.nodes.get(id)?.adjacency || []).filter((next) =>
    allocated.has(next),
  ).length;
}

function preservedNodes(graph, candidate, mode) {
  if (!MODES.includes(mode)) throw new Error(`Unknown reroute mode: ${mode}`);
  const allocated = new Set(candidate.allocatedNodeIds);
  const required = new Set(candidate.requiredNodeIds);
  const preserved = new Set(candidate.freeStartNodeIds);
  for (const id of candidate.allocatedNodeIds) {
    const node = graph.nodes.get(id);
    if (!node) continue;
    if (required.has(id)) {
      preserved.add(id);
      continue;
    }
    if (mode === "rebuild") continue;
    if (node.ascendancyId) {
      preserved.add(id);
      continue;
    }
    if (mode === "standard") {
      if (
        node.isNotable ||
        node.isKeystone ||
        node.isJewelSocket ||
        node.isMultipleChoice ||
        node.isMultipleChoiceOption ||
        node.isMastery ||
        isStateful(candidate, id)
      ) {
        preserved.add(id);
      }
      continue;
    }
    const pureTravel =
      !node.isNotable &&
      !node.isKeystone &&
      !node.isJewelSocket &&
      !node.isMultipleChoice &&
      !node.isMultipleChoiceOption &&
      !node.isMastery &&
      !isStateful(candidate, id) &&
      allocatedDegree(graph, allocated, id) === 2;
    if (!pureTravel) preserved.add(id);
  }
  return sortedUniqueNumbers(preserved);
}

function estimateModes(graph, candidate) {
  const allocatedCount = candidate.allocatedNodeIds.length;
  return MODES.map((mode) => {
    const terminals = preservedNodes(graph, candidate, mode);
    const removable = allocatedCount - terminals.length;
    const familyCount = Math.max(4, Math.min(16, terminals.length + 3));
    return {
      mode,
      preservedTerminalCount: terminals.length,
      potentiallyChangedNodeCount: removable,
      connectorFamilies: familyCount,
      relativeWork:
        terminals.length * familyCount + removable * removable,
      materiallyLarger:
        mode === "rebuild" && removable > Math.max(12, allocatedCount * 0.35),
    };
  });
}

function traversable(graph, candidate, currentAllocated, id) {
  const node = graph.nodes.get(id);
  if (!node || node.isOnlyImage || node.ascendancyId) return false;
  if (candidate.forbiddenNodeIds.includes(id)) return false;
  if (
    (node.isAttribute ||
      node.isSwitchable ||
      node.isMultipleChoiceOption ||
      node.isMastery) &&
    !currentAllocated.has(id)
  ) {
    return false;
  }
  return true;
}

function shortestConnector(
  graph,
  candidate,
  connected,
  target,
  tieMode,
) {
  if (connected.has(target)) return [];
  const baseline = new Set(candidate.allocatedNodeIds);
  const distance = new Map();
  const previous = new Map();
  const queue = [];
  for (const id of connected) {
    const score = { distance: 0, respecPenalty: 0 };
    distance.set(id, score);
    queue.push({ id, ...score });
  }
  const compare = (left, right) =>
    left.distance - right.distance ||
    left.respecPenalty - right.respecPenalty ||
    (tieMode === "high-id" ? right.id - left.id : left.id - right.id);
  while (queue.length) {
    queue.sort(compare);
    const current = queue.shift();
    const best = distance.get(current.id);
    if (
      !best ||
      current.distance !== best.distance ||
      current.respecPenalty !== best.respecPenalty
    ) {
      continue;
    }
    if (current.id === target) break;
    for (const next of graph.nodes.get(current.id)?.adjacency || []) {
      if (!traversable(graph, candidate, baseline, next) && next !== target) {
        continue;
      }
      const stepCost = connected.has(next) ? 0 : 1;
      const respecPenalty = baseline.has(next) ? 0 : 1;
      const nextScore = {
        distance: current.distance + stepCost,
        respecPenalty: current.respecPenalty + respecPenalty,
      };
      const existing = distance.get(next);
      const isBetter =
        !existing ||
        nextScore.distance < existing.distance ||
        (nextScore.distance === existing.distance &&
          nextScore.respecPenalty < existing.respecPenalty) ||
        (nextScore.distance === existing.distance &&
          nextScore.respecPenalty === existing.respecPenalty &&
          (tieMode === "high-id"
            ? current.id > (previous.get(next) ?? -Infinity)
            : current.id < (previous.get(next) ?? Infinity)));
      if (!isBetter) continue;
      distance.set(next, nextScore);
      previous.set(next, current.id);
      queue.push({ id: next, ...nextScore });
    }
  }
  if (!previous.has(target)) return null;
  const path = [];
  let step = target;
  while (!connected.has(step)) {
    path.push(step);
    step = previous.get(step);
    if (step === undefined) return null;
  }
  return path.reverse();
}

function rootDistances(graph, candidate, root) {
  const distance = new Map([[root, 0]]);
  const queue = [root];
  for (let index = 0; index < queue.length; index += 1) {
    const id = queue[index];
    for (const next of graph.nodes.get(id)?.adjacency || []) {
      if (
        distance.has(next) ||
        !traversable(graph, candidate, new Set(candidate.allocatedNodeIds), next)
      ) {
        continue;
      }
      distance.set(next, distance.get(id) + 1);
      queue.push(next);
    }
  }
  return distance;
}

function terminalOrders(graph, candidate, terminals, limit) {
  const ordinary = terminals.filter(
    (id) => !graph.nodes.get(id)?.ascendancyId && id !== candidate.classStart,
  );
  const sorted = [...ordinary].sort((a, b) => a - b);
  const distances = rootDistances(graph, candidate, candidate.classStart);
  const farthest = [...ordinary].sort(
    (a, b) =>
      (distances.get(b) ?? Infinity) - (distances.get(a) ?? Infinity) ||
      a - b,
  );
  const nearest = [...farthest].reverse();
  const orders = [sorted, [...sorted].reverse(), farthest, nearest];
  for (
    let offset = 1;
    orders.length < limit && offset < Math.max(1, sorted.length);
    offset += 1
  ) {
    orders.push([...sorted.slice(offset), ...sorted.slice(0, offset)]);
  }
  return orders.slice(0, limit);
}

function pruneStateMap(value, allocated) {
  return Object.fromEntries(
    Object.entries(value || {}).filter(([nodeId]) =>
      allocated.has(Number(nodeId)),
    ),
  );
}

function makeCandidate(base, allocatedNodeIds) {
  const allocated = new Set(allocatedNodeIds);
  return withCandidateKey({
    ...base,
    allocatedNodeIds,
    attributeOverrides: pruneStateMap(base.attributeOverrides, allocated),
    switchableOverrides: pruneStateMap(base.switchableOverrides, allocated),
    multipleChoiceSelections: pruneStateMap(
      base.multipleChoiceSelections,
      allocated,
    ),
    masterySelections: pruneStateMap(base.masterySelections, allocated),
    jewelState: pruneStateMap(base.jewelState, allocated),
    weaponSetAllocations: Object.fromEntries(
      Object.entries(base.weaponSetAllocations).map(([weaponSet, nodes]) => [
        weaponSet,
        nodes.filter((id) => allocated.has(id)),
      ]),
    ),
  });
}

function connectorSummary(graph, baseNodes, candidateNodes) {
  const before = new Set(baseNodes);
  const after = new Set(candidateNodes);
  const added = candidateNodes.filter((id) => !before.has(id));
  const removed = baseNodes.filter((id) => !after.has(id));
  return {
    added: added.map((id) => ({ id, name: graph.nodes.get(id)?.name || "" })),
    removed: removed.map((id) => ({
      id,
      name: graph.nodes.get(id)?.name || "",
    })),
    articulationChanges: {
      added: added.filter((id) => graph.articulationPoints.has(id)),
      removed: removed.filter((id) => graph.articulationPoints.has(id)),
    },
  };
}

function runReroute(graph, baseCandidate, options = {}) {
  const mode = options.mode || "standard";
  const resultLimit = Math.max(1, Number(options.resultLimit || 5));
  const estimates = estimateModes(graph, baseCandidate);
  const selectedEstimate = estimates.find((entry) => entry.mode === mode);
  if (
    mode === "rebuild" &&
    selectedEstimate.materiallyLarger &&
    !options.approveRebuild
  ) {
    return {
      mode,
      estimates,
      approvalRequired: true,
      reason:
        "Rebuild may change materially more nodes; rerun with explicit approval.",
      search: { generated: 0, invalid: 0, duplicate: 0, retained: 0 },
      results: [],
    };
  }
  const terminals = preservedNodes(graph, baseCandidate, mode);
  const preservedAscendancy = terminals.filter(
    (id) => graph.nodes.get(id)?.ascendancyId,
  );
  const terminalSet = new Set(terminals);
  const orders = terminalOrders(
    graph,
    baseCandidate,
    terminals,
    selectedEstimate.connectorFamilies,
  );
  const baselineValidation = validateCandidate(graph, baseCandidate);
  const baselinePoints = baselineValidation.counts.totalPoints;
  const seen = new Set([baseCandidate.canonicalKey]);
  const retained = [];
  let generated = 0;
  let invalid = 0;
  let duplicate = 0;
  const invalidCodeCounts = {};

  for (let familyIndex = 0; familyIndex < orders.length; familyIndex += 1) {
    for (const tieMode of ["low-id", "high-id"]) {
      const connected = new Set([baseCandidate.classStart]);
      let failed = false;
      for (const terminal of orders[familyIndex]) {
        const pathIds = shortestConnector(
          graph,
          baseCandidate,
          connected,
          terminal,
          tieMode,
        );
        if (pathIds === null) {
          failed = true;
          break;
        }
        for (const id of pathIds) connected.add(id);
        connected.add(terminal);
      }
      if (failed) {
        invalid += 1;
        continue;
      }
      for (const id of preservedAscendancy) connected.add(id);
      for (const id of terminalSet) {
        if (!graph.nodes.get(id)?.ascendancyId) connected.add(id);
      }
      generated += 1;
      const candidate = makeCandidate(
        baseCandidate,
        sortedUniqueNumbers(connected),
      );
      if (seen.has(candidate.canonicalKey)) {
        duplicate += 1;
        continue;
      }
      seen.add(candidate.canonicalKey);
      const validation = validateCandidate(graph, candidate, {
        baselineAllocatedNodeIds: baseCandidate.allocatedNodeIds,
      });
      if (!validation.valid) {
        invalid += 1;
        for (const error of validation.errors) {
          invalidCodeCounts[error.code] =
            (invalidCodeCounts[error.code] || 0) + 1;
        }
        continue;
      }
      const summary = connectorSummary(
        graph,
        baseCandidate.allocatedNodeIds,
        candidate.allocatedNodeIds,
      );
      const pointsAfter = validation.counts.totalPoints;
      retained.push({
        mode,
        preservedTerminals: terminals,
        pointsBefore: baselinePoints,
        pointsAfter,
        pointsSaved: baselinePoints - pointsAfter,
        addedNodeIds: summary.added.map((entry) => entry.id),
        removedNodeIds: summary.removed.map((entry) => entry.id),
        respecCount: summary.added.length + summary.removed.length,
        changedConnector: summary,
        canonicalKey: candidate.canonicalKey,
        validation,
        candidate,
        uncertainty: validation.needsPob.map((entry) => entry.code),
      });
    }
  }
  retained.sort(
    (left, right) =>
      right.pointsSaved - left.pointsSaved ||
      left.respecCount - right.respecCount ||
      left.canonicalKey.localeCompare(right.canonicalKey),
  );
  return {
    mode,
    estimates,
    approvalRequired: false,
    preservedTerminals: terminals,
    search: {
      generated,
      invalid,
      duplicate,
      retained: retained.length,
      invalidCodeCounts,
    },
    results: retained.slice(0, resultLimit),
  };
}

module.exports = {
  MODES,
  estimateModes,
  preservedNodes,
  runReroute,
};
