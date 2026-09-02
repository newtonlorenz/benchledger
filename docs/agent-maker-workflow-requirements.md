---
title: Agent-first maker workflow requirements
status: proposed
audience: AI product owner, architect, developer, reviewer, QA agent
product: BenchLedger
target_release: post-0.1 incremental tranches
source_evidence: sanitized agent workflow review, 2026-08-31
---

# Agent-first maker workflow requirements

## 1. Executive decision

BenchLedger's evidence-first domain model is the correct foundation for agent-assisted
3D-printing and electronics work. The next product tranche should preserve that model
while reducing the number of low-level calls, making failures actionable, exposing
complete read-back paths, and adding maker-specific build planning.

The desired outcome is:

> An AI agent can safely set up, inspect, and hand off a realistic multi-part maker
> project in a small number of idempotent operations, without inventing stock,
> compatibility, dimensions, manufacturing evidence, or purchase authority.

Implementation should proceed in five ordered tranches:

1. **P0 reliability:** structured errors, compact discovery, transactional setup,
   truthful summaries, and complete list/read surfaces.
2. **P0 atomic setup:** preview and commit a complete, conflict-checked project graph.
3. **P1 maker decisions:** structured search, specification blockers, maker inventory
   profiles, and 3D build plans/manufacturing evidence.
4. **P1 file workflow:** agent-safe, batch-capable artifact transfer that retains the
   current security boundary.
5. **P2 guided workflow:** inspection queues, templates, and progressive UI/MCP parity.

Do not implement all requirements as one large refactor. Preserve the modular-monolith
boundaries and deliver independently testable vertical slices through domain,
application, API, MCP, server, web, documentation, and the portable skill.

## 2. How an implementation agent should use this document

- Treat every `REQ-*` identifier as independently traceable work.
- Reproduce the related `OBS-*` evidence against the current source before changing
  behavior. The private deployment that produced the observation may lag the branch.
- If current source already satisfies a requirement, add or strengthen the public
  contract, regression test, and documentation rather than duplicating behavior.
- Write the smallest failing test first, then implement the shared application/domain
  behavior before adapting HTTP, MCP, or UI surfaces.
- Keep fixtures synthetic. Do not copy private inventory, project names, identifiers,
  artifacts, supplier history, paths, hosts, or credentials into the repository.
- Do not broaden purchasing, printer-control, execution, deployment, credential, or
  destructive-data authority.

## 3. Product principles to preserve

The following are invariants, not negotiable implementation details:

1. Delivery and order evidence never become current usable stock without a physical
   count or commissioning record.
2. Stock evidence and BOM compatibility remain separate decisions.
3. Catalog product, physical item, product profile, reservation, build configuration,
   and artifact revision remain distinct identities.
4. Reservations are planned allocations, not consumption.
5. Build configuration snapshots and accepted artifacts are immutable; corrections
   supersede rather than rewrite history.
6. Digital CAD, slicer validation, test printing, physical fit, and production approval
   remain distinct evidence states.
7. Beginner output stays concise; expert identifiers and evidence remain available.
8. The web, HTTP, and MCP surfaces use the same application behavior.
9. All list operations remain bounded and paginated.
10. Human approval remains required for purchases, printing, heating, firmware,
    physical validation, publishing, deployment, credentials, and destructive cleanup.

## 4. Sanitized workflow evidence

These observations came from setting up a representative multi-plate H2D sculpture
project against a private BenchLedger instance. They contain no private record data.

