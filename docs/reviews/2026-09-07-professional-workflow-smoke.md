# Professional workflow smoke review

Date: 7 September 2026. Baseline: `f8c2815` (PR #43).
Scope: human working views and the equivalent authorised agent contracts.
No real inventory, physical observations or equipment operations form part of
the synthetic test cases.

## Findings and implemented corrections

| Finding | Correction |
| --- | --- |
| Supplier search excluded requirements beyond the loaded page | Apply normalised query and decision filters before pagination in the shared application service; expose identical HTTP/MCP contracts |
| Empty quote cards repeated long instructions and consumed screen space | Use compact requirement rows, explicit quote counts and inline detail only where needed |
| An unavailable project link silently opened another project | Preserve the requested identity and show a bounded unavailable state with retry and register actions |
| Inline drafts and staged files could disappear on navigation | Register dirty state without storing content; require Keep editing or explicit Discard, and protect unresolved saves |
| Browser Back and refresh could lose the working context | Guard in-app history changes and before-unload; retain same-scope confirmed reads while refreshing |
| Failed reads could look like empty plans or failed saves | Keep loading, error, last-confirmed and committed states separate; test lost acknowledgements and read failures |
| A newly created workstream was absent from the file-scope selector | Refresh shared project context after the committed creation |
| Setup panels preceded the working area on phones | Put tabs and working content first in source and mobile visual order; retain compact, actionable review counts |
| Check/Decide next actions gave instructions without controls | Add direct requirement-review actions using the existing filtered plan |
| Recorded but unverified printers disappeared from home | Show recorded equipment with an explicit stock/product setup check state |
| Token-only contrast checks missed rendered label failures | Correct affected labels and add rendered axe checks across page, dialog and colour states |
| A bound file not present in the loaded picker appeared unselected | Preserve its explicit selection and label it as not loaded; exclude superseded files from new choices |

All identified corrections in this bounded review were implemented before the
release gate. This is not a claim of complete production-team, accessibility or
physical engineering certification. Functional parity means shared semantics
and permissions, not that agents receive broader authority than humans.

## Verification result

The final clean-install release gate passed 951 unit/integration tests and
108 browser flows. Builds, typechecks, existing 80% coverage thresholds and
privacy/public-source checks passed. The production dependency audit reported
no known vulnerabilities. The sourcing regression was observed failing before
its correction; the shared behaviour is now tested against SQLite and memory,
including scoped MCP and HTTP reads.

A separate rendered review exercised 24 states in Chromium and the same 24 in
WebKit, including desktop, phone, light and dark views, editors and dialogs.
The final scans reported no selected WCAG-rule violations, horizontal page
overflow or uncaught browser errors in those states. The initial scan found
contrast failures that the earlier token-only checks had missed.

New functional cases cover unavailable links, browser Back, dirty navigation,
file-scope changes, complete-revision sourcing, workstream/file-scope refresh,
failed reads and ambiguous save acknowledgements. An unconfirmed save is tested
with a committed server write followed by a lost response, then an unchanged
idempotent retry. No duplicate record or silent discard is accepted.

A deployment still requires passing GitHub checks, exact merged-image acceptance,
a verified data/configuration backup, preserved credentials and a live close-out.
Execution of that release is recorded on the pull request, not inferred here.

Repository review identified two additional regressions before merge. Guarded
Back/Forward now restores the original indexed history position instead of
replacing its destination. Repeated cancellation and multi-entry traversal have
explicit browser tests. A quote observation-date-only edit is now registered as
an unsaved provenance change against the form's initial date.

The WebKit functional run also passed all 15 new smoke flows, including repeated
Back/Forward, multi-entry traversal and lost-save recovery. Type-only changes in
a new workstream are protected like date-only quote changes.
