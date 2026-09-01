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

## 2. Refresh before deciding (minute 1–2)

Start a project conversation with:

```json
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"refresh_context","arguments":{"includeInventory":true}}}
```

Then read `benchledger://inventory/summary` and use `list_inventory` with a
small page (normally `limit: 25`). Use the exact item resource when a candidate
needs dimensions, compatibility, provenance, or stock history.

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
requesting an unbounded dump. A project resource is similarly scoped:

```text
benchledger://projects/{projectId}/context
benchledger://projects/{projectId}/revisions/{revisionId}
benchledger://projects/{projectId}/bom
benchledger://projects/{projectId}/artifacts
```

## 3. Ask the simple question first (minute 2–4)

For a beginner, use plain language and explain one next action:

> “Can I build the desk sensor enclosure with the printer, filament, and parts
> I already have? Check the inventory, show what needs a physical count, and
> list only the genuinely missing parts. Do not buy anything.”

The agent should call `calculate_bom_gaps` and explain every result as one of:

- **Supplied:** physically confirmed or commissioned stock meets the line.
- **Inspect first:** an item looks relevant, but quantity or condition is not
  currently confirmed.
- **Partial:** confirmed stock covers only part of the requirement.
- **Missing:** no compatible stock is recorded.
- **Optional:** useful but not required to complete the stated build.

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
host key remains authoritative.
The single-item `update_inventory_item` command accepts a full replacement
`tags` array (normalized and deduplicated). Quantity, evidence, identity,
profile, retirement, partial, undo, and import changes remain unsupported by
these metadata tools.

Use `record_usage` directly only for a deliberate narrow event outside normal
project close-out. Do not replace the atomic reconciliation command with a loose
series of usage and reservation-release writes.

## 6. Store CAD and build files (minute 8–9)

Files are versioned project artifacts. Use `begin_artifact_upload` with the
logical project/work-item/revision and a safe filename. It returns short-lived
scoped HTTP `uploadUrl` and `finalizeUrl` values, each with its own required
`X-Bench-Transfer-Token` header. Upload the bytes to `uploadUrl`, then POST the
byte length and SHA-256 to `finalizeUrl` (or use the typed finalize tool).

The typed `finalize_artifact_upload` command takes only the upload ID and lets
the application verify the declaration recorded at begin time against stored
bytes. If the agent uses the returned HTTP finalize URL directly, it must send
the byte length and SHA-256 JSON payload with the finalize capability header.

To retrieve a file, call `read_artifact_download_metadata`; it returns metadata,
a short-lived scoped `downloadUrl`, and a required transfer header. MCP results
never contain base64 or inline binary bytes. Artifact paths are logical IDs, not
host filesystem paths. Transfer tokens never appear in query strings.

Typical roles include `source`, `cad`, `step`, `stl`, `three_mf`,
`slicer_project`, `gcode`, `drawing`, `validation`, and `document`. Manifest
freezing is deferred in the current application service; treat hashes and
revision status as review evidence until a dedicated freeze operation exists.

## 7. Shop without buying (minute 9–10)

Use `list_offers` and `record_offer_snapshot` to compare supplier observations.
Record supplier, URL, package quantity, price in minor currency units, observed
time, and evidence. A shopping-list answer must separate:

```text
required / optional / substitute / inspect-first / already supplied
```

Include the source URL and observation age, state that price and availability
may have changed, and show package rounding. The adapter never fetches arbitrary
URLs and has no cart, purchase, print, shell, SQL, or credential tool.

## 8. Close the project without guessing

Reconciliation starts as a draft and changes no inventory. Account for each
active reservation with explicit consumed, returned, damaged/lost, usable-
leftover, or converted-asset outcomes and per-outcome evidence. Split quantities
when needed. `reviewed_no_change` is only valid as the sole outcome for a line
with zero active reservations.

Save the draft, show the server-calculated stock/reservation/asset preview, and
obtain explicit confirmation before commit. A stale basis must be re-read and
reviewed; it is never forced. After a successful commit, report it as committed
even if the subsequent context refresh fails.

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

For the full tool/resource matrix, see [`docs/capability-map.md`](../../docs/capability-map.md),
[`docs/stock-evidence-semantics.md`](../../docs/stock-evidence-semantics.md),
and [`docs/reference-project.md`](../../docs/reference-project.md).
