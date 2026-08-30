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
