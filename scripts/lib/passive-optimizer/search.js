"use strict";

const { applyDelta, candidateDelta, deltaCost, normalizeDelta } = require("./delta");
const {
  normalizeBuildProfile,
  rankPackages,
  SCORER_VERSION,
  scoreDelta,
} = require("./scorer");
const { sha256, sortedUniqueNumbers, stableStringify } = require("./stable");
const { validateCandidate } = require("./validator");
const { explainAddedNodes } = require("./mechanic-relevance");

const SEARCH_VERSION = 2;
const DEFAULT_EPSILON = {
  offense: 0.15,
  defense: 0.15,
  accuracy: 0.15,
  recovery: 0.15,
  mobilityResources: 0.15,
  travelEfficiency: 0.25,
  respecCost: 1,
  uncertainty: 0.25,
};

function applySearchDelta(candidate, delta) {
  return withPreservedState(applyDelta(candidate, delta), candidate);
}

function withPreservedState(candidate, source) {
  const { withCandidateKey } = require("./model");
  return withCandidateKey({
    ...candidate,
    attributeOverrides: source.attributeOverrides,
    switchableOverrides: source.switchableOverrides,
    multipleChoiceSelections: source.multipleChoiceSelections,
    masterySelections: source.masterySelections,
    jewelState: source.jewelState,
    weaponSetAllocations: source.weaponSetAllocations,
  });
}

function clampInteger(value, fallback, minimum, maximum) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.floor(number)));
}

function deterministicRank(seed, value) {
  return sha256(`${Number(seed) || 0}:${String(value)}`);
}

function calibrationTier(changedNodeCount) {
  const changed = Math.max(0, Number(changedNodeCount) || 0);
  if (changed === 0) return "baseline";
  if (changed <= 2) return "adjacent";
  return "ordinary";
}

function roleFamily(pkg) {
  const tags = pkg.normalizedTags || pkg.stats?.normalizedTags || [];
  const preferred = [
    "accuracy",
    "damage.crossbow",
    "damage.attack",
    "defense.",
    "recovery.",
    "mobility",
    "resources.",
    "role.totem",
    "role.projectile",
  ];
  for (const prefix of preferred) {
    const match = tags.find(
      (tag) => tag === prefix || tag.startsWith(prefix),
    );
    if (match) return prefix.replace(/\.$/, "");
  }
  return `${pkg.structuralType}:${pkg.context?.groups?.[0] ?? "global"}`;
}

function protectedNodeIds(candidate, graph) {
  const result = new Set([
    candidate.classStart,
    ...candidate.freeStartNodeIds,
    ...candidate.requiredNodeIds,
    ...Object.keys(candidate.attributeOverrides || {}).map(Number),
    ...Object.keys(candidate.switchableOverrides || {}).map(Number),
    ...Object.keys(candidate.multipleChoiceSelections || {}).map(Number),
    ...Object.values(candidate.multipleChoiceSelections || {}).flat().map(Number),
    ...Object.keys(candidate.masterySelections || {}).map(Number),
    ...Object.keys(candidate.jewelState || {})
      .filter((id) => candidate.jewelState[id]?.active)
      .map(Number),
    ...Object.values(candidate.weaponSetAllocations || {}).flat().map(Number),
  ]);
  for (const id of candidate.allocatedNodeIds) {
    if (graph.nodes.get(id)?.ascendancyId) result.add(id);
  }
  return result;
}

function packageIsActive(pkg, allocated) {
  const nodes = pkg.addNodeIds || [];
  return nodes.length > 0 && nodes.every((id) => allocated.has(id));
}

