# Showcase images and sample model

The README images are direct captures of BenchLedger's web interface, using only
synthetic data. They are not mock-ups, private workshop screenshots or evidence
of a validated physical build. Captured on 2026-09-13 from the application accompanying this showcase update.

| Asset | What it shows |
| --- | --- |
| [Workbench](assets/showcase/workbench.png) | The default synthetic demo's project register, attention queue and equipment. |
| [Exploded assembly](assets/showcase/assembly-exploded.png) | A seven-part synthetic electronics enclosure with saved viewing offsets. |
| [Dark assembly](assets/showcase/assembly-dark.png) | The same guide, with the controller board selected. |
| [Sample GLB](assets/showcase/synthetic-enclosure.glb) | Static geometry generated entirely from boxes and cylinders. |

All four assets are suitable for sharing with a link to the repository. They use
the repository's Apache-2.0 licence. The model is illustrative; it has not been
checked for printing, mechanical fit, electrical safety or functionality.

## Recreate the model and views

1. Follow the README's local quickstart and sign into the in-memory demo.
2. Run `node scripts/create-showcase-model.mjs` from the repository root to
   regenerate the GLB. The generator reads no private CAD or project files.
3. Upload `docs/assets/showcase/synthetic-enclosure.glb` through the demo
   project's **Files** tab.
4. In **Assembly**, select that file, open **Coordinates**, set **metre** and
   **Z up**, then choose **Open assembly**.
5. Use **Edit assembly** to name the guide `Synthetic sensor enclosure`, add
   illustrative notes, and set the viewing offsets below. These are display
   offsets, not manufacturing or disassembly instructions.
6. Save the guide in the disposable demo, choose **Exploded**, and adjust the
   zoom with the mouse wheel. Select the controller board for the detail view.
7. Switch appearance through **View** for the dark capture. Capture the assembly
   workspace element; do not change labels, state or rendering to simulate UI.

| Part | Separation X / Y / Z (mm) |
| --- | --- |
| Base enclosure | 0 / 0 / 0 |
| Board standoffs | 0 / 0 / 15 |
| Controller board | 0 / 0 / 30 |
| Processor and headers | 0 / 0 / 42 |
| USB connector | -12 / 0 / 35 |
| Vented cover | 0 / 0 / 65 |
| Cover fasteners | 0 / 0 / 82 |

The first README workbench image is captured before renaming the demo project.
The enclosure views use a renamed synthetic demo project. No real inventory,
project files, service addresses, credentials or browser chrome are included.

The full model and capture sizes are intentionally small enough to view directly
on GitHub. Keep future showcase assets factual and regenerate them from the
synthetic demo when the relevant interface changes.
