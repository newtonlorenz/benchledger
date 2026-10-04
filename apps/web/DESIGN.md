---
name: "BenchLedger workspace"
description: "A visual maker workspace for projects, parts, files and evidence-backed stock decisions."
colors:
  primary: "#1558e8"
  primary-dark: "#9fbeff"
  primary-foreground: "#fff"
  primary-foreground-dark: "#102245"
  primary-hover: "#1044b8"
  primary-hover-dark: "#b7ceff"
  selection: "#edf3ff"
  selection-dark: "#233853"
  background: "#fcfcfa"
  background-dark: "#141a24"
  card: "#fff"
  card-dark: "#152033"
  foreground: "#152033"
  foreground-dark: "#edf2fa"
  muted: "#f1f3f6"
  muted-dark: "#202a39"
  muted-foreground: "#536276"
  muted-foreground-dark: "#b3c0d2"
  ink-soft: "#42516a"
  ink-soft-dark: "#c9d3e3"
  border: "#dce1e8"
  border-dark: "#3a4b62"
  input: "#bcc7d5"
  input-dark: "#596d88"
  success: "#246c50"
  success-dark: "#94d8b3"
  success-ink: "#20563f"
  success-ink-dark: "#afe1bf"
  warning: "#91620d"
  warning-dark: "#e9c275"
  warning-ink: "#805409"
  warning-ink-dark: "#f0cd8b"
  danger: "#b42332"
  danger-dark: "#ffadb4"
  information: "#375d99"
  information-dark: "#a9c7f3"
typography:
  heading:
    fontFamily: "IBM Plex Sans Variable, system-ui, sans-serif"
    fontSize: "2.5rem"
    fontWeight: 650
    lineHeight: 1.15
    letterSpacing: "-0.03em"
  project-heading:
    fontSize: "clamp(1.8rem, 4vw, 2.75rem)"
    fontWeight: 650
    lineHeight: 1.12
    letterSpacing: "-0.03em"
  library-heading:
    fontSize: "clamp(1.75rem, 3.2vw, 2.5rem)"
    fontWeight: 600
    lineHeight: 1.15
    letterSpacing: "-0.035em"
  mobile-heading:
    fontSize: "1.875rem"
    lineHeight: 1.2
  mobile-project-heading:
    fontSize: "1.75rem"
  mobile-library-heading:
    fontSize: "2rem"
  section:
    fontSize: "1.45rem"
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: "-0.015em"
  title:
    fontSize: "1.0625rem"
    fontWeight: 600
    lineHeight: 1.4
  body:
    fontFamily: "IBM Plex Sans Variable, system-ui, sans-serif"
    fontSize: "1rem"
    lineHeight: 1.5
  control:
    fontSize: "0.9375rem"
    fontWeight: 500
    lineHeight: 1.4
  supporting:
    fontSize: "0.875rem"
    lineHeight: 1.5
  compact:
    fontSize: "0.8125rem"
  metadata:
    fontSize: "0.75rem"
  wordmark:
    fontSize: "1.3125rem"
    fontWeight: 650
    letterSpacing: "-0.02em"
  dialog:
    fontSize: "1.5rem"
    fontWeight: 600
    lineHeight: 1.3
  mobile-dialog:
    fontSize: "1.375rem"
  technical:
    fontFamily: "IBM Plex Mono, monospace"
rounded:
  square: "0"
  image-label: "4px"
  thumbnail: "5px"
  compact-control: "6px"
  control: "7px"
  surface: "8px"
  panel: "12px"
  phone-sheet: "16px 16px 0 0"
spacing:
  tight: "4px"
  control: "8px"
  related: "12px"
  group: "16px"
  content: "20px"
  section: "24px"
  dialog: "28px"
  gutter: "32px"
  wide-gutter: "64px"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.primary-foreground}"
    typography: "{typography.control}"
    rounded: "{rounded.control}"
    padding: "10px 16px"
  button-primary-hover:
    backgroundColor: "{colors.primary-hover}"
  button-secondary:
    backgroundColor: "{colors.card}"
    textColor: "{colors.foreground}"
    typography: "{typography.control}"
    rounded: "{rounded.control}"
    padding: "10px 16px"
  button-text:
    backgroundColor: "transparent"
    textColor: "{colors.primary}"
    typography: "{typography.control}"
    padding: "4px 0"
  input:
    backgroundColor: "{colors.card}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.control}"
    padding: "10px 12px"
  navigation-tab:
    backgroundColor: "transparent"
    textColor: "{colors.muted-foreground}"
    rounded: "{rounded.square}"
    padding: "10px 16px"
  filter-selected:
    backgroundColor: "{colors.selection}"
    textColor: "{colors.primary}"
    rounded: "{rounded.compact-control}"
    padding: "8px 14px"
  surface:
    backgroundColor: "{colors.card}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.surface}"
  dialog:
    backgroundColor: "{colors.card}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.panel}"
    padding: "28px"
---

# Design System: BenchLedger workspace

## Overview

