# BenchLedger MCP: ten-minute agent quickstart

This document is the short technical contract for an agent discovering the
BenchLedger MCP adapter. It is intentionally model-neutral: an MCP client may
be a coding agent, a local assistant, or a scripted workflow. Read the
capability resource before making a recommendation or write.

## 1. Discover the server (minute 0–1)

The reference private deployment exposes authenticated JSON-RPC at:

```text
POST http://<lan-host>:8792/api/v1/mcp
Content-Type: application/json
Authorization: Bearer <scoped-token>
```

Browser access and MCP access are separate authentication boundaries. The
browser has two workspace modes, selected by an administrator in Settings:

- `lan_open`: browser session routes do not require a workspace password. This
  is intended only for a trusted LAN. Anyone who can reach the configured
  interface and port can use the browser workspace as an authenticated user,
  including write actions available to that session; do not expose this mode to
  the public internet or an untrusted network.
- `password`: browser sessions require the configured workspace password.

These modes affect browser sessions only. `/api/v1/mcp` never receives implicit
LAN access: every MCP request still requires a scoped bearer token, and its
read/write/project allow-list rules remain unchanged. Changing the browser
mode or workspace password invalidates existing browser sessions; the browser
must sign in again. Credential and authentication-setting changes are explicit
human-approval actions and are not MCP capabilities.

Local MCP clients may use the newline-delimited stdio bridge exported by
`runStdio` from `@benchledger/mcp`. The host application supplies the backend
and actor context; the adapter never opens a database or shell itself.

Initialize, then discover capabilities:

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}
{"jsonrpc":"2.0","id":2,"method":"resources/read","params":{"uri":"benchledger://capabilities"}}
```

The response includes the available tools, scopes, evidence vocabulary,
approval boundaries, and the artifact-transfer rule.

If the capability resource names a tool missing from the client's callable
tool list, refresh or reconnect the MCP client. Some hosts cache `tools/list`
for an agent session; do not replace an available atomic operation with dozens
of writes because the client is stale.

## 2. Refresh before deciding (minute 1–2)

Start a project conversation with:

```json
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"refresh_context","arguments":{"includeInventory":true}}}
```

Then read `benchledger://inventory/summary` and use `list_inventory` with a
small page (normally `limit: 25`). Use the exact item resource when a candidate
needs dimensions, compatibility, provenance, or stock history.

Inventory rows expose on-hand, available, and allocated quantities separately.
A fully reserved counted item is `allocated`, not `depleted`; a partial
reservation remains visible with both available and allocated quantities.
Summary allocation counts include partial allocations, while the physically
confirmed evidence and available-confirmed counts remain independent. Retired
history is counted separately and never becomes reusable stock. Availability
filters use these derived states rather than treating evidence labels as stock
balances.

For a printer or filament decision, keep the exact catalog product, owned
physical item, product-profile link state, and project build configuration
separate. Search/read catalog products, then read the physical item's profile;
`reported` or `suggested` links never prove exact compatibility or stock.

Inventory taxonomy is a separate, optional layer: `list_inventory_categories`
and `read_inventory_category` are bounded reads; create, rename/reorder, and
the dedicated archive command use `inventory:write`. Supply `categoryNodeId`
when assigning an item. `kind` remains the closed semantic item type, category
parentage is immutable after creation, only one subcategory level is allowed,
and update/archive commands require an expected version. Project-scoped tokens
may read categories but cannot mutate this workspace-global taxonomy.

Fresh production runtimes include a curated, versioned starter catalog of major
FFF printers and filament products. `search_catalog_products` searches only
explicit identity/specification fields; a product's server-owned manufacturer
provenance URL is read-only metadata and is not a search field. Startup seeding
inserts missing IDs and creates no inventory, profiles, or stock events. During
the v1-to-v2 upgrade it corrects only complete, untouched v1 seed payloads;
edited or custom rows remain authoritative.

The adapter exposes bounded pages. Continue with the returned cursor instead of
requesting an unbounded dump. A project resource is similarly scoped and
includes the selected revision plus its persisted summary without enumerating
revision history:

`list_bom_lines` returns active requirements by default. Pass
`includeRetired: true` only when auditing history. Retiring a line preserves its
requirement, optional flag, notes, and versioned evidence; `restore_bom_line`
requires the current `expectedVersion`. Retired lines never participate in gap
evaluation or accept new reservations.

Use `list_reservations` to read active and historical reservations for one
project revision with a bounded page and opaque cursor. Use `read_reservation`
for one reservation; both reads return the durable revision, BOM line, item,
quantity/unit, status, and version. Project-scoped tokens must prove revision
or reservation ancestry before either read is dispatched.

