"use strict";

const fs = require("fs");
const path = require("path");
const { performance } = require("perf_hooks");
const { PobClient, resolveRuntime } = require("../pob-client");
const {
  drift,
  observableSnapshot,
  parity,
  runtimeIdentity,
  treeParams,
} = require("./pob-smoke");
const {
  epsilonParetoArchive,
  jaccardDistance,
} = require("./search");
const {
  sha256,
  stableStringify,
} = require("./stable");

const SELECTIVE_EVALUATION_VERSION = 3;
const CACHE_SCHEMA_VERSION = 3;
const CHECKPOINT_SCHEMA_VERSION = 2;
const OBJECTIVE_EXTRACTOR_VERSION = 3;
const DEFAULT_MINIMUM_SAMPLE = 8;
const DEFAULT_NEAR_BASELINE_COUNT = 2;
const DEFAULT_SELECTION_MIX = Object.freeze({
  predictedBest: 0.35,
  highUncertainty: 0.2,
  structurallyDiverse: 0.2,
  incumbentAdjacent: 0.15,
  randomSanity: 0.1,
});
const SELECTION_NAMES = Object.freeze(Object.keys(DEFAULT_SELECTION_MIX));

function finiteNumber(value, fallback = null) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function normalizeObjectiveSet(value) {
  const source = Array.isArray(value)
    ? { objectives: value }
    : (value || {});
  const objectives = (source.objectives || source.metrics || [])
    .map((entry) => {
      if (typeof entry === "string") {
        return { name: entry, field: entry, direction: "max" };
      }
      const field = String(entry.field || entry.name || "").trim();
      if (!field) return null;
      const direction = String(entry.direction || "max").toLowerCase();
      if (!["max", "min"].includes(direction)) {
        throw new Error(`Invalid objective direction for ${field}: ${direction}`);
      }
      return {
        name: String(entry.name || field),
        field,
        direction,
        source: String(entry.source || "pob"),
        skill: entry.skill || null,
        role: entry.role ? String(entry.role) : null,
        optional: Boolean(entry.optional),
      };
    })
    .filter(Boolean)
    .sort((left, right) =>
      left.name.localeCompare(right.name) ||
      left.field.localeCompare(right.field),
    );
  const names = new Set();
  for (const objective of objectives) {
    if (names.has(objective.name)) {
      throw new Error(`Duplicate objective name: ${objective.name}`);
    }
    names.add(objective.name);
  }
  return {
    name: String(source.name || "custom"),
    version: source.version ?? 1,
    minimumSample: Math.max(
      2,
      Math.floor(finiteNumber(source.minimumSample, DEFAULT_MINIMUM_SAMPLE)),
    ),
    objectives,
  };
}

function parseObjectiveSpec(value) {
  const text = String(value || "").trim();
  if (!text) return normalizeObjectiveSet([]);
  return normalizeObjectiveSet({
    name: "cli",
    objectives: text.split(",").map((part) => {
      const [field, rawDirection] = part.split(":").map((entry) => entry.trim());
      return {
        name: field,
        field,
        direction: rawDirection || "max",
      };
    }),
  });
}

function normalizeSelectionMix(value) {
  if (!value) return { ...DEFAULT_SELECTION_MIX };
  const aliases = {
    best: "predictedBest",
    uncertainty: "highUncertainty",
    diverse: "structurallyDiverse",
    adjacent: "incumbentAdjacent",
    random: "randomSanity",
  };
  const rawSource = typeof value === "string"
    ? Object.fromEntries(
        value.split(",").filter(Boolean).map((part) => {
          const [name, amount] = part.split("=").map((entry) => entry.trim());
          return [name, Number(amount)];
        }),
      )
    : value;
  const source = Object.fromEntries(
    Object.entries(rawSource).map(([name, amount]) => [
      aliases[name] || name,
      amount,
    ]),
  );
  const result = {};
  for (const name of SELECTION_NAMES) {
    const amount = finiteNumber(source[name], 0);
    if (amount < 0) throw new Error(`Selection mix ${name} cannot be negative`);
    result[name] = amount;
  }
  const unknown = Object.keys(source).filter(
    (name) => !SELECTION_NAMES.includes(name),
  );
  if (unknown.length) {
    throw new Error(`Unknown selection mix keys: ${unknown.sort().join(", ")}`);
  }
  if (Object.values(result).every((amount) => amount === 0)) {
    throw new Error("Selection mix must contain at least one positive value");
  }
  return result;
}

function allocateSelectionCounts(limit, mix) {
  const total = Math.max(0, Math.floor(Number(limit) || 0));
  const active = SELECTION_NAMES.filter((name) => mix[name] > 0);
  const weight = active.reduce((sum, name) => sum + mix[name], 0);
  const allocation = Object.fromEntries(SELECTION_NAMES.map((name) => [name, 0]));
  if (total === 0 || active.length === 0) return allocation;
  const raw = active.map((name) => ({
    name,
    exact: total * mix[name] / weight,
  }));
  for (const entry of raw) allocation[entry.name] = Math.floor(entry.exact);
  let remaining = total - Object.values(allocation).reduce(
    (sum, amount) => sum + amount,
    0,
  );
  raw.sort(
    (left, right) =>
      (right.exact - Math.floor(right.exact)) -
        (left.exact - Math.floor(left.exact)) ||
      SELECTION_NAMES.indexOf(left.name) - SELECTION_NAMES.indexOf(right.name),
  );
  for (let index = 0; remaining > 0; index += 1, remaining -= 1) {
    allocation[raw[index % raw.length].name] += 1;
  }
  return allocation;
}

function deterministicRank(seed, canonicalKey) {
  return sha256(`${Number(seed) || 0}:${canonicalKey}`);
}

function compareCheap(left, right) {
  return Number(right.rankScore || 0) - Number(left.rankScore || 0) ||
    left.canonicalKey.localeCompare(right.canonicalKey);
}

function diverseOrder(entries) {
  const remaining = [...entries].sort(compareCheap);
  const selected = [];
  while (remaining.length) {
    const next = remaining
      .map((entry) => ({
        entry,
        distance: selected.length === 0
          ? 1
          : Math.min(...selected.map((other) =>
              jaccardDistance(entry.changedNodeIds, other.changedNodeIds),
            )),
      }))
      .sort(
        (left, right) =>
          right.distance - left.distance ||
          compareCheap(left.entry, right.entry),
      )[0].entry;
    selected.push(next);
    remaining.splice(
      remaining.findIndex((entry) => entry.canonicalKey === next.canonicalKey),
      1,
    );
  }
  return selected;
}

