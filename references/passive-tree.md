# Passive-Tree Validation

Calculator acceptance does not prove that a tree is legal.

Before recommending a variant, verify:

- requested additions and removals are present;
- connectivity and passive-point budget;
- class start, weapon-set, trial, socket, and special-node constraints;
- ascendancy identity and available ascendancy points.
- unrelated state such as level, attributes, item set, and skill selection did
  not change during tree import.

Reject foreign-ascendancy and disconnected allocations even if the backend
accepts them. Exclude ascendancy nodes from ordinary searches unless the user
requests ascendancy planning.

For transition planning, search legal remove-and-add trees rather than only
nodes reachable as incremental additions. Compare the current tree, playable
intermediate milestones, and the target archetype against their own level and
point budgets.

Use `inspect-build.js --sections tree` for the allocated tree and the
runtime's `search_nodes` action for bounded searches. Limit candidates before
writing output; never emit the complete tree JSON as the default result.

If a tree mutation changes unrelated state, reject that measurement and use a
small custom experiment importing the shared PoB client until the runtime
mutation path is repaired. Do not normalize the drift away.
