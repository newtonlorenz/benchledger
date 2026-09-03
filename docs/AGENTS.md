# BenchLedger agent quickstart (10 minutes)

BenchLedger is an evidence-first workspace for 3D-printing and electronics
projects. It records equipment, tools, consumables, electronic parts, projects,
versioned CAD/build files, BOMs, reservations, usage, and supplier offer
observations. The frontend and MCP adapter use the same application service.

This is the public technical quickstart. It contains synthetic examples only;
the private instance must keep inventory, order/email provenance, project files,
credentials, tokens, logs, and backups outside the public checkout.

## Repository operating lifecycle

Develop BenchLedger locally, verify with synthetic data, then use any configured
private LAN Docker instance only as a development/test integration target. Do not
treat a LAN endpoint as production evidence, and do not write to a live container,
change Docker state, rotate credentials, or publish externally without explicit
human approval.

The normal source workflow is:

1. Create a local branch from the current public `main`.
2. Make the smallest scoped change that preserves the documented public/private
   data boundary.
3. Run the focused local check first, then `npm run public:check` before sharing
   a branch or source archive.
4. Run `npm run check` before requesting merge or release.
5. Perform read-only smoke checks against the configured private LAN Docker
   development/test deployment when the change affects HTTP, MCP, runtime,
   Docker, auth, artifact transfer, or deployment behavior.
6. Contribute through GitHub branches and pull requests. Do not push, open a PR,
   publish packages, deploy, or alter remote infrastructure without explicit
   approval.

Keep exact hostnames, IP addresses, bearer tokens, session secrets, admin
password hashes, SQLite files, private artifacts, logs, and backups out of the
repository. Store those details in private operator notes or runtime
configuration, not in public docs or examples. For the full operator sequence,
see [`development-workflow.md`](development-workflow.md).

## Minute 0–1: discover

Connect to the authenticated MCP endpoint configured by the host application:

```text
POST http://<lan-host>:8792/api/v1/mcp
Authorization: Bearer <scoped-token>
Content-Type: application/json
```

Send `initialize`, then read:

```text
benchledger://capabilities
```

The capability document is the source of truth for the tool list, scopes,
resource templates, stock vocabulary, artifact transfer, and approval boundary.
The adapter is model-neutral; do not assume a particular model, prompt format,
or autonomous agent runtime.

If the capability document names a tool that the client does not expose, refresh
or reconnect that MCP client before falling back to smaller writes. Some hosts
cache `tools/list` for the lifetime of an agent session.

## Minute 1–2: refresh and inspect

Call `refresh_context` before a recommendation or write, then:

1. `read_inventory_summary`
2. `list_inventory` with `limit` no greater than 25 initially
3. `read_inventory_item` or `benchledger://inventory/items/{itemId}` for exact
   dimensions, links, evidence, compatibility, and history

Use `list_inventory_categories` or `benchledger://inventory/categories` when
organizing stock. The closed item `kind` remains semantic (for example,
`filament` or `printer`); a user-managed category is an optional
`categoryNodeId` assignment. Categories support top-level nodes plus one
subcategory level. Rename/reorder with an expected version; parentage is fixed
after creation, and archiving is a separate expected-version command that is
blocked while active children or active inventory references remain.

For the web UI, open **Settings → Manage inventory categories** to add a
top-level category and, if useful, one level of subcategories. Then open
**Inventory → Add item**: choose the semantic item type first and the managed
category second. The category selector and inventory Category filter use the
managed category tree and `categoryNodeId`; the separate Kind filter continues
to use `kind`. If the add form has no active categories, choose **Open Settings**
from that form, create one, and return to Inventory. Existing legacy items may
be unassigned until edited.

For paged inventory reads, pass `categoryNodeId` to filter by an exact managed
node or `unassigned: true` to select legacy items without an assignment. These
filters are applied before pagination and cannot be combined.

