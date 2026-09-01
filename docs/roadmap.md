# Product roadmap

This roadmap records intentionally deferred work. It is not part of the first
private LAN deployment gate.

The consolidated product outcome and simplified beginner-to-expert experience are
defined in [`maker-project-management-prd.md`](maker-project-management-prd.md).
The detailed `REQ-*` engineering contracts below remain the implementation annex.

## Agent-first maker workflow backlog

The client-agent feedback and its complete sanitized contract live in
[`docs/agent-maker-workflow-requirements.md`](agent-maker-workflow-requirements.md).
That document is the source of truth for `OBS-*` evidence, `REQ-*` contracts,
acceptance criteria, security boundaries, and the required test matrix. This
section is intentionally only the delivery index and dependency map.

Every `BL-AW-*` item below is a separate PR and independently reviewable
vertical slice. A slice must reproduce its relevant observation, add the
smallest failing regression test first, preserve shared application behavior
across HTTP/MCP/web, and pass focused checks, `npm run public:check`, and
`npm run check` before review. No slice authorizes deployment, printer control,
purchasing, credential changes, destructive cleanup, or merging.

### Ordered delivery tranches

#### Tranche A — Contract reliability (P0)

- [ ] `BL-AW-001` → `REQ-001`: actionable public errors, explicit commit state,
  command identity, replay/conflict semantics, and rollback tests. **Partial
  foundation only:** project creation already has an atomic application path,
  and some web writes retain idempotency keys, but the shared HTTP/MCP error
  contract and complete ambiguous-command replay contract are not delivered.
- [ ] `BL-AW-002` → `REQ-002`: compact, cacheable capability discovery and
  bounded named-schema lookup. **Proposed.**
- [ ] `BL-AW-003` → `REQ-004`: truthful inventory/BOM summaries that reconcile
  confirmed, allocated, inspect-first, optional, and gap totals. **Partially
  implemented on the current feature branch:** durable BOM retirement excludes
  inactive requirements; inventory reads distinguish on-hand, available,
  allocated, depleted, unverified, and retired states; summary allocation
  quantities are grouped by unit; and optional lines no longer inflate required
  outcome totals. The broader Ready/Check/Decide/Source contract remains.**
- [ ] `BL-AW-004` → `REQ-005`: bounded graph list/read-back tools and resources
  for every created project entity. **Proposed; audit existing list operations
  before adding new ones.**

Dependency gate: pin the sanitized `OBS-*` fixtures and finish the shared
error/idempotency language before changing setup or shopping behavior.

#### Tranche B — Atomic setup (P0)

- [ ] `BL-AW-005` → `REQ-003`: preview and commit a complete conflict-checked
  project graph. **Partial foundation only:**
  `create_project_with_initial_revision` is atomic for its existing scope and
  the web uses that existing atomic project-plus-initial-revision endpoint, but
  ambiguous project-create replay and the full previewable graph workflow and
  five-call success contract remain proposed. Depends on Tranche A.

Dependency gate: reuse the existing unit-of-work and reconciliation
preview/commit patterns; do not create a parallel MCP or web implementation.

#### Tranche C — Maker decision quality (P1)

- [ ] `BL-AW-006` → `REQ-006`: normalized, ranked structured inventory search,
  including LED, hyphenated heat-shrink, and multi-token PETG/manufacturer
  fixtures. **Proposed.**
- [ ] `BL-AW-007` → `REQ-007`: distinguish missing stock from missing
  specification with `specify_first` decisions and shopping exclusions.
  **Proposed.**
- [ ] `BL-AW-008` → `REQ-008`: maker-specific profiles, package/unit
  conversions, and explicit quantity semantics. **Partial foundation only:**
  exact printer/filament product and physical-profile records exist, but the
  complete maker quantity/profile contract and migrations remain. Depends on
  inventory category, catalog, and stock semantics.

Dependency gate: land search and specification state before changing shopping
output; package/unit migrations precede reliable component reservations.

#### Tranche D — Reproducible builds and files (P1)

