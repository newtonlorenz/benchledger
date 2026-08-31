# Product roadmap

This roadmap records intentionally deferred work. It is not part of the first
private LAN deployment gate.

## Next feature tranche

### Agent workflow skill

Status: implemented and independently forward-validated with synthetic beginner
planning and expert close-out scenarios. The portable package lives in
[`skills/benchledger`](../skills/benchledger/SKILL.md), includes staged
lifecycle and ChatGPT/Claude/MCP client guidance, and defers to the live
capability resource when contracts evolve.

Create a portable skill for ChatGPT, Claude, and other MCP-capable agents that
teaches the full BenchLedger workflow: project intake, equipment and stock
discovery, BOM construction, reuse/inspect/buy decisions, reservations,
versioned artifacts, validation evidence, usage recording, and project close.
The skill should use the public MCP capability description rather than depend
on one model vendor or private instance data.

### Post-project inventory reconciliation

Status: implemented and release-verified. The close-out commits as one atomic
operation rather than a loose sequence of usage and reservation calls.

Add a guided project-close flow that starts from reservations and the approved
BOM, then records what was actually consumed, returned, damaged, left over, or
converted into a reusable asset. Nothing should be deducted automatically
without review. The resulting immutable stock events and physical observations
should improve future availability and purchasing recommendations.

### Precise filament selection

Status: implemented and release-verified. The additive exact-product foundation
preserves the existing inventory and never treats an inferred product match as
confirmed stock.

Add catalog-assisted autocomplete that selects an exact filament product and
physical spool rather than a generic material label. The record should support
manufacturer, product family, material/subtype, colour and code, diameter,
spool/net mass, estimated remaining mass or length, lot/batch, opened state,
drying history, location/AMS slot, and qualified printer/profile combinations.

### Precise printer and configuration selection

Status: implemented and release-verified. Printer identity, owned-machine state,
and immutable project build-configuration evidence are separate records so that
a later change to a printer does not rewrite an earlier project revision.

Add catalog-assisted printer selection down to manufacturer, exact model and
variant, followed by the active machine configuration: installed hotend/nozzle
and side, nozzle material/diameter, build plate, enclosure/accessories,
firmware, slicer/version/profile, and calibration state. Projects and artifact
releases should retain the selected configuration as versioned evidence.

## Proposed product and inventory tranche

### Self-service password change

Status: proposed.

Add a password-change action in Settings that verifies the current password,
validates and confirms the replacement, rotates it through a supported credential
store, and invalidates other active sessions. The UI must never expose or retain a
plaintext password or hash. Deployments whose password is owned by an external
secret store should show an explicit administrator rotation path instead of
claiming that an in-app change succeeded.

### Discoverable project creation

Status: partially implemented. The project API and Workbench “New project” dialog
exist, but project creation is not discoverable enough from the Projects journey.

Make “New project” a clear primary action on the Projects list and empty state as
well as the Workbench. After creation, open the new project and its initial
revision so the next action is obvious. Preserve entered values on failure and
provide a specific retry path.

### Managed categories and subcategories

Status: proposed. Inventory creation currently starts with a fixed, flat category
picker.

Add a Settings area for creating, renaming, ordering, nesting, and archiving
inventory categories and one level of subcategories. Use stable identifiers so a
rename does not rewrite inventory or evidence history. Prevent destructive removal
while records still use a category, or require an explicit reviewed migration.
The add-inventory flow must always require a category and offer the relevant
subcategory when one exists.

### Curated printer and filament catalog

Status: proposed catalog content; exact printer/filament product records and local
product creation are implemented.

Ship a versioned starter catalog covering the major current 3D-printer
manufacturers and models plus major filament brands and product lines. Printer
selection should start with manufacturer, model, and exact variant. Filament
selection should progressively choose brand/manufacturer, product line, material
family and subtype, colour and manufacturer code, diameter, and spool/net mass,
with the remaining typical spool details available before saving. Keep an
“unlisted/custom product” path. A preloaded catalog record is a reusable product
identity only; it never proves that the user owns the item or that stock is
currently available.

### Scalable inventory management

Status: proposed for the web UI. The application and MCP layers already expose
bounded cursor pagination.

Add server-backed pagination to Inventory with an explicit page size, next/previous
controls, result count, and stable search/filter state. Add row selection and a
reviewed bulk-edit flow for descriptive fields such as category, subcategory,
location, condition, and tags. Quantity changes must remain explicit stock events,
and bulk actions must not overwrite append-only evidence or audit history.

Simplify the default Inventory page by removing the summary bar for tracked items,
printers, filaments, and electronics. Remove the “Evidence source” table column;
retain provenance and evidence state in the item detail and expert/audit views.

### No-key online item lookup

Status: discovery spike.

Evaluate an online lookup that can suggest printer, filament, electronics, tool,
and consumable product details without requiring the user to supply an API key.
Prefer allow-listed manufacturer sources or openly licensed community datasets,
cache source attribution and observation time, and provide a reviewed manual URL
or metadata-import fallback. Suggested metadata must never create owned stock or
become confirmed evidence without user review.

Do not add unrestricted server-side URL fetching or brittle scraping. The spike
must cover source terms, attribution, rate limits, stale data, request timeouts,
SSRF protection, and graceful failure. If no sustainable no-key source has useful
coverage, ship the manual import fallback and document the limitation rather than
silently degrading lookup quality.
