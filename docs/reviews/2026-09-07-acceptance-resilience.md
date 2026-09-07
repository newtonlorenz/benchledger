# Maker acceptance and interruption review

Date: 7 September 2026. Baseline: `e807f6d` (PR #44).
Scope: human and agent handoffs, inspection, stock close-out, interrupted writes,
access changes, navigation and the corresponding rendered states.

## Review method

The standard demo server does not advertise durable stock reconciliation. A
page-level smoke check can therefore exercise a fallback rather than the actual
close-out journey. New browser tests create and close their own temporary SQLite
workspace for each scenario. Stock evidence and physical outcomes in these tests
are explicitly synthetic and never enter the live workspace.

This review exercises the complete sequence: input, server preview, explicit
approval, saved record and recovery from lost responses. It checks the exact
request identity and final stock quantity, not merely the presence of a success
notification. The official MCP client runs the matching preview/commit/replay
path against an isolated durable instance.

## Implemented findings

| Finding | Correction |
| --- | --- |
| Entered stock outcomes could be lost on navigation | Register dirty outcomes with the existing navigation and unload guard |
| A pending review could replace newer edits | Freeze the request model and disable editing until the result is known |
| A lost commit response did not protect the reviewed input | Keep the same approval payload and request identity; permit only unchanged recovery |
| Custom stock and inspection dialogs did not share a focus boundary | Isolate their siblings, choose a safe initial control, trap keyboard focus and restore focus on close |
| Saved outcomes still looked editable | Render immutable result receipts, remove obsolete mutation controls and focus the saved acknowledgement |
| Inspection confirmation regenerated observation time | Submit the exact observation captured for the reviewed preview |
| Quote filters could unmount an unresolved selection | Lock filtering, paging, refresh and competing selection actions until recovery completes |
| Workstream paging could discard assignment edits | Apply the same navigation guard to continuation controls |
| Denied workflow reads retained previously visible records | Clear the local workflow result on 401/403; preserve same-scope records only for transient read failures |
| Agent edits required leaving the project to refresh | Add a guarded project refresh, with honest failure feedback and explicit discard semantics |
| Embedded close-out repeated a top-level project heading | Use a compact task heading, consistent surfaces and readable narrow-screen summaries |
| A suggested count resembled a prefilled observation | Use an explicit count-entry placeholder, not the expected quantity |

## Release review and fresh verification

The release review corrected an unfinished saved-result label: the receipt now
uses the reservation view model's existing `itemLabel` field. No new transport
field or assertion cast was introduced.

A clean Node.js 24 / npm 11 lockfile installation and `npm run check` passed:
957 unit/integration tests across 105 files, 122 Chromium browser flows, builds,
workspace typechecks, all existing 80% coverage thresholds and public-source
privacy checks. A separate WebKit run passed all 14 new durable acceptance flows.
The production dependency audit reported zero known vulnerabilities.

The approval scenarios use per-test temporary SQLite workspaces. They verify
final stock quantities, unchanged replay keys, immutable saved receipts and
explicit approval, rather than changing live physical evidence. Narrow-screen
review and confirmation states pass the selected accessibility checks in both
themes. These results are not a full accessibility or physical-build certification.

No database migration, credential change or permission widening is required.
Deployment must use the exact merged image, with a verified backup and the
previous image retained. Live browser/MCP acceptance must remain read-only.

The final rendered receipt review also removed residual pending-action wording:
committed receipts show changes recorded and saved stock movements, rather than
changes to apply. The browser regression explicitly checks this distinction.
