# Shadcn foundation migration

This replaces the initial five-component styling pass with a shared web UI
foundation. Application screens now compose local shadcn components backed by
Radix, Tailwind, cmdk, Sonner and resizable panels. `components.json` configures
future registry additions; generated components retain the shadcn MIT licence.

## Coverage

| Surface | Shared implementation |
| --- | --- |
| Actions and forms | Button, Input, Textarea, Label, NativeSelect, Checkbox, RadioGroup, Switch, Slider |
| Records and feedback | Table, Card, Badge, Alert, Progress, Skeleton, Sonner |
| Navigation | Sidebar, Sheet, Tabs, Command, DropdownMenu, Popover, Tooltip |
| Editors and confirmation | Dialog, AlertDialog, Sheet, shared WorkspaceModal adapter |
| Progressive disclosure | Collapsible through Disclosure |
| Desktop inventory | Resizable panels with persisted inspector width |
| Catalog and owned-item search | Command selection inside a Popover |

The source audit rejects parallel native controls and hand-built tab/combobox
roles in application screen files. NativeSelect intentionally retains browser
select semantics; file selection uses Input. Canvas, WebGL and SVG content stay
specialised, with shared controls around them. No unrelated library components
are required simply to increase the installed component count.

`shadcn.css` owns semantic light/dark tokens and Tailwind integration.
`workspace-layout.css` owns domain layout and responsive geometry. Five former
CSS layers have been consolidated. Appearance, density and collapsed navigation
preferences retain their existing browser-local storage.

Radix owns focus traps and background isolation. The adapter preserves dismissal
guards and focus return for conditionally mounted dialogs. Inventory editors stay
mounted beneath confirmations so text and selected-file drafts survive. Category
archive failures appear inside the active confirmation. Keyboard tests wait for
the new Radix layer to become interactive before sending Escape.

## Visual evidence

Fresh captures use only the disposable synthetic demo:

- [Workbench](../assets/shadcn/workbench.png)
- [Inventory](../assets/shadcn/inventory.png)
- [Dark inventory](../assets/shadcn/inventory-dark.png)
- [Stock-count confirmation](../assets/shadcn/count-review.png)
- [Project](../assets/shadcn/project.png)
- [Phone project](../assets/shadcn/project-mobile.png)

## Verification

`npm run check` passed on Node 24 and npm 11, with
`NODE_OPTIONS=--no-experimental-webstorage` for the existing jsdom environment:

- Public/privacy checks, all package/app builds and all type checks passed.
- 127 test files, 1,056 unit/integration tests passed.
- Coverage: 86.71% statements/lines, 82.32% branches, 80.61% functions;
  all required 80% thresholds passed.
- All 141 Playwright browser tests passed, including light/dark accessibility,
  mobile layouts, keyboard navigation, modal isolation, retained drafts,
  confirmation guards, resizable panels, file uploads and stock workflows.
- The repeated physical-count Escape/focus case also passed three consecutive runs.
- Fresh screenshots were inspected; corrected mobile tab wrapping, sheet width
  and nested confirmation overlay stacking. The mobile test now checks that
  every tab stays within its list and that the panel starts beneath it.
- Final diff whitespace check passed. Task-owned preview and browser processes
  were closed; pre-existing services were left alone.

## Boundaries and integration

No HTTP/MCP contracts, authentication, stock rules, durable data or native mobile
code changed. Existing validation, concurrency and evidence rules remain in place.
AI Elements is not installed: the current web product has no AI conversation
surface needing those components.

The migration was verified on `codex/shadcn-redesign`, based on `936f228`.
These results describe the verified source before release. Deployment identity and
private backup evidence are recorded separately in the authorised release task. Review was performed inline without
an independent reviewer agent. Vite still reports large main/viewer chunks; this
migration adds client dependencies and does not address viewer code splitting.

Rollback is a frontend source/dependency rollback followed by a rebuild. It needs
no data migration and must retain existing appearance and inventory-layout keys.
