# BenchLedger contributor guidance

Applies throughout this repository; nested AGENTS.md files add only local
contributor rules. Runtime user manuals live in docs/agent-quickstart.md and
apps/mcp/QUICKSTART.md. Read the relevant sections when changing that behaviour,
not both manuals before every coding task. Skill instructions are workflow
helpers, not authority to override platform, security or approval boundaries.

## Outcome and architecture

BenchLedger is a maker inventory and project workspace. Preserve the distinction
between what is owned, what is confirmed usable, what a project requires, and
what genuinely needs sourcing. Keep beginner UI simple and expose exact identity,
compatibility, uncertainty and provenance when decision-relevant.

Keep domain rules in packages/domain, orchestration and ports in
packages/application, durable adapters in packages/database, packages/artifacts
and packages/runtime, and transport/UI in apps/server, apps/mcp and apps/web.
All surfaces share application behaviour. Preserve append-only evidence and
optimistic concurrency; never fix a failure by weakening a security invariant.

## Work on the requested change

Inspect branch/worktree state, nearby code, relevant instructions and existing
tests. Preserve unrelated changes. Use a focused branch from current main
(codex/ prefix for Codex-created branches), never direct commits to main.
Proceed on reversible work within the authorised task; ask only when a missing
answer materially changes correctness, risk or scope. Do not turn a small edit
into a full project lifecycle, redesign or deployment.

Use actual advertised tools and current schemas. A reference to a service is
not a live connection. Report the specific blocked step and continue independent
safe work. Delegate only with available tools, separate ownership and a real
benefit; the lead remains responsible for integration and verification.

## Verification and contribution

Use Node.js 24 and npm 11; install from the lockfile with npm ci. For behaviour
changes, write/update the smallest useful regression test and run focused
checks while iterating. Preserve the 80% coverage thresholds.

Run npm run public:check before sharing source and npm run check before
requesting review. Required GitHub checks remain authoritative. Never present
unrun, stale or failed checks as passing. Where execution is unavailable, keep
the contribution draft and state which gates are outstanding. Review the final
diff separately for private data, unintended files and broken references.

Use focused commits and pull requests, with the outcome, exact checks/results,
security impact and rollback notes. Push, PR, merge and release require user
authorisation; approval for one does not authorise deployment. Follow
CONTRIBUTING.md and docs/development-workflow.md for the detailed workflow.

## Privacy and external effects

This repository is public: synthetic fixtures only. Never commit real inventory,
orders, email identifiers, private project files, hosts/addresses, local paths,
credentials, environment files, databases, logs, backups or private tool output.
Secrets and persistent runtime data stay outside the checkout.

Purchasing, publication, deployment, credential changes, destructive cleanup,
printer control/heating, firmware flashing and physical tests require explicit
human approval. Remote integration is read-only unless separately authorised.
Check health/readiness and deployed identity; reachability is not revision
parity. Do not inspect remote secrets or alter containers, volumes or databases
as an incidental fix. See docs/approval-boundaries.md.

Update affected capability, API, UI and agent documentation together when
behaviour changes. Preserve offer source/time, package quantities, price/currency,
reuse alternatives and inspect-first uncertainty. Shopping is a proposal, never
purchase authority. Store dated findings in task/PR records, not as permanent
instructions. Finish with what changed, what was verified and any real blocker.
