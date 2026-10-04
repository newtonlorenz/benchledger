# Workspace interface design

## Product intent

BenchLedger helps a maker recognise a project, find its parts and files, and
continue the build. Projects and Inventory are peer destinations. Owned stock,
confirmed usable stock, requirements and actual sourcing gaps remain distinct.
A missing result is never zero or a successful check.

## Visual system and ownership

The interface uses warm-white surfaces, graphite text and restrained cobalt
selection and actions. Dark and System appearance keep the same hierarchy.
Status colours always accompany text. IBM Plex Sans is served locally; IBM Plex
Mono is reserved for identifiers and code. Keep the 16px root and readable phone
form text. Use tabular numerals for quantities.

Working content uses aligned rows, space and single rules. Product imagery leads
the gallery and Overview; it does not repeat above Parts or Build. Contextual
sheets and dialogs have a distinct boundary. Do not turn ordinary task content
into nested cards, decorative counters or unsupported completion claims.

| Stylesheet | Responsibility |
| --- | --- |
| `apps/web/src/shadcn.css` | Semantic light/dark tokens and shared primitives. |
| `apps/web/src/workspace-shell.css` | Retained common controls, typography and shell foundation. |
| `apps/web/src/approved-interface.css` | Current header, working rhythm, Settings and responsive sheet treatment. |
| `apps/web/src/home-experience.css`, `project-library.css` | Project library, view controls, imagery and supporting workspace tools. |
| `apps/web/src/project-workspace.css` | Project heading, four sections, overview, requirements and grouped files. |
| `apps/web/src/inventory-experience.css` | Stock collection, filters, rows and contextual item details. |
| `apps/web/src/specialist-journey.css` | Build sequence, planning forms, stock and inspection reviews. |
| `apps/web/src/assembly.css`, `pcb.css` | Specialist geometry views and guides. |
| `apps/web/src/workspace-layout.css` | Retained workflow and form rules not owned above. |

Use the existing owner rather than adding another global restyling layer. React
and Radix provide interaction boundaries; application rules retain authority over
dismissal, concurrency and stock writes.

## Navigation and preferences

The desktop header keeps Projects, Inventory, workspace commands and Settings
available. Phone navigation keeps Projects and Inventory at the bottom. Settings
contains Appearance and the supporting agent-access route. Light, Dark, System,
Standard and Compact choices are browser-local preferences. Compact spacing does
not reduce touch targets. Inventory view options retain sorting, optional columns
and saved views separately from workspace appearance.

Control/Command + Shift + K opens workspace commands. Control/Command + K retains
the inventory-search shortcut. Commands navigate or open forms; they do not
submit business mutations. Search results state their bounded record scope.
Existing project subroutes remain reachable through the four-section navigation.

## Project library and Overview

Projects defaults to Gallery with a remembered List alternative. Each project
keeps identity, revision, stage and next action together. Search and view controls
stay compact; filters with no results provide recovery rather than a creation
prompt. Active and archived projects remain distinguishable. Pins and recent
project IDs are local preferences, not shared project records.

Overview is the project landing section. It shows the selected image, notes and
one next action derived from the available project state. An image is explicitly
a design render, reference image or built-product photo. Missing or failed images
retain useful actions, and a prior-revision selection is not silently reused.
Images do not establish dimensional accuracy or manufacturing readiness.

The project menu contains only actions for that project, including revision
history, build approach, archive/restore and deletion. New project belongs in the
library. Destructive actions retain their confirmations.

## Parts and inventory

Parts holds requirement entry, stock matches, checks and the To source route.
An empty list presents one primary Add first part action and a quiet import
alternative. Requirement entry starts with name, amount and unit. Stock
selection, specifications, alternatives and evidence remain available without
making them prerequisites for capturing the first requirement.

On desktop, part details sit beside the undimmed list. Keep the selected stock,
its uncertainty and Check this stock visible with the requirement. On phones,
the same draft uses a task sheet. Stock detours preserve the originating draft.

Keep required, recorded, available, reserved and used quantities distinct. Ready
requires the relevant canonical compatibility and evidence checks; owning an
item or counting it does not prove fit. Supplier quotes retain their source,
date, package units, currencies and tax/shipping uncertainty. Combined proposals
remain available as a supporting path. A proposal is not a purchase.

