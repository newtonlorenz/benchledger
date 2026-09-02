# BenchLedger lifecycle playbook

Use only the section matching the project's current stage. The names below are
the current reference tools; verify them against `benchledger://capabilities`
before calling them.

## 1. Intake and scope

- Clarify the intended outcome, quantity, target life, relevant environment,
  safety consequence, and what would make the project successful.
- Read an existing project/revision before creating anything. For a new build,
  prefer `create_project_with_initial_revision` so both records are atomic.
- Create work items only for independently revised deliverables such as a
  printed part, electronics assembly, firmware unit, drawing, or validation
  document.
- Current planning is revision/work-item/BOM based. Do not invent milestone,
  dependency, calendar, or task-scheduler records that BenchLedger does not
  expose.

Output: the active project/revision, material unknowns, safety/fit blockers, and
the next decision. Do not fabricate dimensions or electrical requirements.

## 2. Discover inventory and exact equipment

Call `refresh_context`, then read the bounded inventory summary and pages. Read
individual items when dimensions, condition, location, stock history, or links
affect the decision.

For printers and filament:

1. `search_catalog_products` / `read_catalog_product` identifies an exact
   manufacturer product or machine model; it does not prove ownership.
2. `read_inventory_item` identifies a physical owned item and its availability.
3. `read_inventory_product_profile` supplies the exact product link and its
   `confirmed`, `reported`, or `suggested` state when the token has global
   catalog access. A project-scoped token cannot read physical product
   profiles: keep the exact link unknown/inspect-first and ask an authorized
   catalog reader or the user to confirm it. Do not widen the token silently.
4. Use `create_inventory_with_product_profile` only when intentionally creating
   a new physical item and exact profile together. Do not infer an exact link
   from a legacy name.

Output three groups: confirmed usable, inspect first, and absent/unknown. State
which physical or compatibility check would promote an inspect-first candidate.
A confirmed count proves quantity, not suitability: for example, a counted
power supply remains inspect-first for a BOM line until voltage, current,
polarity, connector, dimensions, and condition meet that line's constraints.

## 3. Project and revision structure

- Read and write project lifecycle only as `idea`, `planned`, `ready`,
  `building`, `validating`, `complete`, or `archived`. Report structured
  `blocked` reasons separately; do not persist `blocked` as lifecycle.
- A lifecycle change is an intent/progress update, not manufacturing evidence.
  Never infer or reset CAD, DFAM, mesh, slicer, test-print, fit/function, or
  production approval state from it.
- Use the current planning revision as the BOM basis.
- For a new project, retain the project and initial revision returned by the
  atomic create operation. For an existing project, read its current revision
  before deciding whether a later planning baseline is needed.

For a complete graph, prefer the review-first atomic setup pair:

1. `preview_project_setup` with one project/initial revision, 0–6 work items,
   1–24 BOM lines, and 0–48 reservations (unique local references; 256 KiB
   payload limit)
2. Inspect normalized IDs, semantic errors, unresolved specifications, gap
   candidates/totals, inventory basis, and planned reservations
3. `commit_project_setup` with the same preview ID/version/hash and
   `confirmReservations: true` when reservations are planned; use a distinct
   8–200 character idempotency key

Preview persists only actor-owned bounded metadata for 30 minutes. Commit
rechecks identity and inventory basis in one transaction; a stale 409 requires
a fresh preview. Identical same-actor retries replay safely.
- Create work items and their revisions only for independently versioned
  deliverables. Do not create a new project revision merely to edit an
  unchanged draft.

Output: the active project, planning revision, independently versioned work
items, and explicit planning unknowns.

## 4. BOM evaluation, reuse, and reservations

- Add one `create_bom_line` per real requirement. Use an exact `itemId` only for
  a known compatible physical item; otherwise express constraints and
  evidence-bearing alternatives.
- Run `calculate_bom_gaps` after meaningful BOM or inventory changes.
- Classify each line as supplied, inspect first, partial, missing, optional, or
  substitute. Explain the evidence and compatibility reason.
- Reserve only confirmed compatible stock with `create_reservation`. Re-read
  gaps afterward so other allocations are reflected.

Output: confirmed reuse, inspections needed, missing quantity, optional choices,
and reservations created. Do not reserve uncertain stock.

For a connected revision, resolve the derived inspection queue one action at a
time. Call `GET /api/v1/project-revisions/{revisionId}/inspections` and read
the selected `.../inspections/{inspectionId}` action. Record the observation
with its source and observed time through
`POST .../inspections/{inspectionId}/completion-preview`; the returned server
preview is review-only. For confirmed compatibility, record the explicit
compatibility result and evidence. For unit conversion, record the explicit
factor, basis, source, and observed time; never infer either result. Show exact
affected-line before/after changes, unit coverage, basis/version, and resulting
state, then ask for explicit human confirmation before
`POST .../inspections/{inspectionId}/completion-commit`. A commit must carry
the returned preview ID/version/content hash and `confirmed: true`. The MCP
list/read/preview/commit tools expose the same result with nested REST `each`
quantities and conversions mapped to MCP `piece`, including before/after
items/gaps, affected and reevaluated gaps, refreshed inspections, and evidence.
Authorization remains project-scoped and fail-closed; there is no quick-complete
operation.

## 5. Shopping proposal

