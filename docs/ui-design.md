# Workspace interface design

## Product intent

BenchLedger is a working tool for maker projects, inventory and build records.
Projects and Inventory are peer destinations. The interface should help a maker
find the current record, understand its state and take the next useful action.
It should feel calm and approachable during repeated workshop use.

Keep the distinction between owned stock, confirmed usable stock, project
requirements and actual sourcing gaps. Stock readiness is separate from design
or physical-build validation. A missing or unavailable result is never zero or a
successful check. Do not add marketing panels, simulated activity or unmeasured
statistics.

## Visual system and ownership

The visual direction is a professional workshop register: a steady navigation
rail, readable records, thin rules and contextual tools. Light mode uses a warm
near-white work surface, soft neutral navigation and graphite text. Dark mode
retains the same hierarchy. Forest green identifies primary actions and selection;
semantic status colours accompany explicit status text.

Each stylesheet has an explicit responsibility:

| File | Responsibility |
| --- | --- |
| `apps/web/src/shadcn.css` | Semantic light/dark colour tokens and Tailwind integration. |
| `apps/web/src/workspace-shell.css` | Application frame, navigation, utility bar, shared controls, typography, focus and responsive shell. |
| `apps/web/src/home-experience.css` | Workbench register, recent-project link, optional task queue and workshop tools. |
| `apps/web/src/inventory-experience.css` | Inventory toolbar, filters, register, view options and inspector composition. |
| `apps/web/src/project-workspace.css` | Project heading, tabs, Plan context, requirements and project details. |
| `apps/web/src/workspace-layout.css` | Retained specialist forms, settings and workflow presentation not owned by the files above. |

Use the owning stylesheet when changing a surface. Do not append another global
restyling layer or reintroduce shell, Workbench, inventory or project selectors in
`workspace-layout.css`. Specialist viewers retain their local styles. Colour
values belong in semantic tokens; panels must work in both themes.

React and the existing shared `components/ui` primitives remain in use. Radix
provides interaction semantics and focus boundaries; it does not determine the
product's layout. The overhaul changes composition and presentation without a
framework migration.

IBM Plex Sans is the interface font, served by the application. Use IBM Plex Mono
for code, identifiers and keyboard keys when it aids recognition. Ordinary
quantities use tabular numerals without requiring a different font family.
The explicit root size is 16px: `.875rem` body and control text is 14px, `.75rem`
metadata is 12px, and the standard 1.625rem page title is 26px. Keep this conversion
stable instead of shrinking the entire application through the root size.

Use space and alignment to group records before adding a border. Main registers
are flat work surfaces; floating popovers and dialogs have their own boundary.
Normal controls use a 6px radius. Standard and Compact density change row spacing,
not evidence or functionality. Compact rows apply to pointer devices; touch
controls retain a target height of at least 44px. Form text may increase on phones
to remain readable without browser zoom.

## Navigation and search

Keep Workbench, Inventory and Projects directly available. The desktop rail can
collapse while retaining accessible control names. Phone navigation must close
predictably, restore focus and leave the selected working view usable.

The utility bar has one visible Search & commands launcher. It opens navigation,
project, loaded-item and entry-form commands. Command results explicitly state
that project and item searches cover loaded records. Selecting a command opens a
page or form; it does not submit a business mutation.

Control/Command + Shift + K opens workspace commands. Control/Command + K retains
the direct inventory-search shortcut. Search within a register stays beside its
records and states its scope. An unavailable project link must never substitute
another project.

The View control changes browser-local theme and density. Inventory View options
changes sorting, saved views and optional columns. These are presentation choices,
not stock writes. Preserve existing local preferences when changing defaults.

## Workbench

The Workbench starts with one primary New project action and an Open inventory
action. A recently opened project appears as an inline resume link, rather than
another large panel. The project register uses one visible search, view and sort
strip. Each row keeps its project identity, revision, stage, stock readiness and
next action together.

Active, attention, pinned, complete and all-project views remain available. Pins
and recent projects are saved in this browser. Search, sorting and pagination must
continue to work together; changing a view resets the displayed page limit.

All next actions expands the complete loaded-project task queue. Workspace tools
reveals inventory entry, requirements import and recorded equipment. These are
supporting paths rather than competing default columns. An empty workspace opens
the entry tools and explains how to start without showing an empty register or a
success claim.

Counts cover loaded records only. Unknown stock results remain visible and are
excluded from check/sourcing counts. A failed refresh preserves the previous
records, explains the failure and leaves retry available. Equipment details do
not imply that a printer, material or design has been physically validated.

## Inventory

Inventory opens around its stock register. A fresh layout keeps the inspector
closed; inspecting an item opens it explicitly. Honour an existing saved layout,
including its inspector choice, width and optional columns.

The toolbar keeps search, Filters, View options and Inspector available. Filters
opens one flat set of labelled controls, with no second hidden filter layer.
Active criteria remain visible after closing Filters. View options contains
sorting, saved views, additional columns and explicit reset actions.

