# Build Layers

Load only for idea generation, broad reviews, or material rebuilds.

## Map before searching

Describe each active layer in one line:

- **output:** main clear, boss damage, secondary damage;
- **delivery:** totem, trigger, cooldown, projectile overlap, minion, DoT;
- **amplifier:** rage, curse, exposure, armour break, crit, quality;
- **resource:** spirit, mana, life cost, charges, cooldown uses;
- **defence/recovery:** armour conversion, avoidance, max hit, regen, leech;
- **enabler:** ascendancy, unique, weapon swap, bonded modifier, threshold.

For each layer record `provides`, `requires`, `shared investment`, and
`failure if removed`. Mark it `load-bearing`, `supporting`, or `luxury`.
Treat caps and breakpoints separately from continuously scaling stats.

## Generate material alternatives

Prefer concepts that replace a complete job rather than one stat. For a layer
removal, name:

1. everything lost directly;
2. dependencies that stop working or become weaker;
3. gear, passives, spirit, or sockets made available;
4. one coherent replacement package using those released resources;
5. the smallest test that could falsify the concept.

Also search for cross-layer investments: one change that benefits two or more
existing layers. Do not count a small numerical swap as a concept unless it
tests a broader hypothesis.

## Triage and measure

Search current builds, mechanic discussions, patch notes, and transferable old
ideas. Revalidate old or unclear versions; do not reject them by age alone.

Present the layer map and concept cards before medium or large calculation.
After selection, measure the complete package and a nearby control in the same
validated scenario. Include non-sheet costs such as delay, coverage, uptime,
button load, positioning, and conditional defence.