function selectPobCandidates({
  shortlist,
  limit,
  mix,
  seed = 0,
}) {
  const unique = [...new Map(
    (shortlist || []).map((entry) => [entry.canonicalKey, entry]),
  ).values()];
  const count = Math.min(unique.length, Math.max(0, Math.floor(Number(limit) || 0)));
  const normalizedMix = normalizeSelectionMix(mix);
  const allocation = allocateSelectionCounts(count, normalizedMix);
  const cheapPareto = epsilonParetoArchive(unique);
  const cheapParetoKeys = new Set(cheapPareto.map((entry) => entry.canonicalKey));
  const strategies = {
    predictedBest: [...unique].sort(compareCheap),
    highUncertainty: [...unique].sort(
      (left, right) =>
        Number(right.needsPoB) - Number(left.needsPoB) ||
        Number(right.objectives?.uncertainty || 0) -
          Number(left.objectives?.uncertainty || 0) ||
        Number(right.components?.exploration || 0) -
          Number(left.components?.exploration || 0) ||
        compareCheap(left, right),
    ),
    structurallyDiverse: diverseOrder(unique),
    incumbentAdjacent: [...unique].sort(
      (left, right) =>
        Number(cheapParetoKeys.has(left.canonicalKey)) -
          Number(cheapParetoKeys.has(right.canonicalKey)) ||
        Number(left.changedNodeCount || 0) - Number(right.changedNodeCount || 0) ||
        Number(left.rankScore || 0) - Number(right.rankScore || 0) ||
        left.canonicalKey.localeCompare(right.canonicalKey),
    ),
    randomSanity: [...unique].sort(
      (left, right) =>
        deterministicRank(seed, left.canonicalKey).localeCompare(
          deterministicRank(seed, right.canonicalKey),
        ) ||
        left.canonicalKey.localeCompare(right.canonicalKey),
    ),
  };
  const selected = [];
  const selectedByKey = new Map();
  function take(name, target) {
    let taken = 0;
    for (const entry of strategies[name]) {
      if (taken >= target) break;
      const existing = selectedByKey.get(entry.canonicalKey);
      if (existing) {
        if (!existing.selectionReasons.includes(name)) {
          existing.selectionReasons.push(name);
        }
        continue;
      }
      const selectedEntry = {
        ...entry,
        selectionReasons: [name],
        selectionOrder: selected.length,
      };
      selected.push(selectedEntry);
      selectedByKey.set(entry.canonicalKey, selectedEntry);
      taken += 1;
    }
  }
  for (const name of SELECTION_NAMES) take(name, allocation[name]);
  const fallback = [...unique].sort(compareCheap);
  for (const entry of fallback) {
    if (selected.length >= count) break;
    if (selectedByKey.has(entry.canonicalKey)) continue;
    const selectedEntry = {
      ...entry,
      selectionReasons: ["budgetFill"],
      selectionOrder: selected.length,
    };
    selected.push(selectedEntry);
    selectedByKey.set(entry.canonicalKey, selectedEntry);
  }
  return {
    version: SELECTIVE_EVALUATION_VERSION,
    limit: count,
    mix: normalizedMix,
    allocation,
    cheapParetoKeys: [...cheapParetoKeys].sort(),
    selected,
  };
}

function structuralBucket(entry) {
  const families = [...new Set(entry.families || [])].sort();
  const transactionType = entry.transaction?.type ||
    entry.moveHistory?.[0]?.type ||
    "unknown";
  return `${families.join("+") || "unclassified"}@${transactionType}`;
}

function quantileOrder(entries) {
  const sorted = [...entries].sort(compareCheap);
  const result = [];
  let low = 0;
  let high = sorted.length - 1;
  while (low <= high) {
    result.push(sorted[low]);
    low += 1;
    if (low <= high) {
      result.push(sorted[high]);
      high -= 1;
    }
  }
  return result;
}

function structuralRoleOrder(entries) {
  const buckets = new Map();
  for (const entry of [...entries].sort(compareCheap)) {
    const bucket = structuralBucket(entry);
    if (!buckets.has(bucket)) buckets.set(bucket, []);
    buckets.get(bucket).push(entry);
  }
  const names = [...buckets.keys()].sort();
  const result = [];
  for (let offset = 0; ; offset += 1) {
    let added = false;
    for (const name of names) {
      const entry = buckets.get(name)[offset];
      if (!entry) continue;
      result.push(entry);
      added = true;
    }
    if (!added) break;
  }
  return result;
}

function selectCalibrationCandidates({
  shortlist,
  limit,
  mix,
  seed = 0,
  nearBaselineCount = DEFAULT_NEAR_BASELINE_COUNT,
}) {
  const unique = [...new Map(
    (shortlist || []).map((entry) => [entry.canonicalKey, entry]),
  ).values()];
  const count = Math.min(unique.length, Math.max(0, Math.floor(Number(limit) || 0)));
  const normalizedMix = normalizeSelectionMix(mix);
  const selected = [];
  const selectedByKey = new Map();
  function add(entry, reason) {
    if (!entry || selected.length >= count) return false;
    const existing = selectedByKey.get(entry.canonicalKey);
    if (existing) {
      if (!existing.selectionReasons.includes(reason)) {
        existing.selectionReasons.push(reason);
      }
      return false;
    }
    const selectedEntry = {
      ...entry,
      structuralBucket: structuralBucket(entry),
      selectionReasons: [reason],
      selectionOrder: selected.length,
    };
    selected.push(selectedEntry);
    selectedByKey.set(entry.canonicalKey, selectedEntry);
    return true;
  }
  const baseline = unique
    .filter((entry) =>
      entry.calibrationKind === "baseline" ||
      Number(entry.changedNodeCount || 0) === 0)
    .sort(compareCheap)[0];
  add(baseline, "baseline");
  const near = unique
    .filter((entry) =>
      entry.calibrationKind === "near-baseline" ||
      (
        Number(entry.changedNodeCount || 0) > 0 &&
        Number(entry.changedNodeCount || 0) <= 4
      ))
    .sort(
      (left, right) =>
        Number(left.changedNodeCount || 0) - Number(right.changedNodeCount || 0) ||
        compareCheap(left, right),
    );
  let nearAdded = 0;
  for (const entry of near) {
    if (nearAdded >= Math.max(1, Number(nearBaselineCount) || 0)) break;
    if (add(entry, "nearBaseline")) nearAdded += 1;
  }
  const remaining = unique.filter((entry) => !selectedByKey.has(entry.canonicalKey));
  const weights = {
    cheapRank: normalizedMix.predictedBest,
    uncertainty: normalizedMix.highUncertainty,
    structuralRole: normalizedMix.structurallyDiverse,
    cheapPruned: normalizedMix.incumbentAdjacent,
    deterministicSanity: normalizedMix.randomSanity,
  };
  const allocation = allocateSelectionCounts(
    Math.max(0, count - selected.length),
    {
      predictedBest: weights.cheapRank,
      highUncertainty: weights.uncertainty,
      structurallyDiverse: weights.structuralRole,
      incumbentAdjacent: weights.cheapPruned,
      randomSanity: weights.deterministicSanity,
    },
  );
  const strategies = {
    cheapRank: quantileOrder(remaining),
    uncertainty: [...remaining].sort(
      (left, right) =>
        Number(right.needsPoB) - Number(left.needsPoB) ||
        Number(right.objectives?.uncertainty || 0) -
          Number(left.objectives?.uncertainty || 0) ||
        compareCheap(left, right),
    ),
    structuralRole: structuralRoleOrder(remaining),
    cheapPruned: remaining
      .filter((entry) => entry.cheapPruned)
      .sort(compareCheap),
    deterministicSanity: [...remaining].sort(
      (left, right) =>
        deterministicRank(seed, left.canonicalKey).localeCompare(
          deterministicRank(seed, right.canonicalKey),
        ) ||
        left.canonicalKey.localeCompare(right.canonicalKey),
    ),
  };
  const requested = {
    cheapRank: allocation.predictedBest,
    uncertainty: allocation.highUncertainty,
    structuralRole: allocation.structurallyDiverse,
    cheapPruned: allocation.incumbentAdjacent,
    deterministicSanity: allocation.randomSanity,
  };
  for (const name of Object.keys(strategies)) {
    let added = 0;
    for (const entry of strategies[name]) {
      if (added >= requested[name]) break;
      if (add(entry, name)) added += 1;
    }
  }
  for (const entry of quantileOrder(remaining)) {
    if (selected.length >= count) break;
    add(entry, "budgetFill");
  }
  const cheapParetoKeys = unique
    .filter((entry) => !entry.cheapPruned)
    .map((entry) => entry.canonicalKey)
    .sort();
  return {
    version: SELECTIVE_EVALUATION_VERSION,
    limit: count,
    mix: normalizedMix,
    allocation: requested,
    mandatory: {
      baselineIncluded: Boolean(
        baseline && selectedByKey.has(baseline.canonicalKey),
      ),
      nearBaselineAvailable: near.length,
      nearBaselineIncluded: selected.filter((entry) =>
        entry.selectionReasons.includes("nearBaseline")).length,
    },
    cheapParetoKeys,
    selected,
  };
}

