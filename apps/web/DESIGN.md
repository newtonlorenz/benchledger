---
name: BenchLedger workspace
description: A shadcn-based workspace for inventory evidence and maker project planning.
colors:
  primary: "#21634e"
  primary-dark: "#9dd5b8"
  background: "#fafafa"
  background-dark: "#18181b"
  card: "#ffffff"
  card-dark: "#202024"
  foreground: "#18181b"
  foreground-dark: "#f4f4f5"
  muted-foreground: "#64646d"
  border: "#e1e1e6"
typography:
  heading:
    fontFamily: "IBM Plex Sans Variable, system-ui, sans-serif"
    fontSize: "1.625rem"
    fontWeight: 600
    letterSpacing: "-0.03em"
  body:
    fontFamily: "IBM Plex Sans Variable, system-ui, sans-serif"
    fontSize: "0.875rem"
    lineHeight: 1.5
  control:
    fontSize: "0.8125rem"
  supporting:
    fontSize: "0.75rem"
  metadata:
    fontSize: "0.6875rem"
  section:
    fontSize: "1rem"
  wordmark:
    fontSize: "1.0625rem"
  dialog:
    fontSize: "1.125rem"
  mobile-heading:
    fontSize: "1.5rem"
rounded:
  badge-small: "4px"
  badge: "5px"
  tab: "6px"
  base: "10px"
  dialog: "14px"
  control: "8px"
  panel: "12px"
spacing:
  control: "8px"
  group: "16px"
  section: "24px"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.card}"
    rounded: "{rounded.control}"
    padding: "8px 12px"
---

# BenchLedger workspace design

The web client is a desktop-style maker workspace. Projects and inventory are
peer destinations. Its job is to make records and the next useful action easy
to find, while keeping the meaning of stock evidence intact.

## Structure

- A persistent neutral sidebar holds primary navigation and a contextual
  navigator: loaded projects on project screens, managed categories in inventory.
  Active and archived projects are separate views. Category selection matches
  that exact category; subcategories have their own entries.
- A compact toolbar identifies the open document and revision, with inventory
  search, commands and appearance controls. Settings is available from the sidebar and toolbar.
- On desktop, the working area scrolls independently of navigation and toolbar.
  Page navigation resets its scroll and transfers focus to main content.
- A project has one title, revision actions, contextual stock shortcuts and
  document tabs. Notes are disclosed on demand. The optional right inspector
  holds build context and project settings; hide it for more working space.
  Assembly and PCB viewers use the full working width automatically.
- The workbench uses a project register with named columns and a subordinate
  attention queue. Summary counts are small shortcuts rather than headline cards.
- Inventory is a register with separate recorded and available balances, stock
  queues, stable server-side sorting, saved views and a persistent item inspector.
  On desktop the register and inspector scroll independently. A single click
  selects a row; double-click, Enter, F2 or the explicit Open action opens editing.
  Arrow keys move between rows. Checkboxes select explicit records for bulk
  operations. Selecting a row keeps a hidden inspector hidden.
- Inventory layout preferences remember inspector visibility, width and optional
  columns in this browser, separately for sample and private workspaces. Recorded
  stock, available stock and status stay visible. The divider supports dragging,
  arrow keys, Home/End and double-click reset; Columns offers a full layout reset.
  Item and Location headers expose the existing server-side sort options.
- Inventory filters and sort are in the URL. Up to 12 named views are stored in
  this browser, separately for sample and private workspaces. Detailed filters and view configuration are
  disclosed on demand at every width. Phone rows reflow to keep identity, recorded
  and available quantities, and stock status together.
- Copy for AI produces an explicit selected-record snapshot with identity, units,
  quantities, evidence, version and planning limits. It sends nothing to a service
  and provides selectable text when clipboard access is unavailable.
- On phones, navigation becomes a focus-contained drawer; the inspector follows
  the working area. Controls retain touch-sized targets and tables adapt.

## Visual language

The shared controls use locally owned shadcn/ui components, with Tailwind 4
utilities and Radix primitives. Neutral zinc surfaces separate navigation,
documents and supporting panels. Green identifies the primary action; selection
uses a neutral fill. Retain domain colours and text for stock evidence.

Use bundled IBM Plex Sans for interface text and IBM Plex Mono for identifiers,
revisions and measurements. Page headings are 26px on desktop and 24px on phones.
Controls use an 8px radius; register panels use 12px. Prefer alignment and ruled
rows over nested cards. Desktop actions are at least 36px; phone actions are at
least 44px. Both themes use the same semantic tokens and information hierarchy.

`src/components/ui` is the foundation for actions, form fields, native selects,
checkboxes, radio groups, switches, sliders, tables, tabs, cards, alerts,
disclosures, dialogs, confirmation dialogs, sheets, sidebar navigation, menus,
popovers, tooltips, command/search pickers, progress, skeletons, resizable panels
and notifications. Compose these primitives; do not introduce parallel native
controls or hand-written focus traps. The source audit enforces this boundary.
NativeSelect intentionally keeps browser select behaviour. File inputs use Input.

`components.json` configures the shadcn registry; run the CLI from `apps/web`.
`shadcn.css` is the sole source of semantic light/dark tokens, domain aliases and
Tailwind theme/utilities. `workspace-layout.css` contains domain composition and
responsive geometry. The former independent visual layers have been consolidated.
The dark selector is `data-theme="dark"`. Appearance preferences remain browser-local.

`WorkspaceModal` composes Dialog, AlertDialog and Sheet. Keep underlying editors
mounted while a confirmation is open so file selections and unsaved drafts survive.
Domain callbacks decide whether dismissal is allowed. Radix owns focus trapping
and background isolation; a shared adapter restores focus for conditional dialogs.
Use Command for search selection, Tabs for document panels and Resizable for the
inventory split view. Persist only committed layout changes.

Specialised canvas/WebGL/SVG viewers and evidence diagrams retain their domain
rendering. They use shared controls around that content. AI Elements is not added:
the current product has no AI conversation surface requiring that library.

Change theme colours together without interpolation; animate only focus shadows
on shared controls. This prevents unreadable intermediate foreground/background
pairs during theme changes.

Avoid decorative metrics, marketing copy and decorative motion. Respect reduced
motion and the existing density and collapsed-navigation preferences. Keep
stock readiness separate from physical validation in every visual state.

## Behaviour and boundaries

Never infer stock, physical validation or manufacturing readiness from a visual
state. All document navigation uses the existing unsaved-work guard. Deletion
still requires its confirmation. Authentication, concurrency and append-only evidence remain unchanged. Shared
stock-view filters are additive to HTTP and MCP; available stock never establishes
project compatibility or exact product identity.

`workspace-layout.css` owns the shell, documents, register, category navigator,
item inspector, forms, previews and evidence states. Retain keyboard labels, focus
boundaries, browser history and direct project-tab URLs when changing layout.

## Maker workflow hierarchy

The current project keeps its next useful action above the document tabs, outside
the optional inspector. Stock-ready messaging covers required parts and never
claims design or physical validation. Revision creation is secondary. Assembly
and PCB tabs are disclosed by Design tools and remain visible when linked directly.

The workbench leads with resuming work and project actions, without a duplicate
summary strip. Small project registers disclose search/sort; equipment details
are optional. Inventory keeps search and stock views visible, with filters and
view configuration behind one disclosure. Applied filters remain visible and
clearable. Phone inventory rows keep item identity, recorded/available quantities
and status together. The inspector discloses supporting evidence and AI handoff.
The item drawer puts physical counting before images and maintenance actions.
