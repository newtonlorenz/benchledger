---
title: Simple maker project management PRD
status: proposed
audience: product owner, designer, developer, QA agent, implementation agent
product: BenchLedger
target_release: post-0.1 incremental slices
source_evidence: sanitized live 3D and electronics project trial, 2026-09-01
---

# Simple maker project management PRD

## 1. Product decision

BenchLedger should become the simplest reliable place to manage a complete maker
project from idea to close-out. It should support 3D printing, electronics, firmware,
finishing and assembly without becoming a general task-management system.

The core promise is:

> Tell BenchLedger what you want to make. It shows what you have, what to check,
> what to decide, what may need sourcing, and the next safe action. The UI and an
> authorized agent can complete the same workflow against the same records.

The beginner path must work without knowledge of inventory evidence states, revision
IDs, BOM terminology or manufacturing gates. An expert must still be able to inspect
exact quantities, units, dimensions, compatibility decisions, machine profiles,
artifact hashes and audit history.

This PRD is the product-level source of truth for the desired experience. The more
detailed contracts in
[`agent-maker-workflow-requirements.md`](agent-maker-workflow-requirements.md)
remain the engineering annex for `REQ-001` through `REQ-012`.

## 2. Problem

BenchLedger has a strong evidence-first foundation, but a realistic hybrid project
still exposes too much implementation detail and too many ways to produce a confusing
state.

In the sanitized live trial, an agent could create a project, work items, BOM lines and
an immutable machine configuration. However:

- a clean setup required many separate writes;
- retired BOM lines remained in gap calculations and changed later results;
- project status appeared as `active`, `concept` and `idea` on different surfaces;
- reserved filament appeared depleted rather than allocated;
- optional lines appeared in totals labelled required;
- some error and gap explanations contradicted their own structured state;
- delivery-only candidates and conditional compatibility were difficult to model
  safely;
- no inspection queue, reservation list or complete project graph read-back existed;
- maker quantities, reusable tools and continuously consumed material shared overly
  generic quantity semantics;
- local CAD packets could not be attached through a simple host-mediated agent flow;
- electronics, firmware and software work items could not record a small set of
  useful typed facts;
- the full capability document was too large for efficient agent discovery.

The result was possible to operate, but not easy to trust or teach.

## 3. Goals

1. Make project setup and daily use obvious to a first-time maker.
2. Make every readiness and shopping result mathematically reconcilable and safe.
3. Let an authorized agent achieve the same outcomes as the UI with fewer calls,
   compact documentation and reliable read-back.
4. Support the complete 3D plus electronics lifecycle without controlling a printer,
   purchasing, flashing firmware or claiming physical validation.
5. Preserve expert depth through progressive disclosure rather than a separate expert
   product.
6. Deliver the work as small vertical slices through the shared domain and application
   services used by web, HTTP and MCP.

## 4. Non-goals

BenchLedger will not become:

- a Gantt chart, sprint planner, issue tracker or configurable workflow engine;
- a team chat, calendar or general resource-scheduling product;
- a CAD tool, slicer, firmware IDE or electronics simulator;
- a retailer scraper, cart or purchasing agent;
- a printer controller, heater controller or firmware flasher;
- an autonomous authority for physical counts, fit, electrical safety or production
  approval;
- an arbitrary filesystem, shell, SQL, credential or network-fetch interface.

No new microservice, graph database or separate agent-only backend is required. New UI,
HTTP and MCP capabilities must use the existing modular-monolith application paths.

## 5. Primary users

### Beginner maker

Wants to know what to do next. Uses plain language and may not understand BOMs,
profiles, reservations or evidence states.

### Experienced maker

Needs exact material, component, machine, configuration, revision and validation
records. Expects the system not to hide uncertainty or history.

### Authorized agent

Sets up and maintains projects on the user's behalf. Needs compact discovery,
predictable primitives, complete read-back, structured recovery and approval
boundaries.

The product should not require the user to select one of these modes. The default view
is concise; a **Details** action reveals the expert and agent-readable fields in place.

## 6. The simple product model

Use the existing entities. Add only the minimum structure required to make them work
together.