function readStore(file, schemaVersion) {
  if (!file || !fs.existsSync(file)) {
    return { schemaVersion, entries: {} };
  }
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  if (parsed.schemaVersion !== schemaVersion || !parsed.entries) {
    return { schemaVersion, entries: {} };
  }
  return parsed;
}

function writeJsonAtomic(file, value) {
  if (!file) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(temporary, file);
}

function optionalFileIdentity(file) {
  if (!file || !fs.existsSync(file)) return null;
  const bytes = fs.readFileSync(file);
  return {
    name: path.basename(file),
    sha256: sha256(bytes),
    size: bytes.length,
  };
}

function completeCacheIdentity({
  candidate,
  scoring,
  buildHash,
  baseline,
  runtime,
  objectiveSet,
  enemyProfile,
  treeData,
}) {
  return {
    cacheSchemaVersion: CACHE_SCHEMA_VERSION,
    selectiveEvaluationVersion: SELECTIVE_EVALUATION_VERSION,
    candidate: {
      canonicalKey: candidate.canonicalKey,
      state: candidate,
    },
    scoring: scoring || null,
    build: {
      xmlSha256: buildHash,
      importedIdentity: candidate.importedPobIdentity || null,
      info: baseline.info,
    },
    items: baseline.items,
    skills: baseline.skills,
    jewels: candidate.jewelState,
    choices: {
      attributeOverrides: candidate.attributeOverrides,
      switchableOverrides: candidate.switchableOverrides,
      multipleChoiceSelections: candidate.multipleChoiceSelections,
      masterySelections: candidate.masterySelections,
      weaponSetAllocations: candidate.weaponSetAllocations,
    },
    config: {
      baseline: baseline.config,
      candidate: candidate.configRelevantState,
    },
    enemyProfile: enemyProfile || null,
    treeData: {
      hash: treeData?.hash || candidate.treeDataHash,
      version: treeData?.treeVersion || candidate.treeVersion,
      schemaVersion: treeData?.schemaVersion || null,
    },
    pob: {
      ...runtimeIdentity(runtime),
      executable: optionalFileIdentity(runtime.exe),
      wrapper: optionalFileIdentity(runtime.wrapper),
      manifest: optionalFileIdentity(runtime.manifestPath),
    },
    objectives: {
      extractorVersion: OBJECTIVE_EXTRACTOR_VERSION,
      set: objectiveSet,
    },
  };
}

function cacheKeyFor(input) {
  return sha256(stableStringify(completeCacheIdentity(input)));
}

function candidateObjectiveValue(entry, objective) {
  const values = {
    changedNodeCount: entry.changedNodeCount,
    pointCost:
      entry.costs?.marginal?.add ??
      entry.delta?.addNodeIds?.length,
    respecCost:
      entry.objectives?.respecCost ??
      entry.costs?.respec ??
      entry.delta?.removeNodeIds?.length,
    pointsAdded: entry.delta?.addNodeIds?.length,
    pointsRemoved: entry.delta?.removeNodeIds?.length,
    uncertainty:
      entry.objectives?.uncertainty ??
      Math.abs(Number(entry.components?.uncertainty || 0)),
  };
  return finiteNumber(values[objective.field]);
}

function objectiveSkillNames(skill) {
  if (!skill) return [];
  if (typeof skill === "string") return [skill];
  return [
    ...(skill.names || []),
    ...(skill.name ? [skill.name] : []),
  ].map((value) => String(value).trim()).filter(Boolean);
}

function resolveSkillSelection(skills, skill) {
  if (!skill) return null;
  const names = objectiveSkillNames(skill);
  const lowered = names.map((name) => name.toLowerCase());
  const groups = skills?.groups || [];
  const candidates = [];
  for (const group of groups) {
    const display = group.skills || [];
    const gems = group.gems || [];
    for (let index = 0; index < display.length; index += 1) {
      candidates.push({
        group,
        activeSkill: index + 1,
        name: display[index],
      });
    }
    for (const gem of gems) {
      candidates.push({
        group,
        activeSkill: group.mainActiveSkill || 1,
        name: gem.name,
      });
    }
  }
  const exact = lowered
    .map((name) => candidates.find((entry) =>
      String(entry.name || "").toLowerCase() === name))
    .find(Boolean);
  const partial = lowered
    .map((name) => candidates.find((entry) =>
      String(entry.name || "").toLowerCase().includes(name)))
    .find(Boolean);
  const selected = exact || partial;
  if (!selected) return null;
  return {
    mainSocketGroup: selected.group.index,
    mainActiveSkill: selected.activeSkill,
    matchedName: selected.name,
  };
}

