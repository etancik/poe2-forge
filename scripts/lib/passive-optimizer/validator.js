"use strict";

const { classifyAllocatedPoints } = require("./build-state");
const { normalizeCandidate } = require("./model");
const { sortedUniqueNumbers } = require("./stable");

function createIssue(code, nodeIds, message, details) {
  return {
    code,
    nodeIds: sortedUniqueNumbers(nodeIds),
    message,
    ...(details ? { details } : {}),
  };
}

function reachable(graph, allocated, roots, allowNode) {
  const seen = new Set();
  const queue = [];
  for (const root of roots) {
    if (allocated.has(root) && allowNode(graph.nodes.get(root), root)) {
      seen.add(root);
      queue.push(root);
    }
  }
  for (let index = 0; index < queue.length; index += 1) {
    const id = queue[index];
    for (const next of graph.nodes.get(id)?.adjacency || []) {
      if (
        seen.has(next) ||
        !allocated.has(next) ||
        !allowNode(graph.nodes.get(next), next)
      ) {
        continue;
      }
      seen.add(next);
      queue.push(next);
    }
  }
  return seen;
}

function unlockNodes(constraint) {
  if (!constraint) return [];
  if (Array.isArray(constraint.nodes)) return sortedUniqueNumbers(constraint.nodes);
  if (Array.isArray(constraint)) return sortedUniqueNumbers(constraint);
  return [];
}