function selectRelevantPackages({
  graph,
  buildState,
  candidate,
  packages,
  profile,
  baselineMetrics,
  scorerConfig,
  limit = 160,
  seed = 0,
}) {
  const ranked = rankPackages({
    graph,
    buildState,
    candidate,
    packages,
    profile,
    baselineMetrics,
    config: scorerConfig,
  });
  const byId = new Map(packages.map((pkg) => [pkg.id, pkg]));
  const allocated = new Set(candidate.allocatedNodeIds);
  const mandatoryIds = new Set();
  for (const pkg of packages) {
    if (
      packageIsActive(pkg, allocated) ||
      pkg.structuralType === "bridge_reroute_patch"
    ) {
      mandatoryIds.add(pkg.id);
    }
  }
  for (const entry of ranked.slice(0, Math.max(1, Number(limit)))) {
    mandatoryIds.add(entry.packageId);
  }
  const scoreById = new Map(ranked.map((entry) => [entry.packageId, entry]));
  return [...mandatoryIds]
    .map((id) => byId.get(id))
    .filter(Boolean)
    .sort((left, right) => {
      const leftScore = scoreById.get(left.id)?.rankScore ?? -Infinity;
      const rightScore = scoreById.get(right.id)?.rankScore ?? -Infinity;
      return (
        rightScore - leftScore ||
        deterministicRank(seed, left.id).localeCompare(
          deterministicRank(seed, right.id),
        ) ||
        left.id.localeCompare(right.id)
      );
    });
}

function mergeDelta(left, right) {
  const add = new Set([...(left?.addNodeIds || []), ...(right?.addNodeIds || [])]);
  const remove = new Set([
    ...(left?.removeNodeIds || []),
    ...(right?.removeNodeIds || []),
  ]);
  for (const id of [...add]) {
    if (remove.has(id)) {
      add.delete(id);
      remove.delete(id);
    }
  }
  return normalizeDelta({ addNodeIds: [...add], removeNodeIds: [...remove] });
}

function dependencyClosure(pkg, packageById, seen = new Set()) {
  if (!pkg || seen.has(pkg.id)) return [];
  seen.add(pkg.id);
  const dependencies = (pkg.dependencies || [])
    .flatMap((id) => dependencyClosure(packageById.get(id), packageById, seen));
  return [...dependencies, pkg];
}

function deltaForPackages(addPackages, removePackages, packageById, protectedIds) {
  let delta = normalizeDelta();
  const effects = [];
  const addedPackageIds = new Set();
  const removedPackageIds = new Set();
  for (const pkg of addPackages) {
    for (const entry of dependencyClosure(pkg, packageById)) {
      if (addedPackageIds.has(entry.id)) continue;
      addedPackageIds.add(entry.id);
      delta = mergeDelta(delta, {
        addNodeIds: entry.addNodeIds,
        removeNodeIds: entry.removeNodeIds,
      });
      effects.push({ packageId: entry.id, direction: 1 });
    }
  }
  for (const pkg of removePackages) {
    if (!pkg || removedPackageIds.has(pkg.id)) continue;
    removedPackageIds.add(pkg.id);
    const removable = (pkg.addNodeIds || []).filter(
      (id) => !protectedIds.has(id),
    );
    delta = mergeDelta(delta, { removeNodeIds: removable });
    effects.push({ packageId: pkg.id, direction: -1 });
  }
  return {
    delta,
    effects,
    packageIds: [...new Set([...addedPackageIds, ...removedPackageIds])].sort(),
  };
}

