# Item Completion Before Replacement

Before recommending an item replacement, run
`scripts/inspect-item-opportunities.js` with the active validated baseline.

Check, in order:

1. empty rune, Soul Core, or similar augment sockets;
2. low quality on modifiable equipment;
3. existing rune bonding and the opportunity cost of breaking it;
4. non-rune enchant state and corruption restrictions;
5. cheap item-local mechanics that address the measured deficit;
6. only then, replacement profiles.

Use the active runtime's `Data/ModRunes.lua` as the legality and effect source.
Recommend only entries valid for the item's slot category. Treat socketing,
corruption, and enchant operations as user-approved commitments; never apply
them automatically.

If a legal augment can materially address the measured deficit, include a
small calculator variant for it before testing item replacement. Compare
common/lower-rank and best-available tiers when acquisition cost matters.

An audit may say that no safe item-local improvement is known. Do not invent
an enchant path merely because no enchant was detected.

Use baseline stats for deficits; do not recalculate needs from a build's stale
saved scenario. Diversify suggestions across distinct deficits instead of
listing several tiers of the same rune unless the user asks for tiers.
