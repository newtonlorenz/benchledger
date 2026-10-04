# BenchLedger interface

BenchLedger is a visual project workspace with a direct route from a project to
its parts, files and build. Projects and Inventory are peer destinations. Working
screens put the task and its relevant records first; exact technical detail
remains available when needed.

The [web design system](apps/web/DESIGN.md) is the token-bearing record, with its
component previews and extended tokens in `apps/web/.impeccable/design.json`.
This overview describes composition and ownership; keep the two records aligned.

## Appearance

The app serves IBM Plex Sans locally. Keep the root at 16px. Body and form text
remain readable on phones; page titles have clear scale without competing with
working content. IBM Plex Mono is reserved for identifiers, code and technical
values. Ordinary quantities use tabular numerals.

Light mode uses warm-white surfaces, graphite text and restrained cobalt actions
and selection. Dark mode retains the hierarchy with dark surfaces. Status
colours accompany explicit text. Neither colour nor a project image establishes
stock, compatibility or physical-build validation. Settings holds Light, Dark
and System appearance and Standard or Compact row spacing, saved locally.

The desktop header contains Projects, Inventory, search and Settings. Phone
navigation keeps the two workspace destinations at the bottom. Within a project,
Overview / Parts / Files / Build stay in one compact row. Content, forms and
contextual sheets adapt to narrow widths without a second competing navigation
rail. Touch actions retain at least 44px targets.

Use aligned rows, readable space and single rules. Dialogs and sheets have a
clear boundary; working content should not become nested cards or a wall of
counters. Keep primary actions distinct from optional tools and destructive
operations.

## Composition

- Projects: recognisable images, names, revision, stage and next action; one
  search and compact view controls. New project belongs here. Gallery and List
  are remembered in the browser.
- Overview: selected product image, project notes and a specific next action.
  Images distinguish render, reference and built-product photo. Missing images
  remain useful placeholders rather than invented previews.
- Parts: requirements, quantities, compatible stock and sourcing. First use has
  one primary add action and a quiet CSV alternative. Technical specifications,
  alternatives and evidence expand when needed.
- Inventory: searchable stock rows and an item detail sheet, with Available,
  Needs checking and Reserved views. Recorded, available and reserved amounts
  remain distinct. Arrival, count and consumption are separate operations.
- Files: 3D print, Electronics, CAD & firmware and Instructions. Keep filenames,
  scope and revision visible; show genuine preview/download actions. Opening a
  downloaded file in a slicer and physical fabrication remain outside the app.
- Build: check parts, prepare files, assemble, verify the build and record actual
  use. Reservations, parts/plates and task groups remain disclosed in Build tools.
  Assembly, PCB and actual-stock-use tools remain secondary routes under Build.
- Stock review: show the exact affected item, proposed quantity and balances
  supplied by the service before confirmation. A saved result is a receipt;
  revisiting it must not perform the write again.

Project actions contain actions for the selected project. New project and routine
refresh are not competing rows in that menu. Keep history, revisions, build
approach, archive/restore and deletion reachable with their existing guards.

## Ownership

`apps/web/src/shadcn.css` owns semantic tokens. `workspace-shell.css` retains the
shared control and shell foundation; `approved-interface.css` owns the current
header, global working rhythm and responsive sheet treatment. Project, library,
home and inventory styles own their respective compositions.
`specialist-journey.css` owns Build and supporting reviews; assembly and PCB retain
local styles. Avoid introducing another competing global layer.

React and Radix primitives retain keyboard, focus and interaction semantics.
Local appearance, pins and views do not change business records. Keep protected
drafts mounted through supported detours; never save private form values to
browser storage to implement recovery.

## Verification boundaries

Check desktop and phone layouts, themes, keyboard focus, zoom, long names, empty
states, errors and draft continuity. Follow the repository gates and inspect the
public diff. A design mockup, source change, passing test, merged commit and
verified deployment are separate evidence. Existing showcase screenshots may
illustrate an earlier layout; they do not verify this interface revision.

See [the UI guide](docs/ui-design.md) for interaction details and
[capability map](docs/capability-map.md) for transport boundaries. Dated findings
belong in task or review records, not permanent instructions.