**Creative North Star: "A visual maker workspace"**

Recognise the project, find its parts and files, and continue the build. Warm
white, graphite and restrained cobalt give the workspace a calm, precise
character. Project imagery makes work recognisable; aligned records and clear
task boundaries make repeated use straightforward.

Projects and Inventory have equal prominence. Light, Dark and System appearance
share one hierarchy. The visual system preserves the distinction between a
record, confirmed usable stock and physical verification; neither an image nor a
colour supplies evidence.

**Key Characteristics:**

- Readable working text and locally bundled IBM Plex type.
- Cobalt actions and selection, with separate labelled evidence states.
- Ruled records and contextual disclosure, with imagery for project identity.
- Shared desktop navigation, phone bottom navigation and scoped task sheets.

This is the token-bearing web record. Semantic values come from
`src/shadcn.css`; `src/approved-interface.css` supplies the current shared rhythm,
header and sheets. `src/workspace-shell.css` supplies the control foundation.
Project, library, home, inventory and specialist styles own their compositions.
The [repository overview](../../DESIGN.md) describes the broader interface;
the [surface brief](.impeccable/surfaces/apps-web-src-app-tsx.md) holds its screen
story. Update this record and `.impeccable/design.json` together when that system
changes; do not turn isolated overrides into new defaults.

## Colors

A warm-white working canvas and graphite text carry restrained cobalt actions.
The frontmatter records the light and dark values; runtime CSS selects the
matching semantic tokens with `data-theme="dark"`.

### Primary

- **Cobalt** (`primary`): primary actions, active navigation, focus and caret.
- **Cobalt hover** (`primary-hover`): the hovered primary action.
- **Cobalt wash** (`selection`): selected filters and secondary task controls.
- **On cobalt** (`primary-foreground`): a contrasting primary-action label in
  each appearance.

### Neutral

- **Warm paper** (`background`): the main workspace canvas.
- **Working surface** (`card`): fields, gallery cards and contained tasks.
- **Graphite** (`foreground`): headings, names and ordinary working text.
- **Quiet surface** (`muted`): image placeholders and secondary containers.
- **Supporting ink** (`ink-soft`) and **muted ink** (`muted-foreground`):
  explanation and metadata with a clear hierarchy below primary text.
- **Divider** (`border`) and **field edge** (`input`): single rules and controls.

Success, warning, danger and information use the existing domain palette and
explicit text. They are evidence roles, not a second decorative accent palette.

**The Evidence Rule.** Selection identifies the current task; a labelled status
reports evidence. Never make colour, imagery or task progress stand in for
compatibility, stock confirmation or physical verification.

## Typography

**Display and Body Font:** IBM Plex Sans Variable, with system and sans-serif
fallbacks. **Technical Font:** IBM Plex Mono, with a monospace fallback. Both
families are bundled locally. Keep the root at 16px; weights and size create
hierarchy without ornamental type.

### Hierarchy

- **Heading:** the shared page title; project and library titles use their
  recorded responsive variants, and phones use the mobile roles.
- **Section and title:** clear task subdivisions, without repeating the page
  title's scale. Dialogs use the separate dialog role.
- **Body:** explanations and ordinary form input. Longer introductions and task
  explanations are commonly bounded at 65–70 characters.
- **Control:** primary actions and field labels; supporting text, compact rows
  and metadata step down through the recorded roles.
- **Technical:** identifiers and code. Ordinary quantities retain the interface
  face with tabular numerals. Inventory has a denser 14px record base and 15px
  item names; this does not lower the shared body or form-input size.

**The Readable Work Rule.** Use the body and control roles for doing the task.
Keep metadata subordinate, retain 16px phone inputs, and let long names wrap
without obscuring quantities, actions or evidence.

## Layout

The desktop header is 66px tall and contains Projects, Inventory, search and
Settings. Content is bounded at 1536px, with 64px desktop side gutters, 32px below
1100px and 20px on phones. At 800px, the header becomes 56px tall and the two
workspace destinations move into a fixed bottom navigation with safe-area
padding. Content reserves space for it.

Within a project, Overview, Parts, Files and Build use four equal columns in one
compact row, bounded at 440px. Project menus contain actions for that project.
The library has two gallery columns, becoming one at 760px, and a remembered List
alternative. Images lead browsing and Overview; Parts and Build lead with work.
Inventory uses a searchable register, common stock views and a contextual item
inspector. Container queries reflow its controls and rows according to the
available working width. Detailed filters remain disclosed and clearable.

Use the recorded spacing steps for controls, related groups and sections. Shared
task buttons start at 42px on desktop; icons and core navigation use 44px or more.
Phone controls retain at least 44px targets. Form inputs retain 44px minimum
height. Standard and Compact row spacing are local view preferences, not changes
to the meaning of records.

Desktop task dialogs are bounded and centred; part details sit beside the
undimmed list so quantities, candidate stock and the next action remain in view.
Phones use bottom-attached or full-height sheets as the task needs space.
Keep clear close actions, keyboard access and focus restoration. Supporting
stock tasks preserve the originating requirement and its draft. Detailed screen
behaviour belongs in [the UI guide](../../docs/ui-design.md).

