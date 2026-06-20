# Third-Party Data and Runtime

This repository's optimizer code expects external data and software but does
not redistribute them.

## Grinding Gear Games tree export

The development snapshot was obtained from
`https://github.com/grindinggear/poe2-skilltree-export`. It contained game
passive-tree names, stats, topology, and identifiers. Its redistribution terms
have not been established for this repository, so the snapshot was excluded.

Users must obtain a compatible export themselves and provide its directory.
The importer requires a local `manifest.json` with provenance/version fields
and a SHA-256 for `data.json`. Verify the upstream repository's current terms
before redistributing any export.

## Path of Building

Path of Building and the headless API runtime/shim are separate external
dependencies. Their code and data are not included here. Users and publishers
must review the licenses and attribution requirements of the exact PoB fork,
runtime, and shim they choose.

## Names and affiliation

Path of Exile, Path of Exile 2, and related game data belong to their
respective owners. This project is an independent experimental tool and does
not claim endorsement by Grinding Gear Games or Path of Building maintainers.