function makeMoves(graph, candidate, packages, options = {}) {
  const allocated = new Set(candidate.allocatedNodeIds);
  const protectedIds = protectedNodeIds(candidate, graph);
  const packageById = new Map(packages.map((pkg) => [pkg.id, pkg]));
  const active = packages.filter((pkg) => packageIsActive(pkg, allocated));
  const inactive = packages.filter((pkg) => !packageIsActive(pkg, allocated));
  const moves = [];

  function addMove(type, addPackages, removePackages) {
    const built = deltaForPackages(
      addPackages,
      removePackages,
      packageById,
      protectedIds,
    );
    if (
      built.delta.addNodeIds.length === 0 &&
      built.delta.removeNodeIds.length === 0
    ) {
      return;
    }
    moves.push({
      type,
      id: `${type}:${built.packageIds.join("+")}`,
      ...built,
      family: [...new Set([...addPackages, ...removePackages].map((pkg) =>
        `${roleFamily(pkg)}@${pkg.structuralType}:${
          pkg.context?.groups?.join(".") || "global"
        }`,
      ))]
        .sort()
        .join("+"),
    });
  }

  for (const pkg of inactive) {
    if (pkg.structuralType === "bridge_reroute_patch") {
      addMove("reroute", [pkg], []);
    } else {
      const conflicts = (pkg.conflicts || [])
        .map((id) => packageById.get(id))
        .filter((entry) => entry && packageIsActive(entry, allocated));
      addMove("add", [pkg], conflicts);
    }
  }
  for (const pkg of active) addMove("remove", [], [pkg]);

  const activeByRole = new Map();
  for (const pkg of active) {
    const family = roleFamily(pkg);
    if (!activeByRole.has(family)) activeByRole.set(family, []);
    activeByRole.get(family).push(pkg);
  }
  for (const pkg of inactive) {
    const replacements = activeByRole.get(roleFamily(pkg)) || [];
    for (const previous of replacements.slice(0, 2)) {
      addMove("swap", [pkg], [previous]);
    }
  }

  return moves
    .filter((move) => {
      const cost = deltaCost(candidate, move.delta).marginal.changed;
      const removals = move.delta.removeNodeIds.length;
      return (
        cost <= Number(options.maxChanges ?? 8) &&
        removals <= Number(options.maxRemovals ?? Infinity)
      );
    })
    .sort(
      (left, right) =>
        deterministicRank(options.seed, left.id).localeCompare(
          deterministicRank(options.seed, right.id),
        ) || left.id.localeCompare(right.id),
    );
}

function ordinaryReachable(graph, candidate) {
  const allocated = new Set(candidate.allocatedNodeIds);
  const seen = new Set();
  const queue = [];
  if (allocated.has(candidate.classStart)) {
    seen.add(candidate.classStart);
    queue.push(candidate.classStart);
  }
  for (let index = 0; index < queue.length; index += 1) {
    const id = queue[index];
    for (const next of graph.nodes.get(id)?.adjacency || []) {
      const node = graph.nodes.get(next);
      if (
        seen.has(next) ||
        !allocated.has(next) ||
        !node ||
        node.isOnlyImage ||
        node.ascendancyId
      ) {
        continue;
      }
      seen.add(next);
      queue.push(next);
    }
  }
  return seen;
}

function shortestRepairPath(graph, sources, targets, forbidden, blockedAscendancy) {
  const queue = [...sources].sort((a, b) => a - b);
  const previous = new Map(queue.map((id) => [id, null]));
  let found = null;
  for (let index = 0; index < queue.length && found === null; index += 1) {
    const id = queue[index];
    if (targets.has(id)) {
      found = id;
      break;
    }
    const adjacency = [...(graph.nodes.get(id)?.adjacency || [])].sort(
      (a, b) => a - b,
    );
    for (const next of adjacency) {
      const node = graph.nodes.get(next);
      if (
        previous.has(next) ||
        forbidden.has(next) ||
        !node ||
        node.isOnlyImage ||
        (blockedAscendancy && node.ascendancyId)
      ) {
        continue;
      }
      previous.set(next, id);
      queue.push(next);
    }
  }
  if (found === null) return null;
  const path = [];
  for (let current = found; current !== null; current = previous.get(current)) {
    path.push(current);
  }
  return path.reverse();
}

