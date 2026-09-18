# Desktop workspace redesign

## Outcome

Reorganised the web client around equal access to inventory and project work.
The desktop shell has a compact persistent toolbar, a separately scrolling
working area and a project navigator with search and active/archive views.
Project selection no longer competes with document actions in the page header.
The project inspector can be hidden; assembly and PCB viewers use the full
working width. Project deletion is under Project details → Project settings.

The workbench now presents summary counts as compact shortcuts and names the
project register's columns. Document surfaces use separators and fewer panels,
a compact type scale, a pale sidebar and a restrained green action colour.
Existing dark mode, density, commands, inventory search, stock labels and
responsive layouts are retained.

## Evidence and constraints

Visual inspection used the local synthetic demonstration workspace. Reviewed
project, inventory and workbench views, narrow navigation and the dark theme.
The earlier project screen placed its requirements heading about 160 pixels
lower at the same desktop viewport. Hiding the inspector releases about 270
pixels of width. These are layout observations, not measured user productivity.

The navigator searches loaded projects, not an unbounded server index.
Inventory search remains server-paged. The inspector toggle is local view state.
This changes no database, API, MCP, authentication, stock or purchasing contract.
Draft protection and deletion confirmation remain in place.

## Verification

Final `NODE_OPTIONS=--no-experimental-webstorage npm run check` passed using
Node.js 24 and npm 11: public-source checks, build, all workspace typechecks,
1,034 unit/integration tests and 134 Playwright tests. Coverage thresholds passed
(89.63% statements, 82.31% branches, 82.05% functions, 89.63% lines).
The browser suite includes light/dark accessibility checks, 320px layouts,
keyboard focus, browser history and interrupted-save recovery. The design
scanner reported no findings. No remote integration or deployment was run.
New regressions cover project-name filtering, active/archive empty states,
independent desktop scrolling, inspector width, staged-file navigation protection
and mobile project selection. Viewer tabs also hide the inspector while their
optional code loads or fails, then restore the prior inspector choice on return.
Existing tests follow the new project navigator
and deletion location without weakening their business assertions.

## Delivery and rollback

This record describes the isolated implementation and local verification before
publication. Subsequent release status is recorded in the associated pull request.
The pre-existing mobile work was outside this isolated checkout.
Rollback consists of restoring the web presentation changes; no data migration
or API rollback is required.
