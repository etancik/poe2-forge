"use strict";

function parseNodes(value) {
  return String(value || "")
    .split(",")
    .map(Number)
    .filter(Number.isFinite);
}

function applyPassiveDeltaToXml(xml, delta = {}) {
  const treeTag = xml.match(/<Tree\b[^>]*>/i)?.[0] || "";
  const activeSpec = Number(treeTag.match(/\bactiveSpec="(\d+)"/i)?.[1] || 1);
  let index = 0;
  let changed = false;
  const result = xml.replace(/<Spec\b[^>]*>[\s\S]*?<\/Spec>/gi, (block) => {
    index += 1;
    if (index !== activeSpec) return block;
    return block.replace(/(<Spec\b[^>]*\bnodes=")([^"]*)(")/i, (
      _match,
      prefix,
      nodesText,
      suffix,
    ) => {
      const nodes = new Set(parseNodes(nodesText));
      for (const nodeId of delta.removeNodes || []) nodes.delete(Number(nodeId));
      for (const nodeId of delta.addNodes || []) nodes.add(Number(nodeId));
      changed = true;
      return `${prefix}${[...nodes].sort((left, right) => left - right).join(",")}${suffix}`;
    });
  });
  if (!changed) throw new Error("Active Spec nodes attribute was not found");
  return result;
}

module.exports = { applyPassiveDeltaToXml, parseNodes };
