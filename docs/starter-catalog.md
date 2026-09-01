# BenchLedger starter catalog

The production runtime includes a small, curated catalog of common FFF
printers and 1.75 mm filament products so a new workspace can choose an exact
identity immediately. These are catalog records only: startup never creates a
physical inventory item, product profile, quantity, reservation, or stock
event.

The dataset is versioned in `forge_meta` under
`starter_catalog_dataset_version`. Startup inserts only missing stable IDs. It
does not overwrite an existing or custom row, including a custom row that uses
one of the starter IDs. A later dataset revision must add a new version and
preserve this insert-missing-only rule.

## Review scope

Dataset version 2 was reviewed on 2026-09-01 against direct manufacturer
product pages. It deliberately records only identity fields and core
manufacturer-published dimensions that were verified for this seed: 31 printer
identities and 29 filament identities. Filament length is left unknown unless
the manufacturer declares it; no length is inferred from density. The
catalog should be refreshed when manufacturers retire, rename, or materially
change a product.

The reviewed Anycubic build volumes are Kobra 2 and Kobra 2 Pro at
220 × 220 × 250 mm, and Kobra S1 at 250 × 250 × 250 mm.

The seed keeps one direct product/variant URL per record. Examples of the
reviewed manufacturer pages include [Bambu PLA Matte Charcoal](https://us.store.bambulab.com/products/pla-matte-filament?id=43992833261787),
[PolyMax PETG](https://shop.polymaker.com/products/polymax-petg?variant=39574348169273),
[PolyMide PA6-GF](https://us-wholesale.polymaker.com/products/polymide-pa6-gf?variant=40556798083174),
[Prusament PLA Jet Black](https://www.prusa3d.com/product/prusament-pla-jet-black-1kg/),
[eSUN PETG](https://www.esun3d.com/petg-product/),
[SUNLU PLA Meta](https://www.sunlu.com/products/261), and
[OVERTURE High Speed PETG](https://overture3d.com/products/overture-high-speed-petg).
Collection pages may help a maintainer discover later products, but are not
used as evidence for an exact seeded identity or variant.

The PolyMide PA6-GF record uses the stable ID
`starter-filament-polymaker-polymide-pa6-gf-grey`, matching its reviewed Grey
colour. Stable IDs are part of catalog identity and are searchable; changing a
seed definition leaves existing rows and their append-only history untouched.

Each seeded product carries its source URL and review timestamp as
server-owned read-only provenance. Provenance is returned by catalog reads,
excluded from create/update schemas, and excluded from identity-field search.
When an identity or specification fact is corrected, its current provenance
is cleared until the corrected value is verified again, while the complete
superseded payload and provenance remain in append-only history. No-op updates
retain valid provenance.
The source links are observations, not a live lookup or an availability
claim; the catalog does not fetch arbitrary URLs.

## Catalog versus stock

Selecting a starter product is not the same as recording ownership. To add a
physical spool or printer, first search/read the catalog, then use the guided
exact inventory/profile command with an explicit evidence state. An agent must
still inspect or count the physical item before treating it as usable stock.
