# `@benchledger/application`

The application package is the boundary between the HTTP/MCP surfaces and the
domain, database, and artifact implementations. It owns no persistence and
does not know about Fastify, SQLite, filesystem paths, or model providers.

Adapters implement `ApplicationPorts` and translate their native records into
the API contract types. In particular:

- `InventoryPort` must return `availableQuantity` only for physically counted
  or commissioned stock. Delivered or ordered quantities remain in
  `quantity` and are evaluated as `inspect_first`.
- `ProjectPort.createReservation` must make the reservation and stock balance
  change atomically. It must reject over-allocation and retain a compensating
  release/usage history.
- `ArtifactPort` owns streaming, path containment, quota, hashing, and durable
  storage. Callers only receive logical IDs and short-lived upload URLs.
- Every mutating port operation is wrapped by `ApplicationService`, which
  appends an audit event, publishes an SSE state event, and stores an
  idempotent result when `Idempotency-Key` is present.

Ports use plain serializable values. The only adapter is the SQLite runtime in
`@benchledger/runtime`; demo mode runs it on an in-memory database. The
service intentionally does not fetch supplier URLs, execute CAD/G-code, or
infer physical consumption.

## Module layout

`ApplicationService` (`src/service.ts`) is a thin facade with a stable public
API. Each use-case area lives in `src/service/` and extends `ServiceModule`,
sharing the ports, the audited `CommandRunner` (`command-runner.ts`: unit of
work, idempotent replay, audit, post-commit events) and the project ancestry
guards (`project-access.ts`):

| Module | Responsibility |
|---|---|
| `inventory.ts` | items, categories, stock events, counts, commissioning |
| `catalog.ts` | catalog products and inventory product profiles |
| `build-configurations.ts` | hashed build-configuration snapshots |
| `projects.ts` | projects, lifecycle, work items, revisions |
| `project-setup.ts` | review-first setup preview/commit |
| `bom.ts` | BOM lines and the revision gap evaluation entry point |
| `gap-evaluation.ts` | pure BOM candidate matching and gap/allocation calculation |
| `bom-rules.ts` | pure BOM constraint, specification and write canonicalization rules |
| `reservations.ts` | reservations and usage |
| `inspections.ts` | inspect-first queue preview/commit |
| `reconciliation.ts` | close-out drafts and commits |
| `offers.ts`, `artifacts.ts`, `workspace-security.ts` | offers, artifact transfer, workspace access |
| `shared.ts` | small shared helpers (paging bounds, inventory scan, ids) |

Whether an evidence state counts as available stock is decided in one place:
`classifyEvidenceAvailability` / `isConfirmedEvidence` in
`@benchledger/domain` (`packages/domain/src/evidence.ts`). The service modules
and the SQLite runtime's stock projection both call it.