function validateCandidate(graph, candidateInput, options = {}) {
  const candidate = normalizeCandidate(candidateInput);
  const errors = [];
  const warnings = [];
  const needsPob = [];
  const allocated = new Set(candidate.allocatedNodeIds);
  const generated = new Set(candidate.generatedNodeIds);

  if (candidate.treeDataHash !== graph.source.hash) {
    errors.push(
      createIssue(
        "TREE_DATA_HASH_MISMATCH",
        [],
        "Candidate tree-data hash does not match the loaded graph.",
        {
          expected: graph.source.hash,
          actual: candidate.treeDataHash,
        },
      ),
    );
  }
  if (candidate.treeVersion !== graph.source.treeVersion) {
    errors.push(
      createIssue(
        "TREE_VERSION_MISMATCH",
        [],
        "Candidate tree version does not match the loaded graph.",
        {
          expected: graph.source.treeVersion,
          actual: candidate.treeVersion,
        },
      ),
    );
  }

  const unknown = candidate.allocatedNodeIds.filter(
    (id) => !graph.nodes.has(id) && !generated.has(id),
  );
  if (unknown.length) {
    errors.push(
      createIssue("UNKNOWN_NODE", unknown, "Allocated node IDs are unknown."),
    );
  }
  const generatedAllocated = candidate.allocatedNodeIds.filter((id) =>
    generated.has(id),
  );
  if (generatedAllocated.length) {
    needsPob.push(
      createIssue(
        "GENERATED_SUBGRAPH_NEEDS_POB",
        generatedAllocated,
        "Generated or special-subgraph nodes require PoB validation.",
      ),
    );
  }
  const visualOnly = candidate.allocatedNodeIds.filter(
    (id) => graph.nodes.get(id)?.isOnlyImage,
  );
  if (visualOnly.length) {
    errors.push(
      createIssue(
        "VISUAL_ONLY_NODE",
        visualOnly,
        "Visual-only nodes cannot be allocated.",
      ),
    );
  }

  const allocatedClassStarts = [...graph.classStarts.entries()]
    .filter(([, nodeId]) => allocated.has(nodeId))
    .map(([classId, nodeId]) => ({ classId, nodeId }));
  const allocatedClassStartNodeIds = sortedUniqueNumbers(
    allocatedClassStarts.map((entry) => entry.nodeId),
  );
  if (!allocated.has(candidate.classStart)) {
    errors.push(
      createIssue(
        "CLASS_START_MISSING",
        [candidate.classStart],
        "The selected class start is not allocated.",
      ),
    );
  }
  const expectedStart = graph.classStarts.get(candidate.classId);
  if (expectedStart !== candidate.classStart) {
    errors.push(
      createIssue(
        "WRONG_CLASS_START",
        [candidate.classStart, expectedStart],
        "Candidate class start does not match the selected class.",
      ),
    );
  }
  if (
    allocatedClassStartNodeIds.length !== 1 ||
    !allocatedClassStarts.some(
      (entry) =>
        entry.classId === candidate.classId &&
        entry.nodeId === candidate.classStart,
    )
  ) {
    errors.push(
      createIssue(
        "CLASS_START_COUNT",
        allocatedClassStartNodeIds,
        "Exactly one class start belonging to the selected class is required.",
      ),
    );
  }

  const foreignAscendancy = [];
  for (const id of candidate.allocatedNodeIds) {
    const node = graph.nodes.get(id);
    if (!node?.ascendancyId) continue;
    if (
      node.ascendancyId !== candidate.primaryAscendancy?.id &&
      node.ascendancyId !== candidate.secondaryAscendancy?.id
    ) {
      foreignAscendancy.push(id);
    }
  }
  if (foreignAscendancy.length) {
    errors.push(
      createIssue(
        "FOREIGN_ASCENDANCY",
        foreignAscendancy,
        "Allocated ascendancy nodes do not belong to a selected branch.",
      ),
    );
  }

  const ordinaryIds = candidate.allocatedNodeIds.filter(
    (id) => graph.nodes.has(id) && !graph.nodes.get(id).ascendancyId,
  );
  const ordinarySet = new Set(ordinaryIds);
  const ordinaryReachable = reachable(
    graph,
    ordinarySet,
    [candidate.classStart],
    (node) => Boolean(node && !node.isOnlyImage && !node.ascendancyId),
  );
  const disconnectedOrdinary = ordinaryIds.filter(
    (id) => !ordinaryReachable.has(id),
  );
  if (disconnectedOrdinary.length) {
    errors.push(
      createIssue(
        "DISCONNECTED_ORDINARY",
        disconnectedOrdinary,
        "Ordinary allocations must be rooted at the selected class start.",
      ),
    );
    errors.push(
      createIssue(
        "ORPHAN_COMPONENT",
        disconnectedOrdinary,
        "An allocated component is orphaned from its required root.",
      ),
    );
  }

  for (const [label, ascendancy] of [
    ["PRIMARY", candidate.primaryAscendancy],
    ["SECONDARY", candidate.secondaryAscendancy],
  ]) {
    if (!ascendancy) continue;
    const branchIds = candidate.allocatedNodeIds.filter(
      (id) => graph.nodes.get(id)?.ascendancyId === ascendancy.id,
    );
    if (!allocated.has(ascendancy.startNodeId)) {
      errors.push(
        createIssue(
          `${label}_ASCENDANCY_START_MISSING`,
          [ascendancy.startNodeId],
          `${label.toLowerCase()} ascendancy start is not allocated.`,
        ),
      );
      continue;
    }
    const branchSet = new Set(branchIds);
    const branchReachable = reachable(
      graph,
      branchSet,
      [ascendancy.startNodeId],
      (node) => Boolean(node && node.ascendancyId === ascendancy.id),
    );
    const disconnected = branchIds.filter((id) => !branchReachable.has(id));
    if (disconnected.length) {
      errors.push(
        createIssue(
          `${label}_ASCENDANCY_DISCONNECTED`,
          disconnected,
          `${label.toLowerCase()} ascendancy allocations are not rooted in their start.`,
        ),
      );
    }
  }

  for (const id of candidate.allocatedNodeIds) {
    const node = graph.nodes.get(id);
    if (!node) continue;
    const missing = unlockNodes(node.unlockConstraint).filter(
      (requiredId) => !allocated.has(requiredId),
    );
    if (missing.length) {
      errors.push(
        createIssue(
          "MISSING_UNLOCK",
          [id, ...missing],
          "An allocated node is missing an unlock prerequisite.",
          { nodeId: id, missing },
        ),
      );
    }
    if (node.isAttribute || node.isSwitchable) {
      const selection =
        candidate.attributeOverrides[id] ??
        candidate.switchableOverrides[id];
      if (selection === undefined) {
        errors.push(
          createIssue(
            "UNRESOLVED_SWITCHABLE_NODE",
            [id],
            "Switchable or attribute node has no explicit override.",
          ),
        );
      }
    }
    if (node.isMultipleChoiceOption) {
      const parent = node.multipleChoiceParent;
      if (!allocated.has(parent)) {
        errors.push(
          createIssue(
            "MULTIPLE_CHOICE_PARENT_MISSING",
            [id, parent],
            "Multiple-choice option requires its parent.",
          ),
        );
      }
    }
    if (
      node.isMastery &&
      candidate.masterySelections[id] === undefined
    ) {
      errors.push(
        createIssue(
          "MASTERY_SELECTION_MISSING",
          [id],
          "Allocated mastery-like node requires an explicit selection.",
        ),
      );
    }
  }

  const choicesByParent = new Map();
  for (const id of candidate.allocatedNodeIds) {
    const node = graph.nodes.get(id);
    if (!node?.isMultipleChoiceOption || node.multipleChoiceParent === null) {
      continue;
    }
    if (!choicesByParent.has(node.multipleChoiceParent)) {
      choicesByParent.set(node.multipleChoiceParent, []);
    }
    choicesByParent.get(node.multipleChoiceParent).push(id);
  }
  for (const [parent, choices] of choicesByParent) {
    if (choices.length > 1) {
      errors.push(
        createIssue(
          "MULTIPLE_CHOICE_CONFLICT",
          [parent, ...choices],
          "Mutually exclusive multiple-choice siblings are allocated.",
        ),
      );
    }
  }

  const activeJewelsWithoutSocket = [];
  for (const [nodeIdValue, jewel] of Object.entries(candidate.jewelState)) {
    const nodeId = Number(nodeIdValue);
    if (jewel.active && !allocated.has(nodeId)) {
      activeJewelsWithoutSocket.push(nodeId);
    }
    if (jewel.active && !graph.nodes.get(nodeId)?.isJewelSocket) {
      activeJewelsWithoutSocket.push(nodeId);
    }
  }
  if (activeJewelsWithoutSocket.length) {
    errors.push(
      createIssue(
        "JEWEL_SOCKET_INACTIVE",
        activeJewelsWithoutSocket,
        "Active jewel state requires an allocated jewel socket.",
      ),
    );
  }

  const missingRequired = candidate.requiredNodeIds.filter(
    (id) => !allocated.has(id),
  );
  if (missingRequired.length) {
    errors.push(
      createIssue(
        "REQUIRED_NODE_MISSING",
        missingRequired,
        "Required nodes must remain allocated.",
      ),
    );
  }
  const presentForbidden = candidate.forbiddenNodeIds.filter((id) =>
    allocated.has(id),
  );
  if (presentForbidden.length) {
    errors.push(
      createIssue(
        "FORBIDDEN_NODE_PRESENT",
        presentForbidden,
        "Forbidden nodes must not be allocated.",
      ),
    );
  }

  const points = classifyAllocatedPoints(graph, candidate);
  for (const [code, used, budget] of [
    ["ORDINARY_BUDGET_EXCEEDED", points.ordinary, candidate.budgets.ordinary],
    [
      "PRIMARY_ASCENDANCY_BUDGET_EXCEEDED",
      points.primaryAscendancy,
      candidate.budgets.primaryAscendancy,
    ],
    [
      "SECONDARY_ASCENDANCY_BUDGET_EXCEEDED",
      points.secondaryAscendancy,
      candidate.budgets.secondaryAscendancy,
    ],
    ["TOTAL_BUDGET_EXCEEDED", points.total, candidate.budgets.total],
  ]) {
    if (used > budget) {
      errors.push(
        createIssue(code, [], "Allocated points exceed their budget.", {
          used,
          budget,
        }),
      );
    }
  }
  for (const [weaponSet, used] of Object.entries(points.weaponSets)) {
    const budget = Number(candidate.budgets.weaponSets[weaponSet] || 0);
    if (used > budget) {
      errors.push(
        createIssue(
          "WEAPON_SET_BUDGET_EXCEEDED",
          candidate.weaponSetAllocations[weaponSet],
          "Weapon-set allocations exceed their dedicated budget.",
          { weaponSet, used, budget },
        ),
      );
    }
  }

  const baseline = new Set(options.baselineAllocatedNodeIds || []);
  const removed = baseline.size
    ? [...baseline].filter((id) => !allocated.has(id))
    : [];
  const added = baseline.size
    ? candidate.allocatedNodeIds.filter((id) => !baseline.has(id))
    : [];
  const respecCount = removed.length + added.length;
  if (
    candidate.budgets.respec !== null &&
    respecCount > candidate.budgets.respec
  ) {
    errors.push(
      createIssue(
        "RESPEC_BUDGET_EXCEEDED",
        [...removed, ...added],
        "Candidate exceeds the optional respec budget.",
        { used: respecCount, budget: candidate.budgets.respec },
      ),
    );
  }

  if (
    Object.keys(candidate.weaponSetAllocations).length > 0 &&
    options.complexWeaponConnectivity
  ) {
    needsPob.push(
      createIssue(
        "WEAPON_SET_CONNECTIVITY_NEEDS_POB",
        Object.values(candidate.weaponSetAllocations).flat(),
        "Complex weapon-set connectivity requires PoB confirmation.",
      ),
    );
  }

  return {
    valid: errors.length === 0,
    status:
      errors.length > 0
        ? "invalid"
        : needsPob.length > 0
          ? "needs_pob"
          : "valid",
    errors,
    warnings,
    needsPob,
    counts: {
      allocated: candidate.allocatedNodeIds.length,
      ordinaryPoints: points.ordinary,
      primaryAscendancyPoints: points.primaryAscendancy,
      secondaryAscendancyPoints: points.secondaryAscendancy,
      weaponSetPoints: points.weaponSets,
      totalPoints: points.total,
      freeStarts: candidate.freeStartNodeIds.length,
      errors: errors.length,
      warnings: warnings.length,
      needsPob: needsPob.length,
      respec: respecCount,
    },
  };
}

module.exports = {
  validateCandidate,
};
