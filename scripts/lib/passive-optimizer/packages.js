"use strict";

const { candidateDelta, deltaCost, normalizeDelta } = require("./delta");
const { parseStatLines } = require("./stat-taxonomy");
const {
  sha256,
  sortedUniqueNumbers,
  stableStringify,
} = require("./stable");

const PACKAGE_SCHEMA_VERSION = 1;
const EXTRACTOR_VERSION = 1;
const STRUCTURAL_TYPES = [
  "notable_cluster",
  "terminal_connector",
  "travel_corridor",
  "bridge_reroute_patch",
  "jewel_socket_package",
  "keystone_package",
  "ascendancy_package",
  "build_specific_package",
];

function isChoice(node) {
  return Boolean(
    node?.isSwitchable ||
      node?.isMultipleChoice ||
      node?.isMultipleChoiceOption ||
      node?.isMastery,
  );
}

function isLandmark(graph, id) {
  const node = graph.nodes.get(id);
  return Boolean(
    node &&
      (node.isNotable ||
        node.isKeystone ||
        node.isJewelSocket ||
        node.classStarts.length ||
        node.isAscendancyStart ||
        isChoice(node) ||
        graph.articulationPoints.has(id) ||
        node.adjacency.length !== 2),
  );
}

function sameAscendancy(left, right) {
  return (left?.ascendancyId || null) === (right?.ascendancyId || null);
}

function nodeContext(graph, nodeIds) {
  const nodes = nodeIds.map((id) => graph.nodes.get(id)).filter(Boolean);
  return {
    groups: [...new Set(nodes.map((node) => node.group).filter((v) => v !== null))]
      .sort((a, b) => Number(a) - Number(b)),
    articulationNodeIds: sortedUniqueNumbers(
      nodeIds.filter((id) => graph.articulationPoints.has(id)),
    ),
    componentIds: sortedUniqueNumbers(
      nodeIds.flatMap((id) => graph.biconnectedComponentIds.get(id) || []),
    ),
    ascendancyIds: [
      ...new Set(nodes.map((node) => node.ascendancyId).filter(Boolean)),
    ].sort(),
    ascendancyNames: [
      ...new Set(nodes.map((node) => node.ascendancyName).filter(Boolean)),
    ].sort(),
  };
}

function packageIdentity(pkg, graph) {
  return {
    packageSchemaVersion: PACKAGE_SCHEMA_VERSION,
    extractorVersion: EXTRACTOR_VERSION,
    treeDataHash: graph.source.hash,
    treeVersion: graph.source.treeVersion,
    structuralType: pkg.structuralType,
    sourceNodeIds: sortedUniqueNumbers(pkg.sourceNodeIds),
    addNodeIds: sortedUniqueNumbers(pkg.addNodeIds),
    removeNodeIds: sortedUniqueNumbers(pkg.removeNodeIds),
    variantKey: pkg.variantKey || null,
  };
}

