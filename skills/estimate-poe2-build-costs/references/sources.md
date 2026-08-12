# Price sources and evidence rules

## Currency Exchange

Prefer current, liquid exchange evidence for stackable currencies and crafting
materials.

- PoE2DB item pages expose 24-hour exchange ratios and traded volume. A row such
  as '13.2 Exalted Orb <-> 1 Item' means 13.2 Exalted Orbs per item.
- The official public endpoint is
  'GET https://web.poecdn.com/api/currency-exchange/poe2[/<id>]'.
  It returns hourly historical market-pair digests and 'next_change_id'.
- Official reference:
  'https://www.pathofexile.com/developer/docs/reference#currency-exchange'.
- Current-hour trades are unavailable in the official feed, and old history may
  be removed. For a current approximate quote, a PoE2DB 24-hour aggregate is
  acceptable and should be labeled as such.

Prefer a direct Exalted or Divine pair with meaningful 24-hour volume. If two
pairs disagree, report the liquid pair and mention the spread instead of
silently averaging them.

## Fixed items

Use a current economy page when it identifies the exact unique, gem, base, or
currency variant. Otherwise sample live trade listings. Exclude obvious
misprices and price-fix outliers; report median and a practical buy-now range.
Include corruption, sockets, quality, roll, and item level only when the build
requires them.

## Rare gear

Price the minimum functional specification, not an imagined perfect copy of a
calculator item. Search mandatory mods first, then add optional mods in tiers.
Report at least a lower functional price and a realistic comparable range.
When fewer than five credible comparables exist, use low confidence.

## Crafting

Separate:

- deterministic ingredient cost;
- expected attempts for probabilistic steps;
- tail-risk budget or percentile when material;
- value of reusable or recoverable outputs.

Never call expected cost a guaranteed price. If modifier odds are unknown, show
ingredient cost per attempt and leave total expected cost unpriced.

## Freshness and confidence

- High: same-day liquid direct market with useful volume.
- Medium: same-day coherent listing sample or deterministic conversion using
  high-confidence ingredients.
- Low: sparse market, indirect conversion, stale data, or modeled craft.
- Unknown: no defensible observable evidence.

Always retain the retrieval timestamp and URLs used.
## Screenshots and photographed choices

Treat the image as evidence of what choices exist, not as price evidence.
Transcribe all options before browsing prices and preserve uncertainty for any
blurred name, number, tier, icon, or modifier. Price the options in one batch so
market movement does not bias their ordering.

Rank guaranteed tradeable outputs by realistic net sale value. Rank random
outputs by expected value only when probabilities or a defensible distribution
are known; otherwise report a range and leave expected value unknown. Mention
low volume, trade friction, and character-bound outputs explicitly. If two
options' ranges overlap materially, report a tie rather than false precision.