function repairConnectivity(graph, incumbent, candidate, options = {}) {
  let repaired = candidate;
  const additions = new Set();
  const forbidden = new Set(candidate.forbiddenNodeIds);
  const maxChanges = Number(options.maxChanges ?? 8);
  for (let pass = 0; pass < 4; pass += 1) {
    const reachable = ordinaryReachable(graph, repaired);
    const disconnected = repaired.allocatedNodeIds.filter((id) => {
      const node = graph.nodes.get(id);
      return node && !node.ascendancyId && !reachable.has(id);
    });
    if (disconnected.length === 0) {
      return {
        candidate: repaired,
        repaired: additions.size > 0,
        addedNodeIds: sortedUniqueNumbers(additions),
      };
    }
    const path = shortestRepairPath(
      graph,
      reachable,
      new Set(disconnected),
      forbidden,
      true,
    );
    if (!path) return null;
    const toAdd = path.filter((id) => !repaired.allocatedNodeIds.includes(id));
    for (const id of toAdd) additions.add(id);
    repaired = applySearchDelta(repaired, { addNodeIds: toAdd });
    if (candidateDelta(incumbent, repaired).addNodeIds.length +
        candidateDelta(incumbent, repaired).removeNodeIds.length > maxChanges) {
      return null;
    }
  }
  return null;
}

function changedNodes(incumbent, candidate) {
  const delta = candidateDelta(incumbent, candidate);
  return sortedUniqueNumbers([...delta.addNodeIds, ...delta.removeNodeIds]);
}

function jaccardDistance(left, right) {
  const leftSet = new Set(left || []);
  const rightSet = new Set(right || []);
  const union = new Set([...leftSet, ...rightSet]);
  if (union.size === 0) return 0;
  let intersection = 0;
  for (const id of leftSet) if (rightSet.has(id)) intersection += 1;
  return 1 - intersection / union.size;
}

function scoreSearchCandidate({
  graph,
  buildState,
  incumbent,
  candidate,
  effects,
  packageById,
  profile,
  baselineMetrics,
  scorerConfig,
  validation,
  allowStructuralEffectInvalid = false,
}) {
  const components = {
    offense: 0,
    defense: 0,
    accuracy: 0,
    recovery: 0,
    mobility: 0,
    resource: 0,
    travel: 0,
    synergy: 0,
    uncertainty: 0,
    exploration: 0,
  };
  const reasonCodes = new Set();
  const requiredPoBChecks = new Set(validation.needsPob.map((entry) => entry.code));
  let confidence = 1;
  let status = validation.needsPob.length ? "needsPoB" : "valid";
  for (const effect of effects) {
    const pkg = packageById.get(effect.packageId);
    if (!pkg) continue;
    const scored = scoreDelta({
      graph,
      buildState,
      candidate: incumbent,
      package: pkg,
      profile,
      baselineMetrics,
      config: scorerConfig,
    });
    for (const name of Object.keys(components)) {
      if (name === "travel" || name === "uncertainty") continue;
      components[name] += Number(scored.components[name] || 0) * effect.direction;
    }
    components.uncertainty += Math.abs(Number(scored.components.uncertainty || 0));
    confidence = Math.min(confidence, scored.confidence);
    for (const code of scored.reasonCodes) reasonCodes.add(code);
    for (const check of scored.requiredPoBChecks) requiredPoBChecks.add(check);
    if (
      scored.status === "invalid" &&
      effect.direction > 0 &&
      !allowStructuralEffectInvalid
    ) {
      status = "invalid";
    }
    else if (scored.status === "needsPoB" && status !== "invalid") {
      status = "needsPoB";
    }
    else if (scored.status === "risky" && status === "valid") status = "risky";
  }
  const delta = candidateDelta(incumbent, candidate);
  const costs = deltaCost(incumbent, delta);
  const normalizedProfile = normalizeBuildProfile(profile);
  const nodeExplanations = explainAddedNodes(
    graph,
    incumbent,
    candidate,
    normalizedProfile,
  );
  const unexplained = nodeExplanations.filter((entry) => !entry.accepted);
  if (
    Object.keys(normalizedProfile.mechanicPreferences || {}).length > 0 &&
    unexplained.length
  ) {
    status = "invalid";
    for (const entry of unexplained) reasonCodes.add(entry.reason);
  }
  if (
    normalizedProfile.hardConstraints.maxMarginalPoints !== null &&
    costs.marginal.add >
      normalizedProfile.hardConstraints.maxMarginalPoints
  ) {
    status = "invalid";
    reasonCodes.add("MAX_MARGINAL_POINTS_EXCEEDED");
  }
  if (
    normalizedProfile.hardConstraints.maxRespec !== null &&
    costs.respec > normalizedProfile.hardConstraints.maxRespec
  ) {
    status = "invalid";
    reasonCodes.add("MAX_RESPEC_EXCEEDED");
  }
  components.travel = -(costs.marginal.add + costs.marginal.remove * 0.5);
  const objectives = {
    offense: components.offense,
    defense: components.defense,
    accuracy: components.accuracy,
    recovery: components.recovery,
    mobilityResources: components.mobility + components.resource,
    travelEfficiency: components.travel,
    respecCost: costs.respec,
    uncertainty: Math.abs(components.uncertainty),
  };
  const rankScore =
    components.offense +
    components.defense +
    components.accuracy +
    components.recovery +
    components.mobility +
    components.resource +
    components.synergy +
    components.travel +
    components.exploration -
    objectives.uncertainty;
  return {
    scorerVersion: SCORER_VERSION,
    buildProfileSchemaVersion: normalizedProfile.buildProfileSchemaVersion,
    profileVersion: normalizedProfile.profileVersion,
    profileId: normalizedProfile.id,
    status,
    rankScore,
    components,
    objectives,
    confidence,
    reasonCodes: [...reasonCodes].sort(),
    requiredPoBChecks: [...requiredPoBChecks].sort(),
    costs,
    delta,
    nodeExplanations,
  };
}

