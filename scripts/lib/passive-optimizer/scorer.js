"use strict";

const { applyDelta, deltaCost, normalizeDelta } = require("./delta");
const { packageDelta } = require("./packages");
const { sortedObject } = require("./stable");
const { validateCandidate } = require("./validator");

const BUILD_PROFILE_SCHEMA_VERSION = 1;
const SCORER_VERSION = 1;

const DEFAULT_COMPONENT_WEIGHTS = {
  offense: 1,
  defense: 1,
  accuracy: 1,
  recovery: 1,
  mobility: 0.6,
  resource: 0.7,
  travel: 1,
  synergy: 1,
  uncertainty: 1,
  exploration: 0.2,
};

function normalizeTags(values) {
  return [...new Set((values || []).map(String).filter(Boolean))].sort();
}

function normalizeBuildProfile(input = {}) {
  return {
    buildProfileSchemaVersion:
      input.buildProfileSchemaVersion || BUILD_PROFILE_SCHEMA_VERSION,
    id: input.id || "anonymous",
    archetypeTags: normalizeTags(input.archetypeTags),
    skillTags: normalizeTags(input.skillTags),
    weaponTags: normalizeTags(input.weaponTags),
    desiredTags: normalizeTags(input.desiredTags),
    forbiddenTags: normalizeTags(input.forbiddenTags),
    hardConstraints: {
      requiredTags: normalizeTags(input.hardConstraints?.requiredTags),
      forbiddenTags: normalizeTags(input.hardConstraints?.forbiddenTags),
      maxMarginalPoints: Number.isFinite(
        Number(input.hardConstraints?.maxMarginalPoints),
      )
        ? Number(input.hardConstraints.maxMarginalPoints)
        : null,
      maxRespec: Number.isFinite(Number(input.hardConstraints?.maxRespec))
        ? Number(input.hardConstraints.maxRespec)
        : null,
      performanceFloors: sortedObject(
        input.hardConstraints?.performanceFloors,
        Number,
      ),
    },
    floors: sortedObject(input.floors, Number),
    softTargets: sortedObject(input.softTargets, Number),
    weights: {
      components: {
        ...DEFAULT_COMPONENT_WEIGHTS,
        ...(input.weights?.components || {}),
      },
      tags: sortedObject(input.weights?.tags, Number),
    },
  };
}

function desiredTags(profile) {
  return new Set([
    ...profile.archetypeTags,
    ...profile.skillTags,
    ...profile.weaponTags,
    ...profile.desiredTags,
  ]);
}

function tagMagnitude(stats, predicate) {
  return Object.entries(stats?.tagMagnitudes || {})
    .filter(([tag]) => predicate(tag))
    .reduce((sum, [, value]) => sum + Math.log1p(Math.max(0, value)), 0);
}

function weightedTagValue(pkg, profile, predicate) {
  let value = 0;
  for (const [tag, magnitude] of Object.entries(
    pkg.stats?.tagMagnitudes || {},
  )) {
    if (!predicate(tag)) continue;
    value +=
      Math.log1p(Math.max(0, magnitude)) * (profile.weights.tags[tag] ?? 1);
  }
  return value;
}

function packageTags(pkg) {
  return new Set(pkg.normalizedTags || pkg.stats?.normalizedTags || []);
}

function matchingTag(tags, requested) {
  if (tags.has(requested)) return true;
  return [...tags].some(
    (tag) => tag.startsWith(`${requested}.`) || requested.startsWith(`${tag}.`),
  );
}

function baselineFloorChecks(profile, baseline) {
  const floors = {
    ...profile.floors,
    ...profile.hardConstraints.performanceFloors,
  };
  const failures = [];
  const missing = [];
  for (const [metric, floor] of Object.entries(floors)) {
    const value = Number(baseline?.metrics?.[metric]);
    if (!baseline?.trusted || !Number.isFinite(value)) {
      missing.push({ metric, floor });
    } else if (value < floor) {
      failures.push({ metric, floor, value });
    }
  }
  return { failures, missing };
}

