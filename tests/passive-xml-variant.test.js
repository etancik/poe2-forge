"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { applyPassiveDeltaToXml } = require("../scripts/lib/passive-xml-variant");

test("in-memory passive delta changes only active spec nodes", () => {
  const xml = '<Tree activeSpec="2"><Spec nodes="1,2"><AttributeOverride strNodes="2"/></Spec><Spec nodes="3,4"><AttributeOverride dexNodes="4"/></Spec></Tree>';
  const changed = applyPassiveDeltaToXml(xml, { addNodes: [5], removeNodes: [3] });
  assert.match(changed, /<Spec nodes="1,2">/);
  assert.match(changed, /<Spec nodes="4,5">/);
  assert.match(changed, /<AttributeOverride strNodes="2"\/>/);
  assert.match(changed, /<AttributeOverride dexNodes="4"\/>/);
});
