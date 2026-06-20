"use strict";

const {
  sha256,
  sortedObject,
  sortedUniqueNumbers,
  stableStringify,
} = require("./stable");

const CANDIDATE_SCHEMA_VERSION = 1;

function normalizeChoiceMap(value) {
  return sortedObject(value, (entry) => {
    if (Array.isArray(entry)) return sortedUniqueNumbers(entry);
    const number = Number(entry);
    return Number.isFinite(number) ? number : String(entry);
  });
}

function normalizeJewelState(value) {
  return Object.fromEntries(
    Object.entries(value || {})
      .map(([nodeId, jewel]) => [
        String(Number(nodeId)),
        {
          itemId: jewel?.itemId ?? null,
          itemPbURL: jewel?.itemPbURL ?? null,
          name: jewel?.name ?? null,
          active: Boolean(jewel?.active),
          state: jewel?.state ?? null,
        },
      ])
      .sort(([left], [right]) => Number(left) - Number(right)),
  );
}

function normalizeWeaponSetAllocations(value) {
  return Object.fromEntries(
    Object.entries(value || {})
      .map(([weaponSet, nodes]) => [
        String(weaponSet),
        sortedUniqueNumbers(nodes),
      ])
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

function normalizeCandidate(input) {
  const classId = Number(input.classId);
  if (!Number.isFinite(classId)) throw new Error("Candidate requires classId");
  return {
    candidateSchemaVersion:
      input.candidateSchemaVersion || CANDIDATE_SCHEMA_VERSION,
    treeDataHash: String(input.treeDataHash || "").toLowerCase(),
    treeVersion: input.treeVersion || null,
    classId,
    className: input.className || null,
    classStart: Number(input.classStart),
    primaryAscendancy: input.primaryAscendancy
      ? {
          ascendClassId: Number(input.primaryAscendancy.ascendClassId || 0),
          id: input.primaryAscendancy.id || null,
          name: input.primaryAscendancy.name || null,
          startNodeId: Number(input.primaryAscendancy.startNodeId),
        }
      : null,
    secondaryAscendancy: input.secondaryAscendancy
      ? {
          ascendClassId: Number(input.secondaryAscendancy.ascendClassId || 0),
          id: input.secondaryAscendancy.id || null,
          name: input.secondaryAscendancy.name || null,
          startNodeId: Number(input.secondaryAscendancy.startNodeId),
        }
      : null,
    allocatedNodeIds: sortedUniqueNumbers(input.allocatedNodeIds),
    freeStartNodeIds: sortedUniqueNumbers(input.freeStartNodeIds),
    weaponSetAllocations: normalizeWeaponSetAllocations(
      input.weaponSetAllocations,
    ),
    attributeOverrides: sortedObject(input.attributeOverrides, (entry) =>
      String(entry).toLowerCase(),
    ),
    switchableOverrides: normalizeChoiceMap(input.switchableOverrides),
    multipleChoiceSelections: normalizeChoiceMap(
      input.multipleChoiceSelections,
    ),
    masterySelections: normalizeChoiceMap(input.masterySelections),
    jewelState: normalizeJewelState(input.jewelState),
    budgets: {
      ordinary: Number(input.budgets?.ordinary ?? 0),
      primaryAscendancy: Number(input.budgets?.primaryAscendancy ?? 0),
      secondaryAscendancy: Number(input.budgets?.secondaryAscendancy ?? 0),
      weaponSets: sortedObject(input.budgets?.weaponSets, Number),
      total: Number(input.budgets?.total ?? 0),
      respec:
        input.budgets?.respec === null ||
        input.budgets?.respec === undefined
          ? null
          : Number.isFinite(Number(input.budgets.respec))
            ? Number(input.budgets.respec)
            : null,
    },
    requiredNodeIds: sortedUniqueNumbers(input.requiredNodeIds),
    forbiddenNodeIds: sortedUniqueNumbers(input.forbiddenNodeIds),
    generatedNodeIds: sortedUniqueNumbers(input.generatedNodeIds),
    importedPobIdentity: input.importedPobIdentity || null,
    configRelevantState: sortedObject(input.configRelevantState),
  };
}

function candidateKey(candidate) {
  return sha256(stableStringify(normalizeCandidate(candidate)));
}

function withCandidateKey(candidate) {
  const normalized = normalizeCandidate(candidate);
  return { ...normalized, canonicalKey: candidateKey(normalized) };
}

module.exports = {
  CANDIDATE_SCHEMA_VERSION,
  candidateKey,
  normalizeCandidate,
  withCandidateKey,
};