| Entity | Purpose |
| --- | --- |
| Project | The outcome the user wants to make and its overall lifecycle. |
| Work item | A printed part, assembly, electronics unit, firmware/software unit or document. |
| Requirement | A BOM need, reusable tool/equipment need or specification blocker. |
| Inventory item | What the user owns or has evidence for. |
| Inspection | One physical question or measurement that can unblock requirements. |
| Reservation | A planned consumable allocation or reusable-equipment assignment. |
| Build configuration and plan | Exact machine/material setup and the jobs or plates that use it. |
| Artifact and evidence | Versioned files, measurements, reviews and validation records. |
| Offer | A sourced buying option; never a purchase. |

Do not add a separate general-purpose task entity. A work item may have:

- a status;
- one optional owner;
- one optional target date;
- a short acceptance statement;
- zero or more `blockedBy` work-item IDs.

That is enough to express order and responsibility without building a project-planning
suite.

## 7. Experience principles

### 7.1 One readiness language

Beginner-facing project readiness uses four groups:

| Label | Meaning | Default next action |
| --- | --- | --- |
| **Ready** | Confirmed compatible stock or completed evidence covers the need. | Reuse or continue. |
| **Check** | A physical count, condition check, measurement or compatibility decision is needed. | Show the exact check. |
| **Decide** | The requirement is not specified enough to evaluate or source. | Show the missing decision or measurement. |
| **Source** | The requirement is sufficiently specified and no compatible available stock covers it. | Compare recorded offers. |

`Optional` is a separate flag, not a fifth readiness total. Expert details may expose
the canonical states `supplied`, `inspect_first`, `specify_first`, `partial`, `missing`
and `optional`.

### 7.2 One next action

Every project overview shows one recommended next action derived from blockers. It can
link to a short list when several checks can be completed together. It must never
default to buying an under-specified item.

### 7.3 One source of behavior

Web, HTTP and MCP invoke the same application commands and queries. A rule must not be
implemented independently in a web component or MCP adapter.

### 7.4 Progressive disclosure

Default cards show names, quantities, readiness and the reason in plain language.
**Details** reveals IDs, versions, canonical units, evidence, uncertainty,
compatibility, reservations, hashes and audit history. There is no separate expert
database screen.

## 8. Required product capabilities

### `MPM-001` — Trustworthy inventory and BOM calculations

**Priority:** P0

The readiness engine is authoritative. Every summary must be derivable from its active
detail rows.

Requirements:

- Exclude retired BOM lines from active gap evaluation, readiness totals, candidate
  allocation and shopping output.
- Gap calculation is stateless. A retired line cannot consume candidate availability;
  only an active reservation may reduce availability.
- Count required and optional lines separately.
- Distinguish physically confirmed, available, reserved/allocated and depleted stock.
- A fully reserved item is `allocated`, not `depleted`.
- Delivery/order evidence remains **Check**, never available stock.
- Conditional or unknown compatibility remains **Check**, even when the candidate item
  is explicitly named.
- An exact item ID must not silently upgrade a conditional compatibility decision.
- **Source** is allowed only when specification is sufficient and no available or
  inspect-first candidate covers the requirement.
- Return one explanation consistent with the structured state. Do not produce text
  such as “stock is available” beside zero available quantity.
- Return separate totals for required, optional, Ready, Check, Decide, partial and
  Source.
- Correct corrupted quantity/unit bases through an evidence-bearing count correction;
  do not require deletion or fabricated stock events.

Acceptance criteria:

1. Retiring and replacing a BOM line does not duplicate the requirement or consume its
   candidate availability.
2. A reserved spool increments allocated quantity and never increments depleted.
3. One optional requirement does not increment required totals.
4. A named delivery-only ESP32 with conditional compatibility remains **Check**.
5. A power supply without load/current and connector requirements is **Decide**, not
   **Source**.
6. Totals equal a recomputation from returned active rows in domain, database, HTTP,
   MCP and UI tests.

### `MPM-002` — One lifecycle and evidence model

**Priority:** P0

All surfaces use one project lifecycle:

```text
idea -> planned -> ready -> building -> validating -> complete -> archived
```

`blocked` is a derived condition with reasons, not a competing lifecycle value.
Project `ready` means the current plan can start; it does not mean print ready or
slicer validated.

Work-item progress is deliberately small:

```text
not_started | in_progress | blocked | done
```

