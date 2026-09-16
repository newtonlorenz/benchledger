# Showcase images and example files

Captured on **2026-09-16** from BenchLedger revision `c7442a4`, which includes the
project PCB viewer. Every image is a direct browser capture of the actual app
using a disposable, in-memory synthetic workspace. No private inventory, board,
host address, credential or browser chrome is included. No UI elements or model
geometry were painted into the screenshots.

| Asset | What it shows |
| --- | --- |
| [Exploded assembly](assets/showcase/assembly-exploded.png) | A saved seven-part enclosure guide with illustrative viewing offsets. |
| [Dark assembly](assets/showcase/assembly-dark.png) | The same guide with a selected controller board in dark mode. |
| [Native PCB](assets/showcase/pcb-top.png) | Top view of a native KiCad file, with copper, drill openings and selectable footprint outlines. |
| [Workbench](assets/showcase/workbench.png) | Synthetic project attention and workshop equipment. |
| [Project plan](assets/showcase/project-plan.png) | The synthetic demo's revision-scoped requirements and readiness. |
| [Enclosure GLB](assets/showcase/synthetic-enclosure.glb) | Seven static model parts generated from boxes and cylinders. |
| [Controller KiCad board](assets/showcase/synthetic-controller.kicad_pcb) | A 64 × 44 mm viewing example with 12 component footprints, four mounting holes, six connector drills and illustrative tracks. |

The enclosure and native board are independent illustrative examples. Matching
outer board dimensions do not establish that their geometry, hole positions or
connections form a compatible assembly. Neither is a validated electrical circuit,
printable part, manufacturing file or physical build instruction. The native
viewer shows footprint drawings, not invented component bodies.

## Recreate the examples

From the repository root, after `npm ci`:

```bash
node scripts/create-showcase-model.mjs
node scripts/create-showcase-board.mjs
npm run build
npm run dev
```

These generators read no private project files and create only the two named
synthetic assets above. The demo uses the public password documented in the
[README](../README.md#try-it-locally).

1. Sign in to the demo and open the synthetic lamp project.
2. Upload both example files through **Files**, in the current project revision.
3. Open **Assembly**, select the GLB, and set **metre / Z up** in **Coordinates**.
4. Choose **Open assembly**, then **Edit assembly**. Name the guide
   `Sensor enclosure · assembly guide`, add illustrative notes, and use the
   viewing offsets below. Save only in the disposable demo.
5. Choose **Exploded**. Adjust the camera with the viewer's orbit/zoom controls;
   capture the assembly workspace. Select **Controller board** and use
   **View → Dark** for the second capture.
6. Open **PCB**, choose `synthetic-controller.kicad_pcb`, then **Open PCB → Top**.
   Select the `U1` footprint outline. Capture the PCB workspace with project
   navigation visible; leave source warnings and provenance intact.
7. Capture **Workbench** and the project's **Plan** using their normal UI. All
   names, counts, requirements and states come from the synthetic demo.

| Part | Separation X / Y / Z (mm) |
| --- | --- |
| Base enclosure | 0 / 0 / 0 |
| Board standoffs | 0 / 0 / 15 |
| Controller board | 0 / 0 / 30 |
| Processor and headers | 0 / 0 / 42 |
| USB connector | -12 / 0 / 35 |
| Vented cover | 0 / 0 / 65 |
| Cover fasteners | 0 / 0 / 82 |

The saved guide groups parts into three steps: **Base and board supports**,
**Controller and connections**, and **Cover and fasteners**. These are illustrative
viewing instructions, not a tested assembly sequence.

Screenshots use the app's own light/dark appearance controls and camera controls.
Their crops exclude browser chrome and unrelated navigation while retaining the
real interface. No CSS overrides, fake overlays or private workshop content are
used. Refresh these captures when the represented interface changes.

## Share an example

These assets use the repository's Apache-2.0 licence and can accompany a link to
[BenchLedger](https://github.com/newtonlorenz/benchledger). A useful caption is:

> BenchLedger keeps inventory, BOMs, exploded CAD, native PCB inspection and build
> planning in one self-hosted project workspace, with shared tools for people and
> MCP agents. Screenshots use synthetic demonstration data.

Prefer a specific workflow or a build story over claims about popularity. Remove
private project details before sharing your own screenshots.
