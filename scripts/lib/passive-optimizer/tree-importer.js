"use strict";

const fs = require("fs");
const path = require("path");
const { sha256, sortedUniqueNumbers } = require("./stable");
const { resolveTreeSnapshot } = require("../portable-config");

const SUPPORTED_IMPORTER_SCHEMA = 1;
const DEFAULT_SNAPSHOT = null;

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function normalizeClassStarts(rawNode) {
  if (Array.isArray(rawNode.classesStart)) {
    return rawNode.classesStart
      .map((entry) =>
        typeof entry === "object"
          ? Number(entry.classId ?? entry.id ?? entry)
          : Number(entry),
      )
      .filter(Number.isFinite);
  }
  if (Array.isArray(rawNode.classStartIndex)) {
    return rawNode.classStartIndex.map(Number).filter(Number.isFinite);
  }
  return [];
}

function adjacencyFromNodes(rawNodes) {
  const adjacency = new Map();
  const ensure = (id) => {
    if (!adjacency.has(id)) adjacency.set(id, new Set());
    return adjacency.get(id);
  };
  for (const [rawId, node] of Object.entries(rawNodes)) {
    const id = Number(rawId);
    ensure(id);
    for (const nextValue of [
      ...(node.out || []),
      ...(node.in || []),
      ...(node.connections || []).map((entry) => entry.id ?? entry),
    ]) {
      const next = Number(nextValue);
      if (!Number.isFinite(next) || !rawNodes[String(next)]) continue;
      ensure(id).add(next);
      ensure(next).add(id);
    }
  }
  return adjacency;
}

function computeBiconnectedMetadata(nodes, adjacency) {
  const discovery = new Map();
  const low = new Map();
  const parent = new Map();
  const articulationPoints = new Set();
  const edgeStack = [];
  const components = [];
  let time = 0;

  const visit = (id) => {
    discovery.set(id, ++time);
    low.set(id, discovery.get(id));
    let children = 0;
    for (const next of adjacency.get(id) || []) {
      if (!nodes.has(next) || nodes.get(next).isOnlyImage) continue;
      if (!discovery.has(next)) {
        children += 1;
        parent.set(next, id);
        edgeStack.push([id, next]);
        visit(next);
        low.set(id, Math.min(low.get(id), low.get(next)));
        const isRootCut = !parent.has(id) && children > 1;
        const isInnerCut =
          parent.has(id) && low.get(next) >= discovery.get(id);
        if (isRootCut || isInnerCut) articulationPoints.add(id);
        if (low.get(next) >= discovery.get(id)) {
          const component = new Set();
          let edge;
          do {
            edge = edgeStack.pop();
            if (!edge) break;
            component.add(edge[0]);
            component.add(edge[1]);
          } while (!(edge[0] === id && edge[1] === next));
          if (component.size) components.push([...component].sort((a, b) => a - b));
        }
      } else if (
        parent.get(id) !== next &&
        discovery.get(next) < discovery.get(id)
      ) {
        low.set(id, Math.min(low.get(id), discovery.get(next)));
        edgeStack.push([id, next]);
      }
    }
  };

  for (const [id, node] of nodes) {
    if (node.isOnlyImage || discovery.has(id)) continue;
    visit(id);
    if (edgeStack.length) {
      const component = new Set(edgeStack.flat());
      edgeStack.length = 0;
      components.push([...component].sort((a, b) => a - b));
    }
  }

  const componentIdsByNode = new Map();
  components.forEach((component, componentId) => {
    for (const id of component) {
      if (!componentIdsByNode.has(id)) componentIdsByNode.set(id, []);
      componentIdsByNode.get(id).push(componentId);
    }
  });
  return { articulationPoints, components, componentIdsByNode };
}

