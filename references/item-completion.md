# Item Completion

Before replacing an item, run `scripts/inspect-item-opportunities.js` against
the validated baseline. Check empty augment sockets, quality, bonding,
corruption/enchant restrictions, and cheap legal item-local improvements first.

Use the active runtime's `Data/ModRunes.lua` for legality. Test a material legal
augment as a small variant before replacement; compare affordable and best
available tiers when cost matters. Use validated baseline deficits, never stale
saved configuration. Do not invent an enchant path or apply a permanent change
without approval.
