# Customer workflow review

Date: 7 September 2026.
Reviewed live base: PR #41, `03cd45b`.
Pending design base: `888c272`.
Implementation branch: `codex/customer-workflows-polish`.

## Assessment

The main weakness was task structure, not colour. The live home selected a
project for the user and offered little control over multiple projects. The
pending design improved presentation but still lacked search, pins, useful
filters and direct access to unfinished work. Build planning was below the BOM.
Supplier quote entry followed an empty legacy shopping panel. Import controls
and some disclosures did not clearly communicate where to act.

This review used rendered pages and real application workflows with isolated
synthetic records. Live inspection was read-only. It is an expert review, not
an observed customer study or a claim of universal usability.

## Competitor references

Primary product documentation inspected:

- PartsBox user guide: https://partsbox.com/users-guide.html
- PartsBox saved presets: https://partsbox.com/saved-presets.html
- PartsBox configurable tables: https://partsbox.com/configurable-tables.html
- OpenBOM dashboard: https://help.openbom.com/dashboard-and-user-interface/
- InvenTree user interface: https://docs.inventree.org/en/latest/concepts/ui/

PartsBox informed persistent project views and record-level actions. OpenBOM
informed the clear separation of navigation, record lists and create/import
controls. InvenTree informed the task-oriented dashboard. The implementation
adopts those patterns, not their whole feature sets or unverified claims about
customer preference. No simulated activity feed, invented deadlines or fake
inventory totals were added.

## Page and journey decisions

| Page or journey | Finding | Implemented decision |
| --- | --- | --- |
| Home | Static counts and an arbitrary current project | Searchable project hub, status filters, pins, recent-project resume, task queue and quick entry |
| Home to project | Prior archive view could reopen the wrong context | Switch to active context before opening a home or command result |
| Required parts | Import and add controls were separated from the records | Put both actions above the list; home tasks select the relevant requirement filter |
| Build planning | Buried below the BOM in a disclosure | Add a direct project tab and bookmarkable build route |
| Supplier sourcing | Useful quote entry followed an empty legacy panel | Show project quotes first; expose sourcing/review/all filters; retain legacy offers separately |
| Files | Empty list with no drop target or search | Stage dropped files for explicit upload; search within the selected revision scope |
| Guided setup and import | Narrow long forms, weak disclosure cues | Wider review dialogs, visible setup steps, clearer file controls and mapping layout |
| Inventory and item details | Functional table; confirmed product match used warning styling | Retain the stock workflow; use confirmation styling only for confirmed product identity |
| Settings and categories | Actions worked but needed a consistent visual hierarchy | Retain grouped administration and existing permission boundaries |
| Agent context | Appropriate technical contract and copy workflow | Retain the live-contract guidance; do not invent agent permissions |
| Used-stock close-out | Physical review is consequential | Retain explicit preview/commit and physical-evidence boundaries |
| Modal navigation | A skip link could receive focus behind a modal | Make the link inert with the background and set explicit initial focus in import/setup |

The final visual pass included a six-project workspace, inventory and its drawer,
project planning, files, sourcing, build plans and their editor, imports, new
project entry, guided setup, settings, categories and agent context. Light/dark
and phone views were checked separately. Live close-out was inspected without
submitting a stock change. Browser write acceptance used only synthetic records.

## Verified result and release boundary

The final clean-lockfile local gate passed on Node.js 24 and npm 11:

- 937 unit/integration tests across 98 files.
- 93 browser flows, including the inherited workflows and new home/task/import tests.
- Builds, workspace typechecks, all original coverage thresholds and whitespace checks.
- Coverage: lines/statements 89.43%, branches 81.75%, functions 82.02%.
- Production dependency audit: zero known vulnerabilities reported.
- Twenty rendered application states, including light/dark and mobile views,
  with no reported page-width overflow or uncaught browser errors.

The new acceptance cases test project search, pins and resume at desktop,
intermediate and narrow-phone widths; home-to-stock-check routing; archive-view
recovery; direct build routes; import focus isolation; visible quote entry;
and explicit upload confirmation after dropping a file.

No live business data, database schemas, account permissions or application stock
rules were changed. Local browser preferences do not grant access to records.
The latest live release remains separate from this un-deployed candidate.

Remaining validation is customer observation on real projects, not another
cosmetic pass. Automated checks do not prove that every user will find every
workflow intuitive. Full named-account UX and production-team feature parity are
not claimed. Existing large JavaScript bundle warnings remain unchanged.
