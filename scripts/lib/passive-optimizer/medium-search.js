"use strict";

const { performance } = require("node:perf_hooks");
const { candidateDelta } = require("./delta");
const { withCandidateKey } = require("./model");
const {
  applyDiversityCaps,
  applySearchDelta,
  changedNodes,
  epsilonParetoArchive,
  protectedNodeIds,
  repairConnectivity,
  representativeLabels,
  roleFamily,
  scoreSearchCandidate,
  selectRelevantPackages,
} = require("./search");
const { sortedUniqueNumbers, stableStringify } = require("./stable");
const { validateCandidate } = require("./validator");

const MEDIUM_SEARCH_VERSION = 1;
const TRANSACTION_TYPES = [
  "remove_articulation_branch",
  "add_remote_branch",
  "add_remote_bundle",
  "replace_equivalent_cluster",
  "reroute_biconnected_components",
  "prune_dead_travel",
];

function preservedState(
  candidate,
  reference = candidate,
  { allowAttributeRespec = false } = {},
) {
  const existingAttributeIds = new Set(
    Object.keys(reference.attributeOverrides || {}),
  );
  return stableStringify({
    classId: candidate.classId,
    classStart: candidate.classStart,
    primaryAscendancy: candidate.primaryAscendancy,
    secondaryAscendancy: candidate.secondaryAscendancy,
    attributeOverrides: allowAttributeRespec
      ? {}
      : Object.fromEntries(
          Object.entries(candidate.attributeOverrides || {})
            .filter(([id]) => existingAttributeIds.has(id)),
        ),
    switchableOverrides: candidate.switchableOverrides,
    multipleChoiceSelections: candidate.multipleChoiceSelections,
    masterySelections: candidate.masterySelections,
    jewelState: candidate.jewelState,
    weaponSetAllocations: candidate.weaponSetAllocations,
    requiredNodeIds: candidate.requiredNodeIds,
    forbiddenNodeIds: candidate.forbiddenNodeIds,
  });
}

function allocatedComponentsWithout(graph, allocated, cutId) {
  const seen = new Set([cutId]);
  const components = [];
  for (const start of [...allocated].sort((a, b) => a - b)) {
    if (seen.has(start)) continue;
    const component = [];
    const queue = [start];
    seen.add(start);
    for (let index = 0; index < queue.length; index += 1) {
      const id = queue[index];
      component.push(id);
      for (const next of graph.nodes.get(id)?.adjacency || []) {
        if (
          next === cutId ||
          seen.has(next) ||
          !allocated.has(next) ||
          graph.nodes.get(next)?.ascendancyId
        ) {
          continue;
        }
        seen.add(next);
        queue.push(next);
      }
    }
    components.push(sortedUniqueNumbers(component));
  }
  return components;
}

function articulationBranches(graph, candidate, options = {}) {
  const allocated = new Set(candidate.allocatedNodeIds);
  const protectedIds = protectedNodeIds(candidate, graph);
  const maximum = Number(options.maxChanges ?? 30);
  const branches = [];
  const seen = new Set();
  for (const articulationId of [...graph.articulationPoints].sort(
    (a, b) => a - b,
  )) {
    if (!allocated.has(articulationId)) continue;
    for (const component of allocatedComponentsWithout(
      graph,
      allocated,
      articulationId,
    )) {
      if (
        component.includes(candidate.classStart) ||
        component.some((id) => protectedIds.has(id)) ||
        component.length === 0 ||
        component.length > maximum
      ) {
        continue;
      }
      const key = component.join(",");
      if (seen.has(key)) continue;
      seen.add(key);
      const terminalIds = component.filter((id) => {
        const node = graph.nodes.get(id);
        return Boolean(
          node?.isNotable || node?.isKeystone || node?.isJewelSocket,
        );
      });
      branches.push({
        id: `branch:${articulationId}:${key}`,
        articulationId,
        removeNodeIds: component,
        terminalIds,
        componentIds: sortedUniqueNumbers(
          component.flatMap(
            (id) => graph.biconnectedComponentIds.get(id) || [],
          ),
        ),
      });
    }
  }
  return branches.sort(
    (left, right) =>
      right.removeNodeIds.length - left.removeNodeIds.length ||
      left.id.localeCompare(right.id),
  );
}