function finalizePackage(graph, candidate, input) {
  const sourceNodeIds = sortedUniqueNumbers(input.sourceNodeIds);
  const addNodeIds = sortedUniqueNumbers(input.addNodeIds);
  const removeNodeIds = sortedUniqueNumbers(input.removeNodeIds);
  const rawStatLines = sourceNodeIds.flatMap((id) => {
    const node = graph.nodes.get(id);
    return [
      ...(node?.rawStats || node?.stats || []),
      ...(node?.options || []).flatMap((option) => option.stats || []),
    ];
  });
  const specialNodes = sourceNodeIds
    .map((id) => graph.nodes.get(id))
    .filter(Boolean);
  const stats = parseStatLines(rawStatLines, {
    isKeystone: specialNodes.some((node) => node.isKeystone),
    isJewelSocket: specialNodes.some((node) => node.isJewelSocket),
    isSwitchable: specialNodes.some((node) => node.isSwitchable),
    isMultipleChoice: specialNodes.some(
      (node) => node.isMultipleChoice || node.isMultipleChoiceOption,
    ),
  });
  const delta = normalizeDelta({ addNodeIds, removeNodeIds });
  const identity = packageIdentity(
    {
      ...input,
      sourceNodeIds,
      addNodeIds,
      removeNodeIds,
    },
    graph,
  );
  const id = `pkg-${input.structuralType}-${sha256(
    stableStringify(identity),
  ).slice(0, 16)}`;
  const inferredRequirements = specialNodes.flatMap((node) => {
    const constraint = node.unlockConstraint;
    if (!constraint) return [];
    const nodeIds = Array.isArray(constraint.nodes)
      ? constraint.nodes
      : Array.isArray(constraint)
        ? constraint
        : [];
    return [
      {
        code: "UNLOCK_CONSTRAINT",
        nodeIds,
        details: constraint,
      },
    ];
  });
  const requirements = [
    ...(input.requirements || []),
    ...inferredRequirements,
  ].map((entry) => ({
    code: entry.code,
    nodeIds: sortedUniqueNumbers(entry.nodeIds),
    details: entry.details || null,
  }));
  const reasonCodes = [
    ...new Set([
      ...(input.reasonCodes || []),
      ...stats.reasonCodes,
      ...(requirements.length ? ["HAS_REQUIREMENTS"] : []),
    ]),
  ].sort();
  return {
    id,
    packageSchemaVersion: PACKAGE_SCHEMA_VERSION,
    extractorVersion: EXTRACTOR_VERSION,
    structuralType: input.structuralType,
    name: input.name || input.structuralType,
    coreNodeIds: sortedUniqueNumbers(input.coreNodeIds),
    connectorNodeIds: sortedUniqueNumbers(input.connectorNodeIds),
    optionalNodeIds: sortedUniqueNumbers(input.optionalNodeIds),
    addNodeIds,
    removeNodeIds,
    entryLandmarkIds: sortedUniqueNumbers(input.entryLandmarkIds),
    exitLandmarkIds: sortedUniqueNumbers(input.exitLandmarkIds),
    terminalLandmarkIds: sortedUniqueNumbers(input.terminalLandmarkIds),
    context: nodeContext(graph, sourceNodeIds),
    rawStatLines: stats.rawLines,
    stats,
    normalizedTags: stats.normalizedTags,
    costs: {
      ...deltaCost(candidate, delta),
      opportunity: Math.max(
        0,
        deltaCost(candidate, delta).marginal.add -
          deltaCost(candidate, delta).marginal.remove,
      ),
    },
    requirements,
    dependencies: [],
    conflicts: [],
    overlaps: [],
    scopes: {
      tree: specialNodes.some((node) => node.ascendancyId)
        ? "ascendancy"
        : "ordinary",
      ascendancyIds: nodeContext(graph, sourceNodeIds).ascendancyIds,
      weaponSet: "shared",
      buildSpecific: input.structuralType === "build_specific_package",
    },
    uncertainty:
      input.uncertainty === "high" || stats.uncertainty === "high"
        ? "high"
        : input.uncertainty || "low",
    needsPoB: Boolean(input.needsPoB || stats.needsPoB),
    reasonCodes,
    sourceNodeIds,
    treeDataHash: graph.source.hash,
    treeVersion: graph.source.treeVersion,
    variantKey: input.variantKey || null,
    metadata: input.metadata || {},
  };
}

function localCluster(graph, seedId) {
  const seed = graph.nodes.get(seedId);
  const seen = new Set([seedId]);
  const queue = [seedId];
  for (let index = 0; index < queue.length; index += 1) {
    const id = queue[index];
    for (const next of graph.nodes.get(id)?.adjacency || []) {
      const node = graph.nodes.get(next);
      if (
        seen.has(next) ||
        !node ||
        node.isOnlyImage ||
        !sameAscendancy(seed, node) ||
        node.group !== seed.group ||
        (graph.articulationPoints.has(next) && next !== seedId) ||
        (isLandmark(graph, next) && next !== seedId)
      ) {
        continue;
      }
      seen.add(next);
      queue.push(next);
    }
  }
  return sortedUniqueNumbers(seen);
}

