"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { sortedUniqueNumbers } = require("./stable");
const { withCandidateKey } = require("./model");

function parseAttributes(tag) {
  const result = {};
  for (const match of String(tag).matchAll(/([A-Za-z][\w]*)="([^"]*)"/g)) {
    result[match[1]] = match[2];
  }
  return result;
}

function parseNodeList(value) {
  if (!value || value === "nil") return [];
  return sortedUniqueNumbers(String(value).split(","));
}

function parseNumberOrNull(value) {
  if (value === undefined || value === null || value === "" || value === "nil") {
    return null;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function parseMasteryEffects(value) {
  if (!value) return {};
  const result = {};
  for (const part of String(value).split(",")) {
    const [nodeId, effectId] = part.split(/[=:]/).map(Number);
    if (Number.isFinite(nodeId) && Number.isFinite(effectId)) {
      result[nodeId] = effectId;
    }
  }
  return result;
}

function parseTreeXml(xml) {
  const treeTag = xml.match(/<Tree\b[^>]*>/i)?.[0] || "";
  const treeAttributes = parseAttributes(treeTag);
  const activeSpec = Number(treeAttributes.activeSpec || 1);
  const specTags = [...xml.matchAll(/<Spec\b[^>]*>[\s\S]*?<\/Spec>/gi)].map(
    (match) => match[0],
  );
  const specBlock = specTags[Math.max(0, activeSpec - 1)] || specTags[0] || "";
  const specTag = specBlock.match(/<Spec\b[^>]*>/i)?.[0] || "";
  const spec = parseAttributes(specTag);
  const attributeOverrides = {};
  const attributeTag = specBlock.match(/<AttributeOverride\b[^>]*\/>/i)?.[0];
  if (attributeTag) {
    const attributes = parseAttributes(attributeTag);
    for (const [field, choice] of [
      ["strNodes", "str"],
      ["dexNodes", "dex"],
      ["intNodes", "int"],
    ]) {
      for (const nodeId of parseNodeList(attributes[field])) {
        attributeOverrides[nodeId] = choice;
      }
    }
  }
  const switchableOverrides = {};
  for (const match of specBlock.matchAll(
    /<(?:Node|Switchable)Override\b[^>]*\/>/gi,
  )) {
    const attributes = parseAttributes(match[0]);
    const nodeId = parseNumberOrNull(attributes.nodeId || attributes.id);
    const selection =
      attributes.selection || attributes.option || attributes.optionId;
    if (nodeId !== null && selection !== undefined) {
      switchableOverrides[nodeId] = selection;
    }
  }
  const multipleChoiceSelections = {};
  for (const match of specBlock.matchAll(
    /<MultipleChoice\b[^>]*\/>/gi,
  )) {
    const attributes = parseAttributes(match[0]);
    const parent = parseNumberOrNull(attributes.parent || attributes.parentId);
    const option = parseNumberOrNull(attributes.option || attributes.nodeId);
    if (parent !== null && option !== null) {
      if (!multipleChoiceSelections[parent]) {
        multipleChoiceSelections[parent] = [];
      }
      multipleChoiceSelections[parent].push(option);
    }
  }
  const weaponSetAllocations = {};
  for (const match of specBlock.matchAll(/<WeaponSet\b[^>]*\/?>/gi)) {
    const attributes = parseAttributes(match[0]);
    const setId = attributes.id || attributes.weaponSet || attributes.index;
    if (setId !== undefined) {
      weaponSetAllocations[setId] = parseNodeList(attributes.nodes);
    }
  }
  const jewelState = {};
  for (const match of xml.matchAll(/<SocketIdURL\b[^>]*\/>/gi)) {
    const attributes = parseAttributes(match[0]);
    const nodeId = parseNumberOrNull(attributes.nodeId);
    if (nodeId === null) continue;
    jewelState[nodeId] = {
      itemId: parseNumberOrNull(attributes.itemId),
      itemPbURL: attributes.itemPbURL || null,
      name: attributes.name || null,
      active: Boolean(
        parseNumberOrNull(attributes.itemId) || attributes.itemPbURL,
      ),
      state: null,
    };
  }
  const itemsTag = xml.match(/<Items\b[^>]*>/i)?.[0] || "";
  const items = parseAttributes(itemsTag);
  const buildTag = xml.match(/<Build\b[^>]*>/i)?.[0] || "";
  const build = parseAttributes(buildTag);
  return {
    activeSpec,
    spec,
    build,
    attributeOverrides,
    switchableOverrides,
    multipleChoiceSelections,
    masterySelections: parseMasteryEffects(spec.masteryEffects),
    weaponSetAllocations,
    jewelState,
    activeItemSet: parseNumberOrNull(items.activeItemSet),
    useSecondWeaponSet: items.useSecondWeaponSet === "true",
  };
}

function selectedAscendancy(graph, classId, ascendClassId) {
  if (!ascendClassId) return null;
  const classEntry = graph.classes.find((entry) => entry.classId === classId);
  const ascendancy = classEntry?.ascendancies.find(
    (entry) => entry.ascendClassId === ascendClassId,
  );
  if (!ascendancy) return null;
  return {
    ...ascendancy,
    startNodeId: graph.ascendancyStarts.get(ascendancy.id) ?? null,
  };
}

function classifyAllocatedPoints(graph, state) {
  const free = new Set(state.freeStartNodeIds);
  const weaponNodeToSet = new Map();
  for (const [weaponSet, nodes] of Object.entries(
    state.weaponSetAllocations || {},
  )) {
    for (const id of nodes) weaponNodeToSet.set(Number(id), weaponSet);
  }
  const counts = {
    ordinary: 0,
    primaryAscendancy: 0,
    secondaryAscendancy: 0,
    weaponSets: {},
    total: 0,
  };
  for (const id of state.allocatedNodeIds) {
    if (free.has(id)) continue;
    const weaponSet = weaponNodeToSet.get(id);
    if (weaponSet !== undefined) {
      counts.weaponSets[weaponSet] = (counts.weaponSets[weaponSet] || 0) + 1;
    } else {
      const node = graph.nodes.get(id);
      if (
        state.primaryAscendancy &&
        node?.ascendancyId === state.primaryAscendancy.id
      ) {
        counts.primaryAscendancy += 1;
      } else if (
        state.secondaryAscendancy &&
        node?.ascendancyId === state.secondaryAscendancy.id
      ) {
        counts.secondaryAscendancy += 1;
      } else {
        counts.ordinary += 1;
      }
    }
    counts.total += 1;
  }
  return counts;
}

function buildStateFromPob({
  graph,
  tree,
  info = {},
  xml,
  buildPath,
  config = {},
  budgets = {},
  requiredNodeIds = [],
  forbiddenNodeIds = [],
  respecBudget = null,
}) {
  const xmlState = parseTreeXml(xml);
  const classId = Number(tree.classId ?? xmlState.spec.classId);
  const classEntry = graph.classes.find((entry) => entry.classId === classId);
  if (!classEntry) throw new Error(`Unknown classId ${classId}`);
  const primaryAscendancy = selectedAscendancy(
    graph,
    classId,
    Number(tree.ascendClassId || xmlState.spec.ascendClassId || 0),
  );
  const secondaryAscendancy = selectedAscendancy(
    graph,
    classId,
    Number(
      tree.secondaryAscendClassId ||
        parseNumberOrNull(xmlState.spec.secondaryAscendClassId) ||
        0,
    ),
  );
  const classStart = graph.classStarts.get(classId);
  if (!Number.isFinite(classStart)) {
    throw new Error(`No explicit class start for classId ${classId}`);
  }
  const freeStartNodeIds = sortedUniqueNumbers([
    classStart,
    primaryAscendancy?.startNodeId,
    secondaryAscendancy?.startNodeId,
  ]);
  const allocatedNodeIds = sortedUniqueNumbers([
    ...(tree.nodes || parseNodeList(xmlState.spec.nodes)),
    ...freeStartNodeIds,
  ]);
  const identityBytes = fs.readFileSync(buildPath);
  const baseState = {
    treeDataHash: graph.source.hash,
    treeVersion: tree.treeVersion || xmlState.spec.treeVersion,
    classId,
    className: classEntry.name,
    classStart,
    primaryAscendancy,
    secondaryAscendancy,
    allocatedNodeIds,
    freeStartNodeIds,
    weaponSetAllocations: xmlState.weaponSetAllocations,
    attributeOverrides: xmlState.attributeOverrides,
    switchableOverrides: xmlState.switchableOverrides,
    multipleChoiceSelections: xmlState.multipleChoiceSelections,
    masterySelections:
      Object.keys(xmlState.masterySelections).length > 0
        ? xmlState.masterySelections
        : Object.fromEntries(tree.masteryEffects || []),
    jewelState: xmlState.jewelState,
    budgets: {
      ordinary: 0,
      primaryAscendancy: 0,
      secondaryAscendancy: 0,
      weaponSets: {},
      total: 0,
      respec: respecBudget,
    },
    requiredNodeIds,
    forbiddenNodeIds,
    generatedNodeIds: [],
    level: Number(info.level || xmlState.build.level || 0),
    questPointInputs: budgets.questPointInputs || null,
    importedPobIdentity: {
      file: path.basename(buildPath),
      sha256: crypto.createHash("sha256").update(identityBytes).digest("hex"),
      name: info.name || path.basename(buildPath, path.extname(buildPath)),
      level: Number(info.level || xmlState.build.level || 0),
      activeSpec: xmlState.activeSpec,
      activeItemSet: xmlState.activeItemSet,
      useSecondWeaponSet: xmlState.useSecondWeaponSet,
    },
    configRelevantState: config,
    warnings: [],
  };
  const used = classifyAllocatedPoints(graph, baseState);
  baseState.budgets = {
    ordinary: Number(budgets.ordinary ?? used.ordinary),
    primaryAscendancy: Number(
      budgets.primaryAscendancy ?? used.primaryAscendancy,
    ),
    secondaryAscendancy: Number(
      budgets.secondaryAscendancy ?? used.secondaryAscendancy,
    ),
    weaponSets: budgets.weaponSets || used.weaponSets,
    total: Number(budgets.total ?? used.total),
    respec: respecBudget,
  };
  if (
    budgets.ordinary === undefined ||
    budgets.primaryAscendancy === undefined
  ) {
    baseState.warnings.push({
      code: "BUDGET_INFERRED_FROM_CURRENT",
      message:
        "Point budgets unavailable from PoB API; current allocated usage is the conservative ceiling.",
    });
  }
  return baseState;
}

function candidateFromBuildState(state) {
  return withCandidateKey(state);
}

module.exports = {
  buildStateFromPob,
  candidateFromBuildState,
  classifyAllocatedPoints,
  parseTreeXml,
};
