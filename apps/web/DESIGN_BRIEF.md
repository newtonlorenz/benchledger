# BenchLedger product UI design brief

Status: selected direction awaiting final Impeccable confirmation
Direction: Project Dossier with Instrument Bench navigation

## Feature summary

Build a production-quality responsive workspace where beginners and expert makers
manage both inventory and complete 3D-printing/electronics projects. The interface
must answer what is available, what a project needs, what can be reused or needs
inspection, what must be bought, and which files/evidence belong to each revision.

## Primary user action

Open or create a project and confidently move it one step forward using current
inventory evidence: reuse confirmed stock, inspect uncertain stock, or prepare a
sourced shopping list for genuine gaps.

## Design direction

- Restrained product color strategy.
- Physical scene: a maker reviews a build at a well-lit workbench during focused
  daytime work, moving between a laptop, printer, components, and measuring tools.
- Bright pure-white/cool-neutral surface, graphite ink, moss-green primary,
  mineral slate-teal secondary, and safety amber/red reserved for meaningful state.
- Linear-like hierarchy and restraint, the project context of Bambu Studio, and
  the exact scannability of a strong engineering parts catalog—without imitating
  any product's branding or component system.
- Temporary text wordmark only. Naming and logo remain a later identity slice.

## Scope

Production-ready responsive web product covering the app shell, inventory,
projects, BOM/gaps/shopping list, revisioned files, supplier offers, capabilities,
loading/empty/error states, and beginner/expert disclosure. It is interactive,
keyboard accessible, and ready for API integration rather than a static mock.

## Layout strategy

- Compact persistent desktop navigation makes Inventory and Projects equal
  first-class destinations; it collapses cleanly on narrow screens.
- A project page uses a concise dossier column for purpose, current revision,
  next action, and owner/context beside the main evidence workspace.
- A six-stage build rail anchors the end-to-end flow: Idea, Setup, BOM,
  Reuse/inspect/buy, Files, Validate.
- BOM and inventory use structured rows/tables, not repeated cards. Ready,
  inspect-first, partial, and missing sections explain status using icon, text,
  quantity, and evidence.
- Shopping costs and artifact revisions stay visible as supporting sections but
  never displace the next project action.
- Beginner defaults use plain language and a single next action. An Expert detail
  control reveals exact variants, dimensions, lots, compatibility reasons,
  provenance, hashes, and audit history in place.

## Key states

- First run teaches users to add equipment, consumables, and one project.
- Empty inventory explains the minimum useful setup without implying purchases.
- Loading uses structural skeletons; errors preserve entered work and give a
  specific retry path.
- Uncertain stock is visually distinct from available stock and explains the
  physical check required.
- A complete BOM clearly separates reusable, inspect-first, missing, optional,
  and substituted lines.
- File upload shows progress, hashing, revision creation, safe failure, and a
  verified completion state.
- Offline/server-unavailable state is explicit; stale data is never presented as
  freshly verified.

## Interaction model

- Select a project or inventory item without losing the current workflow context.
- Expand expert evidence inline or in a stable detail pane; avoid modal-first UX.
- Filters and search update predictably, remain keyboard accessible, and survive
  navigation where useful.
- Stock mutations, reservations, and artifact revisions require a clear review
  step and return auditable confirmation.
- External supplier links are visibly external. Shopping lists can be exported or
  copied, but the application never purchases.
- Motion lasts 150–250 ms, explains state, and respects reduced-motion settings.

## Content requirements

Use plain labels such as “Ready to use”, “Check quantity”, “Partly covered”, and
“Need to buy”. Every recommendation states the match, compatibility evidence,
quantity, uncertainty, offer observation date, and next action. Internal status
codes and database language never appear in default UI copy.

## Impeccable implementation references

- `product.md` for trusted product conventions
- `layout.md` for dossier/table hierarchy
- `onboard.md` for beginner activation and empty states
- `harden.md` for realistic errors and edge cases
- `adapt.md` for mobile/desktop behavior
- `typeset.md` and `colorize.md` for hierarchy and restrained palette
- `audit.md`, `critique.md`, and `polish.md` before acceptance

## Anti-goals

No generic AI dashboard, marketing hero, fake metrics, glassmorphism, gradients,
decorative grid/blueprint background, nested card grid, excessive rounding,
terminal aesthetic, ornamental motion, or separate simplified/expert applications.
