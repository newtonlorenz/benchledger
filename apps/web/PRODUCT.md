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

## Stock receiving setting

Settings asks one question: **When does stock count as in stock?** — when
it's bought, when it's delivered, or when I've received and checked it (the
default). Saving first shows the impact on current inventory (“12 items will
now count as in stock”), and refuses a change that would strand project
reservations. Stock that counts only because of this setting stays labelled
with its real evidence (“In stock · delivered, not counted”) in the inventory
list, item drawer and BOM rows, and the item drawer keeps **Receive and
count** available. Only a workspace administrator can change it; everyone else
sees it read-only. After a change the workspace, inventory pages and project
readiness are refetched.

## Item labels

The item drawer offers **Print label**: a preview of a QR code encoding
`benchledger://item/<id>` (the mobile app's scan format) with the item name,
variant and location, then the browser print dialog. The label holds no server
address or credential.
