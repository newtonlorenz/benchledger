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
```

`npm run check` builds every package and app, typechecks all workspaces, enforces
the Vitest coverage thresholds, and runs the Playwright flows. Review the final
diff and status as a separate step; a green test does not prove private files
were excluded.

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

GitHub's required `test` and `dependency-review` checks must pass. Merge and
deployment are separate decisions; merging a contribution does not authorize a
remote deployment or package release.