function extractNotableClusters(graph, candidate) {
  return graph.landmarks.notables.map((id) => {
    const cluster = localCluster(graph, id);
    const boundary = sortedUniqueNumbers(
      cluster.flatMap((nodeId) =>
        (graph.nodes.get(nodeId)?.adjacency || []).filter(
          (next) => !cluster.includes(next),
        ),
      ),
    );
    const node = graph.nodes.get(id);
    return finalizePackage(graph, candidate, {
      structuralType: "notable_cluster",
      name: node.name || `Notable ${id}`,
      coreNodeIds: [id],
      connectorNodeIds: cluster.filter((nodeId) => nodeId !== id),
      optionalNodeIds: [],
      addNodeIds: cluster,
      removeNodeIds: [],
      entryLandmarkIds: boundary,
      exitLandmarkIds: boundary,
      terminalLandmarkIds: [id],
      sourceNodeIds: cluster,
      reasonCodes: ["LOCAL_NOTABLE_CLUSTER"],
    });
  });
}

function corridorKey(path) {
  const forward = path.join(",");
  const reverse = [...path].reverse().join(",");
  return forward < reverse ? forward : reverse;
}

function extractCorridors(graph, candidate) {
  const paths = new Map();
  const landmarkIds = [...graph.nodes.keys()]
    .filter((id) => isLandmark(graph, id))
    .sort((a, b) => a - b);
  for (const start of landmarkIds) {
    const startNode = graph.nodes.get(start);
    for (const first of startNode.adjacency) {
      const firstNode = graph.nodes.get(first);
      if (
        !firstNode ||
        firstNode.isOnlyImage ||
        isLandmark(graph, first) ||
        !sameAscendancy(startNode, firstNode)
      ) {
        continue;
      }
      const path = [start, first];
      let previous = start;
      let current = first;
      while (!isLandmark(graph, current)) {
        const nextOptions = (graph.nodes.get(current)?.adjacency || []).filter(
          (next) =>
            next !== previous &&
            sameAscendancy(graph.nodes.get(current), graph.nodes.get(next)),
        );
        if (nextOptions.length !== 1) break;
        previous = current;
        current = nextOptions[0];
        path.push(current);
      }
      if (path.length >= 3 && isLandmark(graph, path.at(-1))) {
        const key = corridorKey(path);
        if (!paths.has(key)) paths.set(key, path);
      }
    }
  }
  return [...paths.values()]
    .sort((left, right) => corridorKey(left).localeCompare(corridorKey(right)))
    .map((path) =>
      finalizePackage(graph, candidate, {
        structuralType: "travel_corridor",
        name: `Corridor ${path[0]}-${path.at(-1)}`,
        coreNodeIds: [],
        connectorNodeIds: path.slice(1, -1),
        optionalNodeIds: [],
        addNodeIds: path.slice(1, -1),
        removeNodeIds: [],
        entryLandmarkIds: [path[0]],
        exitLandmarkIds: [path.at(-1)],
        terminalLandmarkIds: [],
        sourceNodeIds: path,
        reasonCodes: ["DEGREE_TWO_CORRIDOR"],
      }),
    );
}

function connectorPath(graph, terminalId, firstId) {
  const terminal = graph.nodes.get(terminalId);
  const path = [terminalId, firstId];
  let previous = terminalId;
  let current = firstId;
  while (!isLandmark(graph, current)) {
    const options = (graph.nodes.get(current)?.adjacency || [])
      .filter(
        (next) =>
          next !== previous &&
          sameAscendancy(terminal, graph.nodes.get(next)),
      )
      .sort((a, b) => a - b);
    if (options.length !== 1) break;
    previous = current;
    current = options[0];
    path.push(current);
  }
  return isLandmark(graph, path.at(-1)) ? path : null;
}

function terminalIds(graph) {
  return sortedUniqueNumbers([
    ...graph.landmarks.notables,
    ...graph.landmarks.keystones,
    ...graph.landmarks.jewelSockets,
  ]);
}