function shortestPathToPackage(graph, candidate, pkg) {
  const allocated = new Set(candidate.allocatedNodeIds);
  const targets = new Set(
    (pkg.coreNodeIds?.length ? pkg.coreNodeIds : pkg.addNodeIds || [])
      .filter((id) => {
        const node = graph.nodes.get(id);
        return node && !node.isOnlyImage && !node.ascendancyId;
      }),
  );
  if (targets.size === 0) return null;
  const queue = [...allocated]
    .filter((id) => !graph.nodes.get(id)?.ascendancyId)
    .sort((a, b) => a - b);
  const previous = new Map(queue.map((id) => [id, null]));
  let found = queue.find((id) => targets.has(id)) ?? null;
  for (let index = 0; index < queue.length && found === null; index += 1) {
    const id = queue[index];
    for (const next of [...(graph.nodes.get(id)?.adjacency || [])].sort(
      (a, b) => a - b,
    )) {
      const node = graph.nodes.get(next);
      if (
        previous.has(next) ||
        candidate.forbiddenNodeIds.includes(next) ||
        !node ||
        node.isOnlyImage ||
        node.ascendancyId
      ) {
        continue;
      }
      previous.set(next, id);
      queue.push(next);
      if (targets.has(next)) {
        found = next;
        break;
      }
    }
  }
  if (found === null) return null;
  const path = [];
  for (let current = found; current !== null; current = previous.get(current)) {
    path.push(current);
  }
  return path.reverse();
}

function packageIsActive(pkg, allocated) {
  return (
    (pkg.addNodeIds || []).length > 0 &&
    pkg.addNodeIds.every((id) => allocated.has(id))
  );
}

function transactionFamily(pkg) {
  return pkg ? roleFamily(pkg) : "travel";
}

function addedPackages(spec) {
  return spec.addPackages?.length
    ? spec.addPackages
    : spec.addPackage
      ? [spec.addPackage]
      : [];
}

function safeRemotePackage(graph, pkg) {
  return (pkg.addNodeIds || []).every((id) => {
    const node = graph.nodes.get(id);
    return Boolean(
      node &&
      !node.isOnlyImage &&
      !node.ascendancyId &&
      !node.isAttribute &&
      !node.isSwitchable &&
      !node.isMultipleChoice &&
      !node.isMultipleChoiceOption &&
      !node.isMastery,
    );
  });
}

function dominantAttributeOverride(candidate) {
  const counts = new Map();
  for (const value of Object.values(candidate.attributeOverrides || {})) {
    counts.set(value, (counts.get(value) || 0) + 1);
  }
  return [...counts]
    .sort(
      (left, right) =>
        right[1] - left[1] ||
        String(left[0]).localeCompare(String(right[0])),
    )[0]?.[0] || "str";
}

function safeConnectorNode(graph, id) {
  const node = graph.nodes.get(id);
  return Boolean(
    node &&
    !node.isOnlyImage &&
    !node.ascendancyId &&
    (!node.isSwitchable || node.isAttribute) &&
    !node.isMultipleChoice &&
    !node.isMultipleChoiceOption &&
    !node.isMastery,
  );
}