function objectiveVector(entry) {
  return {
    offense: entry.objectives.offense,
    defense: entry.objectives.defense,
    accuracy: entry.objectives.accuracy,
    recovery: entry.objectives.recovery,
    mobilityResources: entry.objectives.mobilityResources,
    travelEfficiency: entry.objectives.travelEfficiency,
    respecCost: -entry.objectives.respecCost,
    uncertainty: -entry.objectives.uncertainty,
  };
}

function epsilonDominates(left, right, epsilon = DEFAULT_EPSILON) {
  const a = objectiveVector(left);
  const b = objectiveVector(right);
  let meaningfullyBetter = false;
  for (const name of Object.keys(a)) {
    const tolerance = Number(epsilon[name] ?? 0);
    if (a[name] < b[name] - tolerance) return false;
    if (a[name] > b[name] + tolerance) meaningfullyBetter = true;
  }
  return meaningfullyBetter;
}

function epsilonParetoArchive(entries, epsilon = DEFAULT_EPSILON) {
  const archive = [];
  for (const entry of [...entries].sort((a, b) =>
    a.canonicalKey.localeCompare(b.canonicalKey),
  )) {
    if (archive.some((other) => epsilonDominates(other, entry, epsilon))) {
      continue;
    }
    for (let index = archive.length - 1; index >= 0; index -= 1) {
      if (epsilonDominates(entry, archive[index], epsilon)) {
        archive.splice(index, 1);
      }
    }
    archive.push(entry);
  }
  return archive.sort(
    (left, right) =>
      right.rankScore - left.rankScore ||
      left.canonicalKey.localeCompare(right.canonicalKey),
  );
}

function diversityBucket(entry) {
  const distance = entry.changedNodeIds.length;
  const distanceBand = distance <= 2 ? "near" : distance <= 5 ? "medium" : "far";
  const families = entry.families.length ? entry.families.join("+") : "incumbent";
  const roles = Object.entries(entry.objectives)
    .filter(([name, value]) =>
      !["respecCost", "uncertainty"].includes(name) && value > 0.1,
    )
    .map(([name]) => name)
    .sort()
    .join("+") || "travel";
  return `${families}|${roles}|${distanceBand}`;
}

