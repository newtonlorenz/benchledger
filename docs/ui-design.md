# Technical workspace design

## Product intent

BenchLedger is a working tool for maker projects, stock and build records.
The interface must show the current record, its status and the next available
action. Do not add marketing panels, simulated activity or unmeasured statistics.

The overview uses a project register and counts from loaded records. Stock
readiness and design validation remain separate. A blank or unavailable result
must not be presented as zero or as a successful check.

## Visual system

`apps/web/src/workspace-design.css` defines the theme and presentation tokens.
`styles.css` retains component structure and the existing responsive behaviour.
Use tokens for colours. Do not add fixed light backgrounds to individual panels.

The visual language uses graphite navigation, neutral work surfaces, thin
borders and small corner radii. Orange identifies primary interface actions.
Green, amber, blue and red identify existing status meanings. Always show status
text as well as colour. Do not use colour to imply a check that did not occur.

IBM Plex Sans is the interface font. IBM Plex Mono is used for quantities,
identifiers, versions and keyboard keys. Font files are served by the application,
not by a remote font service. Keep essential labels readable at phone widths.

Light, Dark and System modes use the same component structure. Standard and
Compact row spacing change presentation only. Compact rows apply to pointer
devices. Touch controls retain their target size.

## Interaction rules

The View control changes local appearance. These settings are stored in the
browser and must not send workspace writes. The desktop navigation can collapse
to an icon rail; its accessible names remain available.

Control/Command + K opens the existing inventory search.
Control/Command + Shift + K opens workspace commands. Commands can open pages,
projects, loaded items and entry forms. They do not perform data writes. The
command panel states that its project and item results use loaded records.

Reuse the existing dialog focus boundary. Place `data-autofocus` on an explicit
initial control where needed. Escape closes the current dialog. Focus restoration
must not override a later navigation or a newly opened dialog. The skip link
moves focus without changing the application route.

## Interface language

Use short technical sentences with one instruction per sentence. Use the same
term for the same object. Start action labels with a direct verb, such as Add,
Review, Save, Open or Remove. State the result of an operation separately from
the next instruction. Preserve warnings, uncertainty and approval boundaries.

Use Requirements for the plan, Inventory for stock records, Revision for a
recorded version and Stock checks for physical verification. Do not replace
these terms with promotional language. Keep technical details available without
putting identifiers or transport terminology into beginner instructions.

These conventions follow simplified technical-writing principles. They are not
a claim that the complete interface has passed an ASD-STE100 dictionary audit.

## Verification

The design release was checked with a clean lockfile installation, all package
and application builds, workspace typechecks and the existing 80% coverage gates.
The complete local run passed 928 unit/integration tests and 86 browser flows.
The production dependency audit reported no known vulnerabilities.

Design regressions check both themes at 1536, 390 and 320 pixels, local preference
persistence, compact rows, collapsed navigation, command selection, modal focus,
reduced motion, the skip link and same-origin font requests. Eight core text and
background token pairs meet a measured contrast ratio of at least 4.5:1 in both
themes. This token check is not a full accessibility certification.

The change does not modify API contracts, account permissions, stock rules or
database schemas. Theme, density and navigation preferences do not send business
data writes. Screenshots use isolated sample records, not the live workspace.

Local verification is not deployment evidence. The design requires a separate
approved release before it appears on the live service. The existing large
JavaScript chunk warning remains; this pass does not claim a performance audit.

## Task-oriented home and project pages

The home page supports multiple projects with search, local pins, status views
and recent-project resume. Attention entries link to the relevant project and
work, not to a generic landing page. Counts use loaded records and exclude
unknown readiness from Check/Source totals. The page states that limitation.

Place the normal action beside its records: add/import above requirements,
quotes at the start of Shopping, build plans in their own tab and file selection
with the chosen revision. Keep archive and removal controls in project settings.
See the dated [workflow review](reviews/2026-09-07-workflow-polish.md) for scope,
competitor references and the latest test results. Earlier counts above describe
the original technical-design commit, not this later workflow revision.
