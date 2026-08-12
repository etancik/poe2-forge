"use strict";

const MAX_PACKET_BYTES = 2600;

function round(value) {
  return typeof value === "number" && Number.isFinite(value)
    ? Number(value.toFixed(2))
    : value;
}

function clip(value, depth = 0) {
  if (value == null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") {
    return value.length > 220 ? `${value.slice(0, 217)}...` : value;
  }
  if (depth >= 5) return "[details omitted]";
  if (Array.isArray(value)) return value.slice(0, 3).map((item) => clip(item, depth + 1));
  return Object.fromEntries(
    Object.entries(value).slice(0, 16).map(([key, item]) => [key, clip(item, depth + 1)]),
  );
}

function correctedFields(value) {
  return (value.correctedSavedFields || []).map((entry) => entry.field).slice(0, 8);
}

function packetFor(command, value, options = {}) {
  if (value?.requiresInput || value?.requiresApproval || value?.ok === false) return clip(value);
  if (command === "refresh") {
    const packet = {
      ok: value.ok,
      run: value.snapshot || value.build?.hash || null,
      changed: value.changed,
      build: value.build,
      scenarioValid: value.scenarioValid,
      scenario: value.scenario,
      correctedSavedFields: correctedFields(value),
      delta: value.delta || undefined,
      artifact: value.artifact,
    };
    if (["gear", "survival"].includes(options.purpose)) {
      packet.itemCompletion = value.itemCompletion;
    }
    return packet;
  }
  if (command === "inspect") {
    return {
      ok: value.ok,
      build: value.build,
      scenarioValid: value.scenarioValid,
      scenario: value.scenario,
      correctedSavedFields: correctedFields(value),
      stats: value.stats,
      tree: value.tree,
      items: value.items,
      skills: value.skills,
      runtime: value.runtime,
    };
  }
  if (command === "tree") {
    const node = (entry) => entry && ({
      id: entry.id,
      name: entry.name,
      cost: entry.cost,
      stats: entry.stats,
    });
    return {
      ok: true,
      allocated: value.currentNodeCount,
      removableLeaves: (value.removableLeaves || []).slice(0, 3).map(node),
      candidates: (value.candidates || []).slice(0, 3).map(node),
      omittedCandidates: value.omittedCandidates,
      artifact: value.output,
    };
  }
  if (command === "items") {
    return {
      ok: true,
      needs: (value.needs || []).slice(0, 5),
      opportunities: (value.opportunities || []).slice(0, 3).map((entry) => ({
        slot: entry.slot,
        item: entry.item,
        existingEmptySockets: entry.existingEmptySockets,
        creatableSockets: entry.creatableSockets,
        quality: entry.quality,
        qualityOpportunity: entry.qualityOpportunity,
        corrupted: entry.corrupted,
        runeRecommendations: (entry.runeRecommendations || []).slice(0, 2),
        replacementHorizon: entry.replacementHorizon,
      })),
      omittedOpportunities: value.omittedOpportunities,
      artifact: value.output,
    };
  }
  if (command === "experiment") {
    return {
      ok: value.ok,
      name: value.name,
      budget: value.budget,
      variantCount: value.variantCount,
      scenarioValid: value.scenarioValid,
      baseline: value.baseline,
      candidates: (value.top || []).slice(0, 3).map((entry) => ({
        id: entry.id,
        valid: entry.valid,
        deltaPercent: entry.deltaPercent,
      })),
      omittedCandidates: value.omittedFromStdout,
      artifact: value.output,
    };
  }
  if (command === "passive" && value.pareto) {
    return {
      ok: true,
      stage: value.stage,
      run: value.baselineRef,
      counts: value.counts && {
        generated: value.counts.generated,
        retained: value.counts.retained,
        pobCalls: value.counts.pobCalls,
        failures: value.counts.failures,
        drift: value.counts.drift,
      },
      candidates: value.pareto.slice(0, 3).map((entry) => ({
        id: entry.candidateId,
        roles: entry.roles,
        add: entry.added,
        remove: entry.removed,
        metrics: Object.fromEntries(
          Object.entries(entry.metrics || {}).slice(0, 6).map(
            ([key, metric]) => [key, round(metric)],
          ),
        ),
        cost: entry.cost,
        warnings: (entry.warnings || []).slice(0, 2),
      })),
      failures: (value.failures || []).slice(0, 3),
      nextGate: value.nextGate,
    };
  }
  return clip(value);
}

function stringifyPacket(command, value, options = {}) {
  let packet = packetFor(command, value, options);
  let output = `${JSON.stringify(packet)}\n`;
  if (Buffer.byteLength(output) <= MAX_PACKET_BYTES) return output;
  packet = {
    ok: packet.ok !== false,
    command,
    status: "packet-truncated",
    run: packet.run || null,
    artifact: packet.artifact || null,
    candidates: (packet.candidates || []).slice(0, 2).map((entry) => clip(entry)),
    availableFields: Object.keys(packet),
  };
  return `${JSON.stringify(packet)}\n`;
}

function parseJsonOutput(stdout) {
  const text = String(stdout || "").trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function compactError(command, stderr, stdout) {
  const text = `${stderr || ""}\n${stdout || ""}`.trim();
  const errorLine = text.split(/\r?\n/).find((line) => /Error:|failed|mismatch/i.test(line));
  return {
    ok: false,
    command,
    error: String(errorLine || text.split(/\r?\n/)[0] || "Subcommand failed")
      .replace(/^.*?Error:\s*/, ""),
  };
}

module.exports = {
  MAX_PACKET_BYTES,
  compactError,
  packetFor,
  parseJsonOutput,
  stringifyPacket,
};
