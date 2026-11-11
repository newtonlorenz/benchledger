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
section relevant to the current task. Read `benchledger://capabilities` once
when a session starts (or when the server's tools change); `tools/list` is the
authoritative input contract. Do not copy a static tool list into permanent
instructions and assume it will never change.

## Credential and scope setup

- Store bearer tokens in the client's secret/connector storage, never in this
  skill, a prompt, source control, logs, URLs, or artifact metadata.
- Server bearer tokens carry one of three coarse scopes: `read`, `write`
  (which implies read) or `admin`. MCP maps `read` to every `*:read` tool scope
  and `write` to every `*:read` and `*:write` scope; finer MCP scope names such
  as `bom:write` or `catalog:read` describe tool families but cannot be issued
  on their own. Give read-only planning agents a `read` token.
- The enforced narrowing is the project allow-list. Use it for a project
  agent: an allow-listed `write` token can change only its projects and
  cannot mutate shared inventory, categories, catalog products or offers, or
  read physical product profiles. If exact profile linkage matters, use a
  separate unscoped reader or ask the user; do not widen a project token
  automatically.
- Human approval is still required at the moment of purchase, publication,
  printer control, destructive deletion, credential change, deployment, or
  reconciliation commit. A capable client does not imply permission.

## Smoke evaluation

Before calling an integration ready, use synthetic data to check that the agent:

1. reads current state and separates confirmed stock from inspect-first evidence;
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

### Write retry keys

Every mutating tool accepts an optional `idempotencyKey` argument (8–200
printable characters). A host `Idempotency-Key` header is equivalent; if both
are sent they must be identical. Commands that need a key (for example
`save_build_plan`, `commission_inventory_item`, `remove_project`,
`commit_project_setup` and `commit_inspection_completion`) derive a
deterministic key from the tool, actor and canonical arguments when neither is
supplied, so an identical retry replays instead of duplicating. To repeat the
same logical write on purpose, pass a fresh `idempotencyKey`. Reusing a key with
a different payload returns `error.reason: "idempotency_conflict"`. The shipped
`scripts/mcp-http-client.mjs` bridge also supplies a header and keeps it for
unchanged unconfirmed retries. Read the current record before any retry; do not
recreate a write that already committed.

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

## Vocabulary

MCP outputs use the canonical application vocabulary everywhere: units `each`,
`gram`, `millimetre`, `millilitre`, `metre`, `set`; evidence
`physically_counted`, `commissioned`, `delivered_uncounted`,
`ordered_unverified`, `allocated`, `consumed`, `unknown`; condition `new`,
`good`, `worn`, `needs_repair`, `unknown`. Inputs also accept legacy aliases
(`piece` = each, `roll` = set, `physical_count`, `delivery`, `order`, `used` =
good, `opened` = worn) so older agents keep working. A delivery is not counted
stock. Do not infer compatibility from a name or catalogue record. Generic
documents are not validation evidence.