async function extractObjectives({
  client,
  skills,
  objectiveSet,
  entry,
}) {
  const metrics = {};
  const objectiveSources = {};
  const missingRequired = [];
  const unavailableOptional = [];
  const pobObjectives = objectiveSet.objectives.filter(
    (objective) => objective.source !== "candidate",
  );
  for (const objective of objectiveSet.objectives.filter(
    (entryObjective) => entryObjective.source === "candidate",
  )) {
    const value = candidateObjectiveValue(entry, objective);
    if (value === null) {
      (objective.optional ? unavailableOptional : missingRequired)
        .push(objective.name);
    } else {
      metrics[objective.name] = value;
      objectiveSources[objective.name] = {
        source: "candidate",
        field: objective.field,
      };
    }
  }
  const groups = new Map();
  for (const objective of pobObjectives) {
    const selection = resolveSkillSelection(skills, objective.skill);
    if (objective.skill && !selection) {
      (objective.optional ? unavailableOptional : missingRequired)
        .push(objective.name);
      continue;
    }
    const key = selection
      ? `${selection.mainSocketGroup}:${selection.mainActiveSkill}`
      : "current";
    if (!groups.has(key)) groups.set(key, { selection, objectives: [] });
    groups.get(key).objectives.push(objective);
  }
  const touched = new Map();
  try {
    const orderedGroups = [...groups.entries()]
      .sort((left, right) =>
        Number(left[0] !== "current") - Number(right[0] !== "current"));
    for (const [, group] of orderedGroups) {
      if (group.selection) {
        const original = skills.groups.find(
          (entryGroup) => entryGroup.index === group.selection.mainSocketGroup,
        );
        touched.set(group.selection.mainSocketGroup, original?.mainActiveSkill || 1);
        await client.call("set_main_selection", group.selection);
      }
      const fields = [...new Set(
        group.objectives.map((objective) => objective.field),
      )].sort();
      const stats = (await client.call("get_stats", { fields })).stats;
      for (const objective of group.objectives) {
        const value = finiteNumber(stats?.[objective.field]);
        if (value === null) {
          (objective.optional ? unavailableOptional : missingRequired)
            .push(objective.name);
        } else {
          metrics[objective.name] = value;
          objectiveSources[objective.name] = {
            source: "pob",
            field: objective.field,
            skill: group.selection?.matchedName || null,
            mainSocketGroup: group.selection?.mainSocketGroup || null,
            mainActiveSkill: group.selection?.mainActiveSkill || null,
          };
        }
      }
    }
  } finally {
    for (const [mainSocketGroup, mainActiveSkill] of [...touched.entries()]
      .sort((left, right) => left[0] - right[0])) {
      await client.call("set_main_selection", {
        mainSocketGroup,
        mainActiveSkill,
      });
    }
    const originalGroup = skills.groups.find(
      (group) => group.index === skills.mainSocketGroup,
    );
    if (touched.size > 0 && skills.mainSocketGroup) {
      await client.call("set_main_selection", {
        mainSocketGroup: skills.mainSocketGroup,
        mainActiveSkill: originalGroup?.mainActiveSkill || 1,
      });
    }
  }
  return {
    metrics,
    objectiveSources,
    missingRequired: [...new Set(missingRequired)].sort(),
    unavailableOptional: [...new Set(unavailableOptional)].sort(),
  };
}

function realObjectiveVector(result, objectiveSet) {
  return Object.fromEntries(objectiveSet.objectives
    .filter((objective) =>
      Number.isFinite(Number(result.objectives?.[objective.name])))
    .map((objective) => [
      objective.name,
      objective.direction === "min"
        ? -Number(result.objectives[objective.name])
        : Number(result.objectives[objective.name]),
    ]));
}

function realDominates(left, right, objectiveSet) {
  const a = realObjectiveVector(left, objectiveSet);
  const b = realObjectiveVector(right, objectiveSet);
  const names = Object.keys(a).filter((name) => name in b);
  let better = false;
  for (const name of names) {
    if (a[name] < b[name]) return false;
    if (a[name] > b[name]) better = true;
  }
  return names.length > 0 && better;
}

function realParetoArchive(results, objectiveSet) {
  const successful = results
    .filter((entry) => entry.status === "success")
    .sort((left, right) => left.canonicalKey.localeCompare(right.canonicalKey));
  const archive = [];
  for (const entry of successful) {
    if (archive.some((other) => realDominates(other, entry, objectiveSet))) {
      continue;
    }
    for (let index = archive.length - 1; index >= 0; index -= 1) {
      if (realDominates(entry, archive[index], objectiveSet)) {
        archive.splice(index, 1);
      }
    }
    archive.push(entry);
  }
  return archive.sort((left, right) =>
    left.canonicalKey.localeCompare(right.canonicalKey),
  );
}

function normalizedUtility(result, baselineObjectives, objectiveSet) {
  if (!result || result.status !== "success") return null;
  let utility = 0;
  for (const objective of objectiveSet.objectives) {
    const baseline = Number(baselineObjectives[objective.name]);
    const measured = Number(result.objectives[objective.name]);
    if (!Number.isFinite(baseline) || !Number.isFinite(measured)) continue;
    const direction = objective.direction === "min" ? -1 : 1;
    utility += direction * (measured - baseline) / Math.max(1, Math.abs(baseline));
  }
  return utility;
}

function objectiveEvidence(result, baselineObjectives, objectiveSet) {
  const deltas = {};
  let positive = 0;
  let negative = 0;
  for (const objective of objectiveSet.objectives) {
    const baseline = Number(baselineObjectives[objective.name]);
    const measured = Number(result.objectives?.[objective.name]);
    if (!Number.isFinite(baseline) || !Number.isFinite(measured)) continue;
    const absolute = measured - baseline;
    const directional = (objective.direction === "min" ? -1 : 1) * absolute;
    deltas[objective.name] = {
      baseline,
      measured,
      absolute,
      percent: Math.abs(baseline) > 1e-12 ? absolute / Math.abs(baseline) : null,
      directional,
      improved: directional > 0,
      regressed: directional < 0,
    };
    if (directional > 0) positive += 1;
    if (directional < 0) negative += 1;
  }
  const comparison = positive > 0 && negative === 0
    ? "dominates_baseline"
    : negative > 0 && positive === 0
      ? "dominated_by_baseline"
      : positive > 0 && negative > 0
        ? "tradeoff"
        : "equal_to_baseline";
  return {
    ...result,
    objectiveDeltas: deltas,
    baselineComparison: comparison,
    normalizedUtility: normalizedUtility(
      result,
      baselineObjectives,
      objectiveSet,
    ),
  };
}

function rankValues(values, selector) {
  const sorted = [...values].sort(
    (left, right) =>
      selector(right) - selector(left) ||
      left.canonicalKey.localeCompare(right.canonicalKey),
  );
  const ranks = new Map();
  let index = 0;
  while (index < sorted.length) {
    let end = index + 1;
    while (end < sorted.length && selector(sorted[end]) === selector(sorted[index])) {
      end += 1;
    }
    const rank = (index + end - 1) / 2 + 1;
    for (let cursor = index; cursor < end; cursor += 1) {
      ranks.set(sorted[cursor].canonicalKey, rank);
    }
    index = end;
  }
  return ranks;
}

function spearmanCorrelation(values, leftSelector, rightSelector) {
  if (values.length < 2) return null;
  const leftRanks = rankValues(values, leftSelector);
  const rightRanks = rankValues(values, rightSelector);
  const leftMean = [...leftRanks.values()].reduce((sum, value) => sum + value, 0) /
    values.length;
  const rightMean = [...rightRanks.values()].reduce((sum, value) => sum + value, 0) /
    values.length;
  let numerator = 0;
  let leftSquares = 0;
  let rightSquares = 0;
  for (const value of values) {
    const left = leftRanks.get(value.canonicalKey) - leftMean;
    const right = rightRanks.get(value.canonicalKey) - rightMean;
    numerator += left * right;
    leftSquares += left * left;
    rightSquares += right * right;
  }
  const denominator = Math.sqrt(leftSquares * rightSquares);
  return denominator === 0 ? null : numerator / denominator;
}