function createTransactionSpecs({
  graph,
  candidate,
  packages,
  profile,
  buildState,
  baselineMetrics,
  scorerConfig,
  branchLimit = 14,
  remotePackageLimit = 120,
  transactionLimit = 1800,
  seed = 0,
  minChanges = 20,
  maxChanges = 30,
  diagnostics = null,
}) {
  const generation = diagnostics || {};
  generation.remoteBundle = {
    branches: 0,
    budgetFeasible: 0,
    pathsMissing: 0,
    removedOverlap: 0,
    unsafePath: 0,
    remoteOptions: 0,
    belowMinimum: 0,
    specsAdded: 0,
  };
  const allocated = new Set(candidate.allocatedNodeIds);
  const branches = articulationBranches(graph, candidate, { maxChanges })
    .slice(0, branchLimit);
  const fundingBranches = [...branches];
  for (let leftIndex = 0; leftIndex < branches.length; leftIndex += 1) {
    for (
      let rightIndex = leftIndex + 1;
      rightIndex < branches.length;
      rightIndex += 1
    ) {
      const left = branches[leftIndex];
      const right = branches[rightIndex];
      const leftNodes = new Set(left.removeNodeIds);
      if (right.removeNodeIds.some((id) => leftNodes.has(id))) continue;
      const removeNodeIds = sortedUniqueNumbers([
        ...left.removeNodeIds,
        ...right.removeNodeIds,
      ]);
      if (removeNodeIds.length > maxChanges) continue;
      fundingBranches.push({
        id: `branches:${left.id}+${right.id}`,
        articulationId: null,
        articulationIds: sortedUniqueNumbers([
          left.articulationId,
          right.articulationId,
        ]),
        removeNodeIds,
        terminalIds: sortedUniqueNumbers([
          ...left.terminalIds,
          ...right.terminalIds,
        ]),
        componentIds: sortedUniqueNumbers([
          ...left.componentIds,
          ...right.componentIds,
        ]),
      });
    }
  }
  for (let start = 0; start < branches.length; start += 1) {
    const selected = [];
    const selectedNodes = new Set();
    for (let offset = 0; offset < branches.length; offset += 1) {
      const branch = branches[(start + offset) % branches.length];
      if (branch.removeNodeIds.some((id) => selectedNodes.has(id))) continue;
      if (
        selectedNodes.size + branch.removeNodeIds.length >
        maxChanges
      ) {
        continue;
      }
      selected.push(branch);
      for (const id of branch.removeNodeIds) selectedNodes.add(id);
      if (selectedNodes.size >= minChanges) break;
    }
    if (selectedNodes.size < minChanges) continue;
    fundingBranches.push({
      id: `branch-bundle:${selected.map((entry) => entry.id).join("+")}`,
      articulationId: null,
      articulationIds: sortedUniqueNumbers(
        selected.map((entry) => entry.articulationId),
      ),
      removeNodeIds: sortedUniqueNumbers([...selectedNodes]),
      terminalIds: sortedUniqueNumbers(
        selected.flatMap((entry) => entry.terminalIds),
      ),
      componentIds: sortedUniqueNumbers(
        selected.flatMap((entry) => entry.componentIds),
      ),
    });
  }
  const relevant = selectRelevantPackages({
    graph,
    buildState,
    candidate,
    packages,
    profile,
    baselineMetrics,
    scorerConfig,
    limit: remotePackageLimit,
    seed,
  });
  const inactive = relevant.filter((pkg) =>
    !packageIsActive(pkg, allocated) &&
    safeRemotePackage(graph, pkg) &&
    pkg.scopes?.tree !== "ascendancy" &&
    !["ascendancy_package", "build_specific_package"].includes(
      pkg.structuralType,
    ),
  );
  const active = relevant.filter((pkg) => packageIsActive(pkg, allocated));
  const specs = [];
  const seen = new Set();

  function add(spec) {
    const key = stableStringify({
      type: spec.type,
      branch: spec.branch?.id || null,
      addPackage: spec.addPackage?.id || null,
      addPackages: addedPackages(spec).map((pkg) => pkg.id).sort(),
      removePackage: spec.removePackage?.id || null,
    });
    if (seen.has(key) || specs.length >= transactionLimit) return;
    seen.add(key);
    specs.push({ ...spec, id: `tx:${specs.length}:${key}` });
  }

  for (const branch of fundingBranches) {
    add({ type: "remove_articulation_branch", branch });
    add({ type: "prune_dead_travel", branch });
  }
  const singleRemoteSpecLimit = Math.max(
    specs.length,
    Math.floor(transactionLimit * 0.65),
  );
  for (const branch of fundingBranches) {
    for (const pkg of inactive) {
      if (specs.length >= singleRemoteSpecLimit) break;
      const path = shortestPathToPackage(graph, candidate, pkg);
      if (!path) continue;
      if (!path.every((id) => safeConnectorNode(graph, id))) {
        continue;
      }
      const addCount = new Set([
        ...path,
        ...(pkg.addNodeIds || []),
      ].filter((id) => !allocated.has(id))).size;
      const changed = addCount + branch.removeNodeIds.length;
      const trimmable = (pkg.optionalNodeIds || []).length +
        Math.max(0, (pkg.addNodeIds || []).length -
          (pkg.coreNodeIds || []).length);
      if (changed > maxChanges + trimmable || changed < minChanges) continue;
      add({
        type: "add_remote_branch",
        branch,
        addPackage: pkg,
        path,
      });
      const disjointComponents = !pkg.context?.componentIds?.some((id) =>
        branch.componentIds.includes(id),
      );
      if (disjointComponents) {
        add({
          type: "reroute_biconnected_components",
          branch,
          addPackage: pkg,
          path,
        });
      }
    }
  }
  for (const branch of fundingBranches) {
    generation.remoteBundle.branches += 1;
    const removed = new Set(branch.removeNodeIds);
    const fundedCandidate = applySearchDelta(candidate, {
      removeNodeIds: branch.removeNodeIds,
    });
    const maximumAdded = Math.min(
      branch.removeNodeIds.length,
      maxChanges - branch.removeNodeIds.length,
    );
    const minimumAdded = Math.max(
      minChanges - branch.removeNodeIds.length,
      Math.min(10, Math.ceil(branch.removeNodeIds.length * 0.5)),
    );
    if (maximumAdded < minimumAdded) continue;
    generation.remoteBundle.budgetFeasible += 1;
    const remote = inactive
      .map((pkg) => ({
        pkg,
        path: shortestPathToPackage(graph, fundedCandidate, pkg),
      }))
      .filter(({ pkg, path }) => {
        if (!path) {
          generation.remoteBundle.pathsMissing += 1;
          return false;
        }
        if ([...path, ...(pkg.addNodeIds || [])].some((id) => removed.has(id))) {
          generation.remoteBundle.removedOverlap += 1;
          return false;
        }
        if (!path.every((id) => safeConnectorNode(graph, id))) {
          generation.remoteBundle.unsafePath += 1;
          return false;
        }
        generation.remoteBundle.remoteOptions += 1;
        return true;
      });
    for (
      let start = 0;
      start < Math.min(remote.length, branchLimit);
      start += 1
    ) {
      const selected = [];
      const selectedIds = new Set();
      const nodes = new Set();
      for (let offset = 0; offset < remote.length; offset += 1) {
        const option = remote[(start + offset) % remote.length];
        if (selectedIds.has(option.pkg.id)) continue;
        const conflicts = new Set(option.pkg.conflicts || []);
        if (selected.some((entry) =>
          conflicts.has(entry.pkg.id) ||
          (entry.pkg.conflicts || []).includes(option.pkg.id)
        )) {
          continue;
        }
        const nextNodes = new Set(nodes);
        for (const id of [...option.path, ...(option.pkg.addNodeIds || [])]) {
          if (!allocated.has(id)) nextNodes.add(id);
        }
        if (nextNodes.size > maximumAdded) continue;
        selected.push(option);
        selectedIds.add(option.pkg.id);
        for (const id of nextNodes) nodes.add(id);
        if (nodes.size >= minimumAdded) break;
        if (selected.length >= 8) break;
      }
      if (nodes.size < minimumAdded) {
        generation.remoteBundle.belowMinimum += 1;
        continue;
      }
      const before = specs.length;
      add({
        type: "add_remote_bundle",
        branch,
        addPackages: selected.map((entry) => entry.pkg),
        path: sortedUniqueNumbers(selected.flatMap((entry) => entry.path)),
      });
      if (specs.length > before) generation.remoteBundle.specsAdded += 1;
    }
  }
  const activeByRole = new Map();
  for (const pkg of active) {
    const role = transactionFamily(pkg);
    if (!activeByRole.has(role)) activeByRole.set(role, []);
    activeByRole.get(role).push(pkg);
  }
  for (const pkg of inactive) {
    for (const previous of (activeByRole.get(transactionFamily(pkg)) || [])
      .slice(0, 3)) {
      const branch = fundingBranches.find((entry) =>
        previous.addNodeIds.some((id) => entry.removeNodeIds.includes(id)),
      );
      if (!branch) continue;
      const path = shortestPathToPackage(graph, candidate, pkg);
      if (!path) continue;
      if (!path.every((id) => safeConnectorNode(graph, id))) {
        continue;
      }
      const addCount = new Set([
        ...path,
        ...(pkg.addNodeIds || []),
      ].filter((id) => !allocated.has(id))).size;
      const changed = addCount + branch.removeNodeIds.length;
      const trimmable = (pkg.optionalNodeIds || []).length +
        Math.max(0, (pkg.addNodeIds || []).length -
          (pkg.coreNodeIds || []).length);
      if (changed > maxChanges + trimmable || changed < minChanges) continue;
      add({
        type: "replace_equivalent_cluster",
        branch,
        addPackage: pkg,
        removePackage: previous,
        path,
      });
    }
  }
  return specs;
}