| ID | Observation | Product risk |
| --- | --- | --- |
| `OBS-01` | `create_project_with_initial_revision` returned only a generic backend error for a realistic description; the agent had to check for a partial commit and fall back to separate writes. | Duplicate or partial project setup; poor recovery. |
| `OBS-02` | A detailed project-revision summary failed while a very short summary succeeded, behaving like an undocumented text constraint. | Agents cannot correct requests deterministically. |
| `OBS-03` | Full capability discovery produced roughly 28k tokens and was truncated by the client. | High latency/cost and incomplete contract discovery. |
| `OBS-04` | Free-text inventory search produced false positives for `LED`, missed a hyphenated heat-shrink item, and missed a multi-token PETG manufacturer query. | Agents overlook stock or present irrelevant candidates. |
| `OBS-05` | Reserving three confirmed spools reduced the summary's confirmed-item count without exposing a corresponding allocated/reserved count. | Availability changes appear as disappearing inventory. |
| `OBS-06` | Gap totals counted an optional BOM line in a total labelled required. | Shopping and readiness summaries become misleading. |
| `OBS-07` | The agent could create work items and reservations but MCP exposed no corresponding bounded list tools. | Created state is difficult to rediscover or audit. |
| `OBS-08` | Secure artifact sessions existed, but the desktop agent had no approved host-mediated way to transfer local CAD/3MF files. | Project setup cannot attach its actual engineering packet. |
| `OBS-09` | A realistic setup required approximately 30 individual mutating calls. | Excess round trips and material partial-failure risk. |
| `OBS-10` | An LED stock record mixed package count and individual-unit count in descriptive text. | BOM quantity and purchase recommendations can be wrong. |

## 5. Current baseline to preserve

As of the 2026-08-31 local source and live capability contract, BenchLedger already
has important agent-safe foundations that must be reused, not rebuilt in parallel:

- bounded inventory, catalog, project, BOM, reconciliation, build-configuration,
  artifact, offer, and context tool families;
- exact catalog/product-profile separation for printers and filament;
- immutable build-configuration snapshots for exact printer/material setup;
- header-bound short-lived artifact upload/download capabilities that keep binary
  bytes out of MCP messages and keep transfer tokens out of URLs;
- project-scoped ancestry checks for indirect project identifiers;
- review-only reconciliation drafts followed by explicit commit;
- public docs and tests for privacy boundaries, capability parity, stock evidence,
  exact products, build configurations, and post-project reconciliation.

The requirements below focus on the remaining gaps: compact discovery, better
errors, fewer setup round trips, hierarchical project read-back, search/quantity
quality, build plans above build-configuration snapshots, host-mediated batch file
staging, and guided inspection/template workflows.

## 6. Success measures

The tranche is successful when all of the following are true:

- A new hybrid 3D/electronics project with three work items, twenty BOM lines, and
  confirmed reservations can be previewed, committed, and verified in no more than
  five logical MCP calls after context refresh.
- No expected validation failure returns a generic `BACKEND_ERROR`.
- Every mutating command communicates whether it committed, did not commit, or has an
  ambiguous result that must be replayed with the same command key.
- Default capability discovery fits within 12 KiB of JSON and never duplicates every
  full input schema.
- Search regression fixtures pass the `LED`, hyphen normalization, and multi-token
  manufacturer/material scenarios in `OBS-04`.
- Inventory and BOM summaries reconcile exactly with their detail rows before and
  after reservations.
- Every create operation has a bounded list/read-back route available to the same
  authorized project scope.
- A 50-file synthetic CAD packet can be staged and finalized without base64 MCP
  payloads, arbitrary host paths, query-string tokens, or executable-file handling.
- A build plan can represent multiple plates, repeated parts, material roles, exact
  spool selections, nozzle/side, and manufacturing evidence without calling a printer.
- `npm run public:check` and `npm run check` pass with the existing coverage gates.

## 7. Requirement index

| Requirement | Priority | Outcome | Primary surfaces |
| --- | --- | --- | --- |
| `REQ-001` | P0 | Actionable errors and explicit command replay | API contract, application, MCP, server |
| `REQ-002` | P0 | Compact, cacheable capability discovery | MCP, server, docs, skill |
| `REQ-003` | P0 | Previewable atomic project setup | Domain, application, database/runtime, API, MCP, web |
| `REQ-004` | P0 | Truthful inventory and BOM summaries | Domain, application, runtime, API, MCP, web |
| `REQ-005` | P0 | Complete list/read-back surfaces | Application, API, MCP, server, web |
| `REQ-006` | P1 | Predictable structured inventory search | Domain/application query model, runtime/database, MCP, web |
| `REQ-007` | P1 | Distinguish missing stock from missing specification | Domain, application, API, MCP, web |
| `REQ-008` | P1 | Maker-specific quantity and profile semantics | Domain, database, importers, API, web |
| `REQ-009` | P1 | Multi-plate build plans and manufacturing evidence | Domain, application, API, MCP, web, artifacts |
| `REQ-010` | P1 | Agent-safe batch artifact ingestion | Artifacts, application, server, MCP host integration, web |
| `REQ-011` | P2 | Derived physical-inspection queue | Application, API, MCP, web |
| `REQ-012` | P2 | Safe maker project templates | Application, API, MCP, web, docs, skill |

