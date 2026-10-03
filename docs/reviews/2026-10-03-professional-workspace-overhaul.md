# Professional workspace review and implementation plan

Date: 3 October 2026.

Status: implementation and visual review complete. Final automated validation,
required GitHub checks and release status are recorded below. Deployment requires
its own verified runtime result; a local preview does not establish deployment.

## Objective and evidence

The user reports that the interface remains noisy, awkward and difficult to use
after earlier refinements. This pass treats that as a structural design problem:
a maker should recognise the working record, the available action and supporting
context without repeatedly interpreting the interface.

Evidence comes from the current web source, the preceding workflow reviews and
inspection of the synthetic demonstration workspace. Source inspection identifies
repeated layout rules and visible controls; expert design judgement identifies
the likely attention and comprehension costs. This is not a representative-maker
usability study, and no measured productivity improvement is claimed.

The review covers the shell, Workbench, inventory, project Plan, Files, Shopping,
Build planning, details and supporting dialogs. Existing stock evidence, draft
protection and recovery behaviour are constraints for the redesign. Machine
control, purchasing, native mobile work and a new data model are outside scope.

## Findings and priorities

| Priority | Evidence and resulting problem | Implemented response | Acceptance criterion |
| --- | --- | --- | --- |
| P1 | The main layout stylesheet accumulated successive definitions of the same shell, register and responsive selectors. For example, the Workbench column layout was repeatedly replaced later in the same file. A small visual correction could affect unrelated breakpoints. | Give the shell, Workbench, inventory and project their own canonical composition stylesheets. Retain specialist workflow styles separately and remove superseded rules. | Each principal surface has an identifiable stylesheet owner. Desktop and phone views use the same intended hierarchy without relying on another appended override layer. |
| P1 | Small rem-based labels and inconsistent sizing made the interface harder to scan. A 14px root would turn a nominal `.875rem` body into 12.25px and `.75rem` metadata into 10.5px. | Set an explicit 16px root; use 14px body/controls, 12px metadata and 26px page titles, with suitable larger phone inputs. | Inspect computed sizes in the rendered app, including dark mode and narrow widths. Body and metadata remain legible, with no clipped meaningful labels. |
| P1 | Workbench presented a resume panel, multiple project-filter buttons, a project register and a separate task queue with another filter row. These competed for attention and repeated next actions. | Use a full-width project register with one search/view/sort strip, an inline recent-project link and a next action in each row. Disclose the aggregate task queue and workshop tools. | Finding, pinning, sorting, resuming and opening a concrete next action work without expanding supporting tools. Task filtering and pagination remain available after disclosure. |
| P1 | Project guidance, management controls and supporting build context competed with the active tab. The same guidance appeared around work that did not need it. | Put project management in Project tools, keep Project details closed initially, and place Plan guidance within the Plan tab. Keep stable tabs ahead of the working records. | Requirements are the main Plan work area. Files, Shopping and Build planning expose their own work without repeated Plan guidance. Revision and lifecycle controls remain discoverable and functional. |
| P1 | Inventory's layered filters, optional columns and open inspector consumed space before the stock list. Nested filter disclosure made available criteria harder to discover. | Start fresh layouts with a closed inspector; open it when an item is inspected. Use one flat filter group, active-filter feedback and a View options popover for sorting, saved views and optional columns. | Search and core stock columns are immediately usable. Existing saved layouts are honoured. Filtering, column selection, inspector resizing, saved views and reset actions remain keyboard accessible. |
| P2 | The shell repeated search and command entry points while typography, surfaces and control geometry differed between views. | Use one visible Search & commands launcher and one restrained shell/control system. Keep the direct inventory shortcut and contextual register search. | Commands open the correct page or form. Search scope is explicit. Theme, density, navigation collapse and focus remain predictable. |
| P2 | Dense rows and competing columns became awkward on phones and at intermediate desktop widths. Earlier corrections relied on many viewport-specific overrides. | Stack records deliberately when the available width narrows, preserve identity/quantity/status groups and retain 44px touch targets. Avoid decorative cards around each group. | Inspect at desktop, intermediate and phone sizes, including 320px. No document overflow or unreachable actions; labels, menus and dialogs remain usable. |
| P2 | Strong presentation of totals or empty success states could obscure unknown readiness or encourage an incorrect inference that a build is validated. | Preserve loaded-record scope, unknown readiness, evidence text, refresh failures and explicit stock confirmation. Empty workspaces offer entry actions without task-success claims. | Unknown stays unknown; failed reads do not become empty inventory; stock readiness never implies design or physical validation. |

