# Passive Optimizer

The CLI measures legal trees; it does not generate ideas.

## Broad reviews: concept first

1. Refresh the build. Its trusted scenario is the sole source for exact checks.
2. Map the build with `build-layers.md`. Identify load-bearing layers,
   dependencies, shared investments, and what becomes stranded if a layer is
   removed.
3. Search three angles: current builds with the main skill/ascendancy,
   mechanic-specific discussions, and adjacent or older archetypes worth
   revalidating.
4. Present 4-6 concept cards. Each card must replace, strengthen, or connect a
   named layer; include dependencies affected, stranded investment, expected
   tree shape, source status, sacrifice, and cheapest falsification test. Never
   reject an idea only because its patch is old or unclear.
5. Let the user select or combine 2-3 concepts.
6. Give each concept its own desired, forbidden, weapon, skill, and mechanic
   tags. Search bounded permutations inside it: usually 4-12 changes or a
   deliberate 8-20 point rebuild. Global brute force is diagnostic only.
7. Exact-check baseline, at least one concept-sized candidate, and a nearby
   control. Surface only measured upside with a reasonable upside/downside
   ratio; otherwise report that none survived.

Use `node scripts/passive-optimizer.js --help`. Preserve connectivity, budgets,
starts, ascendancy, sockets, choices, and unrelated state. Exact evaluation
ignores profile scenarios and requires a matching trusted refresh artifact.
Cheap scores triage; PoB decides. Never apply a candidate automatically.