Inventory is a searchable collection with stock views such as Available, Needs
checking and Reserved. Selection opens contextual item details. On phones those
details use a sheet; the desktop supports its inspector. Additional columns,
exact categories, evidence and bulk actions remain available through controls.
Bulk selections cover loaded records and retain observed versions.

Add item records known identity and stock information. Record arrival and Count
stock are separate operations. Neither an order nor an arrival silently becomes
confirmed usable stock. Counts review the exact item and proposed balance before
saving. A successful count is a receipt; compatibility remains a separate check.

## Files

Files groups current scoped records under 3D print, Electronics, CAD & firmware
and Instructions. Each row retains its filename, revision and decision-relevant
metadata. Details come from the selected file, never the project cover image.
Missing groups and failed previews have an add or recovery path in context.
Empty groups use compact rows; selected details align with the Files heading on
desktop so the actual files and their actions share the working viewport.

Preview uses supported file bytes and integrity checks. Unsupported formats show
details and Download. The browser does not launch a slicer, review toolpaths or
start a print: download a 3MF and open it in the chosen slicer, then check printer,
nozzle, material, supports and toolpaths. Assembly and PCB inspection remain
separate supported viewers.

Choose one exact current project or workstream revision before uploading.
History/all-files browsing is read-only. Search and scope survive a tab detour
within the same project revision; a new revision resets them. Staging or dropping
a file does not bypass explicit upload or draft protection.

## Build and specialist tools

Build follows five ordered steps: check parts, prepare files, assemble, verify
the build and record actual use. The sequence is guidance, not automatically
checked-off physical progress. Real stock/file facts are shown where available;
task status and model previews never certify a physical assembly.
The compact sequence remains visible alongside actual-use review on desktop
and above it on phones. Detailed tools stay disclosed in Build tools.

Build tools contains Set aside stock, Parts and print plates, and Task groups
and progress as separate disclosures. Verification notes
open the task-group area, where observations can be recorded with the relevant
work. Evidence files are attached in Files. There is no separate automated
physical-verification certificate.

Build retains secondary Assembly, PCB and Used stock routes when the server
advertises them. Plate plans retain repeated parts, layouts, runs, material/time
estimates, file hashes and history. Task groups retain status, notes, assignment,
due date and revision history. Coordinate and placement controls stay available
inside the geometry tools. Missing capabilities explain the unavailable action.

Actual-use review keeps the exact affected stock and proposed movements visible.
On hand after and available after are distinct; unavailable balance fields are
labelled rather than invented. The final confirmation repeats affected items and
quantities. A committed review becomes a receipt and cannot submit again.
Reservations hold availability and do not record physical consumption.
The confirmation keeps the consumption and resulting balances beside Apply;
separate reservation-release and consumption ledger entries remain inspectable.

## Drafts, confirmations and recovery

Use shared focus boundaries and explicit close controls. Escape, Tab/Shift-Tab,
focus restoration and phone sheets must work without leaving a hidden active
form behind another editable surface. A requirement's Check stock action keeps
its draft mounted while the selected item is counted and reviewed. The receipt
returns to that part by name; adding an owned item also returns without replacing
the requirement draft. Counting does not save the match or prove compatibility. Supported reauthentication
recovery retains observation values and original retry identity in memory, not
browser storage; it does not display restricted inventory while signed out or
resubmit automatically.

An ambiguous write keeps its original payload, version and command identity for
unchanged retry. A definitive conflict never silently overwrites newer data.
Recorded receipts do not repeat mutations. Errors, empty collections, filtered
no-results states and unavailable records have different recovery actions.
An Add a part failure keeps its error, retained-draft explanation and retry
together in the footer while the fields scroll, including on short phones.

## Accessibility and release evidence

Maintain readable contrast, visible focus, keyboard/touch operation, reduced
motion, usable zoom and narrow layouts. Check long names, pending writes, failed
reads and draft continuity in rendered views. Automated checks do not establish
full WCAG conformance or replace assistive-technology and maker testing.

Use synthetic fixtures and public assets for verification. Run the required
public-source, build, typecheck, coverage and browser gates before release.
Verify deployed identity and authenticated routes separately. The UI redesign
introduces no new HTTP/MCP operation, stock semantics or physical-operation
authority. Existing [review records](reviews/2026-10-03-professional-workspace-overhaul.md)
and showcase images describe their own revisions, not proof of this build.
