# BenchLedger workspace design

The web client is a desktop-style maker workspace. Projects and inventory are
peer destinations. Its job is to make records and the next useful action easy
to find, while keeping the meaning of stock evidence intact.

## Structure

- A persistent neutral sidebar holds primary navigation and a filterable list
  of loaded projects. Active and archived projects are separate views.
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
- Inventory remains a searchable, server-paged table with explicit stock states.
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
still requires its confirmation. API, MCP, authentication, concurrency and
append-only evidence contracts are unchanged.

`desktop-workspace.css` owns the shell and document layout. Existing component
styles own forms, previews and evidence states. Retain keyboard labels, focus
boundaries, browser history and direct project-tab URLs when changing layout.