function applyDiversityCaps(entries, options = {}) {
  const limit = clampInteger(options.limit, 10, 1, 100);
  const bucketCap = clampInteger(options.bucketCap, 2, 1, 20);
  const minimumDistance = Number(options.minimumJaccardDistance ?? 0.2);
  const counts = new Map();
  const selected = [];
  const deferred = [];
  for (const entry of entries) {
    const bucket = diversityBucket(entry);
    const tooClose = selected.some(
      (other) =>
        jaccardDistance(entry.changedNodeIds, other.changedNodeIds) <
        minimumDistance,
    );
    if ((counts.get(bucket) || 0) >= bucketCap || tooClose) {
      deferred.push(entry);
      continue;
    }
    selected.push({ ...entry, diversityBucket: bucket });
    counts.set(bucket, (counts.get(bucket) || 0) + 1);
    if (selected.length >= limit) return selected;
  }
  for (const entry of deferred) {
    if (selected.length >= limit) break;
    selected.push({ ...entry, diversityBucket: diversityBucket(entry) });
  }
  return selected;
}

function representativeLabels(entries) {
  const definitions = [
    ["offense", (entry) => entry.objectives.offense],
    ["defense", (entry) => entry.objectives.defense + entry.objectives.recovery],
    ["balanced", (entry) =>
      entry.objectives.offense +
      entry.objectives.defense +
      entry.objectives.accuracy +
      entry.objectives.recovery +
      entry.objectives.mobilityResources -
      entry.objectives.respecCost * 0.25],
    ["accuracy_repair", (entry) => entry.objectives.accuracy],
    ["lowest_respec", (entry) => -entry.objectives.respecCost],
    ["experimental_needs_pob", (entry) =>
      (entry.status === "needsPoB" ? 100 : 0) +
      entry.objectives.uncertainty +
      entry.components.exploration],
  ];
  const labels = new Map();
  for (const [label, value] of definitions) {
    const eligible =
      label === "experimental_needs_pob"
        ? entries.filter((entry) => entry.status === "needsPoB")
        : entries;
    const winner = [...eligible].sort(
      (left, right) =>
        value(right) - value(left) ||
        right.rankScore - left.rankScore ||
        left.canonicalKey.localeCompare(right.canonicalKey),
    )[0];
    if (winner) {
      if (!labels.has(winner.canonicalKey)) labels.set(winner.canonicalKey, []);
      labels.get(winner.canonicalKey).push(label);
    }
  }
  return labels;
}

