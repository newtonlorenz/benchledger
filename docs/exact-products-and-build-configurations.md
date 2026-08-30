# Exact products and build configurations

Status: implemented and release-verified.

## Decision

BenchLedger keeps three identities separate:

1. A catalog product describes an exact manufacturer product or machine model.
2. An inventory product profile links that product to one physical spool or
   printer owned by the user.
3. A build-configuration snapshot copies the exact setup used by a project
   revision and cannot be edited in place.

This separation prevents a product match from becoming false evidence about
remaining stock, physical condition, compatibility, or print qualification.

## Catalog products

The first catalog kinds are `filament` and `printer`. Catalog values use
canonical millimetres, grams, and metres. Filament length is descriptive and
records whether it was manufacturer-declared, calculated, or unknown; stock
accounting remains mass-led.

Catalog records are local to an installation. They may be created or corrected
by a user or authorized agent with optimistic version checks. The first release
does not scrape suppliers or maintain a global crowdsourced catalog.

## Physical inventory profiles

An inventory profile links an existing inventory item to one exact catalog
product. Links are `confirmed`, `reported`, or `suggested`. Only a confirmed
link may support exact-product compatibility; a reported or suggested link
remains evidence that must be checked.

A filament-spool profile may record lot or batch, sealed/open state, opened
date, tare mass, and current placement. A printer-asset profile may record a
local asset label and commissioning date. Serial numbers are not exposed by
default.

The original 53 inventory records remain valid without profiles. The migration
does not parse their names, change quantities, convert spool counts to grams,
or rewrite provenance. Users can confirm the seven legacy filament records and
two printers through a later guided flow.

The delivered interface supports exact catalog selection, atomic creation of a
physical inventory item plus its product profile, and reload-safe hydration of
those links. Ambiguous browser retries reuse one logical command rather than
creating duplicate physical records.

## Immutable project setup

A project build-configuration snapshot copies the selected printer and filament
facts together with hotend side, nozzle diameter and material, build plate,
accessories, firmware, slicer/version/profile, calibration state, and explicit
unknowns. Its content hash is calculated deterministically by the service.

Corrections create a superseding snapshot. Existing snapshots have no update or
delete operation. Artifacts may bind to a snapshot only when project and
revision ancestry match.

The browser project flow captures and reloads the latest immutable setup,
supports beginner and expert summaries, and binds uploaded project files to the
same revision's snapshot. The content hash describes setup content rather than
record IDs or project lineage.

## Agent boundary

REST and MCP call the same application services. Catalog and physical-profile
writes require global catalog scope; project-scoped agents may read catalog data
and create snapshots only inside their allowed projects. Agents must not infer
an exact product link from a legacy name or convert an unconfirmed link into
available stock.
