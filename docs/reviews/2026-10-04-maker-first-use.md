# Maker first-use review and refinements

This round reviewed the current app as a new maker creating a 3D printed or
electronics project, adding workshop stock and returning to the project. It also
covered returning users, templates, build steps, physical checks, files, quotes,
keyboard navigation, phone layouts and interrupted saves. These are expert
judgements supported by synthetic task checks, not representative-user research.

## Findings and plan

The independent starting assessment was 27/40 across ten usability heuristics.
The strongest foundation was the separation between owned stock, confirmed
quantity and project readiness. The main weakness was continuity: ordinary tasks
required detours, repeated entry or interpretation of specialist terminology.
A separate source and browser assessment was used to challenge the design review;
its stylistic detector findings were triaged rather than treated as defects.

| Priority | Friction observed | Implemented refinement | Acceptance evidence |
| --- | --- | --- | --- |
| P1 | A requirement cannot capture an unlisted owned item without leaving its draft. | Add an owned item opens inventory capture inside the task and returns the selected item to the original requirement. | Name, quantity, unit and note survive cancellation, counting and sign-in; no implicit compatibility or conversion claim. |
| P1 | Interrupted capture and count can lose context or create overlapping inaccessible dialogs after sign-in. | Retain the draft and original command identity in memory; close the suspended parent modal layer; resume explicit retry after authentication. | Lost acknowledgements, rejected replays, count review, single command identity, restored focus and server read-back are covered. A captured item deleted elsewhere no longer traps workspace loading. |
| P2 | Stock capture repeats a quantity already entered and has no clear end. | Carry explicit counted intent into a separate count review; show Physical count saved, Done and Back to requirement. | Capture alone remains unconfirmed stock. Only the reviewed count changes evidence. The receipt reports the saved quantity and keeps compatibility separate. |
| P2 | Empty registers expose filters, disabled shortcuts and parallel starting choices. | Projects and Inventory have focused first-use states. Hide controls that have no current purpose; distinguish failed loading and filtered zero results. | First project and first item are clear; saved empty searches retain filter recovery; archive-only workspaces can open the archive. |
| P2 | Workbench and Projects overlap; Plan and Build planning sound similar. | One Projects destination opens the project register. Project tabs use Requirements and Build steps. | Project navigation, browser history, selected tabs, retained view filters and project removal return to the correct destination. |
| P2 | Phone controls push the first requirement below the useful viewport. | Move secondary import, design and stock-update actions into Project tools on phones; compact status and the next action. | A complete first requirement is visible at 390px without scrolling. The active stock-update tab remains visible and secondary actions remain reachable. |
| P2 | Fasteners and electronics cannot record useful specifications during capture. | Offer optional details for all manually captured item types; use Electronic component and plain quantity units. | Maker specifications save with the first record. Missing description placeholders never become editable stored text. |
| P2 | Templates keep redundant choices open and stock selection covers only loaded inventory. | Collapse the chosen template, focus its first requirement and use the full inventory search in expanded requirement details. | Original quantities and canonical units are retained; selecting stock does not invent conversions; template choices cannot overwrite existing rows. |
| P2 | Build and inspection editors lack consistent entry, cancellation and recovery focus. | Focus the first field or active check, guard meaningful drafts, return to the initiating control and separate question/candidate/impact text. | Keyboard, discard/keep-editing, failed save and retry flows retain meaningful focus and content. |
| P3 | Specialist language and permanent technical detail compete with work. | Use Task groups, Design file, Save build plan and Save quote; disclose identifiers and evidence when relevant. | Existing domain behaviour and exact technical evidence remain available. |

## Experience decisions

The primary reward is visible progress: a saved count, a usable requirement and a
clear next action. Decorative gamification would not resolve these task costs.
Projects and Inventory remain peer destinations. A project can start with one
requirement; selecting equipment and a build approach can follow when useful.

The first requirement action is persistent, so saving does not remove its keyboard
return target. Empty removed-requirement controls disappear only after checking
retained history, so an all-removed project can still restore its requirements.
Phone simplification moves actions to a named menu instead of removing them.

In the final 390 × 844 synthetic phone view, the first requirement starts at
426px and ends at 623px, compared with approximately 725px for its starting
position before the final refinement. Its quantity, matched item, stock details,
Ready status and Edit action are visible together. Guided setup keeps its header
and primary action readable while scrolling, without content bleeding around
those sticky regions.

## Final expert assessment

| Criterion | Score | Basis |
| --- | --- | --- |
| First project and onboarding | 8.5/10 | Two useful starting paths, concrete maker examples and a short initial form. |
| Navigation and organisation | 8/10 | One project register and distinct requirements/build destinations. |
| Requirement entry | 8.5/10 | Owned-item capture retains the original task and its draft. |
| Inventory capture | 8/10 | Specifications, count intent and explicit completion work together. |
| Language and stock meaning | 8/10 | Plain maker labels; availability, fit and physical validation remain distinct. |
| Visual hierarchy and craft | 8/10 | The working records are visible on desktop and phone; secondary actions recede. |
| Feedback and draft handling | 8/10 | Exact post-sign-in retries, retained drafts, restored focus and saved-data read-back pass. |
| Returning-maker efficiency | 8/10 | Fewer detours and repeated fields; existing view retention remains. |
| Maker-specific usefulness | 8/10 | Practical component specifications, templates, task groups and stock context. |
| Satisfaction and progress | 8/10 | Saved outcomes and useful continuation actions make completion clear. |

The independent re-review initially kept hierarchy and recovery below 8. The
phone layout was corrected and visually re-reviewed. All three recovery browser regressions then passed, including saved-data
read-back and reconnection after removal elsewhere; the reviewer raised recovery
to 8 only after those checks passed.
No criterion is scored 10: real-maker task observation remains necessary to test
these judgements and discover unfamiliar workflows.

## Verification and release

Focused component/API checks and synthetic browser journeys cover the behaviours
above. Independent correctness review found two additional recovery issues:
retaining an ambiguous command identity across rejected retries, and recovering
when a just-captured item is removed elsewhere. Both were corrected before the
final gate. A full browser run then exposed the nested-modal sign-in defect;
the suspended requirement now retains state without an active modal layer.

The final `npm run check` passed: public-source checks, all builds/typechecks,
1,251 tests across 150 files and all 171 browser scenarios. Coverage was 88.09%
statements/lines, 82.84% branches and 82.71% functions. Updated browser tests follow
the visible phone Project tools actions; assertions for drafts, focus, exact
quantities, retry identity and capability boundaries remain in place. Release
identity and required GitHub results are recorded with the pull request.
The release process requires public-source checks, builds/typechecks, coverage,
all browser journeys, separate final-diff review and required GitHub checks.
Deployment uses the exact merged revision, a verified recoverable backup and
post-release checks for image identity, health, readiness, authenticated browser
routes, MCP rejection, database/artifact continuity and neighbouring services.

No domain rules, API schema, database migration, purchasing or physical-machine
capability changes. Draft recovery is in-memory in the current browser session;
it is not durable draft storage across a reload or browser restart. No real
stock was changed during the UI checks and no physical build was validated.

The next research step is to observe representative makers completing a first
project, capturing uncertain workshop stock and recovering from a failed save.
Measure unaided completion, wrong turns, time spent re-entering information and
whether they can explain the difference between owned, available and suitable.