## 8. Detailed requirements

### REQ-001 — Actionable errors and explicit command replay

**User story:** As an agent, when a write fails, I need to know which input is wrong,
whether anything committed, and whether the same request should be replayed.

#### Contract

Every error returned by HTTP and MCP must use a shared public structure:

```json
{
  "error": {
    "code": "FIELD_TOO_LONG",
    "message": "revisionSummary must contain at most 1000 characters",
    "field": "revisionSummary",
    "limit": 1000,
    "retryable": false,
    "commitState": "not_committed",
    "commandId": "synthetic-command-id",
    "correlationId": "synthetic-correlation-id"
  }
}
```

Requirements:

- Publish `minLength`, `maxLength`, enum, range, and item-count limits in shared schemas.
- Map validation, conflict, not-found, forbidden, integrity, storage, timeout, and
  transport failures to distinct public codes.
- Never return internal stack traces, SQL, paths, tokens, or private configuration.
- Return `commitState` as `not_committed`, `committed`, or `unknown`.
- Expose one stable command/idempotency identifier through MCP metadata or the public
  command schema and echo it in success and error responses.
- Replaying an ambiguous command with the same identifier and identical payload must
  return the original result; changing the payload must be rejected.
- Project creation and initial revision creation must remain atomic.

#### Acceptance criteria

1. Given a summary one character beyond the limit, the response identifies the field
   and limit and reports `not_committed`.
2. Given an injected failure after project creation but before revision/audit commit,
   neither record remains visible.
3. Given a simulated lost response after a successful commit, an identical retry
   returns the original IDs and does not create duplicates.
4. Given a changed payload with a reused command ID, the server returns a conflict.
5. MCP, OpenAPI, and application tests assert equivalent error semantics.

#### Likely ownership

`packages/api-contract`, `packages/application`, durable adapters, `apps/server`,
`apps/mcp`, capability documentation, and the portable skill.

### REQ-002 — Compact, cacheable capability discovery

**User story:** As an agent, I need to discover safety rules and available operations
without loading the entire schema catalog into context.

#### Contract

- Make compact capability discovery the default.
- Compact output includes contract version/hash, scopes, tool families, resource
  templates, canonical units, stock states, approval boundaries, and links/identifiers
  for detailed schemas.
- Add a bounded `get_tool_schema(toolName)` operation or equivalent resource.
- Retain a full capability document for debugging and compatibility, but do not require
  agents to read it before every ordinary operation when the contract hash is unchanged.
- Return `contractHash` and document cache/revalidation behavior.
- Keep MCP `tools/list` authoritative for callable tool input schemas.

#### Acceptance criteria

1. Compact discovery is no larger than 12 KiB of serialized JSON.
2. An agent can retrieve the complete schema and examples for one named tool without
   receiving unrelated tool schemas.
3. An unchanged contract hash permits cached capability use followed by normal
   `refresh_context`.
4. Approval boundaries and stock semantics remain available in compact output.

### REQ-003 — Previewable atomic project setup

**User story:** As an agent, I want to construct a complete project plan as one reviewed
transaction rather than dozens of independent writes.

#### Contract

Add a two-step workflow:

1. `preview_project_setup` validates and normalizes a proposed project, initial
   revision, independently versioned work items/revisions, BOM lines, and optional
   confirmed-stock reservations without changing project or inventory state.
2. `commit_project_setup` atomically commits the exact preview basis with optimistic
   conflict checks and command replay protection.

The preview must return:

- normalized project/revision/work-item/BOM structures;
- field errors and unresolved specifications;
- candidate inventory matches and compatibility reasons;
- projected supplied/inspect/specify/missing/optional totals;
- reservations that would be created;
- affected inventory versions;
- a preview ID, version, expiry, and content hash.

The commit must return all created IDs, versions, reservations, audit IDs, and an
initial context/gap summary. No child record may survive a failed commit.

#### Acceptance criteria

