# Passive Optimizer

The deterministic CLI validates, reroutes, extracts, scores, and searches legal
passive candidates. Cheap scores guide selection; PoB is the exact tier.

## Typical commands

```powershell
node scripts/passive-optimizer.js validate --build "C:\path\Build.xml"

node scripts/passive-optimizer.js reroute `
  --build "C:\path\Build.xml" --mode standard --limit 5

node scripts/passive-optimizer.js search `
  --build "C:\path\Build.xml" `
  --profile "C:\path\profile.json" `
  --max-changes 8 --result-limit 10 `
  --output "C:\path\search.json"

node scripts/passive-optimizer.js search `
  --build "C:\path\Build.xml" `
  --profile "C:\path\profile.json" `
  --medium-rebuild --preset auto `
  --runtime-limit-ms 60000 --evaluation-limit 12 `
  --min-changes 20 --max-changes 30 `
  --cache "C:\path\search.cache.json" `
  --checkpoint "C:\path\search.checkpoint.json" `
  --output "C:\path\search.json"
```

Use the hash-verified tree snapshot configured by CLI, environment, or
`config.local.json`. Do not replace it during a search. Use a validated refresh
artifact and complete scenario for exact checks. Exact evaluation must reload
and restore the baseline, preserve attribute choices and unrelated state, and
exclude failed, timed-out, or drifted candidates.

Modes:

- `conservative`: preserve all allocated nodes except degree-two pure travel;
- `standard`: preserve notables, keystones, sockets, ascendancy, required, and
  special-state nodes;
- `rebuild`: preserve mandatory starts and explicitly required nodes. Require
  explicit rebuild approval for materially larger changes.

Keep cheap and exact Pareto archives separate. Treat calibration diagnostics as
evidence about the scorer, not permission to mutate a build. Save full results
to artifacts and keep stdout bounded.