function distancesFrom(graph, rootId, ascendancyId) {
  const distances = new Map([[rootId, 0]]);
  const queue = [rootId];
  for (let index = 0; index < queue.length; index += 1) {
    const id = queue[index];
    for (const next of graph.nodes.get(id)?.adjacency || []) {
      const node = graph.nodes.get(next);
      if (
        distances.has(next) ||
        !node ||
        node.isOnlyImage ||
        (node.ascendancyId || null) !== (ascendancyId || null)
      ) {
        continue;
      }
      distances.set(next, distances.get(id) + 1);
      queue.push(next);
    }
  }
  return distances;
}

function extractTerminalConnectors(graph, candidate) {
  const packages = [];
  for (const terminalId of terminalIds(graph)) {
    const terminal = graph.nodes.get(terminalId);
    const rootId = terminal.ascendancyId
      ? graph.ascendancyStarts.get(String(terminal.ascendancyId))
      : candidate.classStart;
    const distances = distancesFrom(graph, rootId, terminal.ascendancyId);
    const paths = terminal.adjacency
      .map((next) => connectorPath(graph, terminalId, next))
      .filter(
        (path) =>
          path &&
          (distances.get(path.at(-1)) ?? Infinity) <
            (distances.get(terminalId) ?? Infinity),
      );
    const uniquePaths = [
      ...new Map(paths.map((path) => [corridorKey(path), path])).values(),
    ].sort((left, right) =>
      corridorKey(left).localeCompare(corridorKey(right)),
    );
    uniquePaths.forEach((path, index) => {
      const entry = path.at(-1);
      packages.push(
        finalizePackage(graph, candidate, {
          structuralType: "terminal_connector",
          name: `${terminal.name || terminalId} connector ${index + 1}`,
          coreNodeIds: [terminalId],
          connectorNodeIds: path.slice(1, -1),
          optionalNodeIds: [],
          addNodeIds: path.slice(0, -1),
          removeNodeIds: [],
          entryLandmarkIds: [entry],
          exitLandmarkIds: [terminalId],
          terminalLandmarkIds: [terminalId],
          sourceNodeIds: path,
          variantKey: `terminal:${terminalId}:alternative:${index + 1}`,
          reasonCodes: [
            "TERMINAL_CONNECTOR",
            ...(uniquePaths.length > 1
              ? ["ALTERNATIVE_CONNECTOR"]
              : []),
          ],
          metadata: {
            connectorAlternativeIndex: index,
            connectorAlternativeCount: uniquePaths.length,
          },
        }),
      );
    });
  }
  return packages;
}

