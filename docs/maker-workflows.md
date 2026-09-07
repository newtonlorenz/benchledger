# Reviewed maker workflows

## Browser entry points

New project offers **Use a template or import a BOM**. Describe the project,
review editable template or CSV rows, request a server preview, then explicitly
create the reviewed project. The operation creates the project, its first
revision and bounded requirements/workstreams atomically, without reservations.
An acknowledged creation is not repeated when a subsequent workspace refresh
fails.

The **Build planning** tab opens parts, plates and workstreams directly. Its
route can be bookmarked. The Plan toolbar opens **Import requirements from CSV**
in a review dialog. Larger workflows still load only when opened. CSV append supports 1–24 rows and a 256 KiB
source. Columns and decimal conventions are reviewed explicitly. Exact owned
inventory IDs are never auto-mapped. A preview is actor-owned and expires;
changed revision, requirement or selected-stock data requires a new review.
Duplicate names need explicit approval, and an import never replaces stock or
existing requirements.

**Parts, plates and workstreams** records repeated parts, plate layouts, run
counts, material roles, nozzle side and optional time estimates. Runs multiply
part, gram and time quantities. Snapshots retain versions and file hashes.
Missing source files, printer choices, material estimates and physical evidence
remain warnings, not invented validation. No slicer, printer or stock operation
is performed. Workstreams retain independent progress/notes/due dates and
provide read-only access to project revision history.

The Shopping list opens **Supplier quotes for this project** first, with views
for Needs sourcing, Needs review and All requirements. Filtering applies to the
loaded page and does not change the full quote totals. These quotes can
be recorded before owning the item, unlike inventory-linked supplier offers.
An observation includes its source URL, date, pack quantity/unit, price/currency,
shipping and tax information. The application does not fetch the URL or place
an order. A reviewed selection is tied to the observed requirement version.
Stale quotes and changed requirements need renewed review. Only required Source
gaps contribute to the quote estimate; currencies are kept separate, missing
shipping/tax remain explicit, and incompatible units are never guessed.
Existing offers remain under **Inventory-linked supplier records**. Their totals
and requirement-quote totals are separate.

## HTTP and agent parity

These operations share the application service and optimistic/idempotent storage.
Every mutating command uses one stable Idempotency-Key for unchanged retries.
The actor, project and exact revision remain part of the boundary. New commands
use the canonical units `each`, `gram`, `metre`, `millimetre`, `millilitre`, `set`.

Project-revision HTTP paths are rooted at
`/api/v1/projects/{projectId}/revisions/{revisionId}`:

- `sourcing`, `requirement-offers` and `offer-choice` read/record/select quotes.
- `build-plan` and `build-plan/history` read/save retained planning snapshots.
- `bom-import/previews` and `bom-import/commit` review and append requirements.
- `snapshot` reads exact historical revision content without changing the active revision.

Project paths expose `workstreams`, `workstreams/{workItemId}/assignment`,
`workstreams/{workItemId}/revisions` and `revision-history`.
MCP discovery exposes equivalent typed maker commands, including
`read_requirement_sourcing`, `record_requirement_offer`, `choose_requirement_offer`,
`read_build_plan`, `save_build_plan`, `read_build_plan_history`, `list_workstreams`,
`create_workstream`, `update_work_assignment`, `list_project_revisions`,
`list_workstream_revisions`, `read_project_revision_snapshot`, `preview_bom_import`
and `commit_bom_import`. Use their advertised closed schemas, not legacy unit
or payload assumptions. Wrong-project and read-only requests are rejected.

## Release and data boundaries

Workflow records/history and team foundations use additive SQLite tables.
Existing inventory, projects, requirements and credentials are not replaced.
A deployment requires an immutable tested image, a verified private database
and artifact backup, and retention of the previous image/configuration for
rollback. Never rebuild from an unrelated dirty deployment checkout.

Named-account activation is **disabled by default**. The current browser rollout
preserves LAN/password access; it does not enable named accounts, create users or
rotate credentials. The experimental host option `BENCHLEDGER_TEAM_ACCESS_PREVIEW`
is not enabled for this release. Named-account administration/sign-in UX and its
full security acceptance remain a separate release gate. Do not claim complete
team-production support from the planning features shipped here.

## Verification

The inherited workflows remain covered. Additional release checks exercise
reviewed setup/import on desktop and narrow screens, package-aware quotes,
unchanged stock, repeated plate quantities, workstream progress, retained
revisions, wrong-project/read-only denial and unchanged-command replay.
DOM component tests exercise error/retry callbacks; database tests cover
immutable history and rollback on a later transaction failure. The application
source is resolved directly by Vitest integration tests so stale compiled
workspace output cannot stand in for source coverage. All 80% coverage thresholds
remain enforced. Compiler errors no longer emit partial build output.