## Design direction

Use the organisation of a workshop register: stable navigation, clear record
rows, precise labels, generous separation between groups and restrained forest
green for selection or the primary action. Projects and Inventory keep equal
standing in navigation. Calm presentation should make successful work feel
satisfying through useful progress and clear acknowledgements, without decorative
metrics or gamification.

Keep React and the existing Radix-backed primitives. They already provide focus
boundaries, accessible control semantics and established regression coverage.
The visible problems are addressed through hierarchy, composition, sizing and
stylesheet ownership; replacing the interaction framework is not required to
solve them.

No illustration or external image asset is necessary for this tool. Synthetic
records are used for visual acceptance. Real inventory, private hosts, runtime
paths, backup details and user files must not enter the public documentation or
screenshot set.

## Implementation sequence

1. **Establish the foundation.** Consolidate semantic light/dark tokens, set the
   root type scale and define the neutral rail, utility bar, page gutters,
   buttons, fields and focus treatment in `workspace-shell.css`. Remove old
   competing shell rules from `workspace-layout.css`.
2. **Recompose Workbench.** Make New project the primary action and Open inventory
   the peer destination. Keep recent work compact. Replace multiple filter tabs
   with a labelled view selector beside search and sort. Preserve pins, empty
   and unknown states, refresh recovery, equipment and every task route.
3. **Make inventory a working register.** Keep search and stock records together.
   Flatten Filters, group presentation controls in View options and open the
   inspector deliberately. Preserve saved preferences, bulk selection, loaded
   scope and stock evidence.
4. **Make each project tab own its task.** Keep the heading concise, move revision
   and management actions to Project tools, and disclose supporting details.
   Keep Plan context inside Plan. Retain Files/Plan view continuity and the
   existing sourcing, receipt and stock-review workflows.
5. **Validate the complete composition.** Review desktop light and phone dark
   views in a batch, inspect computed geometry/type, then correct the identified
   issues together. Check intermediate widths, both themes and keyboard paths.
   Review the final source independently before the complete project gate.
6. **Release the verified revision.** Run public-source checks and the full gate,
   satisfy required remote checks, merge the reviewed head and deploy its exact
   image. Verify runtime identity, readiness, authenticated routes and data
   preservation separately from local testing.

Steps 1–5 are implemented and reviewed. The validation and release evidence below
determines whether the release gate is satisfied.

## Workflow acceptance matrix

| Journey | Required outcome |
| --- | --- |
| Start with an empty workshop | New project and inventory entry are clear. Import remains available. No empty register or implied successful planning checks. |
| Resume and find work | Search, view, sort and pins combine correctly; the recent link opens the named accessible project. Show more reveals additional loaded projects. |
| Review an outstanding task | A row action and the expanded task queue open the correct project and relevant work. Queue filters and Show more preserve access to all loaded tasks. |
| Find and inspect stock | Search/filter results state their loaded scope. Inspecting a row opens the correct item; opening and closing the inspector does not discard filters or selection. |
| Change the stock view | Flat filters, saved views, optional columns, sorting and reset controls work. Core stock/status columns remain visible and stored preferences survive reopening. |
| Plan a project | Requirements lead the view. Missing details, checks and sourcing link to their actual work. Unavailable readiness is explicit. |
| Move between tasks | Files and Plan retain their current-revision view through detours. Build planning and optional viewers keep their direct routes. Project details can be opened without replacing the active task. |
| Record or receive supplies | Supplier quote evidence, owned-stock matching and complete proposal export remain intact. Capture, count and requirement matching remain separate explicit actions. |
| Recover from interruption | Existing draft guards, stock confirmation, ambiguous-save identity and session-renewal recovery pass unchanged. Sign-out must not display private records. |
| Use keyboard or a phone | Focus is visible, dialogs contain focus, dismissal returns it correctly, menus do not obscure the next task, controls remain reachable and the document does not overflow. |