Use `list_removed_projects` only with an unscoped `projects:read` token; it is
a bounded workspace-global tombstone page and project-scoped tokens are denied.
Use `read_removed_project_history` for the bounded, explicitly scoped audit
history of one removed project. `remove_project` is irreversible and requires
explicit human approval, the current `expectedVersion`, exact case-sensitive
`projectName`, and a stable 8–200 character idempotency key in the MCP request
context. Retry an ambiguous response with the same key and identical input.
Removal releases active reservations and makes the project and descendants
unavailable through ordinary read tools; there is no restore or purge tool.

```text
benchledger://projects/{projectId}/context
benchledger://projects/{projectId}/revisions/{revisionId}
benchledger://projects/{projectId}/bom
benchledger://projects/{projectId}/artifacts
```

Every project list, detail, context and mutation uses the same lifecycle:
`idea`, `planned`, `ready`, `building`, `validating`, `complete`, `archived`.
Use `archive_project` to reversibly archive a project; `retire_project` is a
compatibility alias for the same application command. Archived projects are
hidden from default lists, release active reservations with stock evidence,
and retain all revisions, artifacts, BOM, and audits. Use `restore_project` to
return one to `idea`; released reservations are never recreated. Never send legacy values such as
`active`, `planning`, `paused`, `validation` or `retired`; the public boundary
rejects them. `blocked` is derived from actionable reasons and is not a lifecycle
value. Project lifecycle changes do not advance or reset the separate revision
evidence ladder from `concept` through `production approved`.

## 3. Ask the simple question first (minute 2–4)

For a beginner, use plain language and explain one next action:

> “Can I build the desk sensor enclosure with the printer, filament, and parts
> I already have? Check the inventory, show what needs a physical count, and
> list only the genuinely missing parts. Do not buy anything.”

The agent should call `calculate_bom_gaps` and explain every required result as
one of four decisions:

- **Ready:** physically confirmed or commissioned stock meets the line.
- **Check:** a relevant item exists but its quantity, condition, identity, or
  compatibility still needs inspection. Partial confirmed coverage is Check
  only while an inspect-first candidate may cover the remaining quantity.
- **Decide:** the requirement is under-specified. Resolve the returned
  `missingDecisions` before searching suppliers.
- **Source:** the requirement is sufficiently specified and confirmed stock
  does not cover it, so a shopping proposal may be prepared. A confirmed
  partial line is Source for its remaining quantity when no inspect-first
  candidate could cover that shortfall.

Structured alternatives preserve `compatible`, `reason`, and optional
evidence-backed `quantityConversion`: one inventory `set` covers a positive
whole number of requirement-side MCP `piece`s. MCP maps `piece` losslessly to
the REST/application unit `each`. Candidate available, supplied, and inspect
quantities stay in requirement units, while candidate reasons retain conversion
capacity, allocation, and overage diagnostics. Missing/invalid conversions and
conditional or unknown alternatives remain Check and are never buyable or
reservable. Valid converted reservations are whole-number inventory `set`s and
read back as `set`. Only an exact `itemId` or an explicit alternative becomes a
gap or inspection candidate; kind/category constraints alone are descriptive,
not automatic inventory discovery.

Optional lines remain separately identified and never authorize Source or
create default inspection actions; they stay visible in the plan for explicit
review. A BOM line may record `constraints.specification` with a required
`status`, resolved
`decisions`, and exact `missingDecisions`. The closed decision vocabulary
includes `identity`, `purpose`, `voltage`, `current_or_load`, `connector`,
`compatibility`, `dimensions`, `resistance`, and `power_rating`. An insufficient
power-supply line must resolve current/load and connector before it can become
Source; an LED resistor must resolve resistance and power rating. An exact item
ID does not override conditional compatibility, and ordered or otherwise
unverified stock remains Check rather than a purchase recommendation.

Each returned line also carries its required/optional flag. Ready, Check,
Decide, and Source totals cover required lines only; `optional` is a separate
total even when an optional line happens to be supplied or needs inspection.

Never turn an order, delivery message, or old price into a present stock count.
When a delivery or order has been physically checked, use
`commission_inventory_item` with the observed quantity, commissioned evidence,
the current `expectedVersion`, and a distinct idempotency key in the request
context. Do not change evidence through `update_inventory_item`; commissioning
creates the append-only count event that retains the prior provenance.

## 4. Give experts the evidence (minute 4–6)

For an expert workflow, show exact IDs, variant, unit, dimensions and
uncertainty, machine/process bindings, evidence source and timestamp, matched
candidate IDs, compatibility reasons, reservations, and artifact SHA-256. Keep
the default answer readable; reveal this detail when asked or when it changes a
decision.

An expert prompt might be:

> “For project `project-desk-sensor`, compare revision `project-rev-01` against
> confirmed stock only. Explain machine and nozzle compatibility, dimension
> evidence, every alternative considered, the shortfall, and two current offer
> observations. Produce a shopping-list proposal in EUR, but do not fetch links,
> add to a cart, or purchase.”