function wilsonInterval(successes, total, z = 1.96) {
  if (!total) return null;
  const p = successes / total;
  const denominator = 1 + z * z / total;
  const center = (p + z * z / (2 * total)) / denominator;
  const margin = z * Math.sqrt(
    p * (1 - p) / total + z * z / (4 * total * total),
  ) / denominator;
  return {
    level: 0.95,
    low: Math.max(0, center - margin),
    high: Math.min(1, center + margin),
  };
}

function bootstrapInterval(values, metric, iterations = 400) {
  if (values.length < 4) return null;
  let state = 0x6d2b79f5;
  function nextIndex() {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) % values.length;
  }
  const samples = [];
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const sample = Array.from(
      { length: values.length },
      () => values[nextIndex()],
    );
    const measured = metric(sample);
    if (Number.isFinite(measured)) samples.push(measured);
  }
  if (samples.length < iterations / 2) return null;
  samples.sort((left, right) => left - right);
  return {
    level: 0.95,
    low: samples[Math.floor(samples.length * 0.025)],
    high: samples[Math.min(
      samples.length - 1,
      Math.ceil(samples.length * 0.975) - 1,
    )],
  };
}

function scorerDiagnostics({
  shortlist,
  results,
  baselineObjectives,
  objectiveSet,
  cheapParetoKeys,
  pobCalls,
  minimumSample = DEFAULT_MINIMUM_SAMPLE,
}) {
  const cheapByKey = new Map(shortlist.map((entry) => [entry.canonicalKey, entry]));
  const successful = results
    .filter((entry) => entry.status === "success" && cheapByKey.has(entry.canonicalKey))
    .map((entry) => objectiveEvidence({
      ...entry,
      cheapRankScore: Number(cheapByKey.get(entry.canonicalKey).rankScore || 0),
      cheapPruned: Boolean(cheapByKey.get(entry.canonicalKey).cheapPruned),
      calibrationKind: cheapByKey.get(entry.canonicalKey).calibrationKind,
      structuralBucket: structuralBucket(cheapByKey.get(entry.canonicalKey)),
    }, baselineObjectives, objectiveSet))
    .filter((entry) => Number.isFinite(entry.normalizedUtility));
  const scorerPairs = successful.filter(
    (entry) => entry.calibrationKind !== "baseline",
  );
  const rankCorrelation = spearmanCorrelation(
    scorerPairs,
    (entry) => entry.cheapRankScore,
    (entry) => entry.normalizedUtility,
  );
  const rankCorrelationInterval = bootstrapInterval(
    scorerPairs,
    (sample) => spearmanCorrelation(
      sample,
      (entry) => entry.cheapRankScore,
      (entry) => entry.normalizedUtility,
    ),
  );
  const topK = Math.min(5, scorerPairs.length);
  const cheapTop = [...scorerPairs].sort(
    (left, right) =>
      right.cheapRankScore - left.cheapRankScore ||
      left.canonicalKey.localeCompare(right.canonicalKey),
  );
  const realTop = [...scorerPairs].sort(
    (left, right) =>
      right.normalizedUtility - left.normalizedUtility ||
      left.canonicalKey.localeCompare(right.canonicalKey),
  );
  const realTopKeys = new Set(realTop.slice(0, topK).map((entry) => entry.canonicalKey));
  const recalled = cheapTop.slice(0, topK).filter(
    (entry) => realTopKeys.has(entry.canonicalKey),
  ).length;
  const bestReal = realTop[0]?.normalizedUtility ?? null;
  const cheapBestReal = cheapTop[0]?.normalizedUtility ?? null;
  const cheapPareto = new Set(cheapParetoKeys);
  const improvements = scorerPairs.filter(
    (entry) => entry.baselineComparison === "dominates_baseline",
  );
  const regressions = scorerPairs.filter(
    (entry) => entry.baselineComparison === "dominated_by_baseline",
  );
  const tradeoffs = scorerPairs.filter(
    (entry) => entry.baselineComparison === "tradeoff",
  );
  const auditedCheapPruned = scorerPairs.filter(
    (entry) => entry.cheapPruned || !cheapPareto.has(entry.canonicalKey),
  );
  const falseNegatives = auditedCheapPruned.filter(
    (entry) =>
      entry.baselineComparison === "dominates_baseline" ||
      entry.normalizedUtility > 0,
  );
  const firstImprovement = improvements
    .map((entry) => finiteNumber(entry.completedOffsetMs))
    .filter((value) => value !== null)
    .sort((left, right) => left - right)[0] ?? null;
  const warnings = [];
  if (scorerPairs.length < minimumSample) {
    warnings.push({
      code: "MINIMUM_SAMPLE_NOT_MET",
      observed: scorerPairs.length,
      required: minimumSample,
      message:
        "Scorer diagnostics are descriptive only until the minimum sample is met.",
    });
  }
  if (auditedCheapPruned.length < minimumSample) {
    warnings.push({
      code: "CHEAP_PRUNED_AUDIT_SAMPLE_LOW",
      observed: auditedCheapPruned.length,
      required: minimumSample,
      message:
        "The cheap-pruned false-negative rate is too uncertain for threshold changes.",
    });
  }
  const roleBuckets = new Set(scorerPairs.map((entry) => entry.structuralBucket));
  const nearBaseline = scorerPairs.filter(
    (entry) => entry.calibrationKind === "near-baseline",
  );
  let limitation = "candidate_generation_failure";
  if (scorerPairs.length < minimumSample) {
    limitation = "insufficient_sample";
  } else if (
    falseNegatives.length > 0 ||
    (rankCorrelationInterval && rankCorrelationInterval.high < 0.25) ||
    (topK >= 3 && recalled / topK < 0.5)
  ) {
    limitation = "scorer_failure";
  } else if (
    improvements.length === 0 &&
    nearBaseline.length >= 2 &&
    roleBuckets.size >= 3 &&
    auditedCheapPruned.length >= Math.min(minimumSample, 4)
  ) {
    limitation = "current_tree_locally_strong";
  }
  return {
    evaluatedPairs: scorerPairs.length,
    cheapVsPobSpearman: rankCorrelation,
    cheapVsPobSpearmanConfidenceInterval: rankCorrelationInterval,
    topK,
    topKRecall: topK > 0 ? recalled / topK : null,
    topKRecallConfidenceInterval: wilsonInterval(recalled, topK),
    regret: bestReal === null || cheapBestReal === null
      ? null
      : bestReal - cheapBestReal,
    falseNegativePruning: {
      count: falseNegatives.length,
      canonicalKeys: falseNegatives.map((entry) => entry.canonicalKey).sort(),
      audited: auditedCheapPruned.length,
      rate: auditedCheapPruned.length
        ? falseNegatives.length / auditedCheapPruned.length
        : null,
      confidenceInterval: wilsonInterval(
        falseNegatives.length,
        auditedCheapPruned.length,
      ),
    },
    realImprovements: improvements.length,
    realRegressions: regressions.length,
    realTradeoffs: tradeoffs.length,
    baselineDominance: {
      candidateDominatesBaseline: improvements.length,
      baselineDominatesCandidate: regressions.length,
      tradeoffs: tradeoffs.length,
      equal: scorerPairs.length -
        improvements.length -
        regressions.length -
        tradeoffs.length,
    },
    calibrationCoverage: {
      nearBaseline: nearBaseline.length,
      structuralRoleBuckets: [...roleBuckets].sort(),
      cheapPrunedAudited: auditedCheapPruned.length,
    },
    improvementPerPobCall: pobCalls > 0 ? improvements.length / pobCalls : null,
    bestNormalizedImprovementPerPobCall:
      pobCalls > 0 && bestReal !== null ? Math.max(0, bestReal) / pobCalls : null,
    timeToFirstRealImprovementMs: firstImprovement,
    minimumSample,
    warnings,
    limitationDiagnosis: {
      primary: limitation,
      evidence: {
        evaluatedPairs: scorerPairs.length,
        nearBaseline: nearBaseline.length,
        structuralRoleBuckets: roleBuckets.size,
        cheapPrunedAudited: auditedCheapPruned.length,
        falseNegatives: falseNegatives.length,
        realImprovements: improvements.length,
      },
    },
  };
}

