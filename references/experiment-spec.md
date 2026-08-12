# Experiment Specs

Use `poe2-forge.js experiment SPEC.json` for non-passive API variants. Include
all five validated scenario fields; each variant reloads the baseline and
verifies the scenario. Do not use `update_tree_delta` for exact passive work,
because generic mutation can lose attribute-node choices.

Use `poe2-forge.js directed SPEC.json` for passive deltas:

```json
{
  "name": "cross-layer-swap",
  "build": "C:\\path\\Build.xml",
  "baseline": "artifacts/refresh.json",
  "objectives": [
    {"name": "ehp", "field": "TotalEHP", "direction": "max"},
    {"name": "damage", "field": "TotalDPS", "direction": "max",
     "skill": {"names": ["Shred"]}}
  ],
  "variants": [
    {"id": "swap", "addNodes": [15580], "removeNodes": [13693]}
  ]
}
```

The trusted refresh artifact supplies the scenario. Directed evaluation first
validates the resulting tree, then measures an in-memory XML variant that preserves attribute choices and
checks build, tree, and baseline restoration.

Up to 12 variants are `small`; 13-40 are bounded `medium`. More than 40 or
explicit exhaustive work requires `"approved": true`. Default stdout is a
bounded packet; `silent` chains artifacts and `debug` is explicit.
