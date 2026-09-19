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
  this browser, separately for sample and private workspaces. Mobile filters are
  disclosed on demand; the register scrolls horizontally without widening the page.
- Copy for AI produces an explicit selected-record snapshot with identity, units,
  quantities, evidence, version and planning limits. It sends nothing to a service
  and provides selectable text when clipboard access is unavailable.
- On phones, navigation becomes a focus-contained drawer; the inspector follows
  the working area. Controls retain touch-sized targets and tables adapt.

## Visual language

Use the bundled IBM Plex Sans for ordinary interface text and IBM Plex Mono
only for identifiers, revisions and measurements. Headings have a fixed, compact
scale. White document surfaces and a pale neutral sidebar support daytime work;
the dark theme follows the same hierarchy. Green marks current selection and
primary actions. Amber, red and evidence labels communicate domain states.

Prefer separators and alignment to nested panels. Keep controls consistent,
secondary prose quiet but readable, and destructive actions in project settings.
No marketing hero, decorative metrics or decorative motion. Respect reduced
motion and the existing light/dark, density and collapsed-navigation preferences.

## Behaviour and boundaries

Never infer stock, physical validation or manufacturing readiness from a visual
state. All document navigation uses the existing unsaved-work guard. Deletion
still requires its confirmation. Authentication, concurrency and append-only evidence remain unchanged. Shared
stock-view filters are additive to HTTP and MCP; available stock never establishes
project compatibility or exact product identity.

`desktop-workspace.css` owns the shell and document layout;
`inventory-workspace.css` owns the register, category navigator and item inspector.
Existing component styles own forms, previews and evidence states. Retain keyboard labels, focus
boundaries, browser history and direct project-tab URLs when changing layout.