## 5. Build the project record (minute 6–8)

The normal sequence is:

1. `create_project_with_initial_revision` (one atomic command; reuse that
   command's key only for an ambiguous identical retry), or `read_project` for
   an existing workspace
2. `create_work_item` for each independently revised part, assembly, electronics
   module, firmware unit, or document
3. `create_project_revision` only for a later planning baseline, plus
   `create_work_item_revision` for independently revised deliverables
4. `create_bom_line` for each required/optional requirement
5. `calculate_bom_gaps`
6. `create_reservation` only for confirmed, compatible stock
7. `create_build_configuration` for the exact printer, filament, nozzle, plate,
   slicer/profile, calibration, and explicit unknowns used by the revision
8. versioned artifact upload/finalization, bound to the same revision and build
   configuration when applicable
9. `read_reconciliation` → `save_reconciliation_draft` for a review-only
   preview → `commit_reconciliation` only after explicit confirmation

Each write is one atomic application-service operation and returns IDs, versions,
audit information when available, and the resulting state. Pass the returned
`expectedVersion` on the next mutable update. A conflict means another surface
changed the record; read again rather than overwriting it.

`create_project_with_initial_revision` accepts optional caller-provided
`projectId` and `revisionId` values as stable record identities, never as replay
keys. An ambiguous retry replays exactly once only when the idempotency key and
the complete canonical project/revision payload are identical. Reusing the key
with a changed payload returns a safe idempotency conflict. A 409 collision
response exposes only bounded details (`reason`, `field`, `id`,
`retryable: false`, `commitState: "not_committed"`) and distinguishes
`project_id_exists`, `revision_id_exists`, `project_name_exists`, and
`idempotency_key_reused`. Read the existing project, choose a different project
or revision ID, or choose a different project name as directed. Removed
projects retain their IDs and generated names/slugs, so those identities are
not reclaimed. For a complete graph, prefer `preview_project_setup`, inspect
its normalized IDs, gaps, unresolved specifications, and inventory basis, then
call `commit_project_setup` with the same preview ID/version/hash and explicit
reservation confirmation when needed. The preview is actor-owned metadata only
for 30 minutes; commit is one transaction with one aggregate audit and an
8–200-character idempotency key. This command remains available for the
incremental project-plus-initial-revision path.

For bounded catalog corrections, use `bulk_update_inventory_items` with 1–100
explicit `{itemId, expectedVersion}` targets. Supply at least one of a
non-empty location, canonical condition (`new`, `good`, `worn`, `needs_repair`,
or `unknown`), or normalized tag `{add,remove}` patch; all targets preflight as
one atomic operation. The response separates deterministic `updated` and
`unchanged` `{itemId,version}` references and includes bounded audit and
correlation metadata. No-op rows do not increment versions or create
audit/events, and an idempotent retry returns the stored result without
repeating them.
When the host has no HTTP idempotency header (for example, stdio), the
application bridge derives a bounded actor/action/payload key; an explicit
host key remains authoritative. Stable project and revision IDs never imply
replay, and a reused key with changed project/revision fields is rejected.
The single-item `update_inventory_item` command accepts a full replacement
`tags` array (normalized and deduplicated). Quantity, evidence, identity,
profile, retirement, partial, undo, and import changes remain unsupported by
these metadata tools.

Use `record_usage` directly only for a deliberate narrow event outside normal
project close-out. Do not replace the atomic reconciliation command with a loose
series of usage and reservation-release writes.

## 6. Store CAD and build files (minute 8–9)

Files are versioned project artifacts. Use the authenticated browser/HTTP Files
surface for a one-file upload. Choose exactly one revisioned scope in its File
scope picker: the project `projectRevisionId`, or a work item plus its
`workItemRevisionId`; the all-files view is read-only. The selected file role is
shown in the upload status and travels with the file. Missing, mixed, and
revision-less work-item scopes are rejected, and
`buildConfigurationSnapshotId` is valid only with a project revision. Use
`list_artifacts` with only `projectId`
for the read-only all-artifacts-in-project view, or add one exact scope from
the same union; the legacy generic `revisionId` filter is not accepted. Every
listed artifact exposes its exact `projectRevisionId` or
`workItemId`/`workItemRevisionId` when that ancestry is present.

The authenticated Files flow hashes the browser-selected bytes, calls the
existing application begin → write → finalize sequence, and returns the final
artifact metadata. Generic MCP does not expose that upload session or transfer
capability: raw `begin_artifact_upload`, `finalize_artifact_upload`, and
download tools fail closed with `HOST_TRANSFER_UNAVAILABLE`. MCP never embeds
CAD, STL, STEP, 3MF, build, firmware, or other large files as base64, and never
accepts an absolute host path, shell command, SQL statement, or executable
upload. Artifact paths are logical IDs, not host filesystem paths.

Typical roles include `source`, `cad`, `step`, `stl`, `three_mf`,
`slicer_project`, `gcode`, `drawing`, `validation`, and `document`. Manifest
freezing is deferred in the current application service; treat hashes and
revision status as review evidence until a dedicated freeze operation exists.

Build-configuration filament selections are a strict one-of: an exact
selection contains both `itemId` and `catalogProductId` (with an optional
`profileId`), while a physical-only selection must contain
`{itemId, catalogIdentityState: "unknown"}` and may contain only `role` and
`quantity` in addition. Item-only and profile-only inputs are invalid, and
printers retain the exact identity contract. Physical-only snapshot reads
return the server-copied `physicalLabel` and `physicalEvidence`; they do not
infer catalog identity, compatibility, or availability. The discriminator and
the snapshot's `explicitUnknowns` keep the configuration design-open, so
production approval remains blocked until the filament is identified.

## 7. Shop without buying (minute 9–10)

Use `list_offers` and `record_offer_snapshot` to compare supplier observations.
Record supplier, URL, package quantity, price in minor currency units, observed
time, and evidence. A shopping proposal contains only required BOM lines with a
Source decision. Keep Ready, Check, Decide, and optional lines in separate
readiness context; exclude them from shopping rows, counts, and copied drafts.
If no Source line exists while Decide or Check work remains, say “Nothing is
ready to source” and explain the blockers. A readiness answer must separate:

```text
Ready/reuse / Check/inspect / Decide/specify / Source/required / optional context
```

Include the source URL and observation age, state that price and availability
may have changed, and show package rounding. The adapter never fetches arbitrary
URLs and has no cart, purchase, print, shell, SQL, or credential tool.

## 8. Close the project without guessing

Reconciliation starts as a draft and changes no inventory. First call
`list_reservations` and identify the reservations whose status is `active`.
Submit and account for every active reservation with explicit consumed,
returned, damaged/lost, usable-leftover, or converted-asset outcomes and
per-outcome evidence. Split quantities when needed; every active reservation
must be fully and exactly accounted before commit. BOM lines with zero active
reservations may be omitted from the draft. If a zero-reservation line is
submitted, `reviewed_no_change` remains an optional, explicit sole outcome for
that line, and no other outcome is selected by default.

Save the draft, show the server-calculated stock/reservation/asset preview, and
obtain explicit confirmation before commit. A stale basis must be re-read and
reviewed; it is never forced. After a successful commit, report it as committed
even if the subsequent context refresh fails.

The server preview and staleness basis still include every BOM line, reservation,
and source inventory item, including omitted zero-reservation lines and
historical reservation states. Omission reduces review input; it never removes
history or weakens stale-basis protection.

Each active reservation is released as it is settled. `consumed` and
`converted_asset` then remove source stock, `damaged_lost` removes it as loss,
and `returned`/`usable_leftover` leave on-hand quantity intact so it becomes
available again. A converted asset must satisfy the live create-item schema;
its enclosing BOM line, reservation, and source item preserve reconciliation
lineage. Draft save and commit are different commands and use different
idempotency keys; reuse a key only for an ambiguous retry of the identical
command and payload. The server preview remains authoritative.

## Scopes and boundaries

Read and write scopes are separate (`inventory:*`, `projects:*`, `bom:*`,
`artifacts:*`, `offers:*`, and `context:read`). A project-scoped token can only
read or mutate its allow-listed projects; indirect IDs (revision, BOM line,
reservation, work-item, and artifact) are checked against their project
ancestry before dispatch. Inventory is a shared workspace catalog: scoped
tokens may read it for BOM matching but may not mutate it. Supplier offers are
also shared: scoped tokens may read offers only when an `itemId` is supplied,
but may not record offer snapshots. Human approval remains required for
purchasing, external publication, deployment, credential changes, destructive
purge, printer control, heating, firmware flashing, and physical tests.

For HTTP bearer configuration, a token listed in the write hash environment
variable receives both read and write scopes, while a read token remains
read-only. Indirect ancestry is resolved from durable host state rather than a
request-local cache. The application service's repository-backed defaults cover
historical BOM/reservation records and upload sessions; hosts may provide an
explicit resolver for a different durable store.

The browser access mode does not change this bearer-token contract. A
`lan_open` browser workspace still requires the same scoped bearer token at
`/api/v1/mcp`; agents must not infer MCP authorization from LAN reachability or
from a browser session.

For the full tool/resource matrix, see [`docs/capability-map.md`](../../docs/capability-map.md),
[`docs/stock-evidence-semantics.md`](../../docs/stock-evidence-semantics.md),
and [`docs/reference-project.md`](../../docs/reference-project.md).
