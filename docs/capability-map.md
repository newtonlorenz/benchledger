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
| `benchledger://catalog/products/{productId}` | One exact printer or filament catalog identity | `catalog:read` |
| `benchledger://inventory/summary` | Current counts and categories | `inventory:read` |
| `benchledger://inventory/items/{itemId}` | One item with quantity, dimensions, links, and evidence | `inventory:read` |
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

## Typed atomic tools

Every tool accepts an object with `additionalProperties: false` and rejects
unknown fields, unsafe IDs, oversized pages, unsafe filenames, invalid URLs,
and invalid hashes. Mutating tools use optimistic versions where applicable.

| Family | Tools | Scope | Mutates? |
| --- | --- | --- | --- |
| Inventory | `read_inventory_summary`, `list_inventory`, `read_inventory_item`, `list_stock_events` | `inventory:read` | No |
| Inventory | `create_inventory_item`, `update_inventory_item`, `record_stock_event` | `inventory:write` | Yes |
| Exact inventory | `create_inventory_with_product_profile` | `inventory:write` + `catalog:write` | Yes |
| Catalog | `search_catalog_products`, `read_catalog_product`, `read_inventory_product_profile` | `catalog:read` | No |
| Catalog | `create_catalog_product`, `update_catalog_product`, `link_inventory_product_profile` | `catalog:write` | Yes |
| Projects | `list_projects`, `read_project`, `read_work_item`, `read_project_revision`, `read_work_item_revision` | `projects:read` | No |
| Projects | `create_project`, `create_project_with_initial_revision`, `update_project`, `retire_project`, `create_work_item`, `create_project_revision`, `create_work_item_revision` | `projects:write` | Yes |
| BOM | `list_bom_lines`, `calculate_bom_gaps` | `bom:read` | No |
| BOM | `create_bom_line`, `update_bom_line`, `retire_bom_line`, `create_reservation`, `release_reservation`, `record_usage` | `bom:write` | Yes |
| Reconciliation | `read_reconciliation` | `bom:read` | No |
| Reconciliation | `save_reconciliation_draft`, `commit_reconciliation` | `bom:write` | Draft save / commit |
| Build setup | `list_build_configurations`, `read_build_configuration` | `projects:read` | No |
| Build setup | `create_build_configuration` | `projects:write` | Yes, immutable create |
| Artifacts | `list_artifacts`, `read_artifact_metadata`, `read_artifact_download_metadata` / `download_artifact` | `artifacts:read` | No |
| Artifacts | `begin_artifact_upload`, `finalize_artifact_upload`, `retire_artifact` | `artifacts:write` | Yes |
| Offers | `list_offers` | `offers:read` | No |
| Offers | `record_offer_snapshot` | `offers:write` | Yes |
| Context | `refresh_context`, `get_capabilities` | `context:read` | No |

The server's `tools/list` response contains only MCP's public fields (`name`,
`description`, and `inputSchema`). Scope and mutation metadata are intentionally
kept in the checked-in capability contract and enforced server-side.

## UI parity

| Human workflow | UI surface | MCP composition |
| --- | --- | --- |
| See what I have | Inventory dashboard and item detail | `read_inventory_summary` → `list_inventory` → item resource |
| Count uncertain stock | Item count form and stock timeline | `read_inventory_item` → `record_stock_event(kind=count_correction)` |
| Add an exact printer or spool | Exact-product guided add | catalog search/read → `create_inventory_with_product_profile` |
| Start a project | Guided project setup | `create_project_with_initial_revision` → `create_work_item`; use `create_project_revision` for later planning baselines |
| Understand a build gap | BOM editor and gap panel | `list_bom_lines` → `calculate_bom_gaps` |
| Hold confirmed parts | Reservation panel | `create_reservation` → read BOM/gaps again |
| Add a CAD revision | Artifact upload flow | `begin_artifact_upload` → scoped HTTP PUT → `finalize_artifact_upload` |
| Record exact build setup | Project build-configuration form | catalog/profile reads → `create_build_configuration` |
| Compare buying options | Offers and shopping-list view | `list_offers` → `record_offer_snapshot` (observation only) |
| Close and learn from a build | Project **Close out** review | `read_reconciliation` → `save_reconciliation_draft` → explicit `commit_reconciliation` |

All UI actions in the table are application-service operations. The frontend
does not silently invent compatibility, current counts, or purchase outcomes.

## Artifact transfer contract

`begin_artifact_upload` returns separate short-lived URLs for one upload session's
byte write and finalize actions. Each URL has a required
`X-Bench-Transfer-Token` header; the token is bound to the exact action, ID,
project, expiry, byte length, and SHA-256. `read_artifact_download_metadata`
returns the same header-bound capability pattern for one artifact revision.
Tokens never appear in query strings. The adapter validates HTTP(S), artifact
endpoint scope, no-query links, and expiry metadata. It rejects `data:` URLs and
result keys that imply base64 or inline binary content. Large files are
therefore transferred outside MCP messages without exposing arbitrary
filesystem paths.

`begin_artifact_upload` requires the caller's SHA-256 and accepts either a
project revision or a work-item revision (not both). The typed finalize tool
uses the durable upload declaration; the separate finalize URL accepts the
byte length and SHA-256 payload when an agent performs the HTTP transfer flow.
Finalization trusts the durable upload session's project ancestry, resolved by
the application service or an optional host resolver before a scoped request is
allowed to proceed.

## Deliberate non-capabilities

There is no arbitrary path, shell, SQL, URL-fetch, browser, credential, purchase,
cart, print, printer-control, heater, firmware-flash, or model-execution tool.
Offer links are stored as observations; the backend does not fetch them. Public
publication and deployment are proposals that require explicit human approval.