function representativeRealPareto(results, objectiveSet, baselineObjectives) {
  const candidates = results
    .filter((entry) =>
      entry.status === "success" &&
      (entry.calibrationKind || entry.candidateSummary?.calibrationKind) !==
        "baseline")
    .map((entry) => objectiveEvidence(
      entry,
      baselineObjectives,
      objectiveSet,
    ));
  const labels = new Map();
  function labelWinner(label, selector, why) {
    const winner = [...candidates].sort(
      (left, right) =>
        selector(right) - selector(left) ||
        left.canonicalKey.localeCompare(right.canonicalKey),
    )[0];
    if (!winner) return;
    if (!labels.has(winner.canonicalKey)) labels.set(winner.canonicalKey, []);
    labels.get(winner.canonicalKey).push({ label, why: why(winner) });
  }
  function roleScore(entry, pattern) {
    return objectiveSet.objectives
      .filter((objective) => pattern.test(objective.role || objective.name))
      .reduce((sum, objective) =>
        sum + Number(entry.objectiveDeltas[objective.name]?.directional || 0) /
          Math.max(
            1,
            Math.abs(Number(entry.objectiveDeltas[objective.name]?.baseline || 0)),
          ),
      0);
  }
  labelWinner(
    "damage",
    (entry) => roleScore(entry, /damage/i),
    () => "Best measured configured damage package.",
  );
  labelWinner(
    "balanced",
    (entry) => entry.normalizedUtility,
    () => "Best aggregate measured objective delta.",
  );
  labelWinner(
    "tanky",
    (entry) => roleScore(entry, /defense|life|ehp|max.?hit/i),
    () => "Best measured life, EHP, and maximum-hit package.",
  );
  labelWinner(
    "accuracy_recovery_fix",
    (entry) => roleScore(entry, /accuracy|recovery|leech/i),
    () => "Best measured accuracy and recovery correction.",
  );
  labelWinner(
    "low_respec",
    (entry) => -Number(
      entry.candidateSummary?.respecCost ??
      entry.objectives?.respec_cost ??
      Infinity,
    ),
    () => "Lowest measured respec-cost alternative.",
  );
  labelWinner(
    "experimental_totem",
    (entry) =>
      roleScore(entry, /totem|ballista|placement/i) +
      Number(entry.candidateSummary?.uncertainty || 0) * 0.001,
    () => "Most interesting measured Ballista/totem experiment.",
  );
  return candidates
    .filter((entry) => labels.has(entry.canonicalKey))
    .map((entry) => ({
      ...entry,
      representativeLabels: labels.get(entry.canonicalKey)
        .map((label) => label.label),
      whyInteresting: labels.get(entry.canonicalKey),
    }))
    .sort((left, right) =>
      left.canonicalKey.localeCompare(right.canonicalKey),
    );
}

function classifyFailure(error) {
  const message = error?.message || String(error);
  return {
    status: /timed out|timeout/i.test(message) ? "timeout" : "failure",
    error: message,
  };
}