1. A representative 3-work-item/20-BOM-line plan previews without domain mutation.
2. Commit creates the entire graph and reservations in one unit of work.
3. Any invalid reservation or injected child-write failure rolls back the whole setup.
4. A stock/version change after preview causes a stale-basis conflict, not a forced
   commit.
5. Existing granular tools remain available for incremental edits.
6. UI and MCP invoke the same application command.

### REQ-004 — Truthful inventory and BOM summaries

**User story:** As a person or agent, I need summary numbers to reconcile with detail
rows and explain the effect of reservations.

#### Inventory summary

Expose at least:

- `totalItems`;
- `physicallyConfirmedItems`;
- `availableConfirmedItems`;
- `allocatedItems` and allocation quantity by canonical unit;
- `deliveredUncountedItems`;
- `orderedUnverifiedItems`;
- `depletedItems` and `retiredItems`;
- category counts and evidence age where bounded.

Reserving stock must not reduce the historical physically-confirmed count. It must
reduce available quantity and increase allocated quantity.

#### BOM-gap summary

Expose separate counts for:

- required and optional lines;
- supplied, inspect-first, specify-first, partial, missing, and optional outcomes;
- quantities and shortfalls by canonical unit where aggregation is meaningful.

Do not label all lines as required. Totals must be derivable from returned detail rows.

#### Acceptance criteria

1. Before and after reserving three items, inventory summary deltas reconcile exactly.
2. One optional line increments `optionalLines`, never `requiredLines`.
3. Property-based or table-driven tests compare detail classification with totals.
4. Web, HTTP, MCP, and project context display the same counts and labels.

### REQ-005 — Complete list/read-back surfaces

**User story:** As an agent, I need to rediscover and verify every record I create.

#### Contract

The current contract already exposes individual reads for projects, work items,
project revisions, work-item revisions, BOM lines, build configurations, artifacts,
and reconciliation. Add the missing bounded, cursor-paginated graph reads for:

- project revisions by project;
- work items by project;
- work-item revisions by work item;
- reservations by project revision, with optional status/BOM-line/item filters;
- project setup previews owned by the authorized actor;
- inspection actions and build plans introduced by later requirements.

Create and read responses must retain the submitted human-readable summary,
timestamps, current/latest revision pointers, versions, and audit/correlation IDs where
appropriate.

Existing application-service list operations must be exposed rather than reimplemented
inside MCP or HTTP adapters.

#### Acceptance criteria

1. A fresh client can discover every work item and active reservation using only the
   project ID and bounded pagination.
2. Project-scoped tokens see only allow-listed ancestry.
3. A created revision summary is present in its create response and subsequent read.
4. List ordering and cursor behavior are deterministic and documented.

### REQ-006 — Predictable structured inventory search

**User story:** As an agent, I need search results to be explainable and robust to
punctuation, manufacturer filler words, and common maker terminology.

#### Contract

- Normalize case, Unicode, spaces, and punctuation/hyphens.
- Use token-aware matching; a token `LED` must not match a substring inside
  `delivered` or an unrelated manufacturer name.
- Multi-token queries use documented AND/ranking semantics so a query such as
  `Bambu PETG` can match `Bambu Lab PETG Basic`.
- Search identifiers, canonical names, manufacturer, model, SKU, tags, aliases, and
  relevant structured profile fields.
- Return `matchedFields`, normalized terms, compatibility-neutral score/rank, and a
  short match reason.
- Do not equate search relevance with BOM compatibility or stock confirmation.
- Add structured filters for category/kind, manufacturer, model, material family,
  colour, electrical values, connector, dimensions, availability, evidence, location,
  and tag as the underlying profile supports them.

#### Acceptance criteria

1. `LED` returns synthetic LED items and does not match `delivered` text.
2. `heatshrink` matches `heat-shrink` names and identifiers.
3. `Bambu PETG` matches the intended synthetic product despite the intervening word.
4. Every result states which fields matched.
5. Search tests run against both in-memory/runtime and durable database adapters.

### REQ-007 — Distinguish missing stock from missing specification

**User story:** As an agent, I must not recommend buying an unspecified component merely
because no current inventory name matches it.

#### Contract

Add a BOM decision state such as `specify_first` for requirements that lack fields
needed to determine compatibility or purchasing suitability. Examples include:

- LED driver before voltage/current/channel/load are known;
- power supply before maximum load, connector, cable, and margin are defined;
- panel connector before measured cutout and retention method are defined;
- fastener before thread, length, head, material, and engagement are defined.

