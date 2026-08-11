# Calculator Guardrails

Apply only the rules relevant to the current mechanic:

- Exact passive results must preserve attribute-node choices, selected spec,
  key baseline stats, and the full connector chain. Use non-mutating
  `calc_with_stats`; `set_tree` is a legality smoke check only.
- Set representative sustained resources before evaluating conditional
  passives or skills. Zero-state Rage or charge results may reverse a decision.
- Verify the damaging socket group and subskill, not a placement, trigger,
  loader, or unused count gem. Also verify weapon set and mechanic counts.
- For finite-duration cooldown totems, cap extra-use value by action rate,
  lifetime, firing delay, charge recovery, and queue behaviour. Stored uses
  alone overstate burst.
- For support-colour or count mechanics, count enabled groups and separately
  exclude weapon-granted basic skills when the game may ignore them.
- For user-facing passive comparisons, prefer named Original and Alternative
  specs in one build, set the alternative active, reload, and assert the active
  spec plus requested nodes.
- Before item replacement, check empty augment sockets, quality, bonding,
  corruption, and legal item-local improvements.
- Keep complete artifacts on disk and stdout bounded. Never reload a full
  artifact merely to report its top rows.
