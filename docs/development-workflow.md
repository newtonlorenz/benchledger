# Development and contribution workflow

BenchLedger changes move through four distinct stages: local development, local
verification, maintainer integration testing, and a GitHub pull request. A pass
at one stage does not imply the next stage has occurred.

## 1. Develop locally

Use Node.js 24 and npm 11 or later. Start from current `main` and create a small,
descriptive branch; do not develop directly on `main`.

```bash
git status --short --branch
git switch main
git pull --ff-only
git switch -c feat/short-outcome
npm ci
```

In an isolated worktree, update the worktree's base through the repository's
normal Git workflow instead of switching a branch that is already checked out
elsewhere. Preserve unrelated local changes.

Use synthetic data for development and tests. Real instance data, private host
details, credentials, databases, artifacts, logs, and backups remain outside
the checkout.

Browser authentication has two explicit modes. A fresh no-hash development or
trusted-LAN install starts in `lan_open`; this removes the browser password but
does not protect a reachable service from other devices on that network. An
administrator can select `password` in Settings and set a workspace password.
Demo mode remains password-protected. Existing installations with
`BENCHLEDGER_ADMIN_PASSWORD_HASH` remain password-protected while that hash is
imported into durable settings once; the durable setting wins on later starts.
Changing the browser mode or password invalidates existing browser sessions.
These settings affect browser sessions only: MCP still requires a scoped
bearer token at `/api/v1/mcp`.

## 2. Verify locally

Run focused checks while iterating, then the public-source and full gates before
requesting review:

```bash
# Examples of focused checks
npx vitest run packages/domain/src
npm run typecheck

# Mandatory before sharing a branch
npm run public:check

# Mandatory before requesting review
npm run check

# Only when the mobile app, API contract or lockfile changed (slow Expo export)
npm run check:mobile
```

`npm run check` runs the public-source checks, builds every package and the
server apps (`build:server`: web, MCP, import CLI and server), typechecks all
workspaces including the mobile app, enforces the Vitest coverage thresholds,
and runs the Playwright flows. It no longer runs the Expo mobile export; use
`npm run check:mobile` (or `npm run build`, which builds everything) for that.
Review the final diff and status as a separate step; a green test does not
prove private files were excluded.

`npm run public:check` scans the files Git would publish: tracked files plus
untracked files that are not ignored by `.gitignore`, `.git/info/exclude` or a
global excludes file. Keep private notes in an ignored or locally excluded
path. Without Git (for example in an exported archive) it falls back to scanning
the whole directory tree.

Demo mode and most server integration tests run the real SQLite runtime
(`createDemoRuntime` in `@benchledger/runtime`): an in-memory SQLite database
and a temporary artifact directory that is removed on close, seeded with the
synthetic workspace in `packages/runtime/src/demo-seed.ts`. There is no
separate in-memory rule implementation; add demo content to that seed. The
only demo-specific behaviour is presentation order: demo projects are listed
in creation order so the reference project opens first.

Playwright runs two projects. `desktop-chromium` is the full suite on one worker
against a shared in-memory demo server; specs depend on file-name ordering
(the `zz-` prefixes), so do not rename them casually. `mobile-chromium-smoke`
runs a small read-mostly subset under Pixel 7 emulation against its own demo
server on port 8795. On CI each test is retried once and the retry records a
trace.

## 3. Test the remote Docker integration

The maintainer integration service is a private development/test deployment. It
is not production and is not a public demo. Its base URL and any scoped test
credentials are provided out of band and must not be committed, pasted into an
issue, or captured in a public test artifact.

Begin with the unauthenticated, read-only readiness checks:

```bash
export BENCHLEDGER_INTEGRATION_BASE_URL=http://private-test-host:8792
curl --fail --show-error --silent \
  "$BENCHLEDGER_INTEGRATION_BASE_URL/api/v1/health"
curl --fail --show-error --silent \
  "$BENCHLEDGER_INTEGRATION_BASE_URL/api/v1/ready"
```

