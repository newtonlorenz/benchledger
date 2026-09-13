<p align="center">
  <img src="docs/assets/benchledger-lockup.svg" alt="BenchLedger" width="560">
</p>

<h3 align="center">Inventory, build planning and exploded CAD views for your workshop.</h3>

<p align="center">A self-hosted workspace for 3D printing, electronics and maker projects.<br>Keep parts, BOMs, model files and build guides together — with the same tools available to people and MCP agents.</p>

<p align="center">
  <a href="https://github.com/newtonlorenz/benchledger/actions/workflows/check.yml"><img alt="Build and tests" src="https://github.com/newtonlorenz/benchledger/actions/workflows/check.yml/badge.svg"></a>
  <a href="LICENSE"><img alt="Apache 2.0 licence" src="https://img.shields.io/badge/license-Apache--2.0-0f766e"></a>
  <img alt="Node 24" src="https://img.shields.io/badge/Node-24-3c873a">
  <img alt="Self-hosted" src="https://img.shields.io/badge/self--hosted-local--first-334155">
  <a href="docs/agent-quickstart.md"><img alt="Model Context Protocol" src="https://img.shields.io/badge/AI-MCP--ready-c2410c"></a>
</p>

<p align="center"><a href="#try-it-locally">Quickstart</a> · <a href="#see-it-in-action">Showcase</a> · <a href="docs/assembly-explorer.md">CAD viewer</a> · <a href="docs/agent-quickstart.md">Connect an agent</a> · <a href="CONTRIBUTING.md">Contribute</a></p>

![BenchLedger assembly explorer separating the cover, circuit board, fasteners and base of a synthetic electronics enclosure](docs/assets/showcase/assembly-exploded.png)

*Actual app screenshots using synthetic demo data. The sample enclosure is illustrative, not a validated design.*

> [!NOTE]
> **Early open-source release.** The app works locally and on a private LAN. APIs and schemas may change before 1.0; there is no managed hosted service.

## What can I do with it?

- **Find the parts you already have.** Track filament, electronics, fasteners, tools and printers, with separate evidence for ordered, delivered and physically checked stock.
- **Plan a build around real gaps.** Keep requirements, bill of materials (BOM), revisions, reuse choices and supplier offers together.
- **Explore how a model fits together.** Open STEP, GLB or STL files, pull parts apart, hide layers and inspect the construction in your browser.
- **Leave a useful build guide.** Save part names, placements, fixing notes, linked requirements and a step-by-step assembly order.
- **Keep the project history.** Tie CAD, slicer files, firmware and drawings to exact revisions; reconcile used stock, returns and leftovers after a build.
- **Let an agent help.** Scoped MCP tools use the same validation, permissions and audit history as the web interface.

## See it in action

### Explore the construction

The assembly viewer includes selection, isolation, searchable parts, assembled/exploded views and a separation slider. Saved guides can include colours, materials, position adjustments, requirement links and build steps.