- [ ] `BL-AW-009` → `REQ-009`: multi-plate build-plan aggregate with repeated
  parts, material roles, exact spools, nozzle/side, and manufacturing evidence.
  **Proposed; build-configuration snapshots are a prerequisite foundation.**
- [ ] `BL-AW-010` → `REQ-010`: host-mediated batch artifact staging and
  finalization without base64 MCP payloads, arbitrary paths, or executable
  handling. **Partial foundation only:** secure artifact sessions exist, but
  the approved batch host-transfer workflow does not.

Dependency gate: bind build-plan files only to the secure staging boundary and
retain human approval for physical statuses; never imply that a print occurred.

#### Tranche E — Guided experience (P2)

- [ ] `BL-AW-011` → `REQ-011`: derived physical-inspection queue that routes
  weak evidence to human review without automatic promotion. **Proposed.**
- [ ] `BL-AW-012` → `REQ-012`: safe maker project templates that preview intent
  and never auto-commit, reserve, purchase, or approve. **Proposed.**

Dependency gate: wait until the underlying evidence, specification, inventory,
and build-plan states are stable.

### Dependencies with the existing product roadmap

- **Discoverable project creation** is the web-facing completion of the partial
  `BL-AW-001`/`BL-AW-005` foundation: add a clear Projects-list action and
  post-create handoff only after the retry and atomicity contracts are explicit.
  A web idempotency key on an existing request is not by itself `REQ-001` or
  `REQ-003` complete.
- **Managed categories and subcategories** should establish stable category IDs
  before `BL-AW-003`, `BL-AW-006`, `BL-AW-007`, and `BL-AW-008`. The add-inventory
  category requirement, category settings, and reviewed bulk edits should share
  one migration and evidence-safe model.
- **Scalable inventory management** should sequence server pagination and list
  state with `BL-AW-003`/`BL-AW-004`, then reviewed descriptive bulk edits after
  the quantity/event invariant is stable. Removing the summary strip and
  evidence-source column is a presentation slice, not permission to remove
  provenance from detail or audit views.
- **Precise filament/printer selection** and the **curated catalog** provide
  product/profile foundations for `BL-AW-008` and `BL-AW-009`. Catalog records
  remain reusable identity only; they never prove owned stock or availability.
- **No-key online item lookup** should remain a discovery spike after the
  structured search/profile work (`BL-AW-006`/`BL-AW-008`), with allow-listed
  sources, attribution, SSRF protection, rate limits, and a reviewed manual
  import fallback. It must not become unrestricted scraping or purchase flow.
- **Self-service password change** is an independent security slice. It must
  first establish a supported credential-store and session-revocation boundary;
  deployments whose credentials are externally owned need an administrator
  rotation path rather than a falsely successful UI.

## Next feature tranche

### Agent workflow skill

Status: implemented and independently forward-validated with synthetic beginner
planning and expert close-out scenarios. The portable package lives in
[`skills/benchledger`](../skills/benchledger/SKILL.md), includes staged
lifecycle and ChatGPT/Claude/MCP client guidance, and defers to the live
capability resource when contracts evolve.

Create a portable skill for ChatGPT, Claude, and other MCP-capable agents that
teaches the full BenchLedger workflow: project intake, equipment and stock
discovery, BOM construction, reuse/inspect/buy decisions, reservations,
versioned artifacts, validation evidence, usage recording, and project close.
The skill should use the public MCP capability description rather than depend
on one model vendor or private instance data.

### Post-project inventory reconciliation

Status: implemented and release-verified. The close-out commits as one atomic
operation rather than a loose sequence of usage and reservation calls.

Add a guided project-close flow that starts from reservations and the approved
BOM, then records what was actually consumed, returned, damaged, left over, or
converted into a reusable asset. Nothing should be deducted automatically
without review. The resulting immutable stock events and physical observations
should improve future availability and purchasing recommendations.

### Precise filament selection

Status: implemented and release-verified. The additive exact-product foundation
preserves the existing inventory and never treats an inferred product match as
confirmed stock.

