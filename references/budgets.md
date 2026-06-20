# Scope and Calculation Budgets

## Scope

- `focused`: only the explicitly named subsystem or variants.
- `adjacent`: include directly competing solutions with low extra cost.
- `holistic`: consider passives, ascendancy, gear, rares, uniques, gems,
  supports, skills, configuration, and relevant combinations.

Use `focused` without asking for tightly bounded comparisons. For broad goals
such as survivability, best upgrade, or full build review, recommend
`holistic` and confirm the scope before calculation. A holistic review starts
with cheap subsystem triage; it is not permission for an exhaustive Cartesian
product.

## Budget classes

- `no-runtime`: interpretation, planning, handoff, or a question for which the
  backend cannot materially improve the answer.
- `small`: at most 5 targeted variants and a bounded metric set. Run directly.
- `medium`: 6-25 variants, a filtered scan, or several related subsystems.
  Present a high-level plan and wait for approval.
- `large`: more than 25 variants, exhaustive search, combinatorial work, or
  broad raw-data processing. Present smaller alternatives and wait for
  explicit approval.

Before medium or large work, show the goal, scope choices, approximate variant
count, inputs, outputs, likely value, and intentional exclusions.

The experiment runner enforces this gate: specs with more than 5 variants must
set `approved: true`. Approval applies to that described experiment only.
