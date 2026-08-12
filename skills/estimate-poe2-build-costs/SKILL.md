---
name: estimate-poe2-build-costs
description: Estimate the current acquisition cost of proposed Path of Exile 2 build changes, including gear, uniques, gems, currency, anoints, crafting materials, and respecs, and rank options visible in screenshots or photos of runic stones and other in-game choice screens by current value. Use when comparing upgrades, attaching a price or budget to calculator-backed build recommendations, choosing the most valuable pictured reward or crafting option, checking verified item-specific acquisition alternatives, or separating measured build benefit from market cost and price uncertainty.
---

# Estimate PoE2 Build Costs

Estimate what a proposed build change costs now. Keep calculator effects and
market estimates separate: this skill prices a change; it does not claim that
the change improves the build.

## Workflow

1. Normalize the proposal into net requirements: item or service, quantity,
   exact variant or required mods, and whether the character already owns it.
   Price additions only. Do not credit replaced-item sales unless the user asks;
   if asked, show gross cost and discounted sale credit separately.
2. Identify realm and league when they affect price. Default to the current PoE2
   PC challenge league and say so. Treat every quoted price as time-sensitive.
3. Select evidence:
   - Currency Exchange items: current 24-hour PoE2DB/official exchange data.
   - Fixed uniques, gems, and bases: current economy data when available;
     otherwise sample comparable current listings.
   - Rare items: search by the minimum build-enabling mods, then bracket the
     price. Never present one exact listing as a stable market price.
   - Crafts: price ingredients plus expected attempts and state the probability
     assumptions. Keep deterministic and probabilistic costs separate.
   - Passive changes: trade cost is zero; report known respec/gold requirements
     separately or mark them unknown.
4. Browse or query fresh sources during every estimate. Do not reuse an older
   conversation quote as current data. Record source, realm/league, quote time,
   volume or sample size, and price basis.
5. For PoE2DB-listed exchange items, run
   'python scripts/fetch_poe2db_price.py --item "<name>" --quote "Exalted Orb" --pretty'.
   Use a supplied PoE2DB URL with '--url' when name-to-slug conversion is
   ambiguous.
6. Price direct acquisition first. Then inspect only alternatives verified for
   the exact item and current game version: a vendor recipe, reforge, lower-tier
   upgrade, deterministic craft, or finished-item purchase. Never infer a recipe,
   input combination, or ratio from another item family. Omit alternatives when
   current evidence is absent. For a verified deterministic recipe bundle, use
   'scripts/optimize_acquisition.py'; read
   [references/contracts.md](references/contracts.md) for its input.
7. Normalize totals to Exalted Orbs and also Divine Orbs when a liquid current
   conversion exists. Prefer the highest-volume direct pair. Avoid chaining
   conversions when a direct pair exists.
8. Assign confidence per component: 'high' for liquid direct exchange data,
   'medium' for a coherent listing sample or deterministic recipe, 'low' for
   sparse listings or modeled crafting, and 'unknown' when evidence is absent.
9. Return the compact contract below. Lead with the cheapest feasible total,
   then direct-buy total, savings, dominant uncertainty, and exact shopping or
   crafting steps.

## Screenshot choice workflow

1. Inspect the supplied image and transcribe every visible option before pricing.
   Capture exact names, quantities, tiers, modifiers, restrictions, and icons that
   disambiguate variants. Do not infer obscured text.
2. If a decisive field is unreadable, give a conditional ranking when possible.
   Ask for a closer crop or clearer photo only when the ambiguity can change the
   recommendation.
3. Price all choices from a consistent current snapshot. For a guaranteed
   tradeable result, use its buy-now value. For a random reward, report expected
   value and range separately from the best-case result. For an untradeable
   result, price only defensible downstream tradeable rewards.
4. Rank by realistic net sale value, not the highest visible listing. Include
   liquidity, likely selling friction, and confidence. Keep personal build value
   as a separate ranking when the user's build makes it relevant.
5. Lead with the recommended pictured choice and the margin over second place.
   When the margin is smaller than price uncertainty, call the choices tied.

## Output contract

Return both human-readable results and a compact machine-readable block:

~~~json
{
  "as_of": "ISO-8601 timestamp",
  "realm": "US",
  "league": "current PoE2 challenge league",
  "quote": "Exalted Orb",
  "direct_total": 0,
  "optimized_total": 0,
  "range": [0, 0],
  "confidence": "high|medium|low|unknown",
  "requirements": [],
  "acquisition_plan": [],
  "choice_ranking": [],
  "image_reading_confidence": "high|medium|low|not_applicable",
  "unpriced": [],
  "sources": []
}
~~~

Omit false precision: round liquid totals sensibly and widen the range for rare
gear, low volume, or crafting variance. Read
[references/sources.md](references/sources.md) when choosing or interpreting a
source, and [references/contracts.md](references/contracts.md) when another
skill will consume the result.
