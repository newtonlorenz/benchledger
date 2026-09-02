# Post-project inventory reconciliation

Status: implemented and release-verified on the private LAN deployment.

## Decision

Project close-out is a review-first aggregate with a draft and one explicit,
atomic commit. Creating or editing the draft changes no stock. The commit
settles reservations, appends stock events, creates any approved reusable
assets, writes audit evidence, and closes the reconciliation in one transaction.

The workflow must not compose the existing public usage and reservation
endpoints, because a failure between them could leave a partly closed project.

## Review outcomes

Start by listing reservations and identify the records whose status is
`active`. Only those active reservations need close-out outcomes. A reservation
can be divided between:

- consumed;
- returned or released intact;
- damaged or lost;
- usable leftover, with its measurement evidence;
- converted into a new reusable inventory asset.

Every active reservation must be fully and exactly accounted for in the same
unit before commit. BOM lines with zero active reservations may be omitted from
the submitted draft. If an agent or user submits one anyway, it may use the
explicit sole outcome `reviewed_no_change`; that outcome is optional and is not
selected by default. Released, consumed, and settled reservation history is
never erased by omitting a zero-reservation line.

## Evidence and safety

Each outcome carries its own evidence state, source, observation time, note,
condition, and optional uncertainty. Recording an estimated use does not promote
the whole inventory item to physically counted. A converted asset requires a
complete identity and a positive initial quantity.

The draft stores a hash of every BOM line, reservation, source item version,
and balance used as its basis, and the preview retains the same complete source
view even when the submitted lines cover only active reservations. Commit fails
closed when that basis has changed. A reservation may be settled once, and a
revision may have one committed reconciliation.
Command idempotency and deterministic event keys make retries safe.

## Interface

REST and MCP call one application service. The interface supports reading a
reconciliation, saving a version-checked draft, and explicitly committing it.
Project-scoped agents may use this bounded close-out flow but do not gain general
inventory-write authority.

The UI highlights active reservation-bearing requirements for review, shows
planned, reserved, and unaccounted quantities, and previews every stock change
before confirmation. Zero-reservation requirements remain visible in the full
preview but do not require individual review input.
Beginner mode uses plain-language outcomes; expert detail exposes ancestry,
versions, basis hash, evidence, event IDs, audit ID, and replay state.

## Implemented surface

- Project dossier **Close out** tab with focused active-reservation line review.
- Server-generated preview before the confirmation action is enabled.
- Atomic REST read, draft-save, and commit operations beneath a project revision.
- Matching MCP read, draft-save, and commit tools using bounded BOM scopes.
- Reservation-specific outcome allocation, including split outcomes and multiple
  reservations on one BOM line.
- Stable idempotency keys for ambiguous browser retries, stale-basis rejection,
  immutable stock events, reusable-asset creation, and an auditable receipt.

The release was promoted only after a verified production backup and separate
restore check, a healthy container upgrade, preserved inventory/project counts,
reconciliation-table migration, and read-only neighbour-service verification.
