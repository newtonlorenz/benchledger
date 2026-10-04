# Reviewed maker workflows

## Browser entry points

New project offers **Start from a template** and **Import a parts list (CSV)**. Describe the project,
review editable template or CSV rows, request a server preview, then explicitly
create the reviewed project. The operation creates the project, its first
revision and bounded requirements/workstreams atomically, without reservations.
An acknowledged creation is not repeated when a subsequent workspace refresh
fails.

The project has **Overview / Parts / Files / Build**. Build presents Check parts,
Prepare files, Assemble, Verify the build and Record actual use. Reservations,
plate planning and task groups are disclosed in Build tools. The sequence stays
visible during actual-use review. Its
route can be bookmarked. Parts offers a reviewed CSV import. CSV append supports
1–24 rows and a 256 KiB source. Columns and decimal conventions are reviewed explicitly. Exact owned
inventory IDs are never auto-mapped. A preview is actor-owned and expires;
changed revision, requirement or selected-stock data requires a new review.
Duplicate names need explicit approval, and an import never replaces stock or
existing requirements.

**Parts and print plates** records repeated parts, plate layouts, run
counts, material roles, nozzle side and optional time estimates. Runs multiply
part, gram and time quantities. Snapshots retain versions and file hashes.
Missing source files, printer choices, material estimates and physical evidence
remain warnings, not invented validation. No slicer, printer or stock operation
is performed. Workstreams retain independent progress/notes/due dates and
provide read-only access to project revision history.

**Parts → To source** opens **Supplier quotes for this project** first, with views
for Needs sourcing, Needs review, Optional and All requirements. Search and
filters run across the complete revision before pagination, including requirement
notes and recorded supplier/title text. `total` counts matched rows; `revisionTotal`
and currency estimates retain the full revision scope. These quotes can
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

## Read recovery and draft protection

The browser keeps confirmed same-scope data during refreshes and labels read
failures. It never substitutes old records from another project or revision.
A committed save is not described as failed when its following read fails.
Inline build, quote and workstream drafts and staged file selections block
accidental navigation. Users can keep editing or explicitly discard a draft;
an unconfirmed save must be resolved first. Draft content is not persisted in browser storage.
Workstream creation refreshes the shared project context so its file scope is
available without reloading the browser. The physical-stock rules are unchanged.

`read_requirement_sourcing` and HTTP `GET .../sourcing` accept `query` (up to
200 characters) and `filter` (`all`, `source`, `review`, `optional`) alongside
bounded `limit` and `cursor`. Omitted filters preserve the previous all-row
behaviour. Only required Source lines enter estimates. A narrowed view never
changes quote selection, purchase authority or full-revision cost totals.

## Review, approval and interrupted responses

Stock close-out has three separate states: local results, a saved server preview
and an approved stock update. A pending or unconfirmed request freezes its input.
Retry that exact request to resolve the outcome; do not construct a replacement
write. A saved result is an immutable receipt, not an editable draft. The project
stage is not changed by a stock update.

Inspection confirmation uses the observation captured for its preview, including
its original timestamp. A lost confirmation response keeps the form locked for
unchanged recovery. Quote selection similarly blocks filters, pagination and
competing selections until the pending outcome is known.

Project Refresh reads changes made by another client or agent. It first protects
local drafts. An explicit discard followed by a successful refresh reloads the
working view; a failed refresh retains the current records and explains that the
view is stale. A denied workflow read clears its prior result instead of leaving
restricted data visible. Workstream pagination uses the same draft guard.

## Capture, reuse and build continuity

A new project needs only a name. Add its first requirement before choosing a build
approach or printer; those remain available under Planning details. Template and
CSV setup retain the name and goal already entered. The project-library import action
opens CSV entry directly. Requirement details and workstreams are optional
disclosures; the reviewed preview remains the boundary before creating records.

Requirement entry starts with loaded suggestions and searches the full inventory
in bounded pages using the requirement name. Select
an item explicitly after checking its identity and evidence. Selecting an item
does not assert compatibility or convert quantities. A different stock unit has
an explicit unit action; exact canonical validation still decides readiness.
Normal requirement rows explain their gap without requiring expert mode.

Inventory capture asks where the item is stored, allows incomplete identity, and
puts catalogue search before optional product filters. Saving ordinary capture
opens the item for physical-count review. The recorded quantity is not silently
promoted to confirmed stock. On phones, tapping an item opens its details.

After selecting a supplier quote, **Record received stock** opens inventory
capture. Confirm what physically arrived, then use **Match owned stock** to link
it to the requirement. Quote package quantities remain supplier observations;
they do not become received quantities or purchasing authority.

On persistent hosts that support stock closeout, **Stock for this build** offers
confirmed, compatible stock for consumed requirements. Choose a quantity and
review **Confirm set aside**. This reserves availability without consuming stock.
**Release stock** requires its own review and an observed reservation version.
After the build, **Record actual stock use** opens the existing closeout review.
A revision whose closeout is committed cannot accept new reservations; start a
new revision. The application enforces that rule on every transport.

Build planning keeps warnings visible while file hashes remain disclosed. New
plates start with the usable intended printer and its matching recorded setup,
with explicit overrides available. Add a missing build file inside the editor,
then select its exact revision file for the part; the draft is retained.
Part/plate planning stays optional for non-print projects. Assignment/due date,
material/time estimates and exact file evidence remain available in disclosures.

Changed capture, import and requirement-edit drafts are protected on exit. An
unconfirmed save keeps its exact command and retry key until acknowledged,
including when an intervening retry is rejected.

## Files, specialists and actual use

Files groups the selected revision scope into 3D print, Electronics, CAD &
firmware and Instructions. Open a file's details or supported preview, or download
the original. A project cover is never used as an artifact preview. Download a
3MF before opening it in a slicer; BenchLedger does not launch local fabrication
tools or start a machine. Check printer, material, supports and toolpaths there.

Build's secondary routes retain Assembly, PCB and Used stock when advertised.
Verification notes return to task groups; evidence can be attached in Files.
A task marked done or a successful model preview is not physical certification.

Actual-use review displays proposed quantities and the affected stock balances
provided by the service, then repeats them at confirmation. A confirmed result
is a receipt; repeating navigation cannot consume stock again. Reservations
reduce availability without recording consumption.

A part's **Check stock** action retains the requirement draft while the exact
inventory item is reviewed. The count receipt offers **Return to [part name]**.
Adding an owned item also returns to the draft with an explicit item selection.
Saving that selection remains a separate requirement action; a count alone does
not confirm compatibility.
