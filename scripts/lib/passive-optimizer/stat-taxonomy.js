"use strict";

const { sortedObject } = require("./stable");

const STAT_TAXONOMY_VERSION = 2;

const RULES = [
  ["damage.global", /\b(global )?(increased|more|reduced|less) damage\b/i],
  ["damage.attack", /\battack damage\b/i],
  ["damage.projectile", /\bprojectile damage\b/i],
  ["damage.weapon", /\b(weapon|with (?:a |an )?\w+ weapon)s? damage\b/i],
  ["damage.crossbow", /\bcrossbow damage\b/i],
  ["damage.totem", /\btotems?.*(damage)|damage.*totems?\b/i],
  ["attack.speed", /\battack speed\b/i],
  ["attack.reload", /\breload(ing)? (speed|time)|reload faster\b/i],
  ["attack.projectile_count", /\b(additional|extra|\+\d+).*projectiles?\b/i],
  ["attack.projectile_speed", /\bprojectile speed\b/i],
  ["attack.ammo", /\bammo|bolts? loaded|clip size\b/i],
  ["totem.limit", /\bmaximum number of summoned totems?|totem limit\b/i],
  ["totem.placement", /\btotem placement speed\b/i],
  ["totem.duration", /\btotem duration\b/i],
  ["totem.life", /\btotem life\b/i],
  ["totem.resistance", /\btotem.*resistance|resistance.*totem\b/i],
  ["totem.damage", /\btotems?.*(damage)|damage.*totems?\b/i],
  ["totem.attack_speed", /\btotems?.*attack speed|attack speed.*totems?\b/i],
  ["totem.lifecycle", /\btotems?.*(death|die|expire|expiry)|(?:death|expire|expiry).*totems?\b/i],
  ["defense.life", /\bmaximum life\b|\bto life\b|\blife regeneration\b/i],
  ["defense.armour", /\barmou?r\b/i],
  ["defense.evasion", /\bevasion\b/i],
  ["defense.resist", /\bresistance|resistances\b/i],
  ["defense.damage_taken", /\bdamage taken\b/i],
  ["defense.avoidance", /\bavoid|avoidance|block chance|dodge\b/i],
  ["accuracy", /\baccuracy\b/i],
  ["recovery.regen", /\bregenerat|regeneration\b/i],
  ["recovery.leech", /\bleech\b/i],
  ["recovery.life_on_hit", /\blife.*on hit|on hit.*life\b/i],
  ["recovery.recoup", /\brecoup\b/i],
  ["mobility", /\bmovement speed|move speed|dash|roll distance\b/i],
  ["resources.attributes", /\bstrength|dexterity|intelligence|attributes?\b/i],
  ["resources.spirit", /\bspirit\b/i],
  ["resources.mana", /\bmana\b/i],
  ["resources.reservation", /\breservation|reserve\b/i],
  ["resources.requirements", /\brequirements?\b/i],
  ["role.offensive", /\bdamage|attack speed|projectile|critical|penetration\b/i],
  ["role.defensive", /\bmaximum life\b|\bto life\b|\blife regeneration\b|armou?r|evasion|resistance|damage taken|avoid\b/i],
  ["role.accuracy", /\baccuracy\b/i],
  ["role.recovery", /\bregenerat|leech|life.*on hit|recoup\b/i],
  ["role.mobility", /\bmovement speed|move speed|dash|roll distance\b/i],
  ["role.totem", /\btotems?\b/i],
  ["role.crossbow", /\bcrossbow|bolt|ammo|reload\b/i],
  ["role.projectile", /\bprojectiles?\b/i],
  ["role.grenade", /\bgrenades?\b/i],
  ["damage.grenade", /\bgrenades?.*damage|damage.*grenades?\b/i],
  ["mechanic.grenade", /\bgrenades?\b/i],
  ["mechanic.self-curse", /\bcurse effect on you|curses? on you|self[- ]curse\b/i],
  ["mechanic.spell", /\bspell\b/i],
  ["mechanic.minion", /\bminions?\b/i],
];