function normalizeTree(raw, manifest) {
  if (!raw || typeof raw !== "object" || !raw.nodes || !raw.classes) {
    throw new Error("UNSUPPORTED_TREE_SCHEMA: expected nodes and classes");
  }
  const classNames = new Map(
    raw.classes.map((entry, index) => [index, entry.name]),
  );
  const ascendancyNames = new Map();
  raw.classes.forEach((entry) => {
    for (const ascendancy of entry.ascendancies || []) {
      ascendancyNames.set(
        String(ascendancy.id ?? ascendancy.internalId),
        ascendancy.name,
      );
    }
  });
  const rawAdjacency = adjacencyFromNodes(raw.nodes);
  const nodes = new Map();
  for (const [rawId, entry] of Object.entries(raw.nodes)) {
    const id = Number(rawId);
    const classStarts = normalizeClassStarts(entry);
    const ascendancyId = entry.ascendancyId || entry.ascendancyName || null;
    const options = (entry.options || []).map((option) => ({
      id: option.id ?? null,
      name: option.name ?? "",
      stats: option.stats || [],
    }));
    nodes.set(id, {
      id,
      rawName: entry.name || "",
      rawStats: entry.stats || [],
      name: entry.name || "",
      stats: entry.stats || [],
      adjacency: sortedUniqueNumbers(rawAdjacency.get(id)),
      classStarts,
      classStartNames: classStarts.map((classId) => classNames.get(classId)),
      ascendancyId,
      ascendancyName:
        ascendancyNames.get(String(ascendancyId)) ||
        entry.ascendancyName ||
        null,
      isAscendancyStart: Boolean(entry.isAscendancyStart),
      isNotable: Boolean(entry.isNotable),
      isKeystone: Boolean(entry.isKeystone),
      isJewelSocket: Boolean(entry.isJewelSocket),
      isAttribute: Boolean(entry.isAttribute || entry.isGenericAttribute),
      isOnlyImage: Boolean(entry.isOnlyImage),
      isSwitchable: Boolean(
        entry.isSwitchable || entry.isGenericAttribute || options.length,
      ),
      isMultipleChoice: Boolean(entry.isMultipleChoice),
      isMultipleChoiceOption: Boolean(entry.isMultipleChoiceOption),
      multipleChoiceParent:
        entry.multipleChoiceParent === undefined
          ? null
          : Number(entry.multipleChoiceParent),
      isMastery: Boolean(entry.isMastery),
      unlockConstraint: entry.unlockConstraint || null,
      options,
      group: entry.group ?? null,
      orbit: entry.orbit ?? null,
      orbitIndex: entry.orbitIndex ?? null,
      x: entry.x ?? raw.groups?.[entry.group]?.x ?? null,
      y: entry.y ?? raw.groups?.[entry.group]?.y ?? null,
      raw: entry,
    });
  }
  const { articulationPoints, components, componentIdsByNode } =
    computeBiconnectedMetadata(nodes, rawAdjacency);
  const classStarts = new Map();
  const ascendancyStarts = new Map();
  for (const [id, node] of nodes) {
    for (const classId of node.classStarts) classStarts.set(classId, id);
    if (node.isAscendancyStart && node.ascendancyId) {
      ascendancyStarts.set(String(node.ascendancyId), id);
    }
  }
  const landmarks = {
    classStarts: sortedUniqueNumbers(classStarts.values()),
    ascendancyStarts: sortedUniqueNumbers(ascendancyStarts.values()),
    notables: sortedUniqueNumbers(
      [...nodes].filter(([, node]) => node.isNotable).map(([id]) => id),
    ),
    keystones: sortedUniqueNumbers(
      [...nodes].filter(([, node]) => node.isKeystone).map(([id]) => id),
    ),
    jewelSockets: sortedUniqueNumbers(
      [...nodes].filter(([, node]) => node.isJewelSocket).map(([id]) => id),
    ),
    articulationPoints: sortedUniqueNumbers(articulationPoints),
  };
  return {
    source: {
      repository: manifest.sourceRepository,
      release: manifest.sourceRelease,
      commit: manifest.sourceCommit,
      hash: manifest.sha256,
      exportVersion: manifest.exportVersion,
      treeVersion: manifest.treeVersion,
      importerSchemaVersion: manifest.importerSchemaVersion,
    },
    classes: raw.classes.map((entry, classId) => ({
      classId,
      name: entry.name,
      ascendancies: (entry.ascendancies || []).map((ascendancy, index) => ({
        ascendClassId: index + 1,
        id: String(ascendancy.id ?? ascendancy.internalId),
        name: ascendancy.name,
      })),
    })),
    nodes,
    classStarts,
    ascendancyStarts,
    landmarks,
    articulationPoints,
    biconnectedComponents: components,
    biconnectedComponentIds: componentIdsByNode,
  };
}

function loadTreeGraph(snapshotDir = DEFAULT_SNAPSHOT, options = {}) {
  snapshotDir = resolveTreeSnapshot(snapshotDir, options);
  const manifestPath = path.join(snapshotDir, "manifest.json");
  const dataPath = path.join(snapshotDir, "data.json");
  if (!fs.existsSync(manifestPath) || !fs.existsSync(dataPath)) {
    throw new Error(
      `Invalid PoE2 tree snapshot ${snapshotDir}: expected manifest.json and data.json`,
    );
  }
  const manifest = readJson(manifestPath);
  if (manifest.importerSchemaVersion !== SUPPORTED_IMPORTER_SCHEMA) {
    throw new Error(
      `UNSUPPORTED_IMPORTER_SCHEMA: ${manifest.importerSchemaVersion}`,
    );
  }
  const bytes = fs.readFileSync(dataPath);
  const actualHash = sha256(bytes);
  if (actualHash !== String(manifest.sha256).toLowerCase()) {
    throw new Error(
      `TREE_HASH_MISMATCH: expected ${manifest.sha256}, received ${actualHash}`,
    );
  }
  return normalizeTree(JSON.parse(bytes.toString("utf8")), manifest);
}

module.exports = {
  DEFAULT_SNAPSHOT,
  SUPPORTED_IMPORTER_SCHEMA,
  loadTreeGraph,
  normalizeTree,
  resolveTreeSnapshot,
};
