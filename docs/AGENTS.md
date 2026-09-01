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
as **supplied**, **inspect first**, **partial**, **missing**, or **optional**.
Use one recommended next action, such as “count the delivered wire” or
“compare the missing insert offers.” Do not expose raw database jargon by
default.

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

Projects use one lifecycle on every surface: `idea`, `planned`, `ready`,
`building`, `validating`, `complete`, `archived`. Treat `blocked` as a derived
condition with reasons, not a status. Keep this lifecycle separate from the
revision-scoped manufacturing evidence ladder (`concept`, `CAD complete`, `DFAM
reviewed`, `mesh validated`, `slicer validated`, `test printed`, `fit/function
verified`, `production approved`); moving one never proves or resets the other.

## Minute 8–9: files and revisions

Use `begin_artifact_upload` with a logical project/work-item/revision and a safe
filename. It returns short-lived scoped HTTP `uploadUrl` and `finalizeUrl`
values, each with its own required `X-Bench-Transfer-Token` header; transfer
bytes with the write header, then finalize with the finalize header and byte
length/SHA-256. Use `read_artifact_download_metadata` to receive a short-lived
scoped `downloadUrl` and required transfer header. Tokens never appear in query
strings.

MCP never embeds CAD, STL, STEP, 3MF, build, firmware, or other large files as
base64. It never accepts an absolute host path, shell command, SQL statement, or
executable upload. Keep source, STEP, STL, 3MF, slicer, drawing, and validation
revisions separate; do not overwrite an accepted artifact.

## Minute 9–10: shopping proposal

Call `list_offers` and optionally `record_offer_snapshot` for supplied supplier
observations. A useful shopping proposal separates:

```text
already supplied | inspect-first | required purchase | optional purchase | substitute
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
