---
name: benchledger
description: Plan, source, document, and close 3D-printing or electronics projects against evidence-backed BenchLedger inventory through MCP/API. Use when a maker project needs equipment, exact printer/filament setup, BOM reuse and gaps, supplier options, versioned files, or post-build stock reconciliation.
---

# BenchLedger

Use BenchLedger as the shared inventory and project record, not merely a parts
list. Keep equipment, exact consumables, BOM decisions, supplier observations,
revisioned files, build configuration, validation evidence, and actual usage
connected from project intake through close-out.

## Discover the connected instance

Before recommending or writing, read `benchledger://capabilities`. It is the
authoritative contract for available tools, scopes, resources, and approval
boundaries. If this skill and the live capability document differ, follow the
live contract and explain the mismatch briefly.

Useful repository references when source is available:

- `apps/mcp/AGENTS.md` — technical MCP quickstart;
- `docs/capability-map.md` — tool/resource and UI parity;
- `docs/stock-evidence-semantics.md` — availability and evidence meanings.

## Choose the current stage

Do not restart a mature project at intake or force every stage into one turn.
Read the current project/revision state, identify the next incomplete decision,
and perform only the work needed for the user's request.

1. Intake and safety scope.
2. Inventory, equipment, and exact-product discovery.
3. Project/revision/work-item setup.
4. BOM evaluation, reuse, inspection, and reservations.
5. Shopping proposal and supplier observations.
6. Immutable build configuration and revisioned artifacts.
7. Build evidence and validation observations.
8. Review-only close-out preview and explicit atomic reconciliation.

Project lifecycle is one canonical value on every surface:
`idea`, `planned`, `ready`, `building`, `validating`, `complete`, `archived`.
Treat `blocked` as a derived condition with structured reasons, never as a
project status. Keep project lifecycle independent from revision-scoped
manufacturing evidence (`concept` through `production approved`); changing one
does not prove, advance, or reset the other. Legacy lifecycle names are read-
migration inputs only and must not be sent in new commands.

For the tool choices, outputs, and stopping conditions at each stage, read
[references/lifecycle.md](references/lifecycle.md). For ChatGPT, Claude, Codex,
or another MCP host, read [references/client-setup.md](references/client-setup.md)
only when configuring or packaging the integration.

## Non-negotiable decision rules

- An order, shipment, delivery, imported purchase, or old price is evidence,
  not proof of current usable quantity.
- Reuse automatically only when the exact physical item, quantity, unit,
  condition, compatibility, evidence, and project context support it.
- Stock evidence and BOM compatibility are separate decisions. A physically
  counted item can still be **inspect first** for a BOM line until its voltage,
  connector, dimensions, material, or other relevant constraints are proven.
- Put plausible but unconfirmed candidates in **inspect first**. Do not reserve
  or consume them to make a gap disappear.
- Resolve a derived project check as a review-first action: list/read the
  revision-scoped inspection, submit its observation for a server completion
  preview, show that preview, and ask for explicit confirmation before commit.
  Never use a quick-complete shortcut or infer evidence from a name, photo, or
  delivery record. Keep action ID, affected line/item versions, evidence
  source, canonical predicate/unit, and effects available for expert review.
- Keep these identities separate: catalog product, physical inventory item,
  product profile/link state, and immutable project build configuration.
- Prefer exact printer model/configuration, filament product and spool, nozzle,
  plate, lot/batch, part number, dimensions, supplier observation, and price
  date over generic labels. A `reported` or `suggested` product link is not a
  confirmed match.
- A reservation is not consumption. Planned BOM quantity is not actual usage.
- Never purchase, add to cart, publish, start/heat a printer, submit a print,
  flash firmware, delete history, or overwrite retained artifacts without
  fresh explicit approval.
- Treat a close-out draft as review-only. Show the server preview and obtain
  explicit confirmation before `commit_reconciliation`.
- On an ambiguous write retry, reuse the same idempotency key and identical
  payload when the client or transport exposes command idempotency. Every
  distinct write—including draft save and commit—uses a different key. A
  changed intention or payload is a new command with a new key.
- On a version, ancestry, or stale-basis conflict, read current state again;
  never force an overwrite.

## Response style

For a beginner, lead with the decision and one next action:

```text
You can build this with confirmed stock except for:
- inspect first: ...
- buy: ...
- optional: ...
Next action: ...
```

Reveal expert traceability only when requested or decision-relevant: project and
revision IDs, exact item/product/profile IDs, quantities and canonical units,
evidence source/age, compatibility reasons, reservation IDs, build-configuration
hash, artifact SHA-256, offer observation date, reconciliation basis, event IDs,
and audit ID.

## Missing context

Ask only for facts that materially change safety, compatibility, availability,
or the purchase recommendation: consequence of failure, loads, fit-critical
measurements, voltage/current/connector requirements, material/process limits,
exact printer state, or a missing physical count. Otherwise proceed with an
explicit assumption and keep the affected requirement inspect-first.

BenchLedger records evidence; it does not prove that a CAD part is slicer
validated, physically tested, electrically safe, or fit/function verified.
Follow the active fabrication repository's engineering and approval rules too.
