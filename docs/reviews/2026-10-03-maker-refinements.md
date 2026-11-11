# Maker workflow review: second refinement round

This review follows the first maker-experience release. It examines the work
behind the simplified navigation: project setup, requirements, stock editing,
supplier quotes and build planning. Findings come from source review and
synthetic browser flows; they are not observations of real makers.

## Findings and implementation

| Friction observed | Refinement | Acceptance evidence |
| --- | --- | --- |
| The workbench could show no remaining checks for a printed project whose printer was missing or unusable, while the project still asked for setup. | Use the same printer eligibility rules in home tasks and the project. Link the task directly to build approach. | Missing, unconfirmed and usable printer cases; navigation regression. |
| Escape discarded new project and requirement drafts without warning. | Register changed forms and pending saves with the existing unsaved-work guard. | Keep editing retains inputs; explicit discard closes; clean forms close normally. |
| Changing project details after an unconfirmed create could start a different request while the first remained unresolved. | Retain the submitted payload, disable changes and offer an unchanged retry until confirmation. | Identical payload across ambiguous and failed retries; existing idempotency-key browser regression. |
| Editing item details left physical counting, commissioning and image controls competing with the active form. | Focus the drawer on identification and storage while editing. Keep other sections mounted but hidden so their drafts survive. Protect unsaved metadata. | Edit/cancel/save recovery, stock and image draft retention, mobile layout. |
| A selected quote could say “Selected for estimate” when the canonical estimate rejected it as stale or incompatible. | Show whether the selection actually contributes to the estimate; explain review and fresh-quote recovery. | Valid, stale, changed-requirement and mismatched-unit cases. |
| Quote entry appeared after the quote history without moving keyboard focus. | Put the form beside its requirement, focus Supplier and restore focus to Record quote after cancellation or saving, or to the sourcing region if refresh fails or the trigger is unavailable. | Focus transfer, draft retention and refresh recovery. |
| Inventory-linked offer totals implied an order estimate although they summed one package per row. Copied drafts dropped package and source evidence. | Label recorded offer prices, disclose partial price coverage and retain supplier, package, currency, date and source in the copied draft. | Mixed priced/unpriced rows and copied evidence tests. |
| A blank build-part name produced a raw schema path and left focus on Review. | Explain which part needs a name and focus that input. | Invalid draft cannot advance; correction can advance without a write. |

## Design decisions

Keep the first release's navigation and visual system. This round improves
consistency, task focus and recovery, rather than adding a new navigation layer.
Use the existing shadcn controls and guard mechanisms. Stock confirmation,
quote fit checks and optimistic versions keep their existing meaning.

Project quotes remain the primary shopping workflow. Inventory-linked supplier
records are separate historical observations. Their package-price sum must not
be confused with the canonical quantity-adjusted project estimate.

## Verification plan

Run focused regressions for each finding, then the public-source gate, complete
build/typecheck, coverage suite and browser suite. Independently review the final
diff. Check phone and desktop layouts, keyboard focus and both themes. Follow
the existing release gates, preserve a rollback image and backup, and verify
deployed identity, readiness and data continuity before reporting deployment.

## Remaining evaluation

Observe makers completing a project and inventory task before introducing more
navigation or onboarding. The primary project-quote workflow still has no copied
shopping proposal; adding one should use the complete canonical quote selection
and pagination, not the historical inventory-linked export. Validation beyond
the common empty part-name case still includes technical server/schema messages.
These are follow-up opportunities, not claimed as completed in this round.

## Measured editing improvement

The item Name field moved from about 389 px to 234 px from the top at desktop
width, and from 523 px to 258 px at 390 px phone width. It receives focus when
editing begins. Phone and desktop checks found no page overflow and verified
that Keep editing retains the changed value and explicit discard closes it.
