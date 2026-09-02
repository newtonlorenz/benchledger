# BenchLedger MCP capability map

The MCP adapter is an API-first boundary over the same application service used
by the web UI. It does not contain a model, and it does not make multi-step
judgments on an agent's behalf. An agent composes small, typed operations into
an end-to-end project decision.

## Resources

Resources are bounded and read-only. Pages use an opaque cursor and a maximum
of 100 items; project context and JSON resources are limited by the adapter's
resource byte budget.

| URI | Purpose | Scope |
| --- | --- | --- |
| `benchledger://capabilities` | Tool, resource, evidence, transfer, and safety contract | `context:read` |
| `benchledger://catalog/products/{productId}` | One exact printer or filament catalog identity, with read-only manufacturer provenance when present | `catalog:read` |
| `benchledger://inventory/summary` | Reconciled availability buckets, confirmed-evidence counts, allocated quantities by unit, and categories | `inventory:read` |
| `benchledger://inventory/categories` | Bounded user-managed category taxonomy; archived nodes are opt-in | `inventory:read` |
| `benchledger://inventory/items/{itemId}` | One item with quantity, dimensions, links, and evidence | `inventory:read` |
| `benchledger://inventory/categories/{categoryId}` | One user-managed category or subcategory | `inventory:read` |
| `benchledger://inventory/items/{itemId}/product-profile` | Exact-product link for one physical item; non-confirming states stay explicit | `catalog:read` |
| `benchledger://projects/{projectId}/context` | Bounded project brief and next actions | `projects:read` |
| `benchledger://projects/{projectId}/revisions/{revisionId}` | One versioned planning revision | `projects:read` |
| `benchledger://projects/{projectId}/revisions/{revisionId}/build-configurations` | Immutable exact build-setup snapshots for a revision | `projects:read` |
| `benchledger://build-configurations/{buildConfigurationId}` | One build setup with copied facts and content hash | `projects:read` |
| `benchledger://projects/{projectId}/revisions/{revisionId}/reconciliation` | Review-only close-out draft and server preview | `bom:read` |
| `benchledger://projects/{projectId}/bom` | Bounded BOM requirement page | `bom:read` |
| `benchledger://projects/{projectId}/artifacts` | Artifact metadata and hashes | `artifacts:read` |

`resources/read` returns JSON metadata/text only. It never returns a host path,
database connection, executable content, or binary bytes.

Project-scoped indirect identifiers are authorized through durable ancestry
lookups. The application service provides repository-backed lookups for work
items, historical revisions and BOM lines/reservations, artifact records, and
upload sessions; a host may supply a resolver when its storage has additional
ancestry. The adapter does not keep request-local ID maps.

Reservation reads are revision-scoped and read-only: `list_reservations` accepts
one project revision plus the standard bounded `limit`/opaque `cursor`, while
`read_reservation` accepts one reservation ID. Both return the normalized
reservation identity, including its durable project revision, BOM line, item,
quantity/unit, status, and version. Project-scoped tokens must prove the
revision or reservation ancestry before dispatch.

## Browser session authentication

Browser session access is configured separately from MCP authorization. An
administrator selects the browser workspace mode in Settings:

| Browser mode | Browser session behavior | MCP behavior |
| --- | --- | --- |
| `lan_open` | No workspace password is required to establish a browser session. Use only on a trusted LAN. Anyone who can reach the configured interface and port can use the browser workspace as an authenticated user, including write actions available to that session. | No change: `/api/v1/mcp` still requires a scoped bearer token. LAN reachability never grants MCP access. |
| `password` | The configured workspace password is required to establish a browser session. | No change: scoped bearer tokens and their read/write/project allow-list rules still apply. |

Fresh installations with no password hash start in `lan_open` mode. Existing
hash-configured installations remain password-protected and import that hash
into durable settings once. After initialization, the durable setting wins over
bootstrap configuration. Demo mode remains password-protected regardless of the
browser setting. Changing the browser mode or workspace password invalidates
existing browser sessions, so the browser must sign in again.

The MCP adapter never treats a browser session, a private address, or LAN
reachability as a bearer token. `/api/v1/mcp` has no implicit LAN access in
either browser mode. Changing the browser mode, workspace password, or other
credential/authentication settings is an explicit human-approval action and is
not an MCP capability.

## Typed atomic tools

Every tool accepts an object with `additionalProperties: false` and rejects
unknown fields, unsafe IDs, oversized pages, unsafe filenames, invalid URLs,
and invalid hashes. Mutating tools use optimistic versions where applicable.