Use `list_offers` for existing observations and `record_offer_snapshot` only
when the user supplied or authorized recording a source observation. BenchLedger
does not fetch arbitrary URLs or purchase.

For every proposed purchase show supplier, source URL, package quantity, package
rounding, item and shipping price when known, currency, observation time, and
whether the offer may now be stale. Keep required, optional, substitute,
inspect-first, and already-supplied lines separate.

Stop at a proposal unless the user explicitly authorizes a separate purchasing
surface. BenchLedger itself has no cart or purchase operation.

## 6. Build configuration and files

Before treating a revision as a reproducible build, create an immutable
`create_build_configuration` snapshot from the exact physical printer and
filament selections. Record active hotend/nozzle and side, plate, accessories,
firmware, slicer/version/profile, calibration, and explicit unknowns. A
correction creates a superseding snapshot; it never edits history.

Upload source, CAD, STEP/STL/3MF, slicer project, drawing, firmware, validation,
or document artifacts through the authenticated browser/HTTP Files surface:

1. choose exactly one project revision or work-item revision in the File scope
   picker; the all-files view is read-only;
2. use the file role shown in the upload status;
3. let the browser hash the bytes while the application runs its existing
   begin/write/finalize flow;
4. review the returned artifact metadata without overwriting an older revision.

Generic MCP does not expose upload sessions or transfer capabilities: its raw
`begin_artifact_upload`, `finalize_artifact_upload`, and download tools fail
closed. Never send binary files as base64 MCP payloads, reveal transfer tokens,
use host paths, execute an upload, or replace evidence from an older revision.
Atomic 50-file transfers and download-to-host remain deferred.

Output: revision binding, role, filename, byte length, SHA-256, and build-
configuration hash/unknowns.

## 7. Build and validation evidence

Record observed counts, compatibility, measurements, fit results, failures,
condition, and actual process state as evidence. Keep digital, slicer, test-print,
and physical acceptance states distinct. A project note or BOM plan is not proof
that a print ran or a part passed.

Use direct `record_usage` or `record_stock_event` only for a deliberate narrow
event outside project close-out. Prefer the atomic reconciliation flow below for
normal post-project settlement.

## 8. Atomic post-project reconciliation

1. `list_reservations` for the active project revision and identify every
   reservation whose status is `active`, then call `read_reconciliation`. No
   draft is a normal starting state.
2. Review each BOM line with an active reservation and account for every active
   reservation. Split a reservation when quantities had different outcomes.
3. Choose explicit outcomes: `consumed`, `returned`, `damaged_lost`,
   `usable_leftover`, or `converted_asset`. Each outcome needs quantity, unit,
   reservation/item identity, and evidence. A converted asset also needs the
   inventory fields advertised by the live tool schema: at minimum name, kind,
   positive starting quantity, canonical unit, tags, links, and evidence. Its
   enclosing BOM-line, reservation, and source-item references are the source
   lineage retained in the reconciliation; use the evidence source/source ID
   when an additional build-log or artifact reference matters.
4. BOM lines with zero active reservations may be omitted from the submitted
   draft. If one is submitted, `reviewed_no_change` is an optional explicit
   sole outcome for that line; it is invalid for an untouched active
   reservation.
5. `save_reconciliation_draft` to obtain the server-calculated preview. This
   changes no stock or reservations. The preview and staleness basis still
   retain every BOM line, reservation, and source inventory item, including
   omitted zero-reservation lines and historical reservation states.
6. Present the exact reservation settlements, stock deltas, created assets, and
   remaining uncertainty. Ask for explicit confirmation.
7. Only after confirmation, call `commit_reconciliation` with the returned
   draft ID/version. A draft save and its later commit are distinct commands
   and must not share an idempotency key. If the client or transport exposes
   command idempotency, retry an ambiguous save or commit with that command's
   own original key and identical payload. The commit is atomic and cannot be
   replaced by a loose series of usage and release calls.
8. Refresh project and inventory context. If refresh fails after a successful
   commit, report the commit as successful and the refresh as a separate issue.

If the BOM, reservation, item version, or balance changed, the basis is stale.
Read again and rebuild the draft; do not force it through.

Outcome-to-stock semantics:

| Outcome | Reservation | Source stock | New item |
| --- | --- | --- | --- |
| `consumed` | settled/released | quantity removed | none |
| `returned` | settled/released | on-hand retained; quantity becomes available again | none |
| `usable_leftover` | settled/released | on-hand retained; quantity becomes available again | none |
| `damaged_lost` | settled/released | quantity removed as loss | none |
| `converted_asset` | settled/released | source quantity removed | one reusable inventory item |
| `reviewed_no_change` | only valid with no active reservation | no change | none |

`returned` means the reserved item came back intact; `usable_leftover` records a
usable remainder of a consumed material or package. Their numeric stock effect
is intentionally the same. Always present the server preview as authoritative.

Output: consumed, returned/released, lost/damaged, reusable leftovers/assets,
unresolved physical checks, stock event IDs, reconciliation basis/audit evidence,
and the exact next action.

## Handoff checklist

Before finishing, make the achieved state unambiguous:

- project/revision and current lifecycle stage;
- confirmed reuse versus inspect-first versus buy;
- reservations and remaining gaps;
- exact printer/filament/build configuration and explicit unknowns;
- artifact identities and hashes;
- whether reconciliation is absent, draft-previewed, or committed;
- what was written, what remains only proposed, and what still needs human or
  physical verification.
