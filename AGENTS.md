# BenchLedger contributor-agent guidance

These instructions apply to the whole repository. The nested `docs/AGENTS.md`
and `apps/mcp/AGENTS.md` files describe how an agent uses BenchLedger; read them
when changing MCP capabilities or agent-facing behavior.

## Project boundaries

BenchLedger is a beginner-friendly through expert-capable maker inventory and
project-planning tool for 3D-printing and electronics work. Every product change
should help answer: what does the user have, what does a project need, what can
be reused, and what genuinely needs to be bought? Preserve agent-readable
context for equipment, accessories, consumables, and electronic parts; sourced
shopping proposals; explicit evidence and provenance; and progressive
disclosure so expert IDs, dimensions, compatibility, uncertainty, and history do
not crowd the default UI.

BenchLedger is a TypeScript modular monolith. Keep domain rules in
`packages/domain`, orchestration and ports in `packages/application`, durable
adapters in `packages/database`, `packages/artifacts`, and `packages/runtime`,
and transport/UI concerns in `apps/server`, `apps/mcp`, and `apps/web`. The web,
HTTP, and MCP surfaces must share application behavior instead of bypassing it.

This is a public repository. Use synthetic fixtures only. Never commit private
inventory, projects, artifacts, supplier or order history, email identifiers,
hostnames or private addresses, local filesystem paths, credentials, tokens,
environment files, databases, logs, backups, or remote-service output that
contains private data. Plaintext secrets belong in a local secret store; runtime
configuration and persistent data stay outside the checkout.

Preserve append-only evidence and audit history. Keep purchasing, publication,
deployment, credential changes, destructive cleanup, printer control, firmware,
heating, and physical validation behind explicit human approval.

## Required lifecycle

1. **Local development**
   - Start by reading `git status`, the current branch/worktree state, and the
     instructions nearest the files you will change.
   - Work on a focused branch from current `main`; Codex-created branches use the
     `codex/` prefix. Do not commit directly to `main`.
   - Use Node.js 24 and npm 11. Install exactly from the lockfile with `npm ci`.
   - Write or update the smallest useful test before implementation for behavior
     changes. Preserve the repository's 80% coverage thresholds.
2. **Local verification**
   - During iteration, run the focused workspace/unit/type/browser check that
     covers the change.
   - Run `npm run public:check` before any branch is shared. It is a mandatory
     privacy and public-source gate, not a substitute for tests.
   - Run `npm run check` before requesting review. It builds all packages/apps,
     typechecks, runs coverage-gated Vitest tests, and runs Playwright flows.
   - Review `git diff` and `git status`; confirm generated output and private
     runtime files are absent.
3. **Remote Docker integration testing**
   - The maintainer-provided LAN endpoint is a development/test deployment, not
     production. Its base URL and credentials are private configuration supplied
     out of band; never add them to tracked files or public reports.
   - First check the public `/api/v1/health` and `/api/v1/ready` endpoints. A
     healthy response proves service reachability and dependency readiness only;
     it does not prove the deployed revision matches the local branch.
   - Treat the remote service as read-only unless the user explicitly approves a
     scoped integration mutation. Use synthetic, isolated records and least-
     privilege credentials for approved authenticated tests.
   - Do not run remote `docker compose up/down/build`, restart, exec, prune,
     migration, import, restore, or deployment commands without explicit user
     approval. Do not inspect or copy remote environment variables, credentials,
     databases, volumes, artifacts, or backups.
   - Record the local commit, endpoint role, checks performed, and observed
     service identity/version. Report legacy or mismatched deployment identity;
     do not silently redeploy it.
4. **Open-source contribution**
   - Keep commits focused and use conventional subjects where practical.
   - Contributions flow through a branch and pull request. Never push, publish,
     open or merge a pull request, create a release, or change GitHub settings
     without explicit user approval.
   - The PR must state outcome, focused and full checks, remote integration
     evidence or why it was not run, privacy/security impact, and migration or
     rollback notes. Required GitHub checks remain authoritative.

## Documentation and capability parity

Update `docs/capability-map.md`, the relevant agent quickstart, OpenAPI-facing
behavior, and UI documentation together when a capability changes. Keep the
beginner path clear while preserving exact evidence for expert use. Shopping
lists must retain source, observation time, package quantity, price/currency,
reuse alternatives, and inspect-first uncertainty; they are proposals, never
purchase authority. Deployment examples must remain generic and safe for public
source; maintainer-specific hosts and credentials belong only in private
configuration.