function extractSpecialPackages(graph, candidate) {
  const packages = [];
  for (const id of graph.landmarks.keystones) {
    const node = graph.nodes.get(id);
    packages.push(
      finalizePackage(graph, candidate, {
        structuralType: "keystone_package",
        name: node.name || `Keystone ${id}`,
        coreNodeIds: [id],
        addNodeIds: [id],
        sourceNodeIds: [id],
        terminalLandmarkIds: [id],
        uncertainty: "high",
        needsPoB: true,
        reasonCodes: ["KEYSTONE_MECHANIC"],
      }),
    );
  }
  for (const id of graph.landmarks.jewelSockets) {
    const node = graph.nodes.get(id);
    packages.push(
      finalizePackage(graph, candidate, {
        structuralType: "jewel_socket_package",
        name: node.name || `Jewel socket ${id}`,
        coreNodeIds: [id],
        addNodeIds: [id],
        sourceNodeIds: [id],
        terminalLandmarkIds: [id],
        uncertainty: "high",
        needsPoB: true,
        reasonCodes: ["JEWEL_EFFECT_UNKNOWN"],
      }),
    );
  }
  for (const [id, node] of graph.nodes) {
    if (!isChoice(node)) continue;
    packages.push(
      finalizePackage(graph, candidate, {
        structuralType: "build_specific_package",
        name: node.name || `Build-specific node ${id}`,
        coreNodeIds: [id],
        addNodeIds: [id],
        sourceNodeIds: [id],
        terminalLandmarkIds: [id],
        uncertainty: "high",
        needsPoB: true,
        requirements: node.multipleChoiceParent
          ? [
              {
                code: "MULTIPLE_CHOICE_PARENT",
                nodeIds: [node.multipleChoiceParent],
              },
            ]
          : [],
        reasonCodes: ["BUILD_SPECIFIC_STATE"],
      }),
    );
  }
  const byAscendancy = new Map();
  for (const [id, node] of graph.nodes) {
    if (!node.ascendancyId) continue;
    if (!byAscendancy.has(node.ascendancyId)) {
      byAscendancy.set(node.ascendancyId, []);
    }
    byAscendancy.get(node.ascendancyId).push(id);
  }
  for (const [ascendancyId, nodeIds] of [...byAscendancy].sort(([a], [b]) =>
    String(a).localeCompare(String(b)),
  )) {
    const startId = graph.ascendancyStarts.get(String(ascendancyId));
    packages.push(
      finalizePackage(graph, candidate, {
        structuralType: "ascendancy_package",
        name:
          graph.nodes.get(startId)?.ascendancyName ||
          `Ascendancy ${ascendancyId}`,
        coreNodeIds: nodeIds.filter(
          (id) =>
            graph.nodes.get(id)?.isNotable ||
            graph.nodes.get(id)?.isKeystone,
        ),
        connectorNodeIds: nodeIds.filter(
          (id) =>
            !graph.nodes.get(id)?.isNotable &&
            !graph.nodes.get(id)?.isKeystone &&
            id !== startId,
        ),
        addNodeIds: nodeIds.filter((id) => id !== startId),
        sourceNodeIds: nodeIds,
        entryLandmarkIds: [startId],
        terminalLandmarkIds: nodeIds.filter(
          (id) => graph.nodes.get(id)?.isNotable,
        ),
        uncertainty: "high",
        needsPoB: true,
        reasonCodes: ["ASCENDANCY_SEPARATE_SCOPE"],
      }),
    );
  }
  return packages;
}

function packageForTerminal(packages, terminalId) {
  const priority = [
    "notable_cluster",
    "keystone_package",
    "jewel_socket_package",
  ];
  return packages
    .filter(
      (pkg) =>
        pkg.coreNodeIds.includes(terminalId) &&
        priority.includes(pkg.structuralType),
    )
    .sort(
      (left, right) =>
        priority.indexOf(left.structuralType) -
          priority.indexOf(right.structuralType) ||
        left.id.localeCompare(right.id),
    )[0];
}

function decorateRelationships(packages) {
  const byChoiceParent = new Map();
  for (const pkg of packages) {
    const parent = pkg.requirements.find(
      (entry) => entry.code === "MULTIPLE_CHOICE_PARENT",
    )?.nodeIds[0];
    if (parent !== undefined) {
      if (!byChoiceParent.has(parent)) byChoiceParent.set(parent, []);
      byChoiceParent.get(parent).push(pkg.id);
    }
  }
  return packages.map((pkg) => {
    const source = new Set(pkg.sourceNodeIds);
    const overlaps = packages
      .filter(
        (other) =>
          other.id !== pkg.id &&
          other.sourceNodeIds.some((id) => source.has(id)),
      )
      .map((other) => other.id)
      .sort();
    const dependencies = [];
    if (pkg.structuralType === "terminal_connector") {
      const core = packageForTerminal(packages, pkg.terminalLandmarkIds[0]);
      if (core && core.id !== pkg.id) dependencies.push(core.id);
    }
    const conflicts = [];
    for (const ids of byChoiceParent.values()) {
      if (ids.includes(pkg.id)) {
        conflicts.push(...ids.filter((id) => id !== pkg.id));
      }
    }
    if (
      pkg.structuralType === "terminal_connector" &&
      pkg.metadata.connectorAlternativeCount > 1
    ) {
      conflicts.push(
        ...packages
          .filter(
            (other) =>
              other.structuralType === "terminal_connector" &&
              other.id !== pkg.id &&
              other.terminalLandmarkIds[0] === pkg.terminalLandmarkIds[0],
          )
          .map((other) => other.id),
      );
    }
    return {
      ...pkg,
      dependencies: [...new Set(dependencies)].sort(),
      conflicts: [...new Set(conflicts)].sort(),
      overlaps,
    };
  });
}