Manufacturing evidence remains separate and revision/configuration-scoped:

```text
concept -> CAD complete -> DFAM reviewed -> mesh validated -> slicer validated
-> test printed -> fit/function verified -> production approved
```

Requirements:

- Project, project context, UI and MCP return the same lifecycle value.
- A project lifecycle change never implies a manufacturing evidence change.
- Evidence transitions cite the artifact, inspection or human attestation that allows
  the transition.
- Agents may record supplied evidence but cannot self-attest physical or production
  states.
- Migration maps legacy values without fabricating progress and preserves the original
  value in audit history.

Acceptance criteria:

1. A project cannot simultaneously read as `active`, `concept` and `idea`.
2. A mesh-validated printed-part revision can belong to a project that is still
   `planned`.
3. Physical states require a human evidence source and timestamp.
4. Context, list, detail, HTTP and MCP responses agree.

### `MPM-003` — Guided project setup with preview and commit

**Priority:** P0

Starting a project should require no more than three UI steps:

1. **Describe** — name the outcome in plain language or choose a safe template.
2. **Review** — inspect proposed work items, requirements, unknowns and stock matches.
3. **Create** — atomically commit the reviewed graph.

Agents use the equivalent `preview_project_setup` and `commit_project_setup`
operations. Granular create/update tools remain available for later edits.

Requirements:

- Templates cover printed part, printed assembly, electronics build and hybrid
  printed/electronics project.
- A preview may propose structure but must leave measurements, electrical limits,
  exact hardware, quantities and physical evidence unknown when not supplied.
- Preview performs normalization, field validation, gap evaluation and reservation
  preflight without changing durable state.
- Commit is atomic, idempotent and bound to the exact preview hash and inventory
  versions.
- Failure reports the field, recovery action, retryability and commit state.
- A successful response returns the complete created graph and next action.

Acceptance criteria:

1. A hybrid project with six work items and twenty-four requirements previews and
   commits in at most five logical agent calls after context refresh.
2. A child-write or reservation failure leaves no partial graph.
3. A stale inventory basis blocks commit and explains what to refresh.
4. The UI and MCP produce equivalent records from the same proposal.

### `MPM-004` — Useful project overview and work management

**Priority:** P1

The project page is the daily working surface. Its default view contains:

1. the project lifecycle and one next action;
2. Ready, Check, Decide and Source counts;
3. work items with progress and blockers;
4. the active build/configuration warning state;
5. recent artifacts/evidence;
6. close-out state when applicable.

Requirements:

- Provide bounded reads for project revisions, work items, work-item revisions,
  reservations/assignments, inspections, build plans and artifacts.
- The project context response is structured JSON plus an optional concise human
  summary. It includes current revision IDs, lifecycle, blocker counts and links or
  cursors for every child collection.
- Work items support the minimal owner, target date, acceptance statement and
  `blockedBy` fields defined in section 6.
- Creating, updating, retiring and restoring a record is available through both UI
  and agent tools when permitted by audit rules.
- The UI updates immediately after agent writes.

Acceptance criteria:

1. A fresh authorized client can rediscover the complete project graph from only the
   project ID.
2. No agent must retain an ID solely because no list operation exists.
3. The project overview renders without loading unbounded child collections.
4. A dependency cycle is rejected with an actionable error.

### `MPM-005` — Maker-aware inventory without a form explosion

**Priority:** P1

Keep the common inventory form short. Reveal a small profile section based on item
kind.

Minimum typed fields:

- **Packaged components:** package count, units per package, loose count and count
  basis.
- **Filament:** nominal/tare/current mass, lot/batch, sealed/open/dry state, placement
  and exact product/profile when known.
- **Electronics:** exact variant/part number, voltage/current/logic summary, connector
  or pinout reference, dimensions and measurement source.
- **Reusable equipment/tools:** condition, commissioning, installed setup,
  maintenance/calibration and shared/exclusive assignment.
- **Finishes/adhesives:** container amount, opened/expiry state, substrate evidence
  and safety note.
- **Fasteners/assortments:** size, length, head/material and usable count.

Requirements:

