# MCP contributor scope

The root AGENTS.md applies. This file governs changes to apps/mcp, not ordinary
use of a connected BenchLedger instance. The runtime manual formerly here is
preserved in [QUICKSTART.md](QUICKSTART.md).

Keep the adapter a transport over the shared application service; do not add
shell, SQL, arbitrary-path, credential or implicit transfer capabilities. Read
the relevant capability definitions, validation, adapter and regression tests
before changing a command. Preserve scopes and durable project-ancestry checks,
expected versions, idempotency and atomic preview/commit boundaries. Browser
LAN access must never imply MCP bearer authorisation.

Keep resource/tool schemas, unit mapping and error semantics consistent with
HTTP/application behaviour. Update ../../docs/capability-map.md and the affected
QUICKSTART.md and skill reference sections when a contract changes. Read only
the sections relevant to the task. Run focused adapter/protocol/validation and
security tests, then the root contribution gates; do not exercise a live write
or remote deployment without its separate approval.
