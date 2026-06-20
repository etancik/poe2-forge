"use strict";

const { withCandidateKey } = require("./model");
const { sortedUniqueNumbers } = require("./stable");

const DELTA_SCHEMA_VERSION = 1;

function normalizeDelta(input = {}) {
  return {
    deltaSchemaVersion: input.deltaSchemaVersion || DELTA_SCHEMA_VERSION,
    addNodeIds: sortedUniqueNumbers(
      input.addNodeIds || input.addNodes || input.add || [],
    ),
    removeNodeIds: sortedUniqueNumbers(
      input.removeNodeIds || input.removeNodes || input.remove || [],
    ),
    requiredNodeIds: sortedUniqueNumbers(input.requiredNodeIds || []),
    forbiddenNodeIds: sortedUniqueNumbers(input.forbiddenNodeIds || []),
  };
}

function deltaCost(candidate, input) {
  const delta = normalizeDelta(input);
  const allocated = new Set(candidate.allocatedNodeIds);
  const marginalAddNodeIds = delta.addNodeIds.filter((id) => !allocated.has(id));
  const marginalRemoveNodeIds = delta.removeNodeIds.filter((id) =>
    allocated.has(id),
  );
  return {
    intrinsic: {
      add: delta.addNodeIds.length,
      remove: delta.removeNodeIds.length,
      changed: delta.addNodeIds.length + delta.removeNodeIds.length,
    },
    marginal: {
      add: marginalAddNodeIds.length,
      remove: marginalRemoveNodeIds.length,
      changed: marginalAddNodeIds.length + marginalRemoveNodeIds.length,
      addNodeIds: marginalAddNodeIds,
      removeNodeIds: marginalRemoveNodeIds,
    },
    respec: marginalRemoveNodeIds.length,
  };
}

function pruneStateMap(value, allocated) {
  return Object.fromEntries(
    Object.entries(value || {}).filter(([nodeId]) =>
      allocated.has(Number(nodeId)),
    ),
  );
}

function applyDelta(candidate, input) {
  const delta = normalizeDelta(input);
  const allocated = new Set(candidate.allocatedNodeIds);
  for (const id of delta.removeNodeIds) allocated.delete(id);
  for (const id of delta.addNodeIds) allocated.add(id);
  const allocatedNodeIds = sortedUniqueNumbers(allocated);
  const nextAllocated = new Set(allocatedNodeIds);
  return withCandidateKey({
    ...candidate,
    allocatedNodeIds,
    requiredNodeIds: sortedUniqueNumbers([
      ...candidate.requiredNodeIds,
      ...delta.requiredNodeIds,
    ]),
    forbiddenNodeIds: sortedUniqueNumbers([
      ...candidate.forbiddenNodeIds,
      ...delta.forbiddenNodeIds,
    ]),
    attributeOverrides: pruneStateMap(
      candidate.attributeOverrides,
      nextAllocated,
    ),
    switchableOverrides: pruneStateMap(
      candidate.switchableOverrides,
      nextAllocated,
    ),
    multipleChoiceSelections: pruneStateMap(
      candidate.multipleChoiceSelections,
      nextAllocated,
    ),
    masterySelections: pruneStateMap(
      candidate.masterySelections,
      nextAllocated,
    ),
    jewelState: pruneStateMap(candidate.jewelState, nextAllocated),
    weaponSetAllocations: Object.fromEntries(
      Object.entries(candidate.weaponSetAllocations || {}).map(
        ([weaponSet, nodes]) => [
          weaponSet,
          nodes.filter((id) => nextAllocated.has(id)),
        ],
      ),
    ),
  });
}

function candidateDelta(before, after) {
  const beforeSet = new Set(before.allocatedNodeIds);
  const afterSet = new Set(after.allocatedNodeIds);
  return normalizeDelta({
    addNodeIds: after.allocatedNodeIds.filter((id) => !beforeSet.has(id)),
    removeNodeIds: before.allocatedNodeIds.filter((id) => !afterSet.has(id)),
  });
}

module.exports = {
  DELTA_SCHEMA_VERSION,
  applyDelta,
  candidateDelta,
  deltaCost,
  normalizeDelta,
};