Confirm the reported service identity/version and the local commit under test.
Reachability is not revision parity. Authenticated or state-changing integration
tests require explicit maintainer approval, least-privilege credentials, and
synthetic isolated records with a documented cleanup plan.

When checking authentication behavior, keep the scenarios separate: verify
browser `lan_open`/`password` behavior and session invalidation, then verify
that `/api/v1/mcp` rejects a request without a scoped bearer token in both
browser modes. Do not treat a successful browser request as evidence that an
agent may use MCP.

Do not deploy, rebuild, restart, exec into, migrate, import, restore, prune, or
otherwise alter the remote container or host as part of routine integration
testing. Do not read remote secrets, environment variables, databases, volumes,
artifacts, or backups.

Capture only non-sensitive evidence: local commit, test deployment role,
endpoint paths checked, HTTP outcomes, reported application version, focused
scenario result, and timestamp. State clearly when remote integration was not
run.

If a password-managed deployment is rolled back to code from before durable
browser settings, restore `BENCHLEDGER_ADMIN_PASSWORD_HASH` from the private
secret store before starting the older code. Older code cannot read a
Settings-managed password or browser mode. Verify the resulting browser session
behavior after rollback.

## 4. Contribute through GitHub

Push the reviewed branch only when authorized, then open a pull request into
`main`. The PR should include:

- the user or agent outcome;
- focused checks and the final `npm run check` result;
- remote integration evidence, or why it was not run;
- privacy and security impact;
- schema, migration, deployment, and rollback considerations; and
- UI/MCP/capability-map documentation changes where relevant.

GitHub CI runs these workflows:

| Workflow / job | What it proves | Required |
|---|---|---|
| `check / public check, typecheck and audit` | privacy and public-release scan, package build, all workspace typechecks (including mobile `tsc --noEmit`), strict `npm audit --omit=dev` for every workspace in the server image, and a whole-tree production audit that fails on high or critical advisories | yes |
| `check / unit tests and coverage` | Vitest with the 80% coverage thresholds; uploads JUnit and coverage | yes |
| `check / browser end-to-end` | Playwright desktop suite and mobile smoke; uploads the report and traces on failure | yes |
| `check / container image build and smoke` | `deploy/Dockerfile` builds, the demo container answers `/api/v1/health`, the image `HEALTHCHECK` turns healthy, it runs as UID 10001 and ships no sources, mobile app or Vite | yes |
| `dependency-review` | no new moderate-or-worse advisories in the PR's dependency diff | yes |
| `codeql / analyze (javascript-typescript)` | CodeQL `security-extended` queries; also weekly | recommended |
| `mobile / expo export` | Expo export for iOS and Android; runs only when `apps/mobile`, the API contract, `package.json` or the lockfile change | no (path-filtered) |

The single `test` job was split into the four `check` jobs above; update branch
protection to require them instead of `test`. Expo/mobile build tooling
advisories below high severity are reported by the whole-tree audit but do not
fail CI, because that toolchain never ships in the server image; high and
critical advisories anywhere in production dependencies still fail. All
actions are pinned by commit SHA with a release comment; Dependabot proposes
action and base-image updates.

The required checks must pass. Merge and
deployment are separate decisions; merging a contribution does not authorize a
remote deployment or package release.

## Dependency updates

Vite and its React plugin are build-time `devDependencies` of `apps/web`; the
server image ships only the compiled `apps/web/dist`. Keep them in one update, and Vitest and its coverage provider
in another coordinated update. Node type definitions stay on major 24 to match
the supported runtime. Dependabot groups these toolchains and ignores Node type
major updates until the runtime is deliberately upgraded.

The Zod 4 package is installed, but existing contracts deliberately import
`zod/v3`. This compatibility entry point preserves validation and generated MCP
schemas. A future switch to Zod 4 schema semantics needs its own contract review.
