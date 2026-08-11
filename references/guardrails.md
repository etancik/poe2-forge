# Calculator Guardrails

Load only for the mechanic under investigation:

- Exact passive checks must preserve attribute choices, selected spec,
  connectors, and unrelated state. `set_tree` is legality smoke only.
- Verify the damaging socket group/subskill, weapon set, sustained resources,
  conditional effects, and mechanic counts.
- Cap finite-duration cooldown/totem value by action rate, lifetime, delay,
  recovery, and queue behaviour rather than stored uses alone.
- For support-colour/count mechanics, count enabled groups and exclude
  weapon-granted basic skills when the game does.
- Keep complete artifacts on disk and consume bounded output.