function pruneDeadTravel(graph, candidate, keepIds) {
  const allocated = new Set(candidate.allocatedNodeIds);
  const removed = [];
  let changed = true;
  while (changed) {
    changed = false;
    for (const id of [...allocated].sort((a, b) => a - b)) {
      const node = graph.nodes.get(id);
      if (
        keepIds.has(id) ||
        node?.ascendancyId ||
        node?.isNotable ||
        node?.isKeystone ||
        node?.isJewelSocket ||
        node?.isSwitchable ||
        node?.isMultipleChoice ||
        node?.isMultipleChoiceOption ||
        node?.isMastery
      ) {
        continue;
      }
      const degree = (node?.adjacency || []).filter((next) =>
        allocated.has(next),
      ).length;
      if (degree <= 1) {
        allocated.delete(id);
        removed.push(id);
        changed = true;
      }
    }
  }
  return {
    candidate: applySearchDelta(candidate, { removeNodeIds: removed }),
    removedNodeIds: sortedUniqueNumbers(removed),
  };
}

function executeMediumTransaction({
  graph,
  incumbent,
  spec,
  minChanges = 20,
  maxChanges = 30,
  allowAttributeRespec = false,
}) {
  const protectedIds = protectedNodeIds(incumbent, graph);
  if (allowAttributeRespec) {
    for (const id of Object.keys(incumbent.attributeOverrides || {}).map(Number)) {
      if (!(incumbent.requiredNodeIds || []).includes(id)) protectedIds.delete(id);
    }
  }
  const beforeState = preservedState(incumbent, incumbent, {
    allowAttributeRespec,
  });
  const removeNodeIds = sortedUniqueNumbers([
    ...(spec.branch?.removeNodeIds || []),
    ...(spec.removePackage?.addNodeIds || []),
  ]).filter((id) => !protectedIds.has(id));
  if (
    removeNodeIds.length !==
    new Set([
      ...(spec.branch?.removeNodeIds || []),
      ...(spec.removePackage?.addNodeIds || []),
    ]).size
  ) {
    return {
      committed: false,
      candidate: incumbent,
      reason: "PROTECTED_NODE_REMOVAL",
    };
  }
  const addNodeIds = sortedUniqueNumbers([
    ...(spec.path || []),
    ...addedPackages(spec).flatMap((pkg) => pkg.addNodeIds || []),
  ]).filter((id) => !incumbent.allocatedNodeIds.includes(id));
  const grown = applySearchDelta(incumbent, { addNodeIds });
  const peakPointOverage = Math.max(
    0,
    grown.allocatedNodeIds.length - incumbent.allocatedNodeIds.length,
  );
  let trimmed = applySearchDelta(grown, { removeNodeIds });
  const keepIds = new Set([
    ...protectedIds,
    ...addedPackages(spec).flatMap((pkg) => pkg.coreNodeIds || []),
    ...addedPackages(spec).flatMap((pkg) => pkg.terminalLandmarkIds || []),
    ...(spec.path || []),
  ]);
  const growTrimRemovedNodeIds = [];
  const optionalAdded = sortedUniqueNumbers([
    ...addedPackages(spec).flatMap((pkg) => pkg.optionalNodeIds || []),
    ...addedPackages(spec).flatMap((pkg) => pkg.addNodeIds || []),
  ]).filter(
    (id) =>
      !keepIds.has(id) &&
      !incumbent.allocatedNodeIds.includes(id) &&
      trimmed.allocatedNodeIds.includes(id),
  );
  while (
    optionalAdded.length > 0 &&
    (
      trimmed.allocatedNodeIds.length > incumbent.allocatedNodeIds.length ||
      changedNodes(incumbent, trimmed).length > maxChanges
    )
  ) {
    const id = optionalAdded.pop();
    growTrimRemovedNodeIds.push(id);
    trimmed = applySearchDelta(trimmed, { removeNodeIds: [id] });
  }
  const pruned = pruneDeadTravel(graph, trimmed, keepIds);
  const repair = repairConnectivity(graph, incumbent, pruned.candidate, {
    maxChanges,
  });
  if (!repair) {
    return {
      committed: false,
      candidate: incumbent,
      reason: "REPAIR_FAILED",
      peakPointOverage,
    };
  }
  const allocatedAfterRepair = new Set(repair.candidate.allocatedNodeIds);
  const attributeOverrides = Object.fromEntries(
    Object.entries(repair.candidate.attributeOverrides || {})
      .filter(([id]) => !allowAttributeRespec || allocatedAfterRepair.has(Number(id))),
  );
  const inheritedAttribute = dominantAttributeOverride(incumbent);
  for (const id of repair.candidate.allocatedNodeIds) {
    if (
      graph.nodes.get(id)?.isAttribute &&
      attributeOverrides[id] === undefined
    ) {
      attributeOverrides[id] = inheritedAttribute;
    }
  }
  const candidate = withCandidateKey({
    ...repair.candidate,
    attributeOverrides,
  });
  const delta = candidateDelta(incumbent, candidate);
  const changed = delta.addNodeIds.length + delta.removeNodeIds.length;
  if (changed < minChanges || changed > maxChanges) {
    return {
      committed: false,
      candidate: incumbent,
      reason: "FINAL_CHANGE_BUDGET",
      changed,
      peakPointOverage,
    };
  }
  if (preservedState(candidate, incumbent, {
    allowAttributeRespec,
  }) !== beforeState) {
    return {
      committed: false,
      candidate: incumbent,
      reason: "PROTECTED_STATE_DRIFT",
      peakPointOverage,
    };
  }
  const validation = validateCandidate(graph, candidate, {
    baselineAllocatedNodeIds: incumbent.allocatedNodeIds,
  });
  if (!validation.valid) {
    return {
      committed: false,
      candidate: incumbent,
      reason: "FINAL_VALIDATION_FAILED",
      validation,
      peakPointOverage,
    };
  }
  return {
    committed: true,
    candidate,
    validation,
    delta,
    changed,
    peakPointOverage,
    temporaryPointBank: removeNodeIds.length,
    repaired: repair.repaired,
    repairAddedNodeIds: repair.addedNodeIds,
    deadTravelRemovedNodeIds: pruned.removedNodeIds,
    growTrimRemovedNodeIds: sortedUniqueNumbers(growTrimRemovedNodeIds),
  };
}

