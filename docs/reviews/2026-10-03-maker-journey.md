# Maker journey review and implementation plan

## Intended experience

A maker comes to BenchLedger with an idea, an untidy parts drawer, or a build
already underway. They need to capture what they know, find what they can reuse,
resolve uncertainty, and return to making. A project should become useful after
its name and first requirement. Exact equipment, evidence and file revisions
matter when a decision depends on them; they should not be entrance requirements.

This review uses the product brief, implementation, synthetic desktop and phone
journeys, and persistent-runtime fixtures. It is an expert evaluation, not a claim
that representative makers have been observed using the changes.

## Primary journey and acceptance criteria

| Journey | Observed friction | Intended refinement | Acceptance |
| --- | --- | --- | --- |
| Open the workspace and resume | Build-method setup outranks adding requirements, even after choosing Decide later. | Prioritise the next useful project task consistently on the Workbench and project. | Empty project leads to its first requirement; setup remains available. |
| Capture an idea | Name, goal, route and printer appear before there is a useful plan. | Name-first creation; optional planning details. | A name alone creates a project without invented equipment or specifications. |
| Start from a list or template | Separate setup loses blank-project details; import is hidden behind another disclosure; each row is a large form. | Retain shared details, open the requested import, compact rows and disclose specifications/workstreams. | Import is reviewed before creating records, rows remain editable, drafts survive accidental exit. |
| Add a requirement and reuse stock | Nine controls and duplicated searching; beginner statuses omit the reason for a stock gap. | Name-driven, explicit owned-item choices; essentials first; plain reasons and contextual actions. | No automatic compatibility assertion or unit conversion; uncertainty remains visible. |
| Capture and locate inventory | Location missing from generic capture, search below catalogue filters, unknown identity hard to record. | Search-first catalogue, progressive filters, manual uncertain identity, location and protected drafts. | An unknown part can be captured honestly and found by its location. |
| Confirm stock | Capture ends with a toast; mobile item taps change an inspector below the list. | Open the created item for an explicit count; open mobile details directly. | Creation never silently becomes physical confirmation; count review remains explicit. |
| Source a gap | Quote selection has no contextual route to stock received later. | Explain and connect receipt, count and requirement matching; preserve supplier package/source evidence. | Selecting a quote never purchases or confirms stock. |
| Plan the build | Important shortages/files/equipment warnings are collapsed with hashes; printer selection repeats. | Visible actionable planning checks; use recorded intended printer as the initial plate choice. | Warnings stay visible and overrides remain possible. |
| Attach a needed design | Visiting Files interrupts an unsaved build-part draft. | Upload from the part editor and retain the draft. | File scope and recorded binding are explicit; upload failure preserves work. |
| Set aside parts and finish | Browser has no reservation creation, but actual-use review depends on reservations. | Reviewed set-aside and release actions before actual-use review. | Canonical availability/evidence checks, unchanged retry, explicit closeout; no automatic stock consumption. |
| Return later and recover | Some imports lack draft guards; rejected retry can forget an earlier ambiguous save. | Consistent draft protection and retain unchanged commands until acknowledged. | No silent discard or duplicate write after an uncertain response. |
| Use a phone, keyboard or settings | Some actions have offscreen consequences and account controls are buried. | Immediate contextual details, logical focus and directly discoverable account actions. | No horizontal overflow; useful labels, focus recovery and theme consistency. |

## Delivery sequence

1. Simplify capture and reuse as one sequence, retaining canonical evidence.
2. Connect inventory creation to location and physical-count review.
3. Connect planning, file upload, set-aside stock and actual-use review.
4. Revisit sourcing and the return journey, then review the complete primary
   sequence again on desktop and phone.
5. Run focused regressions, the public-source gate, full build/typecheck,
   coverage and browser checks. Independently review the final diff and address
   required CI/review findings before merging.
6. Release the exact merged revision with a backup and rollback image. Verify
   health, deployed identity, authenticated read-only routes and data continuity.

## Review boundaries

Ownership, confirmed usable stock, project requirements and sourcing remain
separate facts. A planning snapshot is not a validated design or permission to
operate a machine. No purchase or physical activity is introduced by this work.
Production smoke checks must not manufacture business records or stock evidence.

Implementation and verification results are recorded below as they complete.

## Iteration findings

The second pass found additional integration problems after the first simplified
screens worked: editing still used the old stock picker, changing build approach
could remount an active plan, file-upload retries differed between demo and
persistent storage, and owned-item search covered only the workspace preview.
These were treated as primary workflow problems and corrected before release.

Recovery now preserves exact commands through rejected retries. Upload recovery
reads durable progress, resumes only the missing suffix with an atomic offset
precondition, and finalises with the original identity. An expired, unfinalised
session is restarted only after the server establishes that state. Existing
append behaviour remains available to other transports.

Phone review also removed duplicate disclosure indicators that changed accessible
button names, retained the expanded planning context after adding a printer,
and corrected copy that conflated physical-count evidence with exact product
identification.


The final integration pass checked references outside the initial inventory page,
including requirement editing and the return journey. Search is bounded and
cancelled when its context changes; a project loads only its referenced missing
items. A failed lookup preserves the recorded choice and offers retry. Printer
and filament choices use the same full-inventory lookup while preserving their
existing eligibility rules.

Project metadata, revision and build-approach dialogs now protect their own
drafts. Closing a clean child does not ask to discard the underlying build plan.
Late inventory hydration cannot silently clear a saved printer, and uncertain
writes retain their original payload and idempotency identity through retries.

The persistent build journey exposed clipped content inside a phone-sized build
section even though the page itself did not overflow. The grid now contains its
children and wraps stock actions. Reviewed reservations and releases left stock
on hand unchanged; recording actual use changed the balance only at closeout.


Dark-mode visual review caught low contrast on the selected owned-item card.
The selection now uses the shared neutral accent surface and matching foreground.
Quantity and unit remain side by side on phones, and the unit control has an
explicit accessible name.


## Final review

The rebuilt desktop light and phone dark journeys passed name-only creation,
explicit stock reuse, requirement editing, Workbench resume and reload with the
saved stock choice retained. The final source review found no remaining material
correctness issue in the changed primary flows. Inventory capture/count/reopen
and persistent build/file/reservation/closeout journeys were also exercised.
These are synthetic expert checks; validation with representative makers remains
a useful separate product activity.


Final local release gate: `npm run check` passed the public-source checks, all
package/application builds and typechecks, 1,167 tests across 142 files, and 150
browser tests. Coverage was 87.52% statements/lines, 82.60% branches and 81.88%
functions, above the enforced thresholds. The final diff was separately checked
for private data, unrelated files and broken references.