All list responses are bounded pages. Follow `nextCursor`; never request an
unbounded database dump. Inventory cursors are opaque read-committed continuation
tokens: concurrent writes can affect later pages, and keyset snapshot semantics
are not yet provided. Read the project resources for context, BOM, and artifact
metadata when working in a project.

## Minute 2–4: beginner path

Ask one concrete question in plain language:

> “Can I build this enclosure with the printer, filament, tools, and electronic
> parts I have? Show what I can reuse, what needs a physical count, and what is
> actually missing. Do not buy anything.”

The agent should inspect the BOM and call `calculate_bom_gaps`. Explain results
as **Ready**, **Check**, **Decide**, or **Source**, while keeping the underlying
supplied, inspect-first, partial, missing, and optional evidence visible when
useful. A Decide result must name its exact `missingDecisions` (for example, an
LED resistor needs `resistance` and `power_rating`) and stays out of shopping
until resolved. Use one recommended next action, such as “count the delivered
wire” or “resolve the resistor rating.” Do not expose raw database jargon by
default.

When a connected revision exposes a Check candidate, use the revision-scoped
inspection queue: list and read the action, submit its observation to the
`completion-preview` endpoint, show the server preview, and ask for explicit
human confirmation before calling `completion-commit`. The Project Plan Checks
panel sits above the BOM, shows three concrete beginner questions plus **View
all**, and reveals action/line/item versions, evidence, predicate, unit, and
effects in expert mode. Confirmed compatibility and unit conversion require
explicit values and evidence (source, basis, and observed time); never infer
them. Preview exact per-line before/after changes and unit coverage. MCP
list/read/preview/commit parity is complete, including nested each↔piece
mapping, refreshed before/after state, and project-scoped fail-closed access.
There is no quick-complete path.

## Minute 4–6: expert path

When the user asks for detail, reveal exact item and revision IDs, units,
dimensions and uncertainty, evidence source/time, machine/nozzle/material
bindings, compatibility reasons, reservation state, artifact hashes, and audit
IDs. A nominal manufacturer dimension is not a measured fit. A name match is not
compatibility. A delivery email is not a current count.

Example:

> “Evaluate `project-rev-01` against confirmed stock only. Explain the H2D and
> material configuration, every compatible alternative, remaining quantity,
> evidence age, and the shortfall. Compare observed supplier offers by source currency, but
> do not fetch links or purchase.”

## Minute 6–8: project and BOM

Use the smallest atomic sequence that answers the request:

```text
create_project
  -> create_work_item
  -> create_project_revision / create_work_item_revision
  -> create_bom_line
  -> calculate_bom_gaps
  -> create_reservation (confirmed stock only)
  -> record_usage (after actual use)
```

A project work item can be a printed part, assembly, electronics module,
firmware unit, or document. Revisions are versioned planning/engineering
baselines; BOM lines and metadata remain editable through optimistic version
checks. Updates pass the returned version; a conflict means “read again,” not
“overwrite.” Reservations reduce available confirmed stock but are not
consumption. Corrections and usage are append-only events.

Gap and inspection candidates require an exact item ID or an explicit
alternative. Broad kind/category constraints do not automatically nominate
inventory; add the intended candidate explicitly when a physical check is
needed.

`create_project_with_initial_revision` accepts optional caller-provided
`projectId` and `revisionId` values as stable record identities. They are not
idempotency or replay keys: an ambiguous retry replays exactly once only when
the idempotency key and the complete canonical project/revision payload are
identical; reusing the key with a changed payload returns an idempotency
conflict. A 409 for this command has sanitized details with `reason`, `field`,
`id`, `retryable: false`, and `commitState: "not_committed"`. Reasons are
`project_id_exists`, `revision_id_exists`, `project_name_exists`, or
`idempotency_key_reused`; read the existing project, choose a different project
or revision ID, or choose a different project name as directed. Removed
projects retain their IDs and generated names/slugs, so those identities are
never reclaimed. For a bounded complete project graph, use
`preview_project_setup` followed by the actor-owned, version/hash-checked
`commit_project_setup` (with explicit reservation confirmation when needed).
The shared application service is authoritative across HTTP and MCP; web UI
composition, templates, and a full Describe→Review→Create flow remain
separate work.