function reroutePackages(graph, candidate, rerouteResult) {
  return (rerouteResult?.results || []).map((entry, index) =>
    finalizePackage(graph, candidate, {
      structuralType: "bridge_reroute_patch",
      name: `Reroute ${entry.mode} ${index + 1}`,
      coreNodeIds: entry.preservedTerminals,
      connectorNodeIds: entry.addedNodeIds,
      optionalNodeIds: [],
      addNodeIds: entry.addedNodeIds,
      removeNodeIds: entry.removedNodeIds,
      entryLandmarkIds: entry.changedConnector?.articulationChanges?.added || [],
      exitLandmarkIds:
        entry.changedConnector?.articulationChanges?.removed || [],
      terminalLandmarkIds: entry.preservedTerminals,
      sourceNodeIds: sortedUniqueNumbers([
        ...entry.addedNodeIds,
        ...entry.removedNodeIds,
        ...entry.preservedTerminals,
      ]),
      variantKey: entry.canonicalKey,
      uncertainty: entry.uncertainty?.length ? "high" : "low",
      needsPoB: entry.uncertainty?.length > 0,
      reasonCodes: [
        "SLICE1_REROUTE_CONVERSION",
        ...(entry.uncertainty || []),
      ],
      metadata: {
        mode: entry.mode,
        pointsSaved: entry.pointsSaved,
        respecCount: entry.respecCount,
        candidateCanonicalKey: entry.canonicalKey,
      },
    }),
  );
}

function extractPackages(graph, candidate, options = {}) {
  let packages = [
    ...extractNotableClusters(graph, candidate),
    ...extractCorridors(graph, candidate),
    ...extractTerminalConnectors(graph, candidate),
    ...extractSpecialPackages(graph, candidate),
    ...reroutePackages(graph, candidate, options.reroute),
  ];
  packages = decorateRelationships(packages).sort((left, right) =>
    left.id.localeCompare(right.id),
  );
  const counts = Object.fromEntries(
    STRUCTURAL_TYPES.map((type) => [
      type,
      packages.filter((pkg) => pkg.structuralType === type).length,
    ]),
  );
  return {
    packageSchemaVersion: PACKAGE_SCHEMA_VERSION,
    extractorVersion: EXTRACTOR_VERSION,
    treeDataHash: graph.source.hash,
    treeVersion: graph.source.treeVersion,
    candidateCanonicalKey: candidate.canonicalKey,
    counts,
    unknownStatLines: [
      ...new Set(packages.flatMap((pkg) => pkg.stats.unknownLines)),
    ].sort(),
    uncertainPackageCount: packages.filter(
      (pkg) => pkg.uncertainty === "high",
    ).length,
    packages,
  };
}

function packageDelta(pkg) {
  return normalizeDelta({
    addNodeIds: pkg.addNodeIds,
    removeNodeIds: pkg.removeNodeIds,
  });
}

function convertCandidateToPackage(graph, candidate, nextCandidate, input = {}) {
  const delta = candidateDelta(candidate, nextCandidate);
  return finalizePackage(graph, candidate, {
    structuralType: input.structuralType || "build_specific_package",
    name: input.name || "Explicit candidate delta",
    coreNodeIds: input.coreNodeIds || delta.addNodeIds,
    connectorNodeIds: input.connectorNodeIds || [],
    optionalNodeIds: input.optionalNodeIds || [],
    addNodeIds: delta.addNodeIds,
    removeNodeIds: delta.removeNodeIds,
    sourceNodeIds: sortedUniqueNumbers([
      ...delta.addNodeIds,
      ...delta.removeNodeIds,
    ]),
    uncertainty: input.uncertainty || "high",
    needsPoB: input.needsPoB !== false,
    reasonCodes: ["EXPLICIT_CANDIDATE_DELTA"],
  });
}

module.exports = {
  EXTRACTOR_VERSION,
  PACKAGE_SCHEMA_VERSION,
  STRUCTURAL_TYPES,
  convertCandidateToPackage,
  extractPackages,
  isLandmark,
  packageDelta,
  reroutePackages,
};