## Verification gates and results

| Gate | Current evidence |
| --- | --- |
| Workbench component/state regressions | Passed: 6 component tests and 8 state tests, 14 total. Covers search, pins, resume, next actions, disclosure, task pagination, equipment, empty/unknown records and refresh failures. |
| Integrated visual review and computed-size checks | Passed for the inspected synthetic workspace: desktop light, tablet dark and phone light/dark. The final review covered 1280, 820 and 390px layouts; browser regressions also cover 320px. Root type is 16px, body 14px; inventory stacks at its actual container width. |
| Independent correctness and design review | Independent follow-up found no remaining source blocker. Findings corrected: stable inventory focus, inspector width reset and repeated resizing after the layout settles, collapsed category navigation, tablet filter sizing, popup-to-dialog focus return and phone command positioning. Regression coverage retains stock, evidence, draft and modal-isolation assertions. |
| Public-source/privacy and final diff review | Public-source/privacy checks passed. Separate final diff review contains only application, synthetic regression tests and documentation changes. |
| Build, typecheck, coverage and complete browser suite | Passed: `npm run check`, including all builds/typechecks, 1,225 unit/integration tests across 150 files and 165 browser scenarios. Coverage: 87.95% statements/lines, 82.67% branches, 82.37% functions; the 80% thresholds remain unchanged. |
| Required remote checks and merge | Awaiting publication and required GitHub checks. The pull request will record their outcome and merge identity. |
| Deployment and live verification | Blocked by unavailable access to the authorised integration host. This revision has not been deployed; runtime identity, data preservation and live verification remain outstanding. |

The focused Workbench command was:

```sh
NODE_OPTIONS=--no-experimental-webstorage npm run test --workspace=@benchledger/web -- src/workbench-home.test.tsx src/workbench-state.test.ts
```

The pull request records the exact reviewed commit and subsequent merge/release
identity. Local screenshots contain synthetic demonstration records only.
The design detector returned three advisories: the existing brand bar radius
and prominent phone item size are documented; the additional navigation shadow
was removed. No new raster assets ship with the app. Passing automated accessibility checks establishes only their bounded
result; representative-maker and assistive-technology testing remain separate.

## Finish verdict

The new hierarchy makes the project and inventory registers the main working
surfaces, with management and supporting detail available on request. The
identified layout and focus defects are corrected. This is a technical and expert
design acceptance, not a claim that representative makers have validated the
experience. Release remains conditional on the recorded release gates.

## Release boundaries and rollback

The redesign changes web presentation, navigation composition and local view
defaults. It does not introduce a data migration, HTTP/MCP contract, authentication
change, new stock rule, purchase action or machine operation. Keep append-only
evidence, optimistic concurrency, draft retention and reviewed save semantics.

Before cutover, take and verify a recoverable runtime backup and preserve the
previous image. Deploy only the intended service. Confirm the exact deployed
revision, readiness, authenticated application paths, unauthenticated endpoint
protection and retained data/artifacts. Keep private deployment evidence outside
the public checkout.

Rollback uses the preceding application image or reverts the web presentation
change and rebuilds. No database downgrade or deletion of local preferences is
needed. A release must not claim measured ease-of-use improvement, physical build
validation or production parity without corresponding evidence.

## Follow-up research

After technical and visual acceptance, observe representative makers completing
three tasks: create a project and first requirement, reuse uncertain owned stock,
and recover from an interrupted save. Record completion, wrong turns, unnecessary
navigation and whether the maker can explain stock readiness versus build
validation. Use those observations to prioritise subsequent changes; this review
has not performed that study.