| Family | Tools | Scope | Mutates? |
| --- | --- | --- | --- |
| Inventory | `read_inventory_summary`, `list_inventory`, `read_inventory_item`, `list_stock_events` | `inventory:read` | No |
| Inventory | `create_inventory_item`, `update_inventory_item`, `commission_inventory_item`, `record_stock_event` | `inventory:write` | Yes |
| Inventory | `bulk_update_inventory_items` | `inventory:write` | Yes; explicit 1–100 optimistic-version targets |
| Inventory taxonomy | `list_inventory_categories`, `read_inventory_category` | `inventory:read` | No |
| Inventory taxonomy | `create_inventory_category`, `update_inventory_category`, `archive_inventory_category` | `inventory:write` | Yes; update/archive require an expected version |
| Exact inventory | `create_inventory_with_product_profile` | `inventory:write` + `catalog:write` | Yes |
| Catalog | `search_catalog_products`, `read_catalog_product`, `read_inventory_product_profile` | `catalog:read` | No |
| Catalog | `create_catalog_product`, `update_catalog_product`, `link_inventory_product_profile` | `catalog:write` | Yes |
| Projects | `list_projects`, `list_removed_projects`, `read_removed_project_history`, `read_project`, `read_work_item`, `read_project_revision`, `read_work_item_revision` | `projects:read` | No |
| Projects | `create_project`, `create_project_with_initial_revision`, `update_project`, `archive_project`, `restore_project`, `remove_project`, `retire_project` (compatibility alias), `create_work_item`, `create_project_revision`, `create_work_item_revision` | `projects:write` | Yes; atomic initial setup accepts stable caller IDs |
| Project setup | `preview_project_setup` | `projects:write` + `bom:write` | Preview metadata only; actor-owned 30-minute row, no graph/stock/audit/event mutation |
| Project setup | `commit_project_setup` | `projects:write` + `bom:write` | Yes; exact preview, reservations, one aggregate audit, and idempotent replay |
| BOM | `list_bom_lines`, `list_reservations`, `read_reservation`, `calculate_bom_gaps` (Ready/Check/Decide/Source plus exact missing specification decisions) | `bom:read` | No |
| BOM | `create_bom_line`, `update_bom_line`, `retire_bom_line`, `restore_bom_line`, `create_reservation`, `release_reservation`, `record_usage` | `bom:write` | Yes |
| Reconciliation | `read_reconciliation` | `bom:read` | No |
| Reconciliation | `save_reconciliation_draft`, `commit_reconciliation` | `bom:write` | Draft save / commit |
| Build setup | `list_build_configurations`, `read_build_configuration` | `projects:read` | No |
| Build setup | `create_build_configuration` | `projects:write` | Yes, immutable create |
| Artifacts | `list_artifacts`, `read_artifact_metadata`, `read_artifact_download_metadata` / `download_artifact` | `artifacts:read` | No |
| Artifacts | `begin_artifact_upload`, `finalize_artifact_upload`, `retire_artifact` | `artifacts:write` | Yes |
| Offers | `list_offers` | `offers:read` | No |
| Offers | `record_offer_snapshot` | `offers:write` | Yes |
| Context | `refresh_context`, `get_capabilities` | `context:read` | No |

Project reads, filters and writes use one lifecycle value everywhere:
`idea`, `planned`, `ready`, `building`, `validating`, `complete`, or `archived`.
`archive_project` is the canonical reversible project-retirement command;
`retire_project` remains a compatibility alias. Default project lists and the
workspace omit archived projects, while `status=archived` is the explicit
Archived view. Archiving releases every active reservation across all project
revisions and appends stock-release evidence; revisions, BOM, artifacts, stock
events, and audits are retained. `restore_project` returns the project to
`idea` and never recreates released reservations. `blocked` is a derived
readiness condition and is never accepted as a project status.
`remove_project` is a separate irreversible, approval-required command. It
requires `expectedVersion`, exact case-sensitive `projectName` confirmation,
and a stable 8–200 character idempotency key in the MCP request context so an
ambiguous response can be replayed safely. It releases active reservations,
hides the project and descendants from ordinary reads, and retains only
explicit tombstone/history access. Use bounded `list_removed_projects` and
`read_removed_project_history` pages with their opaque continuation cursors;
project-scoped tokens cannot enumerate the workspace-global tombstone list.
Project context returns the canonical lifecycle plus structured BOM blocker
reasons containing the revision, line, decision and explanation. The separate
revision evidence ladder (`concept` through `production
approved`) does not move when the project lifecycle changes.

`preview_project_setup` accepts one project and initial revision, up to six work
items (each with one initial revision), one to 24 BOM lines, and up to 48
optional reservations. Local references are unique and the canonical proposal
is limited to 256 KiB. The preview returns stable normalized IDs, semantic
field errors, unresolved specifications, gap candidates/totals, planned
reservation and before/after inventory basis, expiry, and a SHA-256 content
hash. It persists only bounded actor-owned preview metadata for 30 minutes.
`commit_project_setup` requires the exact preview ID/version/hash and an
8–200-character idempotency key; planned reservations additionally require
`confirmReservations: true`. It rechecks every basis row and creates the
complete graph and allocation events in one transaction. Stale basis is a
non-retryable 409 with `commitState: "not_committed"` and a fresh-preview
recovery action. Identical same-actor/key/canonical commits replay; changed
payloads conflict.