Item identity, recorded stock, available stock and status remain visible. Phone
rows group the quantity and status with the item instead of relying on a wide
scrolled table. Additional columns must not replace required evidence. The
inspector supports reading; opening the item editor leads to the existing stock,
metadata and evidence workflows.

Bulk selection refers to loaded items and keeps its stated limits. Loading,
partial-load failure, no matches, empty inventory and unavailable records need
distinct messages and useful recovery actions. Do not turn an unsuccessful read
into a misleading empty-stock view.

## Projects and task flow

A project starts with its name, revision and stage, followed by stable task tabs.
Project tools groups revision and project-management actions. Project details is
closed initially and reveals the build approach, supporting context and settings
when needed. Destructive actions retain their explicit confirmations.

Place Plan guidance inside the Plan tab, before its requirements. Missing-detail,
stock-check and sourcing shortcuts open the relevant work. Do not repeat that
same guidance above Files, Shopping or Build planning. Requirements precede the
physical-check queue; physical verification stays available below them.

Plan and Files preserve their query, filter and scope through tab detours for the
same project revision. A new revision resets those choices. Staged files require
an explicit upload, with the revision scope visible. Build planning has its own
tab. Design tools reveals Assembly and PCB viewers; existing direct links remain
valid.

Shopping offers owned-stock matching before quoting and keeps canonical selected
quotes distinct from inventory-linked supplier records. Copy/download includes
the complete canonical proposal, not just the currently filtered rows. Preserve
source/date, package quantities, currency, coverage and tax/shipping uncertainty.
The result is a proposal, never an order or purchase authorisation.

Receiving retains the originating requirement through item capture, explicit
count and a separate match review. Do not infer received quantities from package
size or imply that capture confirms compatibility.

## Drafts, confirmations and recovery

Reuse the shared dialog boundary, explicit initial focus and background isolation.
Escape, Tab/Shift-Tab and focus restoration must work with nested confirmations
and newly opened dialogs. The skip link moves focus without changing route.

Draft protection covers project and requirement forms, inventory metadata,
inline build plans, supplier quotes, workstream edits and staged files. Keep
editing preserves the draft; Discard is explicit. Use before-unload protection
only while a protected draft or operation exists.

Stock approval and inspection require their existing reviewed confirmation.
An uncertain save retains its original payload, version and replay identity until
acknowledged. Show failure and recovery inside the active confirmation. Do not
allow a visual simplification to dismiss uncertainty or submit a duplicate command.

Session renewal restores the reviewed stock observation from memory after
sign-in without displaying inventory while signed out or resubmitting it
automatically. Reload the exact item, even outside the initial inventory page.
A definitive rejection permits editing or explicit discard when appropriate;
an ambiguous result does not prove rejection. Private draft content is not saved
in browser storage.

After a confirmed stock update, show a read-only acknowledgement and focus it.
Keep close-out beneath the existing project heading; do not leave an obsolete
review prompt or disabled edit form as the main saved state.

## Optional viewers

Assembly, PCB and Markdown code loads when those views are opened. Image and
plain-text previews do not need the Markdown parser. Keep loading and recovery
local to the affected panel, with the preview's close action and focus boundary
available.

Renderer recovery must preserve edits, parts and notes, and dispose the previous
graphics resources. If a failed module remains cached, explain that the user
should check the connection, save work and refresh. Do not automatically reload
the workspace or offer a retry that cannot recover the failed resource.

## Language and accessibility

Use short, direct sentences and stable maker terminology: Requirements, Inventory,
Revision and Stock checks. Action labels name their action. Errors explain what
failed and the available recovery. Keep exact identity, compatibility, uncertainty
and provenance available when decision-relevant; technical details do not belong
in every beginner instruction.

Readable contrast, visible keyboard focus, hover/disabled/loading/error states,
reduced motion, usable narrow layouts and meaningful control names are acceptance
requirements. Test rendered views as well as token contrast. Automated accessibility
checks do not establish full WCAG conformance or replace assistive-technology and
representative-maker testing.

## Verification and release records

The current overhaul's findings, implementation and acceptance gates are recorded
in [the professional workspace review](reviews/2026-10-03-professional-workspace-overhaul.md).
Its validation and release status must be filled from actual results. A source
change, passing local check, merge and deployed revision are separate outcomes.

The original technical-design release recorded 928 unit/integration tests and
86 browser flows. Those are historical results, not current verification. Later
records include the [shared-component migration](reviews/2026-09-20-shadcn-foundation.md),
[maker experience review](reviews/2026-10-02-maker-experience.md),
[second refinement review](reviews/2026-10-03-maker-refinements.md) and
[flow refinement review](reviews/2026-10-03-maker-flow-refinements.md). Each applies
to its own reviewed revision; dated release status may be superseded by its pull
request or release task.

Use synthetic records for committed tests and screenshots. Require the public
source check, build, typecheck, coverage and browser gates before release. Verify
the deployed image identity, readiness, authenticated routes and retained runtime
data separately. The presentation change introduces no database migration,
HTTP/MCP schema change, purchasing permission or physical-operation authority.
