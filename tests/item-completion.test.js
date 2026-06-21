"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  completionModel,
  parseItem,
  recommendationsFor,
} = require("../scripts/inspect-item-opportunities");

test("non-corrupted socketable helmet with zero sockets exposes creation", () => {
  const item = parseItem({
    slot: "Helmet",
    name: "Ironride",
    type: "Helmet",
    raw: "Rarity: Unique\nIronride\nQuality: +0%",
  });
  assert.equal(item.existingEmptySockets, 0);
  assert.equal(item.creatableSockets, 1);
  assert.equal(item.corrupted, false);
});

test("corrupted or jewellery items do not expose socket creation", () => {
  assert.equal(parseItem({
    slot: "Helmet",
    type: "Helmet",
    raw: "Corrupted",
  }).creatableSockets, 0);
  assert.equal(parseItem({
    slot: "Ring 1",
    type: "Ring",
    raw: "",
  }).creatableSockets, 0);
});

test("expensive permanent runes require transition-anchor evidence", () => {
  const catalog = [{
    name: "Expensive Rune",
    slot: "helmet",
    effects: ["+10% to Fire Resistance"],
    rank: 4,
  }];
  const needs = [{
    id: "fire-resistance",
    deficit: 20,
    regex: /\+([0-9]+)% to Fire Resistance/i,
  }];
  const temporary = completionModel({
    slot: "Helmet",
    type: "Helmet",
    existingEmptySockets: 0,
    creatableSockets: 1,
  }, {
    Helmet: { replacementHorizon: "temporary" },
  });
  assert.deepEqual(recommendationsFor(temporary, catalog, needs, 3), []);
  const anchor = completionModel(temporary, {
    Helmet: { replacementHorizon: "transition anchor" },
  });
  assert.equal(recommendationsFor(anchor, catalog, needs, 3).length, 1);
});
