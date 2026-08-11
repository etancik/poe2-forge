# Scenario Diagnosis

Normally trust the validated output of `refresh-build.js` without reading this
reference. For diagnosis: enemy level uses explicit area level or character
level, clamps to the runtime maximum, and selects Armour/Evasion from
`Data/Misc.lua`. Resistance penalty comes from current `ConfigOptions.lua` and
distance defaults to 20.

Near a campaign transition, ask for Act or area level and rerun with `--act` or
`--area-level`. After load, verify enemy level, Armour, Evasion, resistance
penalty, and distance through `get_config`; reject any mismatch. Apply the same
validated packet to baseline and every variant.
