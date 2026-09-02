<p align="center">
  <img src="docs/assets/benchledger-lockup.svg" alt="BenchLedger" width="520">
</p>

<p align="center"><strong>Know what you have. Plan what to build. Close the loop.</strong></p>

<p align="center">
  BenchLedger is a self-hosted workspace for 3D-printing and electronics makers, from hobbyists to expert workshops.
</p>

<p align="center">
  Manage projects yourself in the web UI, or ask an authorized AI agent to help. Both use the same records, application rules, and approval boundaries.
</p>

> [!NOTE]
> BenchLedger is an early open-source release. The private-LAN workflow is
> working, but APIs, schemas, and MCP capabilities may change before 1.0.

## Make a project you can trust

BenchLedger keeps the information around a maker project together. Use it to:

- Track printers, tools, accessories, spare parts, electronics, and consumables.
- Keep exact product profiles for printers, filament, nozzles, plates, and parts.
- Keep an append-only stock ledger with confirmed, uncertain, reserved, and unavailable states.
- Start projects with work items, revisions, bills of materials (BOMs), and build gaps.
- See what you can reuse, what needs a physical check, and what is missing.
- Compare recorded supplier offers, package quantities, observed prices, and alternatives.
- Keep versioned CAD, STEP, STL, 3MF, firmware, drawing, and validation files.
- Bind build configurations and SHA-256 hashes to project revisions.
- Record actual use, returns, loss, leftovers, and converted assets after a build.

It treats uncertainty honestly. An old order is evidence that something was bought,
not proof that it is still on hand. A compatible-looking part is a candidate,
not an exact match. Recommendations can retain their reason, source, observation
time, and next physical check.

## One workspace, two ways to work

Use the web UI when you want to manage the project yourself. Add inventory,
organize categories, create a project, review its BOM, attach files, and close
out the build from the same workspace.

Use authorized AI agents when you want help with the same bounded workflow.
The model-neutral MCP server lets an agent inspect inventory, calculate BOM gaps,
prepare shopping proposals, manage revisions and artifacts, and draft project
close-out reconciliation. The agent works against the same records through the
same application rules as the UI. It is not a separate agent-only system.

Beginners see plain outcomes such as **Ready to use**, **Check quantity**, and
**Need to buy**. Expert detail remains available in place: exact variants,
dimensions, lots, compatibility evidence, build configuration, hashes, and audit history.

BenchLedger does **not** purchase products, scrape retailers, execute uploads,
slice models, generate G-code, or control printers.

## A project from idea to close-out

```mermaid
flowchart LR
  I[Inventory] --> P[Project]
  P --> B[BOM and build setup]
  B --> G{Gap check}
  G -->|Reuse| R[Reserve stock]
  G -->|Inspect| C[Physical check]
  G -->|Missing| S[Shopping proposal]
  R --> F[Files and validation]
  C --> F
  S --> F
  F --> X[Post-project reconciliation]
  X --> I
```

![BenchLedger synthetic sample workspace showing a project build path, the next useful action, inventory status, and project summary](docs/assets/benchledger-workspace.png)

### Set up inventory categories

Open **Settings → Manage inventory categories** before adding stock. Add a
top-level category such as “Workshop” or “Electronics”; you can add one level of
subcategories such as “Workshop / Measuring tools”. Rename or change the order
when your storage changes, or archive a category that should no longer be used.

When you choose **Inventory → Add item**, select the item type first and then an
active managed category. The item type remains the semantic kind used for
matching (for example, `tool` or `electronic`); the managed category is the
display label and is used by the Category filter. Existing legacy items can stay
unassigned until you edit them. If no category is available, the add form links
back to Settings so you can create one before continuing.

## Five-minute local demo

Requirements: Node.js 24 LTS and npm 11 or later.

```bash
npm ci
npm run dev
```

Open [http://127.0.0.1:8792](http://127.0.0.1:8792). Development mode uses
synthetic demo data; never copy a private inventory database into the checkout.
The demo remains password-protected. A fresh trusted-LAN deployment with no
bootstrap password hash starts with browser access in `lan_open` mode; use that
mode only when every device on the network is trusted. An administrator can
enable `password` mode in Settings.

For a production-like LAN installation with external persistent storage, follow
the [deployment guide](docs/deployment.md).

## Agent and MCP access

BenchLedger is agent-native rather than agent-only. The model-neutral MCP server
offers bounded resources and scoped tools over the same application service used
by the web UI.

Use the bundled [`$benchledger` skill](skills/benchledger/SKILL.md) when your
runtime supports skills. Otherwise begin with the
[ten-minute agent quickstart](docs/AGENTS.md) and
[capability map](docs/capability-map.md).

Agents can inspect inventory, calculate BOM gaps, prepare shopping proposals,
manage revisions and artifacts, and draft project close-out reconciliation. They
cannot buy, publish, purge permanently, control a printer, or bypass physical
verification. Browser access mode does not grant MCP access: `/api/v1/mcp`
always requires a scoped bearer token, including when the browser is in
`lan_open` mode.

## Architecture

BenchLedger is a TypeScript modular monolith:

```text
React + Vite web UI ─┐
Fastify HTTP API ────┼─> application services ─> domain rules
MCP adapter ─────────┘          │                    │
                               ├─> SQLite repositories
                               └─> content-addressed artifact storage
```

The UI, HTTP API, and MCP adapter never write to SQLite or the filesystem
directly. See the [capability map](docs/capability-map.md),
[stock semantics](docs/stock-evidence-semantics.md), and
[approval boundaries](docs/approval-boundaries.md) for the public contract.

## Repository map

| Path | Purpose |
| --- | --- |
| `apps/web` | Responsive beginner-to-expert interface |
| `apps/server` | Fastify API, auth, OpenAPI, and application host |
| `apps/mcp` | Model-neutral MCP adapter and protocol boundary |
| `packages/domain` | Evidence-aware inventory and project rules |
| `packages/application` | Use cases and ports shared by every surface |
| `packages/database` | SQLite schema and repositories |
| `packages/artifacts` | Content-addressed project file storage |
| `skills/benchledger` | Portable workflow skill for compatible agents |
| `docs` | Semantics, deployment, privacy, roadmap, and reference workflow |

## Private data stays outside the repository

This source tree contains application code, documentation, deployment examples,
and synthetic fixtures only. Do not commit real inventory, project artifacts,
supplier history, order/message identifiers, `.env` files, credentials, SQLite
databases, logs, backups, or private exports.

Read [Privacy](docs/privacy.md) and [Security](SECURITY.md) before importing data.
Run `npm run public:check` before sharing a branch or source archive.

## Contributing

Focused issues and pull requests are welcome.
Start with [CONTRIBUTING.md](CONTRIBUTING.md), the
[Code of Conduct](CODE_OF_CONDUCT.md), [development workflow](docs/development-workflow.md),
and [support guide](SUPPORT.md).

During development, test the smallest affected surface. The complete release
gate is:

```bash
npm run check
```

## Project status

- **Working:** private LAN app, external data boundary, authentication, scoped
  MCP, projects/BOMs, exact product profiles, revisioned artifacts, backups, and
  post-project reconciliation
- **Pre-release:** APIs and schemas may still change; there are no published npm
  packages or stable compatibility guarantees
- **Not yet published:** npm packages or a hosted service

See [CHANGELOG.md](CHANGELOG.md) and the
[open-source readiness review](docs/open-source-readiness.md).

## License

Licensed under the [Apache License 2.0](LICENSE).