![A saved synthetic enclosure assembly with a selected circuit board and build notes in BenchLedger's dark interface](docs/assets/showcase/assembly-dark.png)

| Source | What the viewer preserves |
| --- | --- |
| **STEP / STP** | Separate solids, source placements and hierarchy where present; declared units are converted to millimetres. |
| **GLB** | Static glTF meshes, nested transforms, repeated placements and illustrative colours. |
| **STL** | One part per file, with explicit units and editable placement. |

Separate exports keep their original positions. An exploded view illustrates relationships; it does not establish fit or a safe removal sequence. Other native CAD formats need a STEP or GLB export.

[Assembly guide and limits](docs/assembly-explorer.md) · [Download the synthetic demo model](docs/assets/showcase/synthetic-enclosure.glb) · [Screenshot provenance](docs/showcase.md)

### Know what needs attention

The workbench brings projects, equipment and next actions together. Stock evidence helps distinguish what is ready to use from what still needs counting, a decision or sourcing.

![BenchLedger workbench showing synthetic maker projects, stock checks and workshop equipment](docs/assets/showcase/workbench.png)

| Status | Next action |
| --- | --- |
| **Ready** | The recorded evidence supports using this item. |
| **Check** | Confirm a count or compatibility detail. |
| **Decide** | Resolve a project choice. |
| **Source** | Review options for a confirmed gap. |

Technical mode exposes exact variants, lots, provenance, revision scope, hashes and audit history.

### Keep people and agents on the same page

BenchLedger works as a normal web app. An MCP-capable client can also read inventory, calculate gaps, inspect model parts, prepare an assembly guide and save approved changes through the same application service.

For example, ask your agent:

> “Read this project's current revision. Inspect its model files, explain the parts, and draft a build order. Flag missing evidence before suggesting what to source.”

Assembly tools include `inspect_assembly_sources`, `read_project_assembly`, `save_project_assembly` and `read_assembly_history`. Saves validate exact source hashes and revision ownership, retain history and protect against stale updates.

Agents do not gain permission to purchase products, publish files, purge history or control a printer. Physical verification remains a separate maker decision.

[Agent quickstart](docs/agent-quickstart.md) · [MCP setup and tool reference](apps/mcp/QUICKSTART.md) · [Capability map](docs/capability-map.md) · [Bundled agent skill](skills/benchledger/SKILL.md)

## Try it locally

Requirements: **Node.js 24** and **npm 11+**.

```bash
git clone https://github.com/newtonlorenz/benchledger.git
cd benchledger
npm ci
npm run build
npm run dev
```

Open **[http://127.0.0.1:8792](http://127.0.0.1:8792)** and sign in with the demo password:

```text
demo-password-please-change
```

This starts a **synthetic, in-memory demo**. Its data resets when the server restarts. The demo password is public and is not a credential for a persistent installation.

To try the showcase model, download [synthetic-enclosure.glb](docs/assets/showcase/synthetic-enclosure.glb), upload it to the demo project's **Files**, then open **Assembly**. In the file's **Coordinates**, use **metre** units and **Z up**. Choose **Open assembly**, then **Exploded**.

For persistent storage, authentication and backups, follow the [self-hosting and deployment guide](docs/deployment.md). MCP connections use scoped bearer tokens even when the browser is configured for trusted-LAN access.

## How it works

BenchLedger is a TypeScript modular monolith with one set of application rules behind its interfaces.

```text
React + Vite web UI ─┐
Fastify HTTP API ────┼─> application services ─> domain rules
MCP adapter ─────────┘          │                    │
                               ├─> SQLite repositories
                               └─> content-addressed artifact storage
```

Source CAD stays intact. Assembly geometry is derived for viewing; saved guides use the existing versioned workflow store. STEP conversion uses `occt-import-js` / Open CASCADE; rendering uses Three.js. See [format support and dependency licences](docs/assembly-explorer.md#implementation-and-distribution).

BenchLedger does not slice models, generate G-code, control printers, scrape retailers or place orders.

## Help shape BenchLedger

Try it on a maker workflow and tell us where it breaks down. Useful contributions include clearer first-run guidance, reproducible CAD import bugs, accessibility fixes, additional maker workflows and focused tests.

- [Report a reproducible bug](https://github.com/newtonlorenz/benchledger/issues/new?template=bug_report.yml)
- [Suggest a workflow or feature](https://github.com/newtonlorenz/benchledger/issues/new?template=feature_request.yml)
- [Browse good first issues](https://github.com/newtonlorenz/benchledger/issues?q=is%3Aissue%20is%3Aopen%20label%3A%22good%20first%20issue%22)
- [Read the contributing guide](CONTRIBUTING.md)

If BenchLedger would help your workshop, **star the repository** to keep it handy and share it with another maker. Feedback from an actual build is especially useful at this stage.

Before contributing, read the [Code of Conduct](CODE_OF_CONDUCT.md), [development workflow](docs/development-workflow.md) and [support guide](SUPPORT.md). Run focused checks while iterating and `npm run check` before review.

## Privacy and licence

Public examples use synthetic data. Keep real inventory, private project files, supplier history, credentials, databases and backups outside the source tree. Read [Privacy](docs/privacy.md) and [Security](SECURITY.md); run `npm run public:check` before sharing source.

BenchLedger's own code is licensed under [Apache 2.0](LICENSE). Dependencies retain their respective licences.

[Changelog](CHANGELOG.md) · [Maker workflows](docs/maker-workflows.md) · [Open-source readiness](docs/open-source-readiness.md)
