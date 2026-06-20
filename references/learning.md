# Bounded Learning

After each completed evaluation, ask one cheap postflight question:

> Did this run reveal one evidence-backed rule that will prevent repeated
> waste, a repeated mistake, or a missed upgrade category?

If no, write nothing. If yes, add at most one entry with
`scripts/learning-manager.js`. Keep the rule reusable and independent of a
single transient number.

Store `learning.json` in the character roadmap directory. Keep at most 12
entries. Load only `learning-manager.js summary`, which returns at most five
short rules; do not load the full file during normal work.

Valid categories include `workflow`, `scenario`, `items`, `passives`,
`skills`, and `mechanics`. Evidence must name the measured run or observed
failure. Do not store speculation, generic game knowledge, or conclusions
already represented by an active roadmap decision.
