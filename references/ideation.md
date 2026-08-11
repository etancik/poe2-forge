# Build Idea Discovery and Triage

Use discovery for broad reviews, new build directions, or when local search is
unlikely to invent a mechanic, unique, skill package, or playstyle alternative.

## Discovery

Search enough current and older material to create a diverse raw pool. Prefer:

1. official patch notes and current game/PoB data for present mechanics;
2. poe.ninja profiles and timelines for combinations people actually play;
3. Reddit build discussions for unusual interactions and playstyle warnings;
4. guides and videos as leads whose claims still require verification.

Record the source URL, publication date or patch, build version when known,
and the exact transferable mechanic. Do not copy a full build when only one
interaction is relevant.

## Revalidate before rejecting

Assign one evidence status:

- `current`: source and dependencies match the current version;
- `needs-revalidation`: old patch, unknown version, renamed dependency, or
  incomplete evidence;
- `translated-current`: the original form changed but a current equivalent was
  identified;
- `invalid-current`: a specific required interaction, item, skill, or passive
  no longer works;
- `measured`: tested under the validated current scenario.

For `needs-revalidation`, identify required dependencies, check current patch
notes and data, map renamed or reworked components, and run a small PoB or
in-game verification when useful. Age or missing version alone is never a
rejection reason.

## Automatic sanity triage

Remove only proven duplicates, candidates with a demonstrated impossible
dependency, and candidates that cannot address the stated goal. Preserve
uncertain but plausible ideas and state the cheapest verification needed.

Consider level/accessibility, respec size, gear dependence, price uncertainty,
defensive cost, resource uptime, input intensity, mobility, visual clarity,
boss/clear split, and whether PoB can model the important part.

## Shared triage packet

Present 6-8 distinct cards before expensive calculation. Each card contains:

- the exact idea and what it replaces;
- why it might fit the current build and the user's preferences;
- evidence status and source;
- expected playstyle, cost, and respec size;
- main failure mode or uncertainty;
- the smallest useful calculator or in-game test.

Ask the user to select, reject, or combine cards. Measure 2-4 preferred ideas,
then keep rejected ideas only in the current task artifact when they contain a
reusable reason. Do not create a persistent character roadmap.
