# PCB viewer

The project **PCB** tab is a read-only view of exact revisioned files. Upload a
`.kicad_pcb` source or self-contained STEP/GLB export in **Files**, select it in
**PCB**, then choose **Open PCB**. Files remain downloadable, unchanged, through
**Files & downloads**. No generated view replaces an editable design.
Uploads accept KiCad’s `application/x-kicad-pcb` media type and the existing
`application/octet-stream` fallback.

Use **3D**, **Top**, **Bottom**, **Fit board**, orbit and zoom to inspect the
source. The native viewer offers board, copper and component-outline visibility,
individual part visibility, reference/value search, selection and isolation.
**Component outlines are footprint drawings, not invented component bodies.**
Select a pad or footprint to see its reference, value and footprint identifier.
For export files, part selection and visibility use the exported node identities;
the viewer does not guess which meshes are copper or components.

Every open uses the existing Assembly inspection service with the selected
project revision, artifact ID and SHA-256. Changing the file, its hash, revision
or coordinate choice clears the previous view. Late responses cannot replace a
newer selection. The source panel displays exact provenance and omissions.
The tab is advertised by `pcb.read`; an older server does not expose it.

## Native KiCad support and limits

The reader supports modern board versions from KiCad 6 through KiCad 10
(version tokens 20210101–20260206). Legacy `module` footprints and newer unknown
versions are rejected; resave or export from KiCad rather than silently omit them.
It follows the [KiCad board format](https://dev-docs.kicad.org/en/file-formats/sexpr-pcb/)
and [common S-expression geometry](https://dev-docs.kicad.org/en/file-formats/sexpr-intro/).

- One closed board outline from Edge.Cuts lines, modern three-point arcs,
  rectangles, circles or polygons, including internal cutouts.
- Declared substrate thickness, round/oval pad drills and through-via holes.
- Outer F.Cu/B.Cu tracks and arcs, supported pad shapes (circle, rectangle,
  oval, rounded rectangle), and through vias. Copper is clipped to the board
  and drill openings with polygon-clipping (MIT). Declared pad-layer removal
  rules are not recalculated; an explicit warning identifies this case.
- Footprint placement/rotation and reference/value metadata. Source Fab outlines
  are preferred, then courtyard, then silkscreen line geometry when available.
- KiCad millimetres are fixed: X/Y become viewer X/−Y, board back at Z=0 and
  front at Z=thickness. Copper/outline offsets are illustrative display spacing.
  Native imports reject other coordinate choices at the service boundary.

Zones (including cached fills), internal copper, mask, paste, text, copper graphic
items, custom/chamfered pads and blind/micro vias are omitted with limitations
reported in the viewer. Offset drills, footprint-local Edge.Cuts, open/branched
or self-intersecting outlines, touching/intersecting/nested cutouts or holes,
and drills intersecting the board edge are rejected. These cases need a KiCad
STEP/GLB export. Curves are tessellated for viewing, not manufacturing.

No external component model, library, environment variable, script or URL is
resolved or executed. Even locally installed KiCad models are not loaded.
Export a self-contained STEP/GLB from KiCad when exact component bodies or filled
copper zones matter. Keep the native file and export together with their
provenance; an export does not prove it matches a different source revision.

The existing assembly limits apply: 20 MB/file, 40 MB per inspection, 300 parts,
250,000 triangles, a two-worker concurrency limit, 20-second worker lifetime and
256 MB JavaScript heap. Native parsing additionally limits nesting to 48, tokens
to 250,000, strings to 4,096 characters, outline edges to 1,500, contour vertices
to 5,000, drill openings to 1,000, geometry operations to 10,000 and intersection
comparisons to two million. Unsupported input fails with a controlled error.

Some KiCad GLB exporters split each surface into a separate primitive. When that
would exceed the part limit, the static GLB importer combines fragments only
within the same scene node and material. Placement, colours and the triangle
budget are retained; distinct components are not combined across nodes. Files
that already fit the part limit retain their existing part identifiers.

## Assembly and agents

Native PCB files also open in **Assembly** alongside enclosure geometry, with
its existing explicit save, guide and history controls. PCB inspection itself
never saves an assembly, changes stock, edits a board, runs DRC or controls a
machine. Electrical, mechanical and manufacturing validation remain separate.

MCP uses `inspect_assembly_sources` with the same project/revision, artifact hash,
`unit: "millimetre"` and `upAxis: "z"` for native boards. Read every part page.
Inspection returns source-derived references/value/footprint notes and warnings,
without geometry buffers. HTTP inspection includes derived `geometry[].pcb`
metadata for category, side and available footprint/board facts. That metadata
is not user-editable or persisted over source files. Existing Assembly save/read
operations and scopes are unchanged; no PCB write command is introduced.

## Synthetic example

`packages/artifacts/testfiles/synthetic-board.kicad_pcb` contains only synthetic
geometry and deliberately references a missing model to exercise the limitation
report. Use the local demo, upload it in Files, open PCB, and select the source.
The example is not an electrically or physically qualified design.

The planar clipping adapter uses [polygon-clipping 0.15.7](https://github.com/mfogel/polygon-clipping) under MIT; its installed package retains the upstream licence. It performs bounded geometry operations inside the same isolated worker.
