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
