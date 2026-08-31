# Contributing

Thanks for helping make BenchLedger more useful to people building 3D-printing,
CAD, electronics, and mixed maker projects.

The project is pre-release. Small, outcome-focused changes are easiest to review;
discuss a large schema, protocol, or architecture change in an issue first.

## Before you start

- Use synthetic data only. Never attach a real inventory database, order record,
  project file, token, or private export to an issue or pull request.
- Preserve evidence and provenance. Corrections should add history rather than
  silently rewriting stock events or audit records.
- Keep UI and MCP outcomes aligned, or document why an action is intentionally
  human-only.
- Keep purchasing, publication, destructive cleanup, printer control, and
  physical validation behind explicit human approval.
- Prefer a clear beginner path with expert evidence available nearby.

## Local setup

Requirements: Node.js 24 LTS and npm 11 or later.

```bash
npm ci
npm run dev
```

The development server uses synthetic demo data at
`http://127.0.0.1:8792`.

## Branch and integration workflow

Use a local branch for each contribution and keep `main` aligned with the public
GitHub default branch. Do not push a branch, open a pull request, publish a
package, deploy, or change remote infrastructure until the maintainer explicitly
approves that external action.

The expected lifecycle is local development, focused local verification, optional
read-only smoke checks against the configured private LAN Docker development/test
deployment, then a GitHub pull request. Treat that LAN deployment as an
integration target only; it is not production evidence. Never include its exact
host address, credentials, private data directory, database, artifacts, logs, or
environment file in commits, issues, pull requests, or screenshots.

See [`docs/development-workflow.md`](docs/development-workflow.md) for the full
operator workflow.

## Agile testing

Use the smallest useful check while iterating:

| Change | Useful check |
| --- | --- |
| Documentation, metadata, community files | `npm run public:check` |
| Focused Vitest files | `npx vitest run packages/domain/src` (replace the path) |
| Type or contract changes | `npm run typecheck` |
| UI behavior | the focused web test plus the affected Playwright flow |
| Domain, authorization, storage, imports | focused invariant and failure-path tests |
| HTTP, MCP, runtime, Docker, auth, artifacts, deployment behavior | focused local checks plus read-only LAN development/test smoke checks when configured |

Write tests first when a rule is risky or a regression would be expensive.
Coverage is a signal for critical domain, security, artifact, and data-integrity
code—not a reason to add low-value tests to presentation or glue code.

Before requesting a release or merge, run the full gate once:

```bash
npm run check
```

## Pull requests

Keep the description practical:

- the user or agent outcome;
- the focused tests you ran;
- the full `npm run check` result;
- the remote integration result, or why it was not run;
- privacy/security impact;
- migration and rollback considerations;
- UI/MCP capability-map changes, if any.

Use conventional commit subjects where practical, for example
`feat: add filament profile suggestions` or `fix: reject stale reconciliation`.

By submitting a contribution, you agree that it is licensed under the project's
[Apache License 2.0](LICENSE).
