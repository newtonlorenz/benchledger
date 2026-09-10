# Client setup and packaging

BenchLedger exposes one model-neutral MCP contract. ChatGPT, Claude, Codex, and
other clients should use the same evidence rules and application operations;
only their skill-installation and MCP-connection surfaces differ.

## Skill-capable clients

Install the complete `skills/benchledger/` folder so `SKILL.md`, its references,
and `agents/openai.yaml` remain together. Keep normal automatic discovery unless
the user explicitly requests explicit-only invocation. The skill declares a
dependency on an MCP server named `benchledger`.

## MCP-only or project-instruction clients

Connect the BenchLedger MCP endpoint, then provide the `SKILL.md` body as
project/workspace instructions. Preserve the reference files or inline only the
section relevant to the current task. Always start live work by reading
`benchledger://capabilities`; do not copy a static tool list into permanent
instructions and assume it will never change.

## Credential and scope setup

- Store bearer tokens in the client's secret/connector storage, never in this
  skill, a prompt, source control, logs, URLs, or artifact metadata.
- Prefer the least scope needed. Read-only project planning should not receive
  global write authority.
- Use project allow-listing for a project agent. Shared catalog/profile and
  inventory mutations remain global operations and require their own scopes.
- Physical inventory product-profile reads are also workspace-global and are
  rejected for project-scoped tokens, even with `catalog:read`. If exact
  linkage matters, use a separate authorized global catalog reader or ask the
  user to confirm it; do not expand a project token automatically.
- A project-scoped close-out uses `bom:read`/`bom:write`; it does not grant
  general `inventory:write`.
- Human approval is still required at the moment of purchase, publication,
  printer control, destructive deletion, credential change, deployment, or
  reconciliation commit. A capable client does not imply permission.

## Smoke evaluation

Before calling an integration ready, use synthetic data to check that the agent:

1. refreshes context and separates confirmed stock from inspect-first evidence;
2. does not turn a catalog match or delivery record into physical availability;
3. creates a revisioned BOM and explains gaps before proposing purchases;
4. preserves exact printer/filament/build configuration and artifact hashes;
5. saves and explains a reconciliation preview without committing it;
6. asks for explicit confirmation before the atomic close-out commit;
7. never exposes tokens, invents physical test results, or claims to have bought
   or printed anything.

Run evaluations against an isolated synthetic instance. Do not forward-test a
write-capable skill against private production inventory without explicit user
authorization.

## Verified host connection

A skill is not a connection. A client must complete MCP initialisation and
`tools/list` with a credential authorised by the server before any work is
attributed to live MCP. Browser LAN access is not a substitute.

A host with Node.js 24 can run `scripts/mcp-http-client.mjs --config <private-file>`
for stdio clients. The private file contains the exact MCP endpoint, bearer token
and (only for a trusted private HTTP LAN) `allowInsecureLan: true`. It must be a
regular file owned by that user with mode 0600. Keep it outside the repository.
The bridge sends credentials only to the fixed endpoint, refuses redirects and
makes no automatic retries. Unconfirmed unchanged commands reuse their key in
that running connection; after a restart, re-read state before a new write.

Register only the intended project in the server token allow-list. A restricted
project token can update that project but cannot create a new workspace-global
project or change shared inventory. Project setup that creates new identities
requires a separately authorised creator, not a silently widened project token.
Keep the installed skill folder in sync with its versioned repository copy.
An installed skill does not include the repository's `apps/`, `docs/` or
`scripts/` directories. Resolve those paths from an available BenchLedger
checkout root, not relative to this installed folder. Without a checkout, use
the [MCP quickstart](https://github.com/newtonlorenz/benchledger/blob/main/apps/mcp/QUICKSTART.md)
and [maker workflow contract](https://github.com/newtonlorenz/benchledger/blob/main/docs/maker-workflows.md)
as references, verifying availability against the connected server.

### Build-plan writes and retry keys

`save_build_plan` requires an 8–200 character idempotency key in the transport
context. Use the shipped `scripts/mcp-http-client.mjs` bridge (or its exported
`createForwarder` / `runStdioBridge`) for host clients; it supplies the required
HTTP header and retains the same key for unchanged unconfirmed retries. A raw
stdio-to-HTTP proxy that only forwards JSON can omit this context and cause an
opaque `INVALID_ARGUMENT` even when the plan satisfies its schema. Do not add
an unsupported key field to the tool arguments or invent a different payload.
Check the host transport and read the current plan before any retry; do not
recreate a plan that already committed.

Unsliced plans can omit plate material rows and times, leaving estimates
unknown. Structured material rows require positive grams and filament inventory
recorded in grams. A spool count does not prove remaining mass; record unknown
filament choices in notes until supported measurements or slicer estimates are
available. Do not convert spool counts into invented gram balances.

## Host file transfer

Generic MCP cannot transfer general project file bytes. An explicit user request
to upload, attach or sync named CAD, STEP, Bambu/3MF or supporting build files to
an identified private BenchLedger project supplies transfer authorisation once.
Use the exact accepted payload and revision; do not widen this to other files,
projects or services. Creating a build plan alone does not imply file transfer.
Host filesystem/execution access must also be available under platform rules.
With that access and a BenchLedger checkout, run
`node scripts/artifact-transfer.mjs --help` from that checkout root.
Use the current helper's arguments and environment credentials, never credentials
in arguments or MCP messages. Choose one explicit file, project and role, and
one exact project revision or work-item/revision pair. Upload requires media
type; download requires artifact identity. The helper verifies SHA-256/length,
refuses redirects and download overwrites, and returns metadata only. It does
not provide generic MCP filesystem access. After interrupted finalization,
inspect the revision before repeating an upload; there are no automatic retries.
Without host access, use the authenticated browser Files surface.

## Schema dialects

Use the advertised schema for each tool. Legacy item and quantity tools use
`piece` and evidence labels such as `physical_count`, `delivery` and `order`.
The atomic setup, quote, build-plan and close-out contracts use canonical
application units such as `each`. A delivery is not counted stock. Do not copy
REST evidence labels into legacy MCP input fields, or infer compatibility from
a name or catalogue record. Generic documents are not validation evidence.