function runPackageSearch(input) {
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
    maxChanges: clampInteger(input.maxChanges, 8, 0, 8),
    beamWidth: clampInteger(input.beamWidth, 24, 1, 500),
    beamDepth: clampInteger(input.beamDepth, 3, 1, 3),
    resultLimit: clampInteger(input.resultLimit, 10, 1, 100),
    relevantLimit: clampInteger(input.relevantLimit, 160, 10, 1000),
    seed: Number(input.seed) || 0,
    epsilon: { ...DEFAULT_EPSILON, ...(input.epsilon || {}) },
    diversityBucketCap: clampInteger(input.diversityBucketCap, 2, 1, 20),
    maxRemovals: clampInteger(
      input.maxRemovals,
      clampInteger(input.maxChanges, 8, 0, 100),
      0,
      100,
    ),
    minAdded: clampInteger(input.minAdded, 0, 0, 100),
    maxAdded: clampInteger(
      input.maxAdded,
      clampInteger(input.maxChanges, 8, 0, 100),
      0,
      100,
    ),
  };
  const baselineSnapshot = stableStringify(incumbent);
  const relevant = selectRelevantPackages({
    graph,
    buildState,
    candidate: incumbent,
    packages,
    profile,
    baselineMetrics,
    scorerConfig,
    limit: options.relevantLimit,
    seed: options.seed,
  });
  const packageById = new Map(packages.map((pkg) => [pkg.id, pkg]));
  const moves = makeMoves(graph, incumbent, relevant, options);
  const counts = {
    relevantPackages: relevant.length,
    moves: Object.fromEntries(
      ["add", "remove", "swap", "reroute"].map((type) => [
        type,
        moves.filter((move) => move.type === type).length,
      ]),
    ),
    generated: 1,
    repaired: 0,
    invalid: 0,
    overBudget: 0,
    duplicate: 0,
    usable: 1,
    expanded: 0,
  };
  const seen = new Set([incumbent.canonicalKey]);
  const usable = [];

  function makeEntry(candidate, effects, families, moveHistory, depth) {
    const validation = validateCandidate(graph, candidate, {
      baselineAllocatedNodeIds: incumbent.allocatedNodeIds,
    });
    if (!validation.valid) {
      counts.invalid += 1;
      return null;
    }
    const score = scoreSearchCandidate({
      graph,
      buildState,
      incumbent,
      candidate,
      effects,
      packageById,
      profile,
      baselineMetrics,
      scorerConfig,
      validation,
    });
    if (score.status === "invalid") {
      counts.invalid += 1;
      return null;
    }
    const nodes = changedNodes(incumbent, candidate);
    return {
      canonicalKey: candidate.canonicalKey,
      candidate,
      validation,
      ...score,
      changedNodeIds: nodes,
      changedNodeCount: nodes.length,
      families: [...new Set(families)].filter(Boolean).sort(),
      moveHistory,
      depth,
      needsPoB: score.status === "needsPoB",
    };
  }

  const incumbentEntry = makeEntry(incumbent, [], [], [], 0);
  usable.push(incumbentEntry);
  let beam = [{
    candidate: incumbent,
    delta: normalizeDelta(),
    effects: [],
    families: [],
    moveHistory: [],
    entry: incumbentEntry,
  }];

  for (let depth = 1; depth <= options.beamDepth; depth += 1) {
    const next = [];
    for (const state of beam) {
      for (const move of moves) {
        if (state.moveHistory.some((entry) => entry.id === move.id)) continue;
        counts.expanded += 1;
        const delta = mergeDelta(state.delta, move.delta);
        const raw = applySearchDelta(incumbent, delta);
        const rawDelta = candidateDelta(incumbent, raw);
        const rawChanges =
          rawDelta.addNodeIds.length + rawDelta.removeNodeIds.length;
        if (
          rawChanges > options.maxChanges ||
          rawDelta.removeNodeIds.length > options.maxRemovals ||
          rawDelta.addNodeIds.length > options.maxAdded
        ) {
          counts.overBudget += 1;
          continue;
        }
        const repair = repairConnectivity(graph, incumbent, raw, options);
        if (!repair) {
          counts.invalid += 1;
          continue;
        }
        if (repair.repaired) counts.repaired += 1;
        const repairedDelta = candidateDelta(incumbent, repair.candidate);
        const changed =
          repairedDelta.addNodeIds.length + repairedDelta.removeNodeIds.length;
        if (changed > options.maxChanges) {
          counts.overBudget += 1;
          continue;
        }
        counts.generated += 1;
        if (seen.has(repair.candidate.canonicalKey)) {
          counts.duplicate += 1;
          continue;
        }
        seen.add(repair.candidate.canonicalKey);
        const effects = [...state.effects, ...move.effects];
        const families = [...state.families, move.family];
        const moveHistory = [...state.moveHistory, {
          id: move.id,
          type: move.type,
          packageIds: move.packageIds,
        }];
        const entry = makeEntry(
          repair.candidate,
          effects,
          families,
          moveHistory,
          depth,
        );
        if (!entry) continue;
        if (
          entry.changedNodeCount === 0 &&
          entry.canonicalKey !== incumbent.canonicalKey
        ) {
          counts.invalid += 1;
          continue;
        }
        counts.usable += 1;
        usable.push(entry);
        next.push({
          candidate: repair.candidate,
          delta: repairedDelta,
          effects,
          families,
          moveHistory,
          entry,
        });
      }
    }
    next.sort(
      (left, right) =>
        right.entry.rankScore - left.entry.rankScore ||
        deterministicRank(options.seed, left.entry.canonicalKey).localeCompare(
          deterministicRank(options.seed, right.entry.canonicalKey),
        ) ||
        left.entry.canonicalKey.localeCompare(right.entry.canonicalKey),
    );
    beam = next.slice(0, options.beamWidth);
    if (beam.length === 0) break;
  }

  const eligible = usable.filter((entry) =>
    entry.changedNodeCount === 0 ||
    (
      entry.delta.addNodeIds.length >= options.minAdded &&
      entry.delta.addNodeIds.length <= options.maxAdded &&
      entry.delta.removeNodeIds.length <= options.maxRemovals
    ));
  const paretoArchive = epsilonParetoArchive(eligible, options.epsilon);
  const explorationBucket = eligible
    .filter(
      (entry) =>
        entry.status === "needsPoB" &&
        !paretoArchive.some(
          (pareto) => pareto.canonicalKey === entry.canonicalKey,
        ),
    )
    .sort(
      (left, right) =>
        right.components.exploration - left.components.exploration ||
        right.objectives.uncertainty - left.objectives.uncertainty ||
        right.rankScore - left.rankScore ||
        left.canonicalKey.localeCompare(right.canonicalKey),
    )
    .slice(0, Math.max(1, options.diversityBucketCap));
  const archive = [...paretoArchive, ...explorationBucket].sort(
    (left, right) =>
      right.rankScore - left.rankScore ||
      left.canonicalKey.localeCompare(right.canonicalKey),
  );
  const labels = representativeLabels(archive);
  const prioritized = [...archive].sort(
    (left, right) =>
      Number(labels.has(right.canonicalKey)) -
        Number(labels.has(left.canonicalKey)) ||
      right.rankScore - left.rankScore ||
      left.canonicalKey.localeCompare(right.canonicalKey),
  );
  const representatives = applyDiversityCaps(prioritized, {
    limit: options.resultLimit,
    bucketCap: options.diversityBucketCap,
  }).map((entry) => ({
    ...entry,
    representativeLabels: labels.get(entry.canonicalKey) || [],
  }));
  const archiveKeys = new Set(archive.map((entry) => entry.canonicalKey));
  const calibrationPool = [...eligible]
    .sort(
      (left, right) =>
        right.rankScore - left.rankScore ||
        left.canonicalKey.localeCompare(right.canonicalKey),
    )
    .map((entry, cheapRank) => ({
      ...entry,
      cheapRank: cheapRank + 1,
      cheapPruned: !archiveKeys.has(entry.canonicalKey),
      calibrationTier: calibrationTier(entry.changedNodeCount),
      calibrationKind:
        entry.changedNodeCount === 0
          ? "baseline"
          : calibrationTier(entry.changedNodeCount) === "adjacent"
            ? "near-baseline"
            : "candidate",
    }));

  if (stableStringify(incumbent) !== baselineSnapshot) {
    throw new Error("Search mutated the incumbent candidate");
  }
  return {
    searchVersion: SEARCH_VERSION,
    options,
    counts,
    paretoArchiveSize: paretoArchive.length,
    explorationBucketSize: explorationBucket.length,
    archiveSize: archive.length,
    archive,
    representatives,
    calibrationPool,
  };
}

module.exports = {
  DEFAULT_EPSILON,
  SEARCH_VERSION,
  applySearchDelta,
  applyDiversityCaps,
  calibrationTier,
  changedNodes,
  diversityBucket,
  epsilonDominates,
  epsilonParetoArchive,
  jaccardDistance,
  makeMoves,
  protectedNodeIds,
  repairConnectivity,
  representativeLabels,
  roleFamily,
  runPackageSearch,
  scoreSearchCandidate,
  selectRelevantPackages,
};