`missing` means the specification is sufficiently frozen and no compatible confirmed
or inspect-first stock covers the requirement. Only `missing` may default to a `buy`
recommendation. `specify_first` recommends `specify` or `measure`.

Compatibility fields must be structured where practical: electrical limits, connector,
dimensions/uncertainty, material, colour, machine/process, load, environment, and
required evidence.

#### Acceptance criteria

1. An under-specified power line evaluates as `specify_first`, not `missing`.
2. Supplying the required electrical and connector constraints causes reevaluation
   against inventory and may then yield inspect-first or missing.
3. Shopping proposals exclude `specify_first` lines from required purchases.
4. Beginner output gives one concrete next measurement or decision.

### REQ-008 — Maker-specific quantity and profile semantics

**User story:** As a maker, I need the ledger to distinguish packages, individual
components, reusable tools, and continuously consumed material.

#### Additive profile model

Provide typed, extensible profiles rather than overloading the base inventory row:

- **Packaged components:** package count, units per package, counted loose units,
  count basis, uncertainty, and conversion history.
- **Filament spool:** exact product, nominal/tare/current mass, remaining-mass basis and
  uncertainty, lot/batch, opened/sealed state, drying history, placement/AMS slot, and
  qualified process links.
- **Electronics:** part number, package/variant, voltage/current/logic limits, pinout or
  connector, dimensions/source/uncertainty, and allocation.
- **Tools/printers:** condition, commissioning, maintenance/calibration state and due
  date, installed accessories, and reusable assignment rather than consumption.
- **Consumables/adhesives/finishes:** container quantity, remaining estimate,
  opened/expiry state, substrate compatibility evidence, storage and safety notes.
- **Fasteners/assortments:** thread/diameter, length, head, material, finish, count, and
  sub-bin or kit membership.

Reservations and reconciliation must work in canonical usable units. A filament BOM
may reserve grams from a physical spool without consuming the whole spool record.

#### Acceptance criteria

1. A synthetic two-pack of forty LEDs is represented as 80 potential units while its
   evidence can remain delivered-uncounted until physically counted.
2. A 1 kg filament spool can reserve 320 g, retain the spool identity, and reconcile
   consumed and usable-leftover mass.
3. Assigning a printer to a project does not model the printer as a consumed unit.
4. Legacy inventory remains readable through an explicit unknown/generic profile.

### REQ-009 — Multi-plate build plans and manufacturing evidence

**User story:** As an agent managing a 3D project, I need to connect the project BOM,
exact machine/material configuration, files, plate layouts, and validation gates.

#### Build-plan aggregate

The existing immutable build-configuration snapshot records the exact printer,
filament, hotend/nozzle, plate, slicer/profile, calibration, and explicit unknowns.
Keep that aggregate as the source of truth for machine setup. Add a separate
versioned build-plan aggregate owned by a project revision and referencing one or
more build-configuration snapshots. It must support:

- one or more build plates/jobs;
- part/work-item revision and instance quantity per plate;
- intended orientation and cosmetic face notes;
- material role and exact spool selection;
- printer, nozzle/hotend/side, plate surface, AMS/external route;
- layer/profile identifier, support/brim strategy, and relevant overrides;
- estimated material mass/time with source and uncertainty;
- slicer-project artifact binding and optional generated-toolpath artifact binding;
- explicit configuration unknowns and validation blockers.

Add `validate_build_configuration` and `validate_build_plan` read-only operations that
return missing fields, incompatible selections, stale profiles, unbound artifacts, and
release blockers before an immutable snapshot is created.

#### Manufacturing evidence

Keep planning status separate from manufacturing evidence. Use the following ordered
states, scoped to one revision/configuration:

```text
concept -> CAD complete -> DFAM reviewed -> mesh validated -> slicer validated
-> test printed -> fit/function verified -> production approved
```

- Status transitions require referenced evidence appropriate to the state.
- A new design/process change resets only the earliest affected state.
- Agents may record supplied evidence but may not self-attest a physical print, fit
  result, safety approval, or production approval.
- `print ready` is not a standalone status.

#### Acceptance criteria

