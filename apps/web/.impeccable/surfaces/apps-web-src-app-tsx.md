---
version: 1
slug: "apps-web-src-app-tsx"
primary_target: "apps/web/src/App.tsx"
related_targets: ["apps/web/src/approved-interface.css","apps/web/src/shadcn.css","apps/web/src/workspace-navigation.tsx","apps/web/src/workbench-home.tsx","apps/web/src/project-library.css","apps/web/src/project-workspace.css","apps/web/src/inventory-experience.css","apps/web/src/specialist-journey.css"]
---

THESIS
A visual maker workspace: recognise a project, find its parts and files, and continue the build. Operate mode. Projects and Inventory have equal weight. The approved visual world and interaction structure are documented in DESIGN.md, PRODUCT.md and docs/ui-design.md; they are the design source for this surface.

OWN-WORLD
Warm-white working surfaces, graphite text and restrained cobalt actions. A compact desktop header exposes Projects and Inventory with search and Settings; phones keep the two workspace destinations in bottom navigation. Project imagery identifies the work in the library and Overview. Working records use readable rows, deliberate spacing and single rules. Exact identity, evidence and specialist controls remain available through contextual disclosure. Dark and System appearance preserve the same hierarchy. Status colours always accompany text and remain distinct from selection.

STORY
Choose a project from Gallery or the remembered List view. Overview shows the selected image, notes and next action; Parts brings requirements, owned-stock matching and sourcing together. Files groups revision-scoped records by 3D print, Electronics, CAD & firmware and Instructions. Build follows parts, files, assembly, verification notes and actual-use review, with advanced planning and geometry tools in context. A stock-check detour keeps the requirement draft and returns to the named part. Review exact affected stock before confirming; a saved result is a receipt, not another opportunity to repeat the mutation.

FIRST VIEWPORT
A 66px desktop header replaces the retired navigation rail. The main workspace uses generous gutters, reduced on phones. A project has one compact title/revision header and one row of Overview / Parts / Files / Build. The project library and Overview may lead with imagery; Parts and Build lead with useful work. The project menu contains actions for that project, while New project belongs in the library. Mobile uses 44px or larger touch targets, readable form inputs and scoped sheets with explicit close controls. Do not repeat overview imagery, introductory panels or zero counters above working content.

FORM
IBM Plex Sans with a fixed 16px root and 16px form inputs. IBM Plex Mono is reserved for identifiers and code; ordinary quantities use tabular numerals. Primary and selection tokens use cobalt on warm-white/graphite surfaces, with equivalent dark-theme tokens. Controls have restrained rounding; sheets and dialogs establish the task boundary without nesting cards throughout the page. React/Radix controls retain keyboard, focus and dismissal semantics. Settings contains appearance and row-spacing preferences. Hover, disabled, loading, error, empty, focus and reduced-motion states remain explicit. Scoped stock and item sheets must preserve protected drafts and return focus to the relevant work.

FINISH
Project images are authenticated runtime data, selected for an exact revision and labelled as design renders, reference images or built-product photos. No private project images, inventory, paths or names belong in this public metadata. Missing images remain useful placeholders; a selected file preview must come from that artifact. Model views, file checks and task progress do not establish physical verification, and downloads do not launch a slicer or machine. Verify the implemented desktop and phone journeys, accessibility, draft recovery and required repository gates separately from design approval and deployment. Record dated evidence in the task or review record; keep DESIGN.md and this surface brief aligned with the approved world.