Projects use one lifecycle on every surface: `idea`, `planned`, `ready`,
`building`, `validating`, `complete`, `archived`. Treat `blocked` as a derived
condition with reasons, not a status. Keep this lifecycle separate from the
revision-scoped manufacturing evidence ladder (`concept`, `CAD complete`, `DFAM
reviewed`, `mesh validated`, `slicer validated`, `test printed`, `fit/function
verified`, `production approved`); moving one never proves or resets the other.

Build configurations keep physical ownership separate from exact catalog
identity. An active filament item with `physically_counted` or `commissioned`
evidence may be selected without an exact product/profile only through the
explicit `catalogIdentityState: "unknown"` branch. That immutable snapshot
copies the physical label and evidence, creates no catalog/profile/stock or
reservation records, and remains **Design open** with production approval
blocked. Never infer material, colour, diameter, compatibility, or availability
from the item name. Exact filament selections and all printer selections retain
their existing exact catalog requirements.

## Minute 8–9: files and revisions

Choose one explicit file scope before listing or uploading: the exact current
project revision, or one exact work item and its current revision. Project-level
files never inherit the first work item returned by a list. Use the read-only
all-project view to find retained legacy or unbound records without silently
reclassifying them. Keep the chosen scope fixed for the upload.

Use the authenticated browser/HTTP Files surface for a one-file upload. Choose
the project revision or a named work-item revision in its File scope picker;
the all-files view is read-only. The upload status shows the file role, and the
application runs the existing begin → write → finalize sequence with the
browser-computed byte length and SHA-256. Keep source, STEP, STL, 3MF, slicer,
drawing, and validation revisions separate; do not overwrite an accepted
artifact.

Generic MCP does not expose upload sessions or transfer capabilities. Its raw
`begin_artifact_upload`, `finalize_artifact_upload`, and download tools fail
closed with `HOST_TRANSFER_UNAVAILABLE`. MCP never embeds CAD, STL, STEP, 3MF,
build, firmware, or other large files as base64, and never accepts an absolute
host path, shell command, SQL statement, or executable upload.

## Minute 9–10: shopping proposal

Call `list_offers` and optionally `record_offer_snapshot` for supplied supplier
observations. A shopping proposal contains only required BOM lines whose
decision is **Source**. Keep Ready, Check, Decide, and optional lines visible
as separate readiness context; never turn them into shopping rows, counts, or
copied draft text. If no Source line exists while Decide or Check work remains,
say “Nothing is ready to source” and explain those blockers. A useful readiness
summary separates:

```text
Ready/reuse | Check/inspect | Decide/specify | Source/required purchase | optional context
```

Include package rounding, minor-unit price and currency, shipping when known,
the URL, observation time/age, and the reason the offer matches. State that
prices and availability may have changed. BenchLedger stores offer links as
data; it does not fetch arbitrary URLs, add to carts, or place orders.

## Hard boundaries

Token scopes are separate for inventory, projects, BOMs, artifacts, offers, and
context. Project-scoped tokens are allow-listed. Human approval remains required
for purchasing, external publication, deployment, credentials, permanent purge,
printer control, heating, firmware flashing, physical testing, and any
safety-relevant claim. There are deliberately no `purchase`, `print`, `shell`,
`sql`, `fetch_url`, or arbitrary-path tools.

For the complete tool/resource parity table, see
[`capability-map.md`](capability-map.md). For classifications and evidence,
see [`stock-evidence-semantics.md`](stock-evidence-semantics.md). For a fully
synthetic beginner/expert fixture, see [`reference-project.md`](reference-project.md).
Implementation details for the adapter and stdio/HTTP bridge are in
[`../apps/mcp/AGENTS.md`](../apps/mcp/AGENTS.md).
