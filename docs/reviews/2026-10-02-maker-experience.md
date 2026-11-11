# Maker experience review and implementation plan

## Purpose and evidence

Help an individual maker move from an idea to a useful build plan, find owned
stock, resolve uncertainty and return to work without relearning the interface.
The web workspace is the release target, including phone browsers. Native mobile
source in another checkout is outside this release.

The review combined two independent assessments: a design review of hierarchy,
language and task flows, and a detector/browser assessment. Both used synthetic
data. The initial main-branch review was repeated against the deployed shadcn
foundation after discovering that its existing commit had not reached main.
This release includes that foundation to avoid reverting the running interface.

Eight baseline browser checks covered Workbench and Inventory at desktop and
phone widths in light and dark themes. No page overflow, runtime errors or
automated WCAG A/AA violations were observed in those checks. Project screens
were also visually inspected. This is an expert review, not a claim of user
research or complete accessibility conformance.

The detector reported 103 signals, including fixture colours, token fallbacks,
legacy CSS and intentional selection cues. These were manually classified;
they are not 103 confirmed user-facing defects.

## Main finding

The component foundation is consistent. The difficulty is deciding where to go
and which action matters. More styling alone will not solve it. The design must
reduce simultaneous decisions and make progress visible without turning stock
evidence into a claim that a design is safe or physically validated.

## Findings and release plan

| Priority | Surface and problem | Change | Acceptance |
| --- | --- | --- | --- |
| High | Project next action lives in an optional inspector and falls below the work on phones; New revision is the prominent action | Put the next project action in the main reading flow; make revision creation secondary | A maker can choose a build approach, add requirements, inspect stock and reach sourcing from the guidance without opening the inspector |
| High | Inventory has five control bands before its records; first phone row was around 643 px down | Keep search and stock views visible; disclose filters and view configuration; keep applied filters apparent | First records appear sooner; collapsed filters remain discoverable and clearable; search, paging, sorting and saved views keep their semantics |
| High | Inventory phone table separates item identity from available stock and status | Reflow core row information at narrow widths | Name, recorded quantity, available quantity and stock status can be read together without page overflow |
| Medium | Workbench repeats counts, filters and project choices; phone actions are pushed down | Remove duplicate summary strip, strengthen return-to-work, simplify empty onboarding and subordinate equipment | New makers can start from either a project or inventory; returning makers can find, pin and resume projects |
| Medium | Every project feature has equal navigation weight | Keep everyday planning tabs visible and disclose Assembly/PCB under Design tools | Both viewers remain reachable, keyboard usable and directly linkable; an existing viewer URL reveals its active tab |
| Medium | Inspector presents IDs, versions, sources and AI transfer alongside everyday stock details | Disclose supporting evidence and AI handoff | Quantity, uncertainty, location and edit action remain visible; evidence and copy fallback remain accessible |
| Medium | BOM, Source, Decide and Ready require interpretation; final guidance overstates optional-part coverage | Use action-based shortcut labels, consistent requirement import wording and stock-scoped completion language | Required and optional parts remain distinct; stock-ready never means build-validated |
| Medium | Stock-count controls follow images, identity and destructive actions | Put physical count before supporting details and maintenance | Makers reach the count field immediately; review and confirmation remain required |
| Medium | Empty build plan exposes a raw schema validation message | Explain the missing part and focus Add build part | Invalid plans cannot be reviewed or saved; adding a valid part clears the message and allows review |
| Medium | Empty inventory assumes a failed filter search | Distinguish empty workshop from no matching results | Empty workshop offers Add first item; filtered empty results offer recovery through clearing filters |

## Intended task flows

1. **Start a project:** Workbench → New project → describe the goal → choose or
   defer the build approach → add requirements or import a parts list → inspect
   the resulting stock gaps. A printer is optional for non-printing work.
2. **Return to a build:** Workbench → resume or find project → read the next
   action → resolve the relevant missing detail, stock check or source gap.
3. **Record owned stock:** Inventory → search first → Add item when necessary →
   record identity and quantity → confirm evidence only from a real observation.
4. **Find and reuse:** Inventory → search/stock view → read available versus
   recorded quantities → inspect identity and evidence → assess compatibility
   against the project. Selecting an item does not prove compatibility.
5. **Source gaps:** Project → Shopping list → review missing requirements and
   dated offers. Retain quantities, packages, currency and provenance. This is
   preparation, never purchase authority.
6. **Inspect and finish:** Design tools expose visual inspection when needed;
   build planning and used-stock review remain separate from physical machine
   operation and human validation. Preview stock changes before committing them.

## Interaction and visual rules

Keep the existing shadcn controls, IBM Plex typography and light/dark themes.
Use alignment and spacing for hierarchy, one clear action per decision point,
and ordinary language. Enjoyment should come from visible progress, useful
empty states, quick navigation and reliable feedback. Avoid decorative rewards,
fake progress percentages or a forced onboarding tour.

Preserve command navigation, pins, recent projects, keyboard selection, direct
URLs, browser back/forward, focus restoration, unsaved-work protection and
layout preferences. Disclosure must expose its expanded state and work by
keyboard. Narrow layouts must preserve decision-relevant information.

## Verification and release gates

- Add focused regressions for disclosure, empty/filter recovery, visible next
  action, required-versus-optional claims and viewer deep links.
- Exercise create → approach → requirements → shopping at desktop and phone
  widths; verify inventory search, paging, selection, stock checks and copying.
- Run public-source checks, full build/typecheck/unit coverage and browser suite.
- Review the final diff independently for correctness and public-source privacy.
- Publish a PR, wait for required checks, merge and build the exact merged
  revision. Back up private runtime data/configuration, retain the previous image,
  update only BenchLedger and verify data/artifact continuity and authentication.
- Verify the deployed revision, readiness, live browser layouts and neighbouring
  services. Record actual results separately from planned checks.

## Follow-up evaluation

After release, observe real makers completing the six tasks above. Record task
completion, wrong turns, requests for help and time to first useful action.
Use that evidence before adding a wizard, more automation or another visual
redesign. Broad terminology changes and new workflows should follow observed
problems, not be inferred from a detector score.

## Measured local improvement

At 390 × 844, the first inventory row moved from approximately 643 px to 493 px
from the top. Each row now displays its recorded and available balances and stock
status together. The next project action appears within the first 400 px at both
desktop and phone widths, including when the project inspector is closed.
