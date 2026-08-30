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

## Agile testing

Use the smallest useful check while iterating:

| Change | Useful check |
| --- | --- |
| Documentation, metadata, community files | `npm run public:check` |
| One workspace | `npm test --workspace=<workspace>` |
| Type or contract changes | `npm run typecheck` |
| UI behavior | the focused web test plus the affected Playwright flow |
| Domain, authorization, storage, imports | focused invariant and failure-path tests |

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
- privacy/security impact;
- migration and rollback considerations;
- UI/MCP capability-map changes, if any.

Use conventional commit subjects where practical, for example
`feat: add filament profile suggestions` or `fix: reject stale reconciliation`.

By submitting a contribution, you agree that it is licensed under the project's
[Apache License 2.0](LICENSE).