async function evaluateSelectiveCandidates({
  buildPath,
  shortlist,
  objectiveSet: objectiveInput,
  enemyProfile,
  treeData,
  currentRuntime,
  runtimeMeta,
  clientFactory,
  evaluationLimit = 10,
  runtimeLimitMs,
  batchSize = 4,
  selectionMix,
  seed = 0,
  cachePath,
  checkpointPath,
  resume = false,
  nearBaselineCount = DEFAULT_NEAR_BASELINE_COUNT,
  minimumSample,
}) {
  const objectiveSet = normalizeObjectiveSet(objectiveInput);
  if (objectiveSet.objectives.length === 0) {
    throw new Error("Selective PoB evaluation requires at least one objective");
  }
  const wallStarted = performance.now();
  const xml = fs.readFileSync(buildPath, "utf8");
  const buildHash = sha256(xml);
  const runtime = runtimeMeta || resolveRuntime(currentRuntime);
  const makeClient = clientFactory || ((meta) => new PobClient(meta));
  const calibrationMode = shortlist.some((entry) =>
    entry.calibrationKind || entry.cheapPruned);
  const selection = calibrationMode
    ? selectCalibrationCandidates({
        shortlist,
        limit: evaluationLimit,
        mix: selectionMix,
        seed,
        nearBaselineCount,
      })
    : selectPobCandidates({
        shortlist,
        limit: evaluationLimit,
        mix: selectionMix,
        seed,
      });
  const baselineEntry = shortlist.find((entry) =>
    entry.calibrationKind === "baseline" ||
    Number(entry.changedNodeCount || 0) === 0) || {
    ...shortlist[0],
    calibrationKind: "baseline-reference",
    changedNodeCount: 0,
    delta: { addNodeIds: [], removeNodeIds: [] },
    costs: { marginal: { add: 0, remove: 0 }, respec: 0 },
    objectives: { ...(shortlist[0]?.objectives || {}), respecCost: 0 },
  };
  const baselineCandidate = baselineEntry?.candidate;
  if (!baselineCandidate) {
    throw new Error("Selective PoB evaluation requires a non-empty shortlist");
  }
  let client = null;
  let baseline = null;
  let baselineStats = null;
  let startupMs = 0;
  let startupCount = 0;
  async function startClient() {
    const started = performance.now();
    client = makeClient(runtime);
    await client.ready();
    await client.loadXml(xml, "PoE2 Forge Selective Baseline");
    const snapshot = await observableSnapshot(client);
    startupMs += performance.now() - started;
    startupCount += 1;
    if (!baseline) {
      baseline = snapshot;
    } else if (stableStringify(snapshot) !== stableStringify(baseline)) {
      throw new Error("Baseline changed while restarting the PoB client");
    }
  }
  async function closeClient() {
    if (!client) return;
    try {
      await client.close();
    } finally {
      client = null;
    }
  }
  await startClient();
  const baselineMetricReport = await extractObjectives({
    client,
    skills: baseline.skills,
    objectiveSet,
    entry: baselineEntry,
  });
  baselineStats = baselineMetricReport.metrics;
  if (baselineMetricReport.missingRequired.length) {
    await closeClient();
    throw new Error(
      "Baseline is missing required objectives: " +
        baselineMetricReport.missingRequired.join(", "),
    );
  }
  const jobs = selection.selected.map((entry) => {
    const scoring = {
      scorerVersion: entry.scorerVersion ?? null,
      buildProfileSchemaVersion: entry.buildProfileSchemaVersion ?? null,
      profileVersion: entry.profileVersion ?? null,
      profileId: entry.profileId ?? null,
      cheapRankScore: entry.rankScore ?? null,
    };
    const cacheIdentity = completeCacheIdentity({
      candidate: entry.candidate,
      scoring,
      buildHash,
      baseline,
      runtime,
      objectiveSet,
      enemyProfile,
      treeData,
    });
    return {
      canonicalKey: entry.canonicalKey,
      candidate: entry.candidate,
      entry,
      scoring,
      selectionReasons: entry.selectionReasons,
      cheapRankScore: entry.rankScore,
      cacheIdentity,
      jobId: sha256(stableStringify(cacheIdentity)),
    };
  });
  const runKey = sha256(stableStringify({
    version: SELECTIVE_EVALUATION_VERSION,
    buildHash,
    objectiveSet,
    enemyProfile,
    treeData,
    runtime: runtimeIdentity(runtime),
    jobs: jobs.map((job) => job.jobId),
  }));
  const cache = readStore(cachePath, CACHE_SCHEMA_VERSION);
  let checkpoint = {
    schemaVersion: CHECKPOINT_SCHEMA_VERSION,
    entries: {},
    runKey,
    jobs: jobs.map((job) => ({
      jobId: job.jobId,
      canonicalKey: job.canonicalKey,
      selectionReasons: job.selectionReasons,
    })),
  };
  if (resume && checkpointPath && fs.existsSync(checkpointPath)) {
    const parsed = JSON.parse(fs.readFileSync(checkpointPath, "utf8"));
    if (
      parsed.schemaVersion !== CHECKPOINT_SCHEMA_VERSION ||
      parsed.runKey !== runKey
    ) {
      await closeClient();
      throw new Error("Checkpoint does not match this deterministic evaluation job");
    }
    checkpoint = parsed;
  }
  const results = [];
  const batchTimes = [];
  let cacheHits = 0;
  let resumed = 0;
  let pobCalls = 0;
  let runtimeLimited = false;
  let evaluationLimited = false;
  const evaluationBudget = Math.max(0, Math.floor(Number(evaluationLimit) || 0));
  const perBatch = Math.max(1, Math.floor(Number(batchSize) || 1));
  for (let offset = 0; offset < jobs.length; offset += perBatch) {
    const batchStarted = performance.now();
    for (const job of jobs.slice(offset, offset + perBatch)) {
      if (
        Number.isFinite(Number(runtimeLimitMs)) &&
        performance.now() - wallStarted >= Number(runtimeLimitMs)
      ) {
        runtimeLimited = true;
        break;
      }
      if (checkpoint.entries?.[job.jobId]) {
        results.push({ ...checkpoint.entries[job.jobId], source: "checkpoint" });
        resumed += 1;
        continue;
      }
      if (cache.entries[job.jobId]) {
        const result = { ...cache.entries[job.jobId], source: "cache", cached: true };
        results.push(result);
        checkpoint.entries[job.jobId] = cache.entries[job.jobId];
        cacheHits += 1;
        continue;
      }
      if (pobCalls >= evaluationBudget) {
        evaluationLimited = true;
        break;
      }
      const candidateSummary = {
        calibrationKind: job.entry.calibrationKind || "candidate",
        cheapPruned: Boolean(job.entry.cheapPruned),
        cheapRank: job.entry.cheapRank ?? null,
        structuralBucket:
          job.entry.structuralBucket || structuralBucket(job.entry),
        families: job.entry.families || [],
        changedNodeCount: Number(job.entry.changedNodeCount || 0),
        addedNodeIds: job.entry.delta?.addNodeIds || [],
        removedNodeIds: job.entry.delta?.removeNodeIds || [],
        addedPackageIds: (job.entry.moveHistory || [])
          .flatMap((move) => move.packageIds || [])
          .filter(Boolean),
        respecCost:
          job.entry.objectives?.respecCost ??
          job.entry.costs?.respec ??
          job.entry.delta?.removeNodeIds?.length ??
          0,
        pointCost:
          job.entry.costs?.marginal?.add ??
          job.entry.delta?.addNodeIds?.length ??
          0,
        uncertainty:
          job.entry.objectives?.uncertainty ??
          Math.abs(Number(job.entry.components?.uncertainty || 0)),
        scorerVersion: job.scoring.scorerVersion,
        profileVersion: job.scoring.profileVersion,
      };
      if (candidateSummary.calibrationKind === "baseline") {
        const result = {
          jobId: job.jobId,
          cacheKey: job.jobId,
          canonicalKey: job.canonicalKey,
          selectionReasons: job.selectionReasons,
          accepted: true,
          cached: false,
          status: "success",
          metrics: baselineStats,
          objectives: baselineMetricReport.metrics,
          objectiveSources: baselineMetricReport.objectiveSources,
          unavailableOptional:
            baselineMetricReport.unavailableOptional,
          candidateSummary,
          drift: [],
          parity: { exact: true, baseline: true },
          error: null,
          completedOffsetMs: performance.now() - wallStarted,
          source: "baseline",
        };
        cache.entries[job.jobId] = result;
        checkpoint.entries[job.jobId] = result;
        results.push(result);
        writeJsonAtomic(cachePath, cache);
        continue;
      }
      if (!client) await startClient();
      pobCalls += 1;
      const result = {
        jobId: job.jobId,
        cacheKey: job.jobId,
        canonicalKey: job.canonicalKey,
        selectionReasons: job.selectionReasons,
        accepted: false,
        cached: false,
        status: "failure",
        metrics: null,
        objectives: null,
        objectiveSources: null,
        unavailableOptional: [],
        candidateSummary,
        drift: [],
        parity: { exact: false },
        error: null,
        completedOffsetMs: null,
      };
      let clientUsable = true;
      try {
        await client.loadXml(xml, "PoE2 Forge Candidate Baseline");
        const reloadedBaseline = await observableSnapshot(client);
        if (stableStringify(reloadedBaseline) !== stableStringify(baseline)) {
          result.status = "drift";
          result.drift = [{
            field: "baseline",
            before: baseline,
            after: reloadedBaseline,
          }];
        } else {
          await client.call("set_tree", treeParams(job.candidate));
          const accepted = await observableSnapshot(client);
          result.parity = parity(job.candidate, accepted.tree);
          result.drift = drift(baseline, accepted);
          if (!result.parity.exact || result.drift.length) {
            result.status = "drift";
          } else {
            const measured = await extractObjectives({
              client,
              skills: baseline.skills,
              objectiveSet,
              entry: job.entry,
            });
            result.metrics = measured.metrics;
            result.objectives = measured.metrics;
            result.objectiveSources = measured.objectiveSources;
            result.unavailableOptional = measured.unavailableOptional;
            if (measured.missingRequired.length) {
              result.status = "failure";
              result.error =
                "Missing required objectives: " +
                measured.missingRequired.join(", ");
            } else {
              result.status = "success";
              result.accepted = true;
            }
          }
        }
      } catch (error) {
        Object.assign(result, classifyFailure(error));
        clientUsable = result.status !== "timeout";
      } finally {
        result.completedOffsetMs = performance.now() - wallStarted;
        if (clientUsable && client) {
          try {
            await client.loadXml(xml, "PoE2 Forge Candidate Restore");
            const restored = await observableSnapshot(client);
            if (stableStringify(restored) !== stableStringify(baseline)) {
              result.accepted = false;
              result.status = "drift";
              result.drift.push({
                field: "restore",
                before: baseline,
                after: restored,
              });
            }
          } catch (error) {
            result.accepted = false;
            Object.assign(result, classifyFailure(error));
            clientUsable = false;
          }
        }
        if (!clientUsable) await closeClient();
      }
      cache.entries[job.jobId] = result;
      checkpoint.entries[job.jobId] = result;
      results.push(result);
      writeJsonAtomic(cachePath, cache);
    }
    batchTimes.push(performance.now() - batchStarted);
    checkpoint.updatedAt = new Date().toISOString();
    writeJsonAtomic(checkpointPath, checkpoint);
    if (runtimeLimited || evaluationLimited) break;
  }
  let finalBaselineRestored = false;
  let finalBaselineError = null;
  try {
    if (!client) await startClient();
    await client.loadXml(xml, "PoE2 Forge Final Baseline Restore");
    const finalBaseline = await observableSnapshot(client);
    finalBaselineRestored =
      stableStringify(finalBaseline) === stableStringify(baseline);
    if (!finalBaselineRestored) finalBaselineError = "Final baseline mismatch";
  } catch (error) {
    finalBaselineError = error.message;
  } finally {
    await closeClient();
  }
  const buildUnchanged = sha256(fs.readFileSync(buildPath)) === buildHash;
  const realArchive = realParetoArchive(results, objectiveSet);
  const evidenceResults = results.map((entry) =>
    entry.status === "success"
      ? objectiveEvidence(
          entry,
          baselineMetricReport.metrics,
          objectiveSet,
        )
      : entry);
  const diagnostics = scorerDiagnostics({
    shortlist,
    results: evidenceResults,
    baselineObjectives: baselineMetricReport.metrics,
    objectiveSet,
    cheapParetoKeys: selection.cheapParetoKeys,
    pobCalls,
    minimumSample:
      Math.max(
        2,
        Number(minimumSample || objectiveSet.minimumSample),
      ),
  });
  const representatives = representativeRealPareto(
    evidenceResults,
    objectiveSet,
    baselineMetricReport.metrics,
  );
  const elapsedMs = performance.now() - wallStarted;
  return {
    selectiveEvaluationVersion: SELECTIVE_EVALUATION_VERSION,
    objectiveExtractorVersion: OBJECTIVE_EXTRACTOR_VERSION,
    objectiveSet,
    buildHash,
    runtime: runtimeIdentity(runtime),
    selection: {
      limit: selection.limit,
      mix: selection.mix,
      allocation: selection.allocation,
      mandatory: selection.mandatory || null,
      selected: selection.selected.map((entry) => ({
        canonicalKey: entry.canonicalKey,
        selectionReasons: entry.selectionReasons,
        selectionOrder: entry.selectionOrder,
        calibrationKind: entry.calibrationKind || "candidate",
        cheapPruned: Boolean(entry.cheapPruned),
        structuralBucket: entry.structuralBucket || structuralBucket(entry),
      })),
    },
    budget: {
      evaluationLimit: evaluationBudget,
      runtimeLimitMs: Number.isFinite(Number(runtimeLimitMs))
        ? Number(runtimeLimitMs)
        : null,
      pobCalls,
      usedFraction: evaluationBudget > 0 ? pobCalls / evaluationBudget : 0,
      evaluationLimited,
      runtimeLimited,
    },
    timing: {
      startupMs,
      startupCount,
      batchMs: batchTimes,
      wallMs: elapsedMs,
    },
    baseline: {
      objectives: baselineMetricReport.metrics,
      objectiveSources: baselineMetricReport.objectiveSources,
      unavailableOptional: baselineMetricReport.unavailableOptional,
      finalBaselineRestored,
      finalBaselineError,
      buildUnchanged,
    },
    checked: results.length,
    accepted: results.filter((entry) => entry.status === "success").length,
    rejected: results.filter((entry) => entry.status !== "success").length,
    failures: results.filter((entry) => entry.status === "failure").length,
    timeouts: results.filter((entry) => entry.status === "timeout").length,
    drifted: results.filter((entry) => entry.status === "drift").length,
    cacheHits,
    resumed,
    runtimeLimited,
    results: evidenceResults,
    cheapArchive: {
      kind: "cheap",
      canonicalKeys: selection.cheapParetoKeys,
    },
    realArchive: {
      kind: "real-pob",
      candidates: realArchive,
      representatives,
    },
    diagnostics,
    userReport: {
      baseline: baselineMetricReport.metrics,
      realImprovements: diagnostics.realImprovements,
      realRegressions: diagnostics.realRegressions,
      realTradeoffs: diagnostics.realTradeoffs,
      noImprovementFound: diagnostics.realImprovements === 0,
      limitationDiagnosis: diagnostics.limitationDiagnosis,
      warnings: diagnostics.warnings,
      representatives: representatives.map((entry) => ({
        labels: entry.representativeLabels,
        whyInteresting: entry.whyInteresting,
        canonicalKey: entry.canonicalKey,
        baselineComparison: entry.baselineComparison,
        objectiveDeltas: entry.objectiveDeltas,
        addedPackageIds: entry.candidateSummary?.addedPackageIds || [],
        addedNodeIds: entry.candidateSummary?.addedNodeIds || [],
        removedNodeIds: entry.candidateSummary?.removedNodeIds || [],
        pointCost: entry.candidateSummary?.pointCost ?? null,
        respecCost: entry.candidateSummary?.respecCost ?? null,
        uncertainty: entry.candidateSummary?.uncertainty ?? null,
      })),
    },
    checkpoint: checkpointPath || null,
    cache: cachePath || null,
    note:
      "Cheap and real-PoB Pareto archives are independent; only exact successful PoB measurements enter the real archive.",
  };
}

module.exports = {
  CACHE_SCHEMA_VERSION,
  CHECKPOINT_SCHEMA_VERSION,
  DEFAULT_MINIMUM_SAMPLE,
  DEFAULT_NEAR_BASELINE_COUNT,
  DEFAULT_SELECTION_MIX,
  OBJECTIVE_EXTRACTOR_VERSION,
  SELECTIVE_EVALUATION_VERSION,
  allocateSelectionCounts,
  cacheKeyFor,
  completeCacheIdentity,
  evaluateSelectiveCandidates,
  extractObjectives,
  normalizeObjectiveSet,
  normalizeSelectionMix,
  parseObjectiveSpec,
  realDominates,
  realParetoArchive,
  representativeRealPareto,
  scorerDiagnostics,
  selectCalibrationCandidates,
  selectPobCandidates,
  wilsonInterval,
};
