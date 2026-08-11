# Passive-Tree Validation

PoB acceptance does not prove that a tree is legal or unchanged in unrelated
state. Before recommending a variant, verify:

- requested additions, removals, and full connector chains;
- connectivity and ordinary, ascendancy, weapon-set, and other point budgets;
- class start, trial, socket, attribute-choice, and special-node state;
- selected spec, ascendancy identity, level, attributes, items, and skills.

Reject foreign-ascendancy and disconnected allocations. Exclude ascendancy
nodes unless the user requests ascendancy planning. Search legal remove-and-add
trees for transitions; do not limit future archetypes to incremental additions.

Use `inspect-build.js --sections tree` for the allocated tree and
`inspect-tree.js` for bounded candidate/leaf scans. Use non-mutating
`calc_with_stats` for exact metrics. `set_tree` is legality smoke only because
it can discard attribute-node choices. Never apply a candidate automatically.