Structured BOM alternatives preserve their compatibility state and reason,
and may carry evidence-backed `quantityConversion`. MCP names the requirement
side `piece` and maps it losslessly to the REST/application unit `each`; gap
candidate quantities remain in requirement units while reasons retain
capacity, allocation, and overage diagnostics. Missing or invalid conversions,
and conditional or unknown compatibility, remain Check and are never buyable or
reservable. Valid converted reservations use whole inventory `set` quantities
and read back as `set`.

Build-configuration filament selections use a strict union. The existing exact
branch retains `itemId` plus exact catalog product/profile linkage. The
physical-only branch must explicitly declare `catalogIdentityState: "unknown"`
and is accepted only for an active filament with `physically_counted` or
`commissioned` evidence. Its immutable response copies `physicalLabel` and
`physicalEvidence`, includes the design-open production blocker, and contains
no catalog, profile, link-state, or inferred compatibility fields. Creating the
snapshot does not reserve or consume stock. Exact printer selection is
unchanged, and a physical-only filament cannot be attached to a
production-approved revision.

`create_project_with_initial_revision` accepts optional caller-provided stable
project and revision IDs. Those IDs identify records and never act as replay
keys. An identical retry requires the same idempotency key and complete
canonical payload and replays exactly once; a changed payload with that key is
an idempotency conflict. Project-ID, revision-ID, generated project-name/slug,
and reused-key conflicts return sanitized, machine-readable details with
`reason`, `field`, `id`, `retryable: false`, and `commitState: "not_committed"`.
The agent should read the existing project, choose a different project or
revision ID, or choose a different project name according to the reason. No
project, revision, audit, or idempotency record is committed on conflict, and
removed identities are not reclaimed. Use the bounded
`preview_project_setup` and `commit_project_setup` tools for complete graph
setup; this capability remains available for the incremental project-plus-first
revision path. Web UI composition, templates, and a full Describe→Review→Create
flow are separate work.

The server's `tools/list` response contains only MCP's public fields (`name`,
`description`, and `inputSchema`). Scope and mutation metadata are intentionally
kept in the checked-in capability contract and enforced server-side.

The BOM specification decision vocabulary is closed and shared across the
application, HTTP, MCP, and web surfaces: `identity`, `purpose`, `voltage`,
`current_or_load`, `connector`, `compatibility`, `dimensions`, `resistance`,
and `power_rating`. LED resistor requirements remain Decide until both
`resistance` and `power_rating` are resolved. MCP evaluation preserves those
exact `missingDecisions` and returns `recommendedAction: specify`; web shopping
rows, counts, and copied drafts include only required Source lines. Guided
specification editing remains deferred.

The production runtime seeds a curated, versioned starter catalog on startup:
at least 24 FFF printer identities spanning Bambu Lab, Prusa Research,
Creality, ELEGOO, and Anycubic, plus at least 24 exact 1.75 mm filament
identities spanning Bambu Lab, Prusament, Polymaker, eSUN, SUNLU, and
OVERTURE. Seeding inserts missing IDs and never creates inventory items,
physical product profiles, or stock events. During the v1-to-v2 upgrade, only
complete, untouched v1 seed payloads receive the documented corrections; all
edited or custom rows, including rows that reuse a starter identifier, remain
authoritative. Curated records may include server-owned manufacturer
provenance; it is read-only and excluded from create/update inputs and catalog
identity search.

## UI parity

The Inventory destination uses the authenticated `GET /api/v1/inventory` page
directly, with server-side search, canonical kind/evidence/availability filters,
normalized-name-plus-id ordering, and a default page size of 25 with **Load
more**. Each response is read-committed: `nextCursor` is opaque and should be
passed back unchanged, but concurrent writes may change later pages. Keyset
snapshot semantics are deliberately deferred. The bounded `/workspace` preview
continues to support the overview and project flows; it is not the inventory
list source. Inventory pages hydrate exact catalog products and physical
profiles when present.

