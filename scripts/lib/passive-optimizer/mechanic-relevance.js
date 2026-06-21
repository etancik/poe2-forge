"use strict";

const { parseStatLines } = require("./stat-taxonomy");

const PREFERENCE_STATES = Object.freeze([
  "required",
  "preferred",
  "allowed",
  "experimental",
  "planned",
  "inactive",
  "forbidden",
]);

const MECHANIC_PREFIXES = Object.freeze({
  grenade: ["mechanic.grenade", "damage.grenade", "role.grenade"],
  minion: ["mechanic.minion"],
  spell: ["mechanic.spell"],
  projectile: ["role.projectile", "damage.projectile"],
  crossbow: ["role.crossbow", "damage.crossbow", "attack.reload", "attack.ammo"],
  totem: ["role.totem", "totem.", "damage.totem"],
  "self-curse": ["mechanic.self-curse"],
});

function normalizePreferences(input = {}) {
  return Object.fromEntries(
    Object.entries(input)
      .map(([mechanic, state]) => [
        String(mechanic).toLowerCase(),
        String(state).toLowerCase(),
      ])
      .filter(([, state]) => PREFERENCE_STATES.includes(state))
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

function deriveActiveMechanics(skills = {}) {
  const names = (skills.groups || [])
    .filter((group) => group.enabled !== false)
    .flatMap((group) => [
      ...(group.skills || []),
      ...(group.gems || [])
        .filter((gem) => gem.enabled !== false && !gem.isSupport)
        .map((gem) => gem.name),
    ])
    .map((name) => String(name || "").toLowerCase());
  const active = new Set();
  const match = (pattern) => names.some((name) => pattern.test(name));
  if (match(/grenade/)) active.add("grenade");
  if (match(/minion|skeleton|zombie|spectre/)) active.add("minion");
  if (match(/\bspell\b/)) active.add("spell");
  if (match(/bolt|shot|round|projectile|crossbow|ballista/)) {
    active.add("projectile");
  }
  if (match(/crossbow|bolt|shot|round/)) active.add("crossbow");
  if (match(/ballista|totem/)) active.add("totem");
  if (match(/curse|hex/)) active.add("self-curse");
  return [...active].sort();
}

function mechanicForTag(tag) {
  return Object.entries(MECHANIC_PREFIXES)
    .find(([, prefixes]) =>
      prefixes.some((prefix) => tag === prefix || tag.startsWith(prefix)))?.[0] ||
    null;
}

function packageMechanics(pkg) {
  return [...new Set(
    (pkg.normalizedTags || pkg.stats?.normalizedTags || [])
      .map(mechanicForTag)
      .filter(Boolean),
  )].sort();
}

function relevanceForTags(tags, profile = {}, options = {}) {
  const mechanics = [...new Set(tags.map(mechanicForTag).filter(Boolean))];
  const preferences = normalizePreferences(profile.mechanicPreferences);
  const states = mechanics.map((mechanic) => ({
    mechanic,
    state: preferences[mechanic] || "allowed",
  }));
  const rejected = states.filter((entry) =>
    ["inactive", "forbidden"].includes(entry.state));
  const accepted = states.filter((entry) => !rejected.includes(entry));
  if (rejected.length && accepted.length === 0) {
    return {
      accepted: false,
      reason: "INACTIVE_MECHANIC_REJECTED",
      mechanics: states,
    };
  }
  if (accepted.some((entry) => entry.state === "planned")) {
    return { accepted: true, reason: "PLANNED_MECHANIC", mechanics: states };
  }
  if (accepted.some((entry) => entry.state === "experimental")) {
    return {
      accepted: true,
      reason: "EXPERIMENTAL_ALLOWED",
      mechanics: states,
    };
  }
  if (accepted.length || tags.length) {
    return { accepted: true, reason: "ACTIVE_MECHANIC", mechanics: states };
  }
  if (
    options.uncertain &&
    (
      Object.keys(normalizePreferences(profile.mechanicPreferences)).length === 0 ||
      profile.experimentalUnknown === true
    )
  ) {
    return {
      accepted: true,
      reason: "EXPERIMENTAL_ALLOWED",
      mechanics: states,
    };
  }
  return { accepted: false, reason: "NO_EXPLAINED_VALUE", mechanics: states };
}

function packageRelevance(pkg, profile = {}) {
  const tags = pkg.normalizedTags || pkg.stats?.normalizedTags || [];
  return relevanceForTags(tags, profile, {
    uncertain:
      Boolean(pkg.needsPoB) ||
      Boolean(pkg.stats?.unknownLines?.length) ||
      pkg.uncertainty === "high",
  });
}

function explainAddedNodes(graph, incumbent, candidate, profile = {}) {
  const before = new Set(incumbent.allocatedNodeIds);
  const allocated = new Set(candidate.allocatedNodeIds);
  return candidate.allocatedNodeIds
    .filter((id) => !before.has(id))
    .sort((a, b) => a - b)
    .map((id) => {
      const node = graph.nodes.get(id);
      const parsed = parseStatLines(node?.rawStats || [], {
        isKeystone: node?.isKeystone,
        isJewelSocket: node?.isJewelSocket,
        isSwitchable: node?.isSwitchable,
        isMultipleChoice: node?.isMultipleChoice,
      });
      const relevance = relevanceForTags(parsed.normalizedTags, profile, {
        uncertain: parsed.needsPoB && (node?.rawStats || []).length > 0,
      });
      const allocatedDegree = [...(node?.adjacency || [])]
        .filter((next) => allocated.has(next)).length;
      const connector =
        !relevance.accepted &&
        allocatedDegree >= 2 &&
        !node?.isNotable &&
        !node?.isKeystone;
      return {
        nodeId: id,
        name: node?.name || node?.rawName || `Node ${id}`,
        reason: connector ? "REQUIRED_CONNECTOR" : relevance.reason,
        accepted: connector || relevance.accepted,
        connector,
        tags: parsed.normalizedTags,
        stats: node?.rawStats || [],
        mechanics: relevance.mechanics,
      };
    });
}

module.exports = {
  MECHANIC_PREFIXES,
  PREFERENCE_STATES,
  deriveActiveMechanics,
  explainAddedNodes,
  normalizePreferences,
  packageMechanics,
  packageRelevance,
  relevanceForTags,
};
