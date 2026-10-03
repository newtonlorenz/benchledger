# BenchLedger interface

BenchLedger uses a precise workshop register: one navigation rail, one working document and details available on request. Inventory and projects are peer destinations. The interface privileges the current task and its records over dashboard summaries.

## Appearance

The app serves IBM Plex Sans locally. Root type is 16px; ordinary interface text is 14px, supporting metadata at least 12px, prominent phone item names 15px, and page titles 26px. IBM Plex Mono is reserved for identifiers, code and technical values. Never shrink the root to make the workspace appear dense.

Light mode uses a near-white working surface, a pale neutral navigation rail and graphite text. Dark mode retains the same hierarchy with dark surfaces. Forest green identifies primary actions and selection; stock states also use explicit text. Warning and error colours retain their existing meaning. Colour never implies that stock, compatibility or a physical build has been validated.

Use 28px desktop workspace gutters, a 56px utility bar and a 216px navigation rail. The existing brand mark retains 1px internal bar corners. Controls have a 6px radius, with 36–40px pointer targets and at least 44px touch targets. Floating dialogs and popovers use a restrained shadow. Registers use aligned rows and single rules; avoid nested cards and decorative metrics.

## Composition

- Workbench: one project register with visible search, view and sort. New project is the primary action; Open inventory is its peer destination. Recent work is a compact link. All next actions and workshop tools are disclosed below the register.
- Inventory: stock views, then one search/filter/options toolbar. Filters open in place. View options holds sorting, saved views and optional columns. The register starts full width; selection reveals its inspector. Recorded and available quantities remain distinct, with uncertainty explicit. Narrow registers stack labelled values, with recorded and available quantities side by side.
- Projects: title, revision and stage; Project tools holds management actions, and Project details opens supporting setup. Tabs precede the working content. The Plan contains a concise next action and stock shortcuts. Requirement rows align name, quantity, stock and Edit; ready-stock explanations can be disclosed while unresolved stock reasons stay visible.
- Files, shopping, build planning, settings and specialist viewers share the same controls, type and surfaces. Keep task-specific evidence and approval boundaries explicit.

## Ownership

`shadcn.css` owns semantic tokens. `workspace-shell.css` owns typography, common controls and app chrome. `project-workspace.css`, `home-experience.css` and `inventory-experience.css` own their respective primary workspaces. `workspace-layout.css` retains specialist forms and workflows. Add a style to its owner rather than appending a competing skin.

React and Radix primitives retain keyboard, focus and interaction semantics. The framework does not determine the visual composition. Local appearance, pins and saved views do not change business records.

## Finish requirements

Review desktop, tablet and phone composition in both themes; inspect keyboard navigation, visible focus, empty and error states, long content and draft continuity. Run the repository gates and review the public diff separately. Dated findings and release evidence belong in `docs/reviews/2026-10-03-professional-workspace-overhaul.md` and the release record. There are no shipping raster images in this design.
