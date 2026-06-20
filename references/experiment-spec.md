# Experiment Specs

Run:

```text
node scripts/run-experiment.js <spec.json> --output summary.json
```

Minimal shape:

```json
{
  "name": "one-point-passive-check",
  "build": "PATH/Build.xml",
  "scope": "focused",
  "metrics": ["Life", "TotalEHP", "TotalDPS"],
  "xmlScenario": {
    "placeholders": {"enemyLevel": 33, "enemyDistance": 20},
    "inputs": {"resistancePenalty": -20, "enemyDistance": 20}
  },
  "scenarioActions": [
    {"action": "set_config", "params": {"enemyLevel": 33}}
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
  "stdoutTopN": 3,
  "topN": 5
}
```

Every variant starts from a fresh load of the same build, then receives the
same `scenarioActions`, followed by its own actions. Supported actions are the
runtime's JSON API actions. Use action-level `expect` or final `assertions` to
prove important mutations.

Use `xmlScenario` for values that must exist before PoB initializes the build,
especially campaign resistance penalty and saved placeholders. Use
`scenarioActions` for ordinary runtime configuration.

Supported assertion operations: `equals`, `notEquals`, `includes`,
`notIncludes`, `gte`, `lte`, and `exists`.

Set `approved: true` only after the user approves a medium or large preflight.
Use `--raw` only for debugging or reproducibility. Normal output contains
filtered metrics, deltas, validation, runtime metadata, and top variants.

The saved `--output` artifact is complete for the requested `topN`; stdout is
a smaller decision summary. Do not print the saved artifact again. Set
`summaryMetrics` to at most six fields. Use `--full-stdout` only when debugging
the reporting layer itself.
