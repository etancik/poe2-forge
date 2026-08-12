# Integration contracts

## Proposed-change input

Accept prose or normalize another skill's output to:

~~~json
{
  "realm": "US",
  "league": "current PoE2 challenge league",
  "changes": [
    {
      "action": "add|replace|craft|anoint|respec",
      "name": "exact item or change name",
      "quantity": 1,
      "mandatory": ["properties required for the measured benefit"],
      "optional": ["nice-to-have properties"],
      "owned": 0
    }
  ]
}
~~~

Preserve the build optimizer's exact minimum requirements. Do not silently add
premium rolls or optional affixes.

## Acquisition optimizer example

Pass a JSON file to 'scripts/optimize_acquisition.py --input <file> --pretty':

~~~json
{
  "quote": "Exalted Orb",
  "requirements": {
    "Concentrated Liquid Isolation": 1,
    "Concentrated Liquid Suffering": 1,
    "Concentrated Liquid Fear": 1
  },
  "prices": {
    "Concentrated Liquid Isolation": 223,
    "Concentrated Liquid Suffering": 47.4,
    "Concentrated Liquid Fear": 13.2
  },
  "recipes": [
    {
      "name": "Fear to Suffering",
      "inputs": {"Concentrated Liquid Fear": 3},
      "outputs": {"Concentrated Liquid Suffering": 1}
    },
    {
      "name": "Suffering to Isolation",
      "inputs": {"Concentrated Liquid Suffering": 3},
      "outputs": {"Concentrated Liquid Isolation": 1}
    }
  ]
}
~~~

Recipes are discrete. The optimizer rounds recipe batches upward and returns a
conservative plan; it does not currently reuse incidental excess output across
separate requirements.

This is an item-specific example for the listed emotions, not a general 3:1
rule. Populate 'recipes' only from current evidence for the exact item family
and game version. An empty recipe list is normal; in that case retain direct
pricing and do not invent an alternative path.

## Result handoff

The calling build skill should retain:

- measured build delta from its calculator;
- 'optimized_total', 'range', and 'confidence' from this skill;
- benefit-per-cost only when both sides share the same scenario and the price
  evidence is current;
- an 'unpriced' list so unknown components never become implicit zeroes.

Never let market confidence alter calculator metrics. Never let exact
calculator metrics imply exact market prices.
## Screenshot-choice result

For a photographed choice screen, add:

~~~json
{
  "image_reading_confidence": "high",
  "choice_ranking": [
    {
      "rank": 1,
      "visible_text": "exact transcription",
      "value": 0,
      "range": [0, 0],
      "liquidity": "high|medium|low|unknown",
      "price_confidence": "high|medium|low|unknown",
      "reason": "short recommendation basis"
    }
  ]
}
~~~

Preserve image-reading confidence separately from market-price confidence. A
clear screenshot can still contain a low-confidence market, and a liquid market
does not repair an ambiguous screenshot transcription.
