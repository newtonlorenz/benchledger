# Product

## Register

product

## Platform

web

## Users

People building 3D-printing, CAD, electronics, and mixed maker projects. The
audience spans a beginner planning a first build to an expert managing exact
equipment configurations, material lots, component variants, revisioned files,
and validation evidence. Compatible AI agents are first-class users through MCP.

## Product Purpose

Help a person or agent move from an idea to an evidence-backed build plan. The
product makes available equipment, tools, accessories, consumables, electronic
parts, and project files understandable; identifies what can be reused or needs
physical inspection; and prepares a sourced, priced shopping list for what is
missing without purchasing anything. Success means the first screen quickly
answers what is available, what a project needs, and the next useful action while
expert detail remains immediately accessible.

## Brand Personality

Calm, precise, ingenious. It should feel trustworthy enough for engineering work,
welcoming enough for a first project, and quietly satisfying during repeated use.

## Anti-references

Not a generic AI dashboard, crypto terminal, enterprise warehouse system, or
marketing landing page disguised as a tool. Avoid purple gradients, glassmorphism,
decorative blobs, warm-cream SaaS styling, nested rounded cards, fake headline
metrics, ornamental blueprints, jargon-first labels, and motion without state.

## Design Principles

1. Begin with the build decision, not the database structure.
2. Reveal expert evidence progressively without creating a separate expert app.
3. Explain every reuse, inspection, compatibility, and purchasing recommendation.
4. Make uncertainty visible and actionable rather than smoothing it away.
5. Give people and agents equivalent access to the same current project truth.

## Accessibility & Inclusion

Meet WCAG 2.2 AA. All core flows work by keyboard and with assistive technology.
Never rely on color alone for inventory or risk state. Respect reduced motion,
support 200% zoom and narrow mobile layouts, maintain readable contrast, provide
plain-language labels by default, and keep dense expert views structurally clear.

## Inventory paging

The Inventory destination reads its own server-backed `/inventory` pages rather
than slicing the bounded workspace preview. Search and the Kind, exact Evidence,
and Availability filters are applied before the server orders and slices rows;
the default page size is 25 and continuation is exposed as **Load more**. A
page reports the loaded count against the server total and keeps loaded rows
visible if a continuation request fails. Filter changes and inventory mutations
restart at page one. Pagination is read-committed, so concurrent writes can
shift later pages; the current offset cursor is opaque and keyset snapshots are
deferred.

## Capture and reuse

A name is enough to start a project. Its first useful action is recording what it
needs; build method and equipment remain optional until they affect the plan.
Requirement creation and editing share explicit owned-item selection. Search
uses bounded server results across the inventory, preserves the selected item,
and never implies fit or changes units silently. Referenced stock details are
loaded for the active project so reloads do not turn known selections into
apparently missing stock.

Projects opens the image gallery, with a remembered List option. All projects
includes completed and archived builds; filters narrow the view. Start build
opens current print, PCB, component/firmware and instruction files, with direct
3MF downloads for a slicer. A selected project opens its Requirements, Files,
Shopping list and Build steps. A new workspace offers Start a project and
Add inventory, without empty search/filter controls. Archived-only workspaces,
failed reads and empty filtered results retain their own recovery actions.

Inventory capture records what is known, including storage location and optional
specifications. Catalogue identity can be completed later. A maker can explicitly
choose to review a physical count using the quantity entered during capture.
Creating the record and confirming that count remain separate writes and
decisions. A successful count ends with a receipt and a useful continuation.
Requirement entry can add an unlisted owned item without losing its draft;
selection still does not establish compatibility. Supporting manual-capture and
requirement drafts remain in memory across reconnection, not in browser storage.
