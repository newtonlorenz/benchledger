# Maker flow review and refinement plan

This pass evaluates the released maker journey with fresh independent design and
browser assessments, followed by implementation and a separate correctness review.
It uses synthetic desktop and phone tasks. It is an expert evaluation, not a
usability study with representative makers.

## Assessment

The independent design assessment scored the starting experience 28/40: clear
status, maker terminology, user control and consistency each 3/4; error prevention
4/4; recognition 3/4; efficiency and minimalism each 2/4; recovery 3/4; help 2/4.
The purpose-built distinction between owned, usable and missing stock is a
strength. The largest remaining costs are interrupted tasks and repeated controls.

A separate browser assessment covered Workbench, inventory, project and creation
at 390px dark and 1440px light. Eight settled views had no automated accessibility
violations; dialog keyboard containment and focus restoration passed. A bounded
source detector found no findings in ten inspected UI files. Those clean results
do not establish that task flows are easy: the design assessment still found
material continuity and hierarchy problems.

## Priorities, implementation and acceptance

| Priority | Finding | Refinement | Acceptance |
| --- | --- | --- | --- |
| P1 | Shopping cannot copy the canonical selected requirement quotes; the older copy action uses inventory-linked offers. | Copy/download a dated full-revision proposal with separate readiness context, required sourcing estimates, selected quote evidence and currency totals. | Ignore visible search/filter, read all pages, reject incomplete/changing data, retain package/source/date/tax/shipping uncertainty, provide clipboard fallback. |
| P2 | Returning from Files resets Plan query/filter. Returning to Files resets its scope/search. | Retain view choices by project and revision. Apply explicit task shortcuts once per request. | A tab detour preserves the chosen view; a new revision resets it; an unavailable upload scope clears staged files before falling back. |
| P2 | Repeated project guidance and stock checks push the requirements below the useful workspace. | Keep next-action guidance on Plan, retain task shortcuts elsewhere, put requirements before the physical-check queue. | Search and requirements appear earlier; physical checks remain fully visible and actionable below them. |
| P2 | Reuse is offered only after selecting a supplier quote. | Offer Match owned stock before choosing a quote. | No new supplier observation is needed to review workshop stock; readiness and fit rules stay authoritative. |
| P2 | Recording a receipt loses the originating requirement. | Carry requirement/project/unit context into capture, open the saved item for counting, then review its match against the original active revision. | Actual received quantity is entered explicitly, never inferred from pack size; creation/count/matching stay separate actions; stale revision context cannot save a match. |
| P1 | Count failures appear behind the active confirmation; unresolved retries and measured drafts are fragile. | Show errors inside the review, protect drafts and retain exact requests until acknowledged, including session renewal. Bound requests with a timeout. | Definitive rejection permits editing; ambiguity preserves payload/key/version through rejected retries; an uncertain save cannot be dismissed into a duplicate command. |
| P3 | The final Workbench filter needs horizontal scrolling on a phone. | Wrap the filters. | Every filter is directly visible and operable without page overflow. |

## Design decisions

The experience should reward progress with a clear saved outcome and a useful next
action. It does not need decorative gamification. Preserve the focused workshop
visual language, use a single primary task per area, and disclose supporting
identity/provenance only when useful. Secondary views should make room for their
actual work rather than repeat the same project guidance.

The shopping document is a proposal, never an order. It separates sourcing from
Ready, Check, Decide and optional context; only eligible required Source estimates
contribute to totals. Two complete reads detect changes while exporting, but do
not create an atomic server snapshot. Exports above 10,000 requirements fail with
an explanation rather than silently truncate. No API schema, database migration,
purchasing capability or machine control is introduced.

The receipt continuation is browser navigation context. It does not assert fit,
conversion, physical confirmation or consumption. After capture, stock evidence
still requires an explicit count; the requirement match is reviewed separately.
View retention lasts for the mounted workspace and is not durable preference
storage across browser restarts.

Session recovery keeps the complete reviewed stock observation in memory and
resumes it only after authentication, without automatic resubmission. The editor
reloads the exact item even when it falls outside the initial inventory page.
Lost acknowledgements keep the original payload, replay key and version; first
authentication rejections remain editable after a definitive conflict. An item
deleted after a definitive rejection offers explicit draft discard. No private
draft is persisted in browser storage or displayed while signed out.

## Verification and release plan

1. Run focused unit/component regressions for receipt context, exact quantity,
   matching, state retention, proposal completeness and save recovery.
2. Exercise receipt → count → match, Plan/Files return, export fallback/download,
   and uncertain count recovery in the browser at desktop and phone sizes.
3. Review the final diff independently for correctness and private data; address
   discovered session-renewal and timeout defects before release.
4. Run the full public-source/build/typecheck/coverage/browser gate, then required
   GitHub checks. Merge only the reviewed head.
5. Back up the integration runtime and deploy the exact merged image. Confirm
   image identity, health/readiness, browser routes, MCP authentication, database
   integrity and retained artifacts. Keep the preceding image for rollback.

Representative-maker task testing remains the next research step: observe a new
maker creating a project, reusing uncertain stock and recovering from a failed
save. Measure completion, wrong turns and ability to explain readiness. This
release does not claim that research has already happened.

## Results

The final `npm run check` passed public-source checks, all builds/typechecks,
1,216 tests across 147 files, and 162 browser tests. Coverage was 87.8%
statements/lines, 82.62% branches and 82.1% functions. Earlier full runs exposed two existing test races: popover focus restoration
before keyboard resizing, and responsive cell replacement during viewport
measurement. The tests now wait for the relevant focus and geometry conditions;
all assertions remain in place, and the complete gate passed again.

GitHub and independent reviews exposed additional session-recovery edge cases.
These were corrected and covered by component and real-browser regressions,
including exact post-login retries, version conflicts and deleted items. Final
source review found no remaining material issue in the changed flows. Six final desktop-light/phone-dark views had no axe violations or document
overflow; the wrapped filter rectangles and proposal controls were also checked.
All new browser journeys passed with synthetic data. Source/privacy review was
separate from the automated gate.

Integration preflight verified a fresh backup but found the shared Docker engine
unresponsive before any release change. Deployment and live post-release checks
remain outstanding pending runtime recovery. No engine restart or unrelated
service change was made as part of this review.