1. A synthetic eight-plate project represents repeated parts and five material roles.
2. Different plates may use different profiles/materials while retaining one project
   revision and clear build-configuration ancestry.
3. Validation reports exact unknowns before snapshot creation.
4. A mesh-validated project with unsliced slicer files does not appear slicer validated.
5. No build-plan operation contacts or controls a printer.

### REQ-010 — Agent-safe batch artifact ingestion

**User story:** As an authorized desktop agent, I need to attach a versioned CAD/build
packet without exposing filesystem paths or transfer credentials to the model.

#### Contract

Preserve the current content-addressed, short-lived, header-bound transfer design and
add a host-mediated file capability:

- The user/client selects files and provides opaque file handles or attachment IDs;
  BenchLedger and the model do not receive arbitrary host paths.
- The host streams bytes to the existing scoped upload capability outside the model
  message and never exposes transfer tokens in URLs or model-visible logs.
- Add batch begin/finalize around a declared manifest containing filename, role, byte
  length, SHA-256, project/work-item revision binding, and optional build configuration.
- Files remain `pending_upload` or `staged` until all required bytes and hashes verify.
- Batch finalization publishes a complete artifact set or returns an explicit partial
  staging state; it must never label a partial set complete.
- Deduplicate content by SHA-256 while retaining logical artifact revision/provenance.
- Preserve per-file size/count limits, safe filename rules, media-type checks, scope,
  expiry, and immutable accepted revisions.
- Never execute, render as code, slice, print, or otherwise run uploaded content.

#### Acceptance criteria

1. A synthetic 50-file packet uploads through opaque client handles without any
   absolute path or transfer token appearing in MCP content.
2. A hash mismatch leaves the batch staged/incomplete and identifies the file.
3. Re-uploading identical bytes deduplicates storage but creates the requested logical
   revision relationship.
4. Project-scoped authorization is checked for every file and finalization.
5. Existing one-file upload remains compatible.

#### Host integration note

Do not add arbitrary local path input to MCP. The trusted host application should
broker file selection and byte transfer using opaque attachment handles, while the
BenchLedger backend continues to see only declared filenames, media types, byte
lengths, hashes, project bindings, and scoped transfer sessions.

### REQ-011 — Derived physical-inspection queue

**User story:** As a beginner, I need a short checklist that can promote uncertain
inventory and unblock the project without reading the entire BOM.

#### Contract

Derive inspection actions from BOM gaps and candidate evidence. Each action includes:

- project revision and BOM-line identity;
- candidate item and current evidence state;
- exact question or measurement required;
- expected unit, tolerance/uncertainty where applicable, and evidence source;
- the possible promotion/result states;
- whether completion changes stock, compatibility, specification, or configuration;
- required human confirmation before any evidence-changing write.

Examples: count boards, confirm module variant, measure a panel cutout, weigh a spool,
verify LED resistor topology, inspect adhesive expiry, or compare a finish sample.

#### Acceptance criteria

1. The queue deduplicates one physical check used by multiple BOM lines.
2. Completing a check creates append-only evidence and triggers gap reevaluation.
3. No candidate is promoted automatically from a photo, order, or name match.
4. Beginner UI shows the next few checks; expert/MCP output exposes full traceability.

**Current slice status (2026-09-02):** The shared application and HTTP contract
derive canonical revision-scoped actions and support list/read plus server-side
completion preview and explicit commit. The web Project Plan Checks panel is
above the BOM, shows three concrete beginner questions with candidate and
affected-line counts, and reveals action/line/item versions, evidence,
predicate, unit, and effects in expert mode. The web dialog cannot commit until
the server preview is displayed and the user explicitly confirms it; confirmed
compatibility and unit-conversion observations collect explicit values and
evidence and show exact per-line changes before commit. MCP list/read/preview/
commit tools deep-map nested REST `each` quantities and conversions to MCP
`piece` quantities, preserve before/after and reevaluation data, and fail closed
for non-project-scoped access. REQ-011 is complete for this tranche.

### REQ-012 — Safe maker project templates

**User story:** As an agent, I want a proven starting structure without fabricated
dimensions or hardware.

#### Contract

Provide additive templates for at least:

- printed part;
- multi-part printed assembly;
- electronics build;
- hybrid printed enclosure/electronics project.

