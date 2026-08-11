# PoE2 Scenario Calibration

Treat configuration as build state. `refresh-build.js` and `inspect-build.js`
derive the default scenario from the current build and runtime:

- enemy level defaults to explicit area level, otherwise character level;
- clamp enemy level to the maximum declared by the current runtime (currently
  85) and report both requested and applied values;
- enemy Armour and Evasion come from `Data/Misc.lua` at the applied enemy level;
- resistance penalties come from the current runtime's
  `Modules/ConfigOptions.lua`;
- enemy distance defaults to 20 unless the encounter requires another value.

The level heuristic uses the current campaign bands: Act 1 levels 1-15, Act 2
16-32, Act 3 33-45, Act 4 46-53, later campaign/interludes 54-59 and 60-64,
then endgame at 65+. Within one level of a transition, stop and ask for the
current Act or area level. Use `--act`, `--area-level`, or an explicit
`--resistance-penalty` to confirm it.

Stale saved placeholders are corrected before PoB initializes. After load,
verify enemy level, Armour, Evasion, resistance penalty, and distance through
`get_config`. A successful setter acknowledgement is insufficient; reject the
result if any field differs.

Before damage comparisons, also verify the damaging socket group/subskill,
weapon set, sustained resources, conditional effects, and relevant mechanic
counts. Apply the same packet to every variant and reload the baseline between
variants.