- Legacy records remain usable with an explicit generic/unknown profile.
- Package, individual-unit, mass and length conversions retain their evidence basis.
- A filament reservation may reserve grams without consuming the whole spool.
- A reusable printer/tool assignment never consumes or depletes the asset.
- The build configuration may reference BOM-selected inventory even when an exact
  catalog identity is not yet linked, but it must record the missing profile as an
  explicit blocker.
- Catalog identity remains separate from ownership and availability.

Acceptance criteria:

1. Two delivered packs of forty LEDs can become eighty physically counted units
   without rewriting the purchase provenance.
2. A 1 kg spool can reserve 320 g and reconcile consumed and leftover mass.
3. Assigning an H2D to a planned project leaves it available as a shared asset.
4. A build configuration can be saved as design-open with unprofiled filaments and
   cannot be marked release-closed.

### `MPM-006` — Inspection, reservations and sourcing

**Priority:** P1

The **Check** list is the bridge between uncertain records and an actionable project.

Requirements:

- Derive a deduplicated inspection queue from requirements, inventory evidence,
  compatibility and configuration unknowns.
- Each inspection asks one concrete question: count, weigh, identify, measure, check
  condition or confirm compatibility.
- Completing an inspection previews the evidence/stock change, requires human
  confirmation and then reevaluates affected requirements.
- Provide list/read operations for active and released reservations.
- Consumable reservations allocate canonical usable quantity.
- Reusable equipment uses an assignment mode with optional start/end dates and
  shared/exclusive intent; it does not become depleted.
- Release and reconciliation remain explicit and auditable.
- Source lists include only fully specified **Source** requirements.
- Offers retain supplier, URL, observed time, package quantity, source currency,
  shipping when known and match reason. They never imply a purchase.

Current delivery note: the application, HTTP routes, MCP tools, and web Project
Plan Checks panel provide the derived action list/read and preview-then-confirm
flow. Beginner mode shows the next three questions and expert mode keeps
canonical action, line/item versions, evidence, predicate, unit, and effects
visible. The surfaces share the same action, observation, evidence, and
staleness contracts, and parity tests cover the exposed HTTP/MCP behavior. This
slice is complete for MPM-006; later work may improve presentation or add
additional inspection kinds without changing the human-confirmation boundary.

Acceptance criteria:

1. Four requirements that need the same ESP32 inspection produce one check.
2. Confirming a physical count updates evidence and gaps without erasing delivery
   history.
3. Releasing a consumable reservation restores available quantity.
4. A shared printer assignment does not block an unrelated planning project.
5. **Decide** requirements never appear under “Buy”.

### `MPM-007` — Builds, files and validation evidence

**Priority:** P1

The product must connect project intent to exact files and manufacturing evidence
without executing those files or contacting hardware.

Requirements:

- Retain immutable build-configuration snapshots and add versioned multi-job/build
  plans for plates, parts, instances, materials, nozzles/sides, orientation, support,
  profile, routing and estimates.
- Add read-only validation of configurations and build plans before snapshot/release.
- Let the trusted client host attach one or many local files through opaque attachment
  handles. The model and BenchLedger never receive arbitrary host paths.
- Batch staging declares filename, role, size, SHA-256 and revision binding, then uses
  the existing short-lived header-bound transfer channel outside model content.
- A partial or hash-mismatched batch remains staged and cannot appear complete.
- Artifacts remain separate by role: source, STEP, STL/3MF, slicer project, toolpath,
  firmware, drawing, photo and validation.
- Recording a status transition binds the required artifact or human evidence.
- No operation executes, slices, prints, flashes or renders an uploaded file as code.

Acceptance criteria:

1. A synthetic 50-file project packet can be attached without exposing a host path,
   transfer token or base64 payload to the agent.
2. An eight-plate plan supports repeated parts and multiple material roles.
3. An unsliced setup project cannot advance to slicer validated.
4. A hash mismatch identifies the file and leaves the set incomplete.

### `MPM-008` — Straightforward agent contract and UI parity

**Priority:** P0 across every slice

Agent support is a first-class product surface, not a parallel automation layer.

Requirements:

- Make compact capability discovery the default and keep it below 12 KiB.
- Return a contract version/hash, tool families, resource templates, canonical units,
  states and approval boundaries without embedding every tool schema.
- Add bounded schema lookup for one tool and rely on MCP `tools/list` for callable
  schemas.
