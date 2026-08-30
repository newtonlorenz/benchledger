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

Ports use plain serializable values so a future SQLite adapter and the demo
adapter can be tested against the same service. The service intentionally does
not fetch supplier URLs, execute CAD/G-code, or infer physical consumption.
