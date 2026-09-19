# Desktop workspace surface

Mode: Operate
Status: implemented locally; deployment is a separate action.

The maker needs to move equally easily between project work and inventory.
The previous screens repeated navigation, document actions and summaries above
the records. The replacement uses a contextual sidebar navigator, compact
workspace toolbar, independent document scrolling and a collapsible inspector.

The first viewport should answer: where am I, what am I working on, what needs
attention and what can I do next? Use the durable rules in [DESIGN.md](DESIGN.md).

## Acceptance

- Projects and inventory are direct peer destinations.
- Project selection and active/archive browsing live in the navigation sidebar.
- The project inspector can release its width to requirements and files; viewers use the full width.
- Project readiness retains Ready, Decide, Check and Source meanings. Inventory
  distinguishes Available, Needs checking, Reserved and Out of stock; none proves
  project compatibility.
- Dark mode, compact density, narrow screens and keyboard navigation remain usable.
- Draft protection, deletion confirmation, direct links and history still work.
- Verification uses synthetic local fixtures; live records are not modified.

## Inventory workstation

The inventory register should support both human stock management and AI-assisted
project planning. Make recorded, available and reserved balances distinguishable
without opening an editor. Keep item identity, location, condition and evidence
in a persistent inspector; do not turn missing information into confidence.

- Shared queues cover available stock, checks, reservations and confirmed empty
  stock. Partial reservations may appear in both available and reserved views.
- Sorting and exact-location filters apply to all matching records before paging.
- Saved views retain bounded filters locally, with explicit scope and reset actions.
- Inventory has a searchable category navigator with separate subcategory entries.
- Single-click selects; double-click, Enter, F2 and explicit Open actions open the
  record. Arrow keys move the selection; checkboxes remain bulk-action targets.
- Columns, inspector visibility and resizable width persist independently of
  saved filters. A layout reset restores the defaults. Core stock evidence stays
  visible, and selecting a row does not reopen a deliberately hidden inspector.
- The AI brief contains only explicitly selected records and explains its limits.
- Keyboard navigation, clipboard denial, light/dark contrast and narrow screens
  are checked with synthetic fixtures. No live inventory changes are required.
