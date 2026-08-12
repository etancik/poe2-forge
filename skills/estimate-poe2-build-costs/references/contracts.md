# Integration contracts

## Alternative-candidate batch input

Use one batch for mutually exclusive build candidates:

~~~json
{
  "snapshot": {
    "game": "poe2",
    "trade_realm": "poe2",
    "source_locale": "us",
    "quote": "Exalted Orb"
  },
  "approved": false,
  "candidates": [
    {
      "candidate_id": "stable-id",
      "label": "human label",
      "requirements": [
        {
          "action": "add|replace|craft|anoint|respec",
          "name": "exact item or service",
          "quantity": 1,
          "owned": 0,
          "pricing": "exchange|observed|manual|none",
          "mandatory": ["properties required for measured benefit"],
          "optional": ["premium properties"]
        }
      ]
    }
  ]
}
~~~

Omit `snapshot.league` to discover the current softcore challenge league at
quote time. An explicit league is an override, never a persistent default.
`source_market` and `source_league_scope` are observed output metadata, not
caller assertions.

Pricing modes:

- `exchange`: let `poe2-costs.py batch` fetch a current PoE2DB quote;
- `observed`: aggregate already researched current evidence; include
  `unit_price`, optional `[low, high]` `range`, `confidence`, `source`, and its
  observed market metadata;
- `manual`: keep the component explicitly unpriced pending listing/craft work;
- `none`: no trade acquisition cost, such as a passive-only change.

`quantity - owned` is the net requirement. Unknown or manual components make a
candidate total `null`; they never become zero. More than 40 candidates or
distinct automatic exchange queries requires `approved: true`.

Run:

~~~text
python scripts/poe2-costs.py batch --input batch.json --output costs.json
python scripts/poe2-costs.py report --input costs.json --candidate stable-id
~~~

Both default to bounded packet output. Use `--stdout-mode silent` for chaining
or `debug` only when diagnosing a specific failure. Output artifacts must remain
below the current working directory.

## Batch result

The full machine-only artifact keeps shared snapshot metadata and candidate
results separately:

~~~json
{
  "kind": "cost_batch",
  "as_of": "ISO-8601 timestamp",
  "snapshot": {
    "game": "poe2",
    "trade_realm": "poe2",
    "league": "current or explicit league",
    "league_attribution": "official_current_trade_league|explicit_override|not_queried_no_market_acquisition",
    "league_source": "URL or null",
    "source_market": "US Realm Economy or null",
    "source_locale": "us",
    "source_league_scope": "not_explicitly_labeled or null",
    "quote": "Exalted Orb"
  },
  "candidates": [
    {
      "candidate_id": "stable-id",
      "priced_subtotal": 0,
      "direct_total": 0,
      "range": [0, 0],
      "confidence": "high|medium|low|unknown",
      "requirements": [],
      "unpriced": []
    }
  ],
  "sources": []
}
~~~

The calling build skill retains its calculator delta beside `candidate_id` and
joins only the compact total, range, confidence, and unpriced count. Never let
market confidence modify calculator metrics or exact PoB metrics imply exact
market prices.

## Deterministic acquisition optimizer

Pass verified item-specific recipes to `poe2-costs.py optimize`:

~~~json
{
  "quote": "Exalted Orb",
  "requirements": {"Target": 1},
  "prices": {"Target": 100, "Input": 20},
  "recipes": [
    {
      "name": "Verified conversion",
      "inputs": {"Input": 3},
      "outputs": {"Target": 1}
    }
  ]
}
~~~

Recipes are discrete and rounded upward. Populate them only from current
evidence for the exact item family and version. An empty list is normal. The
optimizer does not reuse incidental excess output across separate requirements.

## Compact handoff

Return only:

- snapshot timestamp, league, market, and quote;
- per-candidate total, range, confidence, and unpriced count;
- dominant uncertainty and exact next acquisition steps;
- artifact path for later bounded `report` queries.

Do not copy full listings, raw HTML, or the full artifact into the calling task.

## Screenshot-choice extension

For a photographed choice add `choice_ranking` entries with rank, exact visible
text, value/range, liquidity, price confidence, and short reason. Preserve
`image_reading_confidence` separately from market confidence.