- Document the shortest safe sequence for beginner setup, inspection, build planning,
  artifact attachment and close-out.
- Use user vocabulary in tool names and descriptions.
- Keep tools atomic for incremental work; use preview/commit only where an atomic
  multi-record outcome is necessary.
- Every mutable entity has create, read/list, update and reversible retire/restore
  coverage. Immutable entities have create, read/list, supersede and retire coverage.
- Every UI action appears in `docs/capability-map.md` with its agent equivalent or an
  explicit human-only reason.
- Errors include code, message, field/path, retryability, commit state, correlation ID
  and a concrete recovery action. They never expose private internals.
- Mutating operations are idempotent and return created/changed IDs, versions and a
  bounded read-back summary.
- Project context and capability documents are cacheable and refreshable during long
  sessions.
- Agent writes appear immediately in the UI and in subsequent reads.

Acceptance criteria:

1. Default discovery is not truncated in supported clients.
2. An agent can ask for the schema of one operation without loading unrelated schemas.
3. Natural-language outcome tests prove the agent can perform every core UI workflow.
4. A stale-version error tells the agent to reread the exact record and does not imply
   that the write committed.
5. A parity test fails CI when a mapped UI action lacks a documented agent path.

## 9. UI information architecture

Retain a small primary navigation:

- **Projects**
- **Inventory**
- **Settings**

Offers, inspections, artifacts and build plans live inside their project or inventory
context. Do not add a top-level destination for every entity.

### Projects list

- One obvious **New project** action.
- Each row shows name, lifecycle, one blocker/readiness summary and last update.
- Search and filters are optional progressive controls.

### Project overview

- Outcome and lifecycle.
- One next-action card.
- Ready / Check / Decide / Source summary.
- Work items and blockers.
- Build/files summary.
- Recent evidence and close-out action.

### Project plan

- Requirements grouped by Ready, Check, Decide and Source.
- Inspection cards inline with affected requirements.
- Optional items visually separate from required items.
- **Details** expands compatibility, evidence, quantities, IDs and history.

### Inventory

- Existing bounded list and filters.
- Default rows show item, useful quantity, availability and location.
- Detail drawer contains provenance, profile, stock events, assignments and affected
  projects.

Use plain action copy: **Check this item**, **Add measurement**, **Reserve material**,
**Compare sources**, **Attach files**, **Record result**. Avoid terms such as aggregate,
ancestry, mutation or canonicalization in default UI copy.

## 10. Agent workflow

The documented default sequence is:

```text
discover compact contract (or reuse unchanged hash)
-> refresh context
-> preview project setup
-> user/agent reviews Ready, Check, Decide and Source
-> commit setup
-> list inspections and resolve confirmed observations
-> reserve consumables / assign reusable equipment
-> validate and save build configuration and plan
-> attach versioned files through the trusted host
-> record validation evidence
-> reconcile actual use and close
```

An agent may enter at any stage for an existing project. It must refresh and read the
current project graph rather than recreate it.

## 11. Approval and safety model

| Action | Default product behavior |
| --- | --- |
| Read, search, calculate, validate or preview | Perform immediately. |
| Create/edit a private draft project record after an explicit user request | Perform and report read-back. |
| Retire or restore a draft record | Preview impact; preserve audit and offer undo. |
| Record a physical count, measurement or compatibility result | Show the evidence change and require human confirmation. |
| Reserve stock or assign exclusive equipment | Show affected availability and require confirmation unless explicitly requested. |
| Commit reconciliation | Show the authoritative stock preview and require explicit confirmation. |
| Purchase, publish, deploy, print, heat, flash or assert physical/safety approval | Never perform without the separate required human authority; printer/purchase operations remain outside BenchLedger MCP. |

## 12. Success measures

- A first-time user can create a hybrid project, understand its blockers and identify
  the next action without opening expert details.
- A representative six-work-item, twenty-four-requirement project previews, commits
  and verifies in at most five logical agent calls after refresh.
- Every active readiness total reconciles exactly with returned rows.
- Retired lines, optional requirements and reservations pass named regression tests.
- A fresh client can rediscover every current project child through bounded reads.
- Compact discovery remains below 12 KiB and is cacheable by contract hash.
- The same synthetic end-to-end fixture passes through application, HTTP, MCP and web.
- No public fixture contains private inventory, paths, hosts, credentials, artifacts or
  supplier history.