Templates may propose work-item roles, requirement categories, evidence gates, and
validation checklists. They must leave fit dimensions, loads, electrical limits,
hardware selections, material quantities, and physical evidence explicitly unknown.
Templates feed `preview_project_setup`; they do not commit records automatically.

#### Acceptance criteria

1. A template produces a valid preview with clearly marked unknowns.
2. No template creates a reservation, purchase proposal, build configuration, or
   manufacturing status without project-specific evidence.
3. Templates are available through the shared application service, UI, and MCP.

## 9. Cross-cutting requirements

### 9.1 Security and privacy

- Preserve least-privilege project ancestry checks for every indirect identifier.
- Never add arbitrary filesystem, shell, SQL, URL-fetch, credential, printer-control,
  or executable-upload capabilities.
- Keep transfer tokens header-bound, short-lived, action-specific, and absent from
  URLs, logs, artifacts, audit descriptions, and model-visible content.
- Use only synthetic fixtures and examples in public source.
- Run the privacy scan for every implementation tranche.

### 9.2 Compatibility and migration

- Prefer additive API changes during the pre-1.0 period where they do not preserve a
  misleading contract.
- Version capability and schema changes and publish a content hash.
- Existing generic inventory must migrate to explicit generic/unknown profiles without
  fabricating package counts, exact products, dimensions, or remaining quantities.
- Existing granular create/update tools remain supported after bulk setup is added.
- Existing single-file artifact transfer remains supported after batch ingestion.

### 9.3 Performance and bounded context

- All lists are cursor-paginated with deterministic ordering and a maximum page size.
- Compact capability discovery stays under the stated 12 KiB target.
- Project context should return summaries plus links/cursors, not unbounded BOM,
  reservation, or artifact collections.
- Search responses include bounded ranking evidence and avoid returning full histories.

### 9.4 Accessibility and progressive disclosure

- Beginner labels remain action-oriented: ready, check, specify, partially covered,
  need to source, optional.
- Expert mode reveals IDs, versions, evidence, dimensions, compatibility reasons,
  reservations, hashes, and audit history in place.
- New UI workflows meet the repository's existing keyboard, focus, responsive, and
  contrast expectations and receive Playwright coverage.

## 10. Implementation ticket split

Create small tickets around stable requirement IDs rather than one omnibus feature.
Recommended split:

| Ticket | Includes | Must not include |
| --- | --- | --- |
| `BL-AW-001` | `REQ-001` public errors, idempotent replay tests, atomic project/revision rollback | Bulk setup, search changes |
| `BL-AW-002` | `REQ-002` compact capabilities, schema lookup, docs/skill update | Tool behavior changes |
| `BL-AW-003` | `REQ-004` truthful inventory/BOM summary reconciliation | New profile model migration |
| `BL-AW-004` | `REQ-005` graph list/read-back tools and resources | Project setup preview/commit |
| `BL-AW-005` | `REQ-003` preview/commit project setup workflow | Artifact transfer changes |
| `BL-AW-006` | `REQ-006` structured search normalization/ranking | BOM compatibility decisions |
| `BL-AW-007` | `REQ-007` `specify_first` BOM decision and shopping exclusions | Supplier scraping or carts |
| `BL-AW-008` | `REQ-008` maker profiles and quantity conversions | Physical stock fabrication |
| `BL-AW-009` | `REQ-009` build-plan aggregate and manufacturing gates | Printer control or G-code submission |
| `BL-AW-010` | `REQ-010` host-mediated batch artifact staging | Arbitrary path, shell, or executable handling |
| `BL-AW-011` | `REQ-011` inspection queue | Automatic promotion from weak evidence |
| `BL-AW-012` | `REQ-012` safe templates | Automatic commits or reservations |

Each ticket should include a fixture named after the relevant `OBS-*` row when it
addresses observed behavior, and each merged ticket should leave the repository in a
state where `npm run public:check` and the relevant focused checks pass.

## 11. Delivery sequence and dependencies

### Tranche A — Contract reliability (P0)

Implement `REQ-001`, `REQ-002`, `REQ-004`, and `REQ-005` first.

Dependencies and notes:

- Pin the sanitized `OBS-*` scenarios as regression tests before behavior changes.
- Reuse current application list operations where present.
- Align API, MCP, capability map, quickstarts, and skill in the same change.