## Elevation & Depth

Working surfaces are flat: alignment, white space, restrained fills and single
rules separate records. Gallery cards and contained tasks have real boundaries;
they do not justify nesting every work section inside another card. Shadows
mark transient layers. The sidecar records the popover and dialog shadows from
the source, including the dark popover variant.

**The Task Boundary Rule.** Use a sheet or dialog to establish a focused task.
Use spacing and rules to organise the work inside it.

Motion explains a state change: shared hover changes use 160ms ease-out and
opening dialogs use a 180ms opacity transition. Reduced motion removes animation,
transitions and animated scrolling. Preserve the existing focus treatment and
never animate a task into apparent completion.

## Shapes

Controls have restrained rounding. Shared task buttons and fields use the
control radius; compact filters and view switches use the compact-control
radius. Small image-role labels and thumbnails have their own smaller corners.
Working surfaces use the surface radius; gallery cards and desktop dialogs use
the panel radius. Phone sheets round only the upper corners. Edge-attached
desktop sheets, ruled records and active-tab underlines remain square.

Circles are functional in checkbox/radio primitives, stock indicators and
numbered Build steps. Keep the source primitives and their states instead of
replacing them with typed symbols or decorative shapes.

## Components

### Buttons

Clear actions with quiet secondary choices. The primary variant pairs cobalt
with its on-cobalt label. The secondary variant has a working-surface fill and
field-edge border. Text actions use cobalt without a filled container. Use the
frontmatter's padding and rounding; shared focus is a ring-coloured outline,
and disabled controls remain visibly unavailable. Destructive actions keep the
existing destructive variant and confirmation rather than competing with the
next ordinary task.

### Chips and status

Filters show selection through cobalt text, a cobalt border and cobalt wash.
Status remains a concise textual statement in its evidence colour; inventory
indicators may retain a small outlined label. Do not assign a success state to a
pending fit check. Filter chips and record state labels are different roles.

### Cards / Containers

Gallery cards hold project identity, image role and next action; images use
`object-fit: contain`. General surfaces have a single divider-coloured border
and no resting shadow. Requirement, file and Build records use ruled rows.
Review panes may use a contained boundary on desktop and become a ruled section
when stacked. Do not place a separate card around every fact.

### Inputs / Fields

Fields use the working-surface fill, field-edge border, control rounding and
body-sized input. Labels sit above their field, with hints and errors beside
the relevant task. Focus uses the shared outline or field-group focus treatment;
errors pair text with the danger colour and a local boundary. NativeSelect
retains browser select behaviour; file inputs use the shared Input primitive.

### Navigation

Projects and Inventory are peer workspace destinations. Desktop navigation and
the four project tabs use a cobalt active underline with active text; phone
bottom navigation combines SVG icons and labels. Gallery/List, stock views and
Settings options have explicit selected states. Do not restore the previous
navigation rail or add competing top-level project tabs.

### Sheets and reviewed changes

Compose the local shadcn/Radix Dialog, AlertDialog and Sheet primitives. They own
focus containment, dismissal and background isolation; domain callbacks own the
unsaved-work guard. Keep the editor mounted through supported detours and
confirmation. Count and consumption reviews identify the affected item and
proposed balance before confirmation, then show a receipt with a useful return.
Revisiting that receipt does not perform the write again.

### Imagery and specialist work

Project images identify a current revision and have an explicit render, reference
or built-product-photo role. Missing images have honest placeholders; selected
file previews come from that artifact. Build keeps its numbered sequence beside
stock review and its detailed planning tools in disclosures. Assembly and PCB
viewers keep their domain rendering and shared surrounding controls. Geometry,
file availability and task progress do not certify physical work.

## Do's and Don'ts

### Do:

- **Do** use semantic light/dark tokens and locally bundled IBM Plex type.
- **Do** keep Projects and Inventory as peers and the four project sections in one compact row.
- **Do** use cobalt for actions and selection, with explicit text for evidence states.
- **Do** use readable working text, 16px phone inputs and at least 44px phone targets.
- **Do** preserve drafts, focus recovery and a named return through supporting stock tasks.
- **Do** use revision-bound runtime imagery with an explicit role and honest missing states.
- **Do** keep technical identity, uncertainty and provenance available through contextual disclosure.

### Don't:

- **Don't** infer compatibility or physical readiness from colour, imagery, file presence or task progress.
- **Don't** restore the retired navigation rail or add competing top-level project tabs.
- **Don't** replace useful working content with decorative metrics, repeated overview imagery or nested cards.
- **Don't** substitute a project cover for a file preview or invent project imagery.
- **Don't** store private runtime images, inventory or form drafts in public design metadata.
- **Don't** imply that a download starts fabrication or that a reservation records consumption.
- **Don't** introduce global resets into embedded viewers or replace shared focus and draft guards.