const HIGH_UNCERTAINTY = [
  ["conditional", /\bif\b|\bwhile\b|\bwhen\b|\bon\b.*\bhit\b|\brecently\b/i],
  ["conversion", /\bconvert|converted|gain.*as extra\b/i],
  ["keystone", /\bkeystone\b/i],
  ["jewel", /\bjewel|radius\b/i],
  ["switchable", /\bswitch|choose|selected|stance\b/i],
  ["threshold", /\bper \d+|for every|at least|nearby allocated\b/i],
  ["totem_lifecycle", /\btotems?.*(death|die|expire|expiry)|(?:death|expire|expiry).*totems?\b/i],
];

function numericMagnitude(line) {
  const values = [...String(line).matchAll(/[-+]?\d+(?:\.\d+)?/g)].map(
    (match) => Math.abs(Number(match[0])),
  );
  return values.length ? Math.max(...values) : 1;
}

function searchableText(raw) {
  return String(raw)
    .replace(/\[([^\]|]+)\|([^\]]+)\]/g, "$2")
    .replace(/\[([^\]]+)\]/g, "$1")
    .replace(/<[^>]+>\{([^}]+)\}/g, "$1");
}

function parseStatLine(rawLine, context = {}) {
  const raw = String(rawLine ?? "");
  const text = searchableText(raw);
  const tags = RULES.filter(([, pattern]) => pattern.test(text)).map(
    ([tag]) => tag,
  );
  const uncertaintyReasons = HIGH_UNCERTAINTY.filter(([, pattern]) =>
    pattern.test(text),
  ).map(([reason]) => reason);
  if (context.isKeystone) uncertaintyReasons.push("keystone");
  if (context.isJewelSocket) uncertaintyReasons.push("jewel");
  if (context.isSwitchable || context.isMultipleChoice) {
    uncertaintyReasons.push("switchable");
  }
  const uniqueReasons = [...new Set(uncertaintyReasons)].sort();
  const unknown = tags.length === 0;
  return {
    raw,
    text,
    normalizedTags: [...new Set(tags)].sort(),
    magnitude: numericMagnitude(raw),
    known: !unknown,
    uncertainty: unknown || uniqueReasons.length ? "high" : "low",
    needsPoB: unknown || uniqueReasons.length > 0,
    reasonCodes: [
      ...(unknown ? ["UNKNOWN_STAT_LINE"] : []),
      ...uniqueReasons.map((reason) => `UNCERTAIN_${reason.toUpperCase()}`),
    ].sort(),
  };
}

function parseStatLines(lines, context = {}) {
  const parsed = (lines || []).map((line) => parseStatLine(line, context));
  const normalizedTags = [
    ...new Set(parsed.flatMap((entry) => entry.normalizedTags)),
  ].sort();
  const unknownLines = parsed
    .filter((entry) => !entry.known)
    .map((entry) => entry.raw);
  const reasonCodes = [
    ...new Set(parsed.flatMap((entry) => entry.reasonCodes)),
  ].sort();
  const tagMagnitudes = {};
  for (const entry of parsed) {
    for (const tag of entry.normalizedTags) {
      tagMagnitudes[tag] = (tagMagnitudes[tag] || 0) + entry.magnitude;
    }
  }
  return {
    taxonomyVersion: STAT_TAXONOMY_VERSION,
    rawLines: parsed.map((entry) => entry.raw),
    parsed,
    normalizedTags,
    tagMagnitudes: sortedObject(tagMagnitudes, Number),
    unknownLines,
    uncertainty: parsed.some((entry) => entry.uncertainty === "high")
      ? "high"
      : "low",
    needsPoB: parsed.some((entry) => entry.needsPoB),
    reasonCodes,
  };
}

module.exports = {
  STAT_TAXONOMY_VERSION,
  parseStatLine,
  parseStatLines,
};
