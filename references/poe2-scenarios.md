# PoE2 Scenarios

Treat configuration as build state. Use the character's current progression
and encounter; do not silently apply endgame defaults to a campaign build.

Keep enemy level, resistances, distance, conditional effects, weapon set,
selected skill, subskill, and calculation mode identical across variants.
Express shared setup as `scenarioActions` in the experiment spec.

When a saved build contains enemy Armour or Evasion placeholders from another
level, replace them with the matching values from the active runtime's
`Data/Misc.lua` tables. Changing enemy level alone does not update stale saved
placeholders.

After applying a scenario, verify the effective values returned by
`get_config`; successful setter acknowledgement is insufficient. Reject
scenario-dependent conclusions when the effective enemy level or other
critical configuration does not match.

Measure the damaging skill or subskill rather than a placement, trigger, or
proxy skill. When a result is implausible, inspect the calculation breakdown
and stale configuration before expanding the search.