Exit criterion: an agent can diagnose failures and fully read back granular writes.

### Tranche B — Atomic setup (P0)

Implement `REQ-003` after error/idempotency semantics are stable.

Dependencies and notes:

- Reuse the unit-of-work boundary and reconciliation preview/commit pattern.
- Do not create a parallel domain implementation in MCP or web.

Exit criterion: the representative setup previews and commits atomically in the call
budget defined under success measures.

### Tranche C — Maker decision quality (P1)

Implement `REQ-006`, `REQ-007`, and `REQ-008` as separate vertical slices.

Dependencies and notes:

- Search and specification state should land before shopping output is changed.
- Package/unit migrations must precede reliable component reservations.

Exit criterion: the system distinguishes what exists, what needs inspection, what
needs specification, and what genuinely needs sourcing.

### Tranche D — Reproducible builds and files (P1)

Implement `REQ-009` and `REQ-010`.

Dependencies and notes:

- Build-plan artifact bindings depend on secure batch staging.
- Physical statuses must retain human-approval boundaries.

Exit criterion: a multi-plate packet and exact configuration can be attached and
validated without claiming that a print occurred.

### Tranche E — Guided experience (P2)

`REQ-011` is complete for the shared application, HTTP, web, and MCP surfaces;
continue with `REQ-012` after the underlying states are stable.

Exit criterion: a beginner can resolve project blockers through a short inspection
queue and safe template-driven setup.

## 12. Required test matrix

Every tranche must include the smallest relevant combination of:

| Layer | Required evidence |
| --- | --- |
| Domain | Classification, invariants, quantity conversion, status transition, rollback inputs |
| Application | Unit-of-work behavior, optimistic conflicts, idempotent replay, preview basis |
| API contract | Schema constraints, enums, public errors, backward-compatibility parsing |
| Durable adapters | Transaction rollback, pagination, search parity, migrations, hash deduplication |
| HTTP server | OpenAPI parity, auth scopes, bounded errors, transfer capabilities |
| MCP | Tool/resource schemas, compact discovery, ancestry, result-size limits, redaction |
| Web | Beginner/expert labels, keyboard flow, responsive state, error recovery |
| End to end | Synthetic project preview/commit/read-back, inspection, build plan, artifact packet |
| Privacy/security | Public-source scan, token/path/secret redaction, malicious filename and scope tests |

At minimum, add named regression fixtures for every `OBS-*` row.

## 13. Documentation and release obligations

Each implemented capability must update, as applicable:

- `docs/capability-map.md`;
- `docs/stock-evidence-semantics.md`;
- `docs/reference-project.md`;
- `docs/AGENTS.md` and `apps/mcp/AGENTS.md`;
- `skills/benchledger/SKILL.md` and lifecycle references;
- OpenAPI-facing behavior and examples;
- UI copy/help and the public changelog;
- migration and rollback notes.

Before requesting review:

1. Run the focused tests for the vertical slice.
2. Run `npm run public:check`.
3. Run `npm run check`.
4. Review the diff for private data, generated output, and unrelated changes.
5. State whether remote integration was skipped or performed read-only against an
   approved synthetic workspace. Never redeploy as part of ordinary verification.

## 14. Explicit non-goals

This requirements set does not authorize or require:

- retailer scraping, cart mutation, or purchasing;
- slicer execution, G-code generation, print submission, printer control, heating, or
  firmware flashing;
- arbitrary path, shell, SQL, network-fetch, or credential tools;
- automated compatibility approval based only on a name, image, order, or delivery;
- agent self-attestation of a physical count, measurement, print, fit, safety result,
  or production approval;
- replacement of the existing evidence ledger, audit history, or reconciliation flow;
- a general task scheduler, calendar, or autonomous project-management system.

## 15. Definition of done

A requirement is complete only when:

- its public contract and migration behavior are documented;
- tests demonstrate every acceptance criterion at the appropriate layers;
- HTTP, MCP, and web share application behavior and use consistent language;
- capability discovery and the portable skill describe the released behavior;
- security, privacy, approval, evidence, and bounded-context invariants still hold;
- focused checks, `npm run public:check`, and `npm run check` pass;
- the implementation diff contains no private data or unrelated work;
- a reviewer can trace the change from `REQ-*` to tests, code, docs, and release notes.