| Human workflow | UI surface | MCP composition |
| --- | --- | --- |
| See what I have | Inventory dashboard and item detail | `read_inventory_summary` → `list_inventory` → item resource |
| Organize inventory | Settings category manager; inventory table, category filter, and item drawer show managed assignments | `list_inventory_categories` → `create_inventory_category` / `update_inventory_category` / `archive_inventory_category`; pass `categoryNodeId` when creating or updating an item; `kind` remains the separate semantic filter |
| Correct metadata across loaded items | Explicit inventory selection and confirmation dialog | `bulk_update_inventory_items` with 1–100 `{itemId, expectedVersion}` targets; location, canonical condition, or normalized tag add/remove only; atomic preflight, deterministic updated/unchanged results, and no-op rows emit no audit/event |
| Count uncertain stock | Item count form and stock timeline | `read_inventory_item` → `record_stock_event(kind=count_correction)` |
| Commission delivered or ordered stock | Item commissioning action with observed quantity and provenance | `read_inventory_item` → `commission_inventory_item` |
| Add an exact printer or spool | Exact-product guided add; reported printers remain inspect-first until explicitly commissioned | catalog search/read → `create_inventory_with_product_profile` |
| Start a project | Guided project setup | `create_project_with_initial_revision` → `create_work_item`; optional stable `projectId`/`revisionId` identify records; use `create_project_revision` for later planning baselines |
| Archive or restore a project | Project Archive action and explicit Archived view | `archive_project` / `restore_project`; archive hides default lists, releases active reservations with evidence, retains history, and restore never recreates reservations |
| Understand a build gap | BOM editor and gap panel | `list_bom_lines` → `calculate_bom_gaps`; Decide before supplier lookup, inspect candidate diagnostics and conversion capacity/overage reasons in Check results, and shop only Source lines |
| Hold confirmed parts | Reservation panel | `create_reservation` → `list_reservations` / `read_reservation` → read BOM/gaps again |
| Add a CAD revision | Artifact upload flow | Authenticated browser/HTTP upload → `finalize_artifact_upload`; generic MCP remains unavailable until a transactional trusted-host bridge exists |
| Record exact build setup | Project build-configuration form | catalog/profile reads → `create_build_configuration` |
| Compare buying options | Offers and shopping-list view | `list_offers` → `record_offer_snapshot` (observation only) |
| Close and learn from a build | Project **Close out** review | `read_reconciliation` → `save_reconciliation_draft` → explicit `commit_reconciliation` |

All UI actions in the table are application-service operations. The frontend
does not silently invent compatibility, current counts, or purchase outcomes.
Connected project plans render canonical gap units, structured alternatives,
candidate relationships, reasons, and nested conversion evidence. The web
preserves `set` as `set`; it may show `g`/`m` as beginner aliases but never
collapses a package into pieces. Unit mismatches and invalid conversions remain
explicit Check diagnostics, and a failed readiness load disables sourcing until
canonical gaps reload. Shopping includes alternative-linked offers only for
exact or confirmed-alternative candidates from that canonical read.

Commissioning is deliberately separate from generic PATCH. It requires an
observed quantity, commissioned evidence with a source and timestamp, and the
current item version. REST callers must also send `If-Match` and
`Idempotency-Key`; retries with the same key and identical payload replay the
same mutation, while a different payload or stale version is rejected. The
append-only count event retains the prior delivery/order evidence for audit.

The REST equivalent is `PATCH /api/v1/inventory/bulk` with a required
`Idempotency-Key`. Targets are explicit optimistic-lock pairs, not an
all-matching query. The REST response is `{data:{updated,unchanged},audits,
correlationId,replayed}` with full inventory items in both arrays, sorted by
item id. MCP deliberately returns bounded `{itemId,version}` references in
`updated` and `unchanged`, together with `auditIds`, `correlationId`, and
`replayed`. A replay with the same actor and canonical payload returns the
stored result without repeating writes, audits, or events. No-op rows do not
increment versions or emit audit/events. Quantity, evidence, identity, profile,
retirement, partial, undo, and import operations are outside this command.

## Artifact transfer contract

Generic MCP never returns live artifact-transfer URLs, headers, tokens, or
credentials, including through `_meta`. Artifact upload and download tools
currently fail closed with `HOST_TRANSFER_UNAVAILABLE` before creating an upload
session, reading artifact metadata, or minting a capability. A future
transactional trusted-host bridge must consume private transfer credentials
outside MCP result serialization. Direct authenticated browser and HTTP
transfer routes retain short-lived, action-, actor-, project-, byte-length-, and
SHA-256-bound header capabilities. Download capabilities are one-use after a
successful read.

`begin_artifact_upload` requires the caller's SHA-256 and accepts either a
project revision or a work-item revision (not both). The typed finalize tool
uses the durable upload declaration. Finalization trusts the durable upload
session's project ancestry, resolved by
the application service or an optional host resolver before a scoped request is
allowed to proceed.

## Deliberate non-capabilities

There is no arbitrary path, shell, SQL, URL-fetch, browser-automation, credential,
purchase, cart, print, printer-control, heater, firmware-flash, or model-execution
tool. The browser session mode described above does not add a browser-automation
tool or bypass MCP bearer authentication.
Offer links are stored as observations; the backend does not fetch them. Public
publication and deployment are proposals that require explicit human approval.