Add catalog-assisted autocomplete that selects an exact filament product and
physical spool rather than a generic material label. The record should support
manufacturer, product family, material/subtype, colour and code, diameter,
spool/net mass, estimated remaining mass or length, lot/batch, opened state,
drying history, location/AMS slot, and qualified printer/profile combinations.

### Precise printer and configuration selection

Status: implemented and release-verified. Printer identity, owned-machine state,
and immutable project build-configuration evidence are separate records so that
a later change to a printer does not rewrite an earlier project revision.

Add catalog-assisted printer selection down to manufacturer, exact model and
variant, followed by the active machine configuration: installed hotend/nozzle
and side, nozzle material/diameter, build plate, enclosure/accessories,
firmware, slicer/version/profile, and calibration state. Projects and artifact
releases should retain the selected configuration as versioned evidence.

## Proposed product and inventory tranche

### Self-service password change

Status: proposed.

Add a password-change action in Settings that verifies the current password,
validates and confirms the replacement, rotates it through a supported credential
store, and invalidates other active sessions. The UI must never expose or retain a
plaintext password or hash. Deployments whose password is owned by an external
secret store should show an explicit administrator rotation path instead of
claiming that an in-app change succeeded.

### Discoverable project creation

Status: partially implemented. The project API and Workbench “New project” dialog
exist, but project creation is not discoverable enough from the Projects journey.

Make “New project” a clear primary action on the Projects list and empty state as
well as the Workbench. After creation, open the new project and its initial
revision so the next action is obvious. Preserve entered values on failure and
provide a specific retry path.

### Managed categories and subcategories

Status: proposed. Inventory creation currently starts with a fixed, flat category
picker.

Add a Settings area for creating, renaming, ordering, nesting, and archiving
inventory categories and one level of subcategories. Use stable identifiers so a
rename does not rewrite inventory or evidence history. Prevent destructive removal
while records still use a category, or require an explicit reviewed migration.
The add-inventory flow must always require a category and offer the relevant
subcategory when one exists.

### Curated printer and filament catalog

Status: proposed catalog content; exact printer/filament product records and local
product creation are implemented.

Ship a versioned starter catalog covering the major current 3D-printer
manufacturers and models plus major filament brands and product lines. Printer
selection should start with manufacturer, model, and exact variant. Filament
selection should progressively choose brand/manufacturer, product line, material
family and subtype, colour and manufacturer code, diameter, and spool/net mass,
with the remaining typical spool details available before saving. Keep an
“unlisted/custom product” path. A preloaded catalog record is a reusable product
identity only; it never proves that the user owns the item or that stock is
currently available.

### Scalable inventory management

Status: proposed for the web UI. The application and MCP layers already expose
bounded cursor pagination.

Add server-backed pagination to Inventory with an explicit page size, next/previous
controls, result count, and stable search/filter state. Add row selection and a
reviewed bulk-edit flow for descriptive fields such as category, subcategory,
location, condition, and tags. Quantity changes must remain explicit stock events,
and bulk actions must not overwrite append-only evidence or audit history.

Simplify the default Inventory page by removing the summary bar for tracked items,
printers, filaments, and electronics. Remove the “Evidence source” table column;
retain provenance and evidence state in the item detail and expert/audit views.

### No-key online item lookup

Status: discovery spike.

Evaluate an online lookup that can suggest printer, filament, electronics, tool,
and consumable product details without requiring the user to supply an API key.
Prefer allow-listed manufacturer sources or openly licensed community datasets,
cache source attribution and observation time, and provide a reviewed manual URL
or metadata-import fallback. Suggested metadata must never create owned stock or
become confirmed evidence without user review.

Do not add unrestricted server-side URL fetching or brittle scraping. The spike
must cover source terms, attribution, rate limits, stale data, request timeouts,
SSRF protection, and graceful failure. If no sustainable no-key source has useful
coverage, ship the manual import fallback and document the limitation rather than
silently degrading lookup quality.
