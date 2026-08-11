# Experiment Specs

Run:

```text
node scripts/run-experiment.js <spec.json> --output summary.json
```

Use the complete scenario emitted by `refresh-build.js`:

```json
{
  "name": "focused-passive-check",
  "build": "C:\\path\\Build.xml",
  "scope": "focused",
  "metrics": ["Life", "TotalEHP", "TotalDPS"],
  "xmlScenario": {
    "placeholders": {
      "enemyLevel": 42,
      "enemyEvasion": 369,
      "enemyArmour": 479
    },
    "inputs": {
      "enemyLevel": 42,
      "enemyEvasion": 369,
      "enemyArmour": 479,
      "enemyDistance": 20,
      "resistancePenalty": -20
    }
  },
  "scenarioActions": [
    {
      "action": "set_config",
      "params": {
        "enemyLevel": 42,
        "enemyEvasion": 369,
        "enemyArmour": 479,
        "enemyDistance": 20,
        "resistancePenalty": -20
      }
    }
  ],
  "variants": [
    {
      "id": "add-node",
      "actions": [
        {"action": "update_tree_delta", "params": {"addNodes": [12345]}}
      ],
      "assertions": [
        {"path": "tree.nodes", "op": "includes", "value": 12345}
      ]
    }
  ],
  "sort": {"metric": "TotalEHP", "direction": "desc"},
  "summaryMetrics": ["TotalEHP", "Life", "TotalDPS"],
  "stdoutTopN": 5,
  "topN": 8
}
```

Every variant reloads the same build, applies the shared scenario, then its own
actions. The runner requires all five scenario fields and verifies them for the
baseline and every variant. Supported assertion operations are `equals`,
`notEquals`, `includes`, `notIncludes`, `gte`, `lte`, and `exists`.

Up to 12 variants run as `small`; 13-40 run as bounded `medium`. Only `large`
work above 40 variants or explicit exhaustive work requires `approved: true`.
Normal stdout contains at most six metrics and five top variants. Use
`--full-stdout` only to debug reporting.