function runMediumRebuildSearch(input) {
  const {
    graph,
    buildState,
    candidate: incumbent,
    packages,
    profile,
    baselineMetrics = null,
    scorerConfig = {},
  } = input;
  const options = {
    minChanges: Math.max(1, Number(input.minChanges ?? 20)),
    maxChanges: Math.max(1, Number(input.maxChanges ?? 30)),
    branchLimit: Math.max(1, Number(input.branchLimit ?? 14)),
    remotePackageLimit: Math.max(1, Number(input.remotePackageLimit ?? 120)),
    transactionLimit: Math.max(1, Number(input.transactionLimit ?? 1800)),
    batchSize: Math.max(1, Number(input.batchSize ?? 64)),
    resultLimit: Math.max(1, Number(input.resultLimit ?? 12)),
    diversityBucketCap: Math.max(
      1,
      Number(input.diversityBucketCap ?? 3),
    ),
    runtimeLimitMs: Number.isFinite(Number(input.runtimeLimitMs))
      ? Math.max(1, Number(input.runtimeLimitMs))
      : null,
    seed: Number(input.seed) || 0,
  };
  if (options.minChanges > options.maxChanges) {
    throw new Error("minChanges cannot exceed maxChanges");
  }
  const started = performance.now();
  const baselineSnapshot = stableStringify(incumbent);
  const generationDiagnostics = {};
  const specs = createTransactionSpecs({
    graph,
    candidate: incumbent,
    packages,
    profile,
    buildState,
    baselineMetrics,
    scorerConfig,
    diagnostics: generationDiagnostics,
    ...options,
  });
  const packageById = new Map(packages.map((pkg) => [pkg.id, pkg]));
  const counts = {
    transactionSpecs: specs.length,
    attempted: 0,
    committed: 0,
    rollback: 0,
    duplicate: 0,
    invalid: 0,
    repaired: 0,
    byType: Object.fromEntries(
      TRANSACTION_TYPES.map((type) => [type, {
        attempted: 0,
        committed: 0,
      }]),
    ),
    rollbackReasons: {},
    rollbackChangeCounts: {},
    rollbackValidationErrors: {},
  };
  const seen = new Set([incumbent.canonicalKey]);
  const usable = [];
  let runtimeLimited = false;
  for (let offset = 0; offset < specs.length; offset += options.batchSize) {
    if (
      options.runtimeLimitMs !== null &&
      offset > 0 &&
      performance.now() - started >= options.runtimeLimitMs
    ) {
      runtimeLimited = true;
      break;
    }
    for (const spec of specs.slice(offset, offset + options.batchSize)) {
      counts.attempted += 1;
      counts.byType[spec.type].attempted += 1;
      const transaction = executeMediumTransaction({
        graph,
        incumbent,
        spec,
        minChanges: options.minChanges,
        maxChanges: options.maxChanges,
      });
      if (!transaction.committed) {
        counts.rollback += 1;
        counts.rollbackReasons[transaction.reason] =
          (counts.rollbackReasons[transaction.reason] || 0) + 1;
        if (Number.isFinite(transaction.changed)) {
          counts.rollbackChangeCounts[transaction.changed] =
            (counts.rollbackChangeCounts[transaction.changed] || 0) + 1;
        }
        for (const issue of transaction.validation?.errors || []) {
          counts.rollbackValidationErrors[issue.code] =
            (counts.rollbackValidationErrors[issue.code] || 0) + 1;
        }
        continue;
      }
      if (seen.has(transaction.candidate.canonicalKey)) {
        counts.duplicate += 1;
        continue;
      }
      seen.add(transaction.candidate.canonicalKey);
      const effects = [
        ...addedPackages(spec).map((pkg) => ({
          packageId: pkg.id,
          direction: 1,
        })),
        ...(spec.removePackage
          ? [{ packageId: spec.removePackage.id, direction: -1 }]
          : []),
      ];
      const score = scoreSearchCandidate({
        graph,
        buildState,
        incumbent,
        candidate: transaction.candidate,
        effects,
        packageById,
        profile,
        baselineMetrics,
        scorerConfig,
        validation: transaction.validation,
        allowStructuralEffectInvalid: true,
      });
      if (score.status === "invalid") {
        counts.invalid += 1;
        continue;
      }
      counts.committed += 1;
      counts.byType[spec.type].committed += 1;
      if (transaction.repaired) counts.repaired += 1;
      usable.push({
        canonicalKey: transaction.candidate.canonicalKey,
        candidate: transaction.candidate,
        validation: transaction.validation,
        ...score,
        changedNodeIds: changedNodes(incumbent, transaction.candidate),
        changedNodeCount: transaction.changed,
        families: [...new Set(
          addedPackages(spec).map(transactionFamily),
        )].sort(),
        moveHistory: [{
          id: spec.id,
          type: spec.type,
          packageIds: [
            ...addedPackages(spec).map((pkg) => pkg.id),
            spec.removePackage?.id,
          ].filter(Boolean),
          articulationId: spec.branch?.articulationId ?? null,
        }],
        depth: 1,
        needsPoB: score.status === "needsPoB",
        transaction: {
          type: spec.type,
          temporaryPointBank: transaction.temporaryPointBank,
          peakPointOverage: transaction.peakPointOverage,
          deadTravelRemovedNodeIds:
            transaction.deadTravelRemovedNodeIds,
          growTrimRemovedNodeIds:
            transaction.growTrimRemovedNodeIds,
          repairAddedNodeIds: transaction.repairAddedNodeIds,
        },
      });
    }
  }
  const paretoArchive = epsilonParetoArchive(usable);
  const explorationBucket = usable
    .filter(
      (entry) =>
        entry.status === "needsPoB" &&
        !paretoArchive.some(
          (other) => other.canonicalKey === entry.canonicalKey,
        ),
    )
    .sort(
      (left, right) =>
        right.objectives.uncertainty - left.objectives.uncertainty ||
        right.rankScore - left.rankScore ||
        left.canonicalKey.localeCompare(right.canonicalKey),
    )
    .slice(0, options.diversityBucketCap);
  const archive = [...paretoArchive, ...explorationBucket].sort(
    (left, right) =>
      right.rankScore - left.rankScore ||
      left.canonicalKey.localeCompare(right.canonicalKey),
  );
  const labels = representativeLabels(archive);
  const representatives = applyDiversityCaps(
    [...archive].sort(
      (left, right) =>
        Number(labels.has(right.canonicalKey)) -
          Number(labels.has(left.canonicalKey)) ||
        right.rankScore - left.rankScore ||
        left.canonicalKey.localeCompare(right.canonicalKey),
    ),
    {
      limit: options.resultLimit,
      bucketCap: options.diversityBucketCap,
    },
  ).map((entry) => ({
    ...entry,
    representativeLabels: labels.get(entry.canonicalKey) || [],
  }));
  const archiveKeys = new Set(archive.map((entry) => entry.canonicalKey));
  const calibrationPool = [...usable]
    .sort(
      (left, right) =>
        right.rankScore - left.rankScore ||
        left.canonicalKey.localeCompare(right.canonicalKey),
    )
    .map((entry, cheapRank) => ({
      ...entry,
      cheapRank: cheapRank + 1,
      cheapPruned: !archiveKeys.has(entry.canonicalKey),
      calibrationKind: "candidate",
    }));
  if (stableStringify(incumbent) !== baselineSnapshot) {
    throw new Error("Medium search mutated the incumbent candidate");
  }
  return {
    mediumSearchVersion: MEDIUM_SEARCH_VERSION,
    options,
    counts,
    generationDiagnostics,
    runtime: {
      elapsedMs: performance.now() - started,
      limited: runtimeLimited,
    },
    paretoArchiveSize: paretoArchive.length,
    explorationBucketSize: explorationBucket.length,
    archiveSize: archive.length,
    archive,
    representatives,
    calibrationPool,
  };
}

module.exports = {
  MEDIUM_SEARCH_VERSION,
  TRANSACTION_TYPES,
  articulationBranches,
  createTransactionSpecs,
  executeMediumTransaction,
  pruneDeadTravel,
  runMediumRebuildSearch,
  shortestPathToPackage,
};