function explicitPackage(delta, graph) {
  const sourceNodeIds = [...new Set([
    ...delta.addNodeIds,
    ...delta.removeNodeIds,
  ])].sort((a, b) => a - b);
  return {
    id: "explicit-delta",
    structuralType: "build_specific_package",
    normalizedTags: [],
    stats: { tagMagnitudes: {}, unknownLines: [] },
    uncertainty: sourceNodeIds.some((id) => !graph.nodes.has(id))
      ? "high"
      : "low",
    needsPoB: sourceNodeIds.some((id) => !graph.nodes.has(id)),
    reasonCodes: ["EXPLICIT_DELTA"],
    costs: null,
    sourceNodeIds,
  };
}

function scoreDelta({
  graph,
  buildState,
  candidate,
  package: packageInput,
  delta: deltaInput,
  profile: profileInput,
  baselineMetrics = null,
  config = {},
}) {
  const profile = normalizeBuildProfile(profileInput);
  const delta = packageInput
    ? packageDelta(packageInput)
    : normalizeDelta(deltaInput);
  const pkg = packageInput || explicitPackage(delta, graph);
  const cost = deltaCost(candidate, delta);
  const nextCandidate = applyDelta(candidate, delta);
  const validation = validateCandidate(graph, nextCandidate, {
    baselineAllocatedNodeIds: candidate.allocatedNodeIds,
  });
  const tags = packageTags(pkg);
  const wanted = desiredTags(profile);
  const reasonCodes = new Set(pkg.reasonCodes || []);
  const requiredPobChecks = new Set();

  const components = {
    offense: weightedTagValue(
      pkg,
      profile,
      (tag) => tag.startsWith("damage.") || tag.startsWith("attack."),
    ),
    defense: weightedTagValue(pkg, profile, (tag) =>
      tag.startsWith("defense."),
    ),
    accuracy: tagMagnitude(pkg.stats, (tag) => tag === "accuracy"),
    recovery: weightedTagValue(pkg, profile, (tag) =>
      tag.startsWith("recovery."),
    ),
    mobility: tagMagnitude(pkg.stats, (tag) => tag === "mobility"),
    resource: weightedTagValue(pkg, profile, (tag) =>
      tag.startsWith("resources."),
    ),
    travel: -(
      cost.marginal.add +
      cost.marginal.remove * Number(config.respecPenalty ?? 0.5)
    ),
    synergy: 0,
    uncertainty: 0,
    exploration: 0,
  };

  for (const requested of wanted) {
    if (matchingTag(tags, requested)) {
      components.synergy += profile.weights.tags[requested] ?? 1;
    }
  }
  for (const [target, desired] of Object.entries(profile.softTargets)) {
    const current = Number(baselineMetrics?.metrics?.[target]);
    const deficit = Number.isFinite(current)
      ? Math.max(0, Number(desired) - current) / Math.max(1, Math.abs(desired))
      : 0.25;
    const targetMatches =
      matchingTag(tags, target) ||
      (target in components && components[target] > 0);
    if (targetMatches && deficit > 0) {
      components.synergy += deficit * (profile.weights.tags[target] ?? 1);
      reasonCodes.add(`SOFT_TARGET_${target.toUpperCase()}_SUPPORTED`);
    }
  }
  const forbidden = [
    ...profile.forbiddenTags,
    ...profile.hardConstraints.forbiddenTags,
  ];
  const forbiddenMatches = forbidden.filter((tag) => matchingTag(tags, tag));
  const requiredMissing = profile.hardConstraints.requiredTags.filter(
    (tag) => !matchingTag(tags, tag),
  );
  if (forbiddenMatches.length) {
    reasonCodes.add("FORBIDDEN_TAG_MATCH");
  }
  if (requiredMissing.length) {
    reasonCodes.add("REQUIRED_TAG_MISSING");
  }

  const unknownCount = pkg.stats?.unknownLines?.length || 0;
  const uncertaintyPenalty =
    (pkg.uncertainty === "high" ? 2 : 0) +
    unknownCount * Number(config.unknownLinePenalty ?? 0.5);
  components.uncertainty = -uncertaintyPenalty;
  if (pkg.needsPoB || pkg.uncertainty === "high") {
    requiredPobChecks.add("MECHANIC_EFFECT");
    reasonCodes.add("PACKAGE_NEEDS_POB");
  }
  for (const issue of validation.needsPob) {
    requiredPobChecks.add(issue.code);
    reasonCodes.add(issue.code);
  }
  if (validation.warnings.length) reasonCodes.add("VALIDATOR_WARNING");

  const knownTags = new Set(config.knownTags || []);
  const novelTags = [...tags].filter((tag) => !knownTags.has(tag)).length;
  components.exploration =
    novelTags * Number(config.explorationPerNovelTag ?? 0.15);

  const floors = baselineFloorChecks(profile, baselineMetrics);
  for (const failure of floors.failures) {
    reasonCodes.add(`TRUSTED_FLOOR_FAILED_${failure.metric.toUpperCase()}`);
  }
  for (const missing of floors.missing) {
    reasonCodes.add(`FLOOR_NEEDS_POB_${missing.metric.toUpperCase()}`);
    requiredPobChecks.add(`PERFORMANCE_FLOOR:${missing.metric}`);
  }

  const maxPointsFailed =
    profile.hardConstraints.maxMarginalPoints !== null &&
    cost.marginal.add > profile.hardConstraints.maxMarginalPoints;
  const maxRespecFailed =
    profile.hardConstraints.maxRespec !== null &&
    cost.respec > profile.hardConstraints.maxRespec;
  if (maxPointsFailed) reasonCodes.add("MAX_MARGINAL_POINTS_EXCEEDED");
  if (maxRespecFailed) reasonCodes.add("MAX_RESPEC_EXCEEDED");

  const hardInvalid =
    !validation.valid ||
    forbiddenMatches.length > 0 ||
    requiredMissing.length > 0 ||
    floors.failures.length > 0 ||
    maxPointsFailed ||
    maxRespecFailed;
  const needsPoB =
    !hardInvalid &&
    (requiredPobChecks.size > 0 || floors.missing.length > 0);
  const risky =
    !hardInvalid && !needsPoB && validation.warnings.length > 0;
  const status = hardInvalid
    ? "invalid"
    : needsPoB
      ? "needsPoB"
      : risky
        ? "risky"
        : "valid";

  const weightedComponents = Object.fromEntries(
    Object.entries(components).map(([name, value]) => [
      name,
      value * Number(profile.weights.components[name] ?? 1),
    ]),
  );
  const estimatedValue = Object.entries(weightedComponents)
    .filter(([name]) => name !== "exploration")
    .reduce((sum, [, value]) => sum + value, 0);
  const rankScore =
    estimatedValue + weightedComponents.exploration - (hardInvalid ? 1000 : 0);
  const confidence = Math.max(
    0.05,
    Math.min(
      1,
      0.9 -
        (pkg.uncertainty === "high" ? 0.35 : 0) -
        Math.min(0.3, unknownCount * 0.05) -
        (baselineMetrics?.trusted ? 0 : 0.1),
    ),
  );

  return {
    scorerVersion: SCORER_VERSION,
    buildProfileSchemaVersion: profile.buildProfileSchemaVersion,
    profileId: profile.id,
    packageId: pkg.id,
    rankScore,
    estimatedValue,
    status,
    components: weightedComponents,
    confidence,
    reasonCodes: [...reasonCodes].sort(),
    requiredPoBChecks: [...requiredPobChecks].sort(),
    validation,
    costs: cost,
    delta,
    candidateCanonicalKey: candidate.canonicalKey,
    resultCandidateCanonicalKey: nextCandidate.canonicalKey,
    note: "Local rank only; this is not an exact DPS or EHP prediction.",
    ...(config.includeCandidate ? { candidate: nextCandidate } : {}),
    ...(buildState ? { buildWarnings: buildState.warnings || [] } : {}),
  };
}

function rankPackages(input) {
  return (input.packages || [])
    .map((pkg) =>
      scoreDelta({
        ...input,
        package: pkg,
        delta: undefined,
      }),
    )
    .sort(
      (left, right) =>
        right.rankScore - left.rankScore ||
        left.packageId.localeCompare(right.packageId),
    );
}

module.exports = {
  BUILD_PROFILE_SCHEMA_VERSION,
  DEFAULT_COMPONENT_WEIGHTS,
  SCORER_VERSION,
  normalizeBuildProfile,
  rankPackages,
  scoreDelta,
};