- `npm run public:check` and `npm run check` pass for every release slice.

## 13. Delivery plan

Keep the implementation small and sequential. Each slice must leave the product
usable and independently reviewable.

| Slice | Outcome | Includes | Existing annex | Depends on |
| --- | --- | --- | --- | --- |
| `MPM-A` | Trust the numbers | `MPM-001` and lifecycle consistency | `REQ-004`, `REQ-007`, `REQ-008`, `REQ-009` | Existing domain/application model |
| `MPM-B` | Read and recover | Errors, compact discovery, graph and reservation reads | `REQ-001`, `REQ-002`, `REQ-005` | `MPM-A` |
| `MPM-C` | Start simply | Three-step setup, preview/commit and templates | `REQ-003`, `REQ-012` | `MPM-A`, `MPM-B` |
| `MPM-D` | Prepare the bench | Maker profiles, Decide, inspections and assignments | `REQ-006`, `REQ-007`, `REQ-008`, `REQ-011` | `MPM-A`–`MPM-C` |
| `MPM-E` | Build and prove | Build plans, batch attachments and validation | `REQ-009`, `REQ-010` | `MPM-D` |
| `MPM-F` | Finish the experience | Overview, accessible copy, parity and outcome tests | Cross-cutting | Continuous; final audit after `MPM-E` |

Do not combine all slices into one refactor. Each slice changes the shared application
behavior first, then adapts HTTP, MCP and web, updates documentation and adds the
smallest relevant migration.

## 14. Test strategy

### Deterministic contract tests

- Retired BOM exclusion and reservation allocation.
- Required versus optional totals.
- Evidence versus availability versus compatibility.
- Unit/package/mass conversion.
- Lifecycle and evidence transitions.
- Atomic preview/commit rollback and replay.
- Project ancestry, pagination and bounded outputs.
- Artifact hash, scope and path/token redaction.

### UI and parity tests

- One synthetic action-parity map is executable in CI.
- Every UI action has an agent outcome or a documented human-only reason.
- Beginner flow works by keyboard on desktop and mobile layouts.
- Expert details reveal the same facts available through HTTP/MCP.
- Agent changes appear without a manual full-page reload.

### Agent outcome tests

Use synthetic state and verify outcomes, not a prescribed sequence of tool calls:

- “Set up a small printed enclosure with an ESP32 and three LEDs. Do not buy or print.”
- “Tell me what I can reuse, what I need to check, what I must decide and what I need
  to source.”
- “Retire the duplicate LED requirement and recalculate the project.”
- “Show every reservation and explain why these spools are unavailable.”
- “Attach this CAD packet to the current revision without exposing my local paths.”
- “Record this supplied measurement without claiming the assembly passed.”
- “Continue this existing project from its current next action.”

Each test verifies the resulting shared application state, approval behavior and UI
read-back.

## 15. Documentation requirements

Each capability slice updates, when applicable:

- `docs/capability-map.md`;
- `docs/AGENTS.md` and `apps/mcp/AGENTS.md`;
- `skills/benchledger/SKILL.md` and lifecycle references;
- OpenAPI schemas and examples;
- UI help and plain-language copy;
- `docs/reference-project.md`;
- migrations, rollback notes and the public changelog.

Documentation must include:

- a five-minute beginner path;
- a concise agent quickstart;
- one full synthetic 3D plus electronics example;
- canonical states and their beginner labels;
- error/recovery examples;
- approval boundaries;
- UI-to-agent capability parity.

## 16. Definition of done

This PRD is complete only when:

1. The sanitized live-trial failures are permanent regression fixtures.
2. Active BOM and inventory calculations reconcile on every supported surface.
3. The UI and agent can preview, create, read, update, retire/restore and verify the
   same project outcomes.
4. A beginner can use the default project flow without understanding internal IDs or
   evidence vocabulary.
5. An expert can inspect the exact underlying evidence without exporting data.
6. The agent contract is compact, documented, cacheable and recovery-oriented.
7. Physical and external authority boundaries remain unchanged.
8. Focused checks, `npm run public:check` and `npm run check` pass.
9. A reviewer can trace every implemented change from `MPM-*` through code, tests,
   documentation and release notes.
