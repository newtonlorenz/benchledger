# Deployment

BenchLedger's initial reference deployment is a single-user installation on a
trusted LAN. It uses one application container and one private persistent data
directory outside the source checkout.

## Browser access mode

The browser workspace supports two administrator-controlled modes:

- `lan_open` does not ask for a workspace password when creating a browser
  session. This is not an authentication boundary: anyone who can reach the
  configured interface and port can use the browser workspace as an
  authenticated user, including write actions available to that session. Use
  it only on a trusted LAN; never expose it to the public internet or an
  untrusted network.
- `password` requires the configured workspace password for browser sessions.

These modes affect browser sessions only. The `/api/v1/mcp` endpoint always
requires a scoped bearer token; LAN reachability and a browser session never
grant MCP access. Changing the mode or workspace password invalidates existing
browser sessions and requires the browser to sign in again. Credential and
authentication-setting changes remain explicit human-approval actions.

## Development/test integration

A maintainer may keep a private LAN Docker deployment available for integration
testing. Treat that endpoint as a development/test target, not production. It is
appropriate to run read-only smoke checks such as `/api/v1/health`,
`/api/v1/ready`, `/api/v1/capabilities`, OpenAPI retrieval, and authenticated
read-token MCP discovery when credentials are already configured in the caller's
secret store.

For end-to-end acceptance, test the two entry points independently: people use
the browser workspace (`lan_open` or a password entered in the UI), while agents
use scoped MCP bearer tokens. Browser automation may exercise authenticated UI
flows with synthetic records, but credentials must come from the runner's secret
store and must not appear in commands, URLs, screenshots, traces, or logs.

Do not record the exact host address in source-controlled files. Do not restart
containers, rebuild images, run imports, mutate data, rotate credentials, change
Compose files on the host, or inspect private volumes unless the maintainer gives
explicit approval for that action.

## Before deployment

1. Build and test from a clean checkout.
2. Create a private data directory with restricted ownership.
3. Generate a high-entropy session secret, for example
   `openssl rand -base64 48`. Startup refuses the `.env.example` placeholder
   and obviously low-entropy values (fewer than 12 distinct characters). For a fresh trusted-LAN install,
   leave `BENCHLEDGER_ADMIN_PASSWORD_HASH` unset to initialize the browser in
   `lan_open` mode. To initialize password protection, provide a built-in
   scrypt admin password hash generated with `hashAdminPassword` from
   `apps/server/src/auth.ts`; if an Argon2id hash is required, the host must
   supply a tested `passwordVerifier` adapter because the default server does
   not pretend to verify Argon2id.
4. If upgrading an installation that already has
   `BENCHLEDGER_ADMIN_PASSWORD_HASH`, keep it configured for the first startup
   after the upgrade. The existing installation remains password-protected and
   imports that hash into durable settings once. After initialization, the
   durable Settings value wins; manage the browser mode and password there.
   Keep the hash in the private secret store, never in source control or logs.
5. Set a storage quota below the host's safely available capacity.
6. Bind the port to the intended LAN interface only. In the example Compose
   file, set `BENCHLEDGER_BIND_ADDRESS` to that exact address; the safe default
   is loopback and no public LAN address is hardcoded.
7. Set `BENCHLEDGER_PUBLIC_BASE_URL` to the exact HTTP(S) origin used by the
   authenticated browser/host transfer flow (for example
   `http://benchledger.local:8792`). It must not contain a path, credentials,
   query, or fragment; the server never trusts a request Host header when
   constructing transfer links. Generic MCP does not receive this origin or
   any transfer credential. This host is also the Host allow-list: requests
   whose `Host` header is not this host, a loopback name (`localhost`,
   `127.0.0.1`, `[::1]`) or an entry in `BENCHLEDGER_ALLOWED_HOSTS` receive
   `421 host_not_allowed`. This blocks DNS-rebinding attacks against
   `lan_open` mode. If people reach the instance by more than one name (for
   example both `benchledger.local` and a LAN IP address), list the extra
   names, without scheme or port, in `BENCHLEDGER_ALLOWED_HOSTS`.
   Behind a reverse proxy the Host check sees whatever `Host` the proxy sends
   upstream. Forward the original Host (nginx: `proxy_set_header Host $host;`;
   Caddy's `reverse_proxy` does this by default), or list the upstream name the
   proxy uses (for example a Docker service name such as `benchledger`) in
   `BENCHLEDGER_ALLOWED_HOSTS`. External health probes that call the container
   by its service name need the same entry; the bundled container healthcheck
   calls `127.0.0.1` and is always allowed. A `421` from a working proxy almost
   always means the Host is not being forwarded.
8. Leave `BENCHLEDGER_SECURE_COOKIES` unset to derive it from the public base
   URL: an `https://` origin issues `Secure` cookies, plain-HTTP LAN origins do
   not. Set it explicitly to `true` or `false` only to override that default.
   With an `https://` public base URL, a browser reaching the server over plain
   HTTP (for example a LAN IP listed in `BENCHLEDGER_ALLOWED_HOSTS`) cannot keep
   a session, because it will not store or send `Secure` cookies over HTTP. Use
   HTTPS for that address too, or set `BENCHLEDGER_SECURE_COOKIES=false`
   accepting that session cookies then travel unencrypted on the network.
9. Leave `BENCHLEDGER_TRUST_PROXY` unset (or `false`) unless a reverse proxy
   sits in front of BenchLedger. Set it to the number of proxy hops (usually
   `1`) or to a comma-separated list of proxy IPv4/IPv6 addresses/CIDRs
   (`loopback`, `linklocal` and `uniquelocal` are also accepted); any other
   entry stops startup with an error naming it. Only then are
   `X-Forwarded-For` addresses used for login rate limiting; trusting every
   forwarder would let a client spoof its address. The legacy value `true` now
   means one hop (the nearest proxy), not every forwarder. Login limits are
   per address; a workspace-wide failure ceiling only slows logins (see
   [SECURITY.md](../SECURITY.md)). Counters are in memory and reset on restart.
10. Configure MCP tokens with lowercase SHA-256 digests in the read/write hash
   environment variables. A write token intentionally includes read access but
   not admin access. Never put plaintext bearer tokens in `.env` or logs.

### Migration and rollback

The durable browser access setting is authoritative after initialization. A
fresh deployment with no password hash can therefore remain in `lan_open` mode
until an administrator selects `password` and sets a workspace password in
Settings. A migrated deployment with an imported hash remains in `password`
mode until an administrator explicitly selects `lan_open`.

If rolling back to code from before durable browser settings existed, restore
`BENCHLEDGER_ADMIN_PASSWORD_HASH` from the private secret store before starting
the older code. Older code cannot read a Settings-managed password or mode. Do
not use a rollback to silently change the access mode; verify the browser
session behavior after the rollback.

### HTTP hardening defaults

- Request bodies are capped at 2 MiB by default and 16 KiB on authentication
  routes. Only artifact upload routes accept larger bodies, bounded by
  `BENCHLEDGER_MAX_UPLOAD_BYTES` (default 100 MiB). A reverse proxy should
  enforce a matching or smaller limit.
- State-changing browser requests (cookie sessions and the `lan_open`
  session bootstrap) must carry a same-origin `Origin`; cross-site requests
  receive `403`. Bearer-token clients without `Origin` are unaffected.
- Failed logins are limited per client address and by a workspace-wide
  ceiling (50 failures per 15 minutes) so rotating source addresses cannot
  multiply the guessing budget. While that ceiling is reached, legitimate
  sign-ins also wait for the window to expire.
- Every response carries `X-Content-Type-Options: nosniff`,
  `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY` and a
  Content-Security-Policy. Artifact downloads are always attachments and use
  their recorded media type only for an allow-list of safe types; anything
  else is served as `application/octet-stream`.
- `/api/v1/ready` omits internal dependency `checks` unless the caller is
  authenticated; `/api/v1/health` never returns them.

## Start

Copy `deploy/compose.example.yml` and `.env.example` into a private deployment
directory, set `BENCHLEDGER_HOST_DATA_DIR` to an explicit absolute path, and
set `BENCHLEDGER_ENV_FILE` to the private absolute path of the environment
file that Compose should load. If it is omitted for a local checkout, the
example resolves `../.env` relative to the Compose file; this default is not a
production secret location. Then:

```bash
export BENCHLEDGER_ENV_FILE=/absolute/private/path/benchledger.env
docker compose --env-file "$BENCHLEDGER_ENV_FILE" config --quiet
docker compose --env-file "$BENCHLEDGER_ENV_FILE" up -d --build benchledger
```

Never place credentials or a real database in the public checkout.

## One-shot private inventory import

The legacy inventory bridge is a local/container command only. It has no HTTP
import route and emits counts, not item names, order numbers, email IDs, source
records, or input bodies. Keep the source JSON outside the public checkout and
mount it read-only for the one-shot container.

Set these variables in the shell that owns the private files; both values must
be absolute host paths. The data path must be a dedicated BenchLedger
directory, not a checkout, home directory, or broad system directory.

```bash
export PRIVATE_INVENTORY_JSON=/absolute/private/path/inventory.json
export BENCHLEDGER_HOST_DATA_DIR=/absolute/private/path/benchledger-data
```

Preview the import first. The command validates the complete document, keeps
ordered/delivered-but-uncounted quantities informational, and makes no item or
stock-event writes during the dry run:

```bash
docker compose run --rm --no-deps \
  -v "$PRIVATE_INVENTORY_JSON:/run/private/inventory.json:ro" \
  benchledger node apps/import-cli/dist/main.js \
  --inventory-file /run/private/inventory.json \
  --data-dir /var/lib/benchledger \
  --dry-run --json
```

After reviewing the count-only summary, repeat the same command without
`--dry-run` to apply it. Replaying the same dated source is idempotent: item
records may be refreshed, but deterministic stock events and audit records are
not duplicated. A failed later write rolls back the complete import
transaction. Keep the source mount read-only and remove the temporary
container after the command completes.

## Verification

- Check `/api/v1/health` and `/api/v1/ready` independently.
- Confirm the intended browser access mode: a fresh no-hash private-LAN install
  should open in `lan_open`, while a migrated hash-configured install should
  require its password. In either case, changing the mode or password should
  invalidate the existing browser session.
- Sign in and complete a synthetic inventory count when password mode is active.
- Verify an MCP read token cannot write at `/api/v1/mcp`.
- Verify `/api/v1/mcp` still rejects requests without a scoped bearer token even
  when the browser is in `lan_open` mode.
- Upload/download a synthetic artifact through the authenticated browser/host
  flow and compare its SHA-256. The private transfer manager may use the
  `X-Bench-Transfer-Token` header; these capabilities are scoped to one action
  and expire. Generic MCP currently returns `HOST_TRANSFER_UNAVAILABLE` before
  creating a session or reading artifact metadata and never returns the private
  origin, URL, header, or token. Transfer actions are not advertised in MCP
  discovery; cached clients still receive that explicit failure. A separately
  authorised agent host can use `node scripts/artifact-transfer.mjs --help`
  from its source checkout, with `BENCHLEDGER_URL` and `BENCHLEDGER_TOKEN`
  supplied privately in its environment. This helper uses the existing scoped
  HTTP routes, verifies length and SHA-256, rejects redirects and refuses
  download overwrites. It is not installed in the application container and
  does not grant host filesystem access through MCP.
- Create a verified backup and restore it into a separate directory (see
  [Backup and restore](#backup-and-restore)); compare counts in the restored
  instance before relying on it.
- Confirm neighbouring containers and services remain healthy.

Do not use broad Docker pruning, daemon restart, host reboot, or unrelated
Compose shutdown as part of deployment.

## Backup and restore

`scripts/benchledger-backup.mjs` (also `npm run backup --` in a source checkout
after `npm run build:server`) is the operator entry point. It is shipped in the
container image. A backup is a **directory** containing a `VACUUM INTO` SQLite
snapshot, a copy of the content-addressed artifact store, and a
`benchledger-backup.json` manifest with the database SHA-256 and every artifact
digest. Every command verifies before it reports success.

```text
benchledger-backup backup  <destination-dir> [--data-dir <dir>] [--online]
benchledger-backup verify  <backup-dir>
benchledger-backup restore <backup-dir> <new-data-dir> [--force]
```

- Paths must be absolute. `--data-dir` defaults to `BENCHLEDGER_DATA_DIR`.
- `backup` refuses a destination that exists or lies inside the data directory,
  and refuses a directory with no `benchledger.sqlite` rather than creating an
  empty workspace. It refuses while the data directory looks in use (a server
  answering on `127.0.0.1:$BENCHLEDGER_PORT`, or `benchledger.sqlite-wal`/`-shm`
  present) unless `--online` is given.
- `restore` never overwrites: it writes a **new** data directory, verifies
  SQLite and every artifact hash, opens it once and checks runtime health. It
  refuses a destination inside the live data directory, and refuses while a
  server is running unless `--force` is given. You then point
  `BENCHLEDGER_DATA_DIR` (Compose: `BENCHLEDGER_HOST_DATA_DIR`) at the restored
  directory. The copied manifest in a restored data directory records its source
  backup; its database digest stops matching once the server has opened it.
- Exit status: 0 success, 1 refused or failed, 2 usage error.

The container runs as UID/GID 10001 with a read-only root filesystem, so create
private host directories it can write, outside the data directory and the
checkout:

```bash
export BENCHLEDGER_HOST_BACKUP_DIR=/absolute/private/path/benchledger-backups
sudo install -d -m 700 -o 10001 -g 10001 "$BENCHLEDGER_HOST_BACKUP_DIR"
```

**Recommended: consistent offline backup.** Stop the service so no writes race
the snapshot, run a one-shot container with the backup directory mounted, then
start the service again:

```bash
stamp=$(date -u +%Y%m%dT%H%M%SZ)
docker compose stop benchledger
docker compose run --rm --no-deps \
  -v "$BENCHLEDGER_HOST_BACKUP_DIR:/backups" \
  benchledger node scripts/benchledger-backup.mjs backup "/backups/benchledger-$stamp"
docker compose start benchledger
```

**Online backup with `docker exec`.** For small instances you can back up the
running service. The CLI runs in a separate process from the server, so the
server's in-process write barrier does not cover it: the SQLite snapshot is
transactionally consistent, and an artifact written while the copy runs makes
verification fail (nothing is kept; rerun). Run it inside the same container so
the CLI and server are the same image version. `/tmp` is a 256 MB tmpfs in the
example Compose file; use the offline procedure when artifacts are larger.

```bash
stamp=$(date -u +%Y%m%dT%H%M%SZ)
docker compose exec benchledger \
  node scripts/benchledger-backup.mjs backup "/tmp/benchledger-$stamp" --online
docker compose cp "benchledger:/tmp/benchledger-$stamp" "$BENCHLEDGER_HOST_BACKUP_DIR/"
docker compose exec benchledger rm -rf "/tmp/benchledger-$stamp"
```

**Verify a stored backup** (safe while the service runs):

```bash
docker compose run --rm --no-deps \
  -v "$BENCHLEDGER_HOST_BACKUP_DIR:/backups" \
  benchledger node scripts/benchledger-backup.mjs verify "/backups/benchledger-$stamp"
```

**Restore** into a new directory with the service stopped, keep the previous
data directory untouched until the restored instance is checked:

```bash
export BENCHLEDGER_HOST_RESTORE_PARENT=/absolute/private/path/benchledger-restore
sudo install -d -m 700 -o 10001 -g 10001 "$BENCHLEDGER_HOST_RESTORE_PARENT"
docker compose stop benchledger
docker compose run --rm --no-deps \
  -v "$BENCHLEDGER_HOST_BACKUP_DIR:/backups" \
  -v "$BENCHLEDGER_HOST_RESTORE_PARENT:/restore" \
  benchledger node scripts/benchledger-backup.mjs restore \
  "/backups/benchledger-$stamp" /restore/data
export BENCHLEDGER_HOST_DATA_DIR="$BENCHLEDGER_HOST_RESTORE_PARENT/data"
docker compose up -d benchledger
```

Then check `/api/v1/health`, `/api/v1/ready` and synthetic or known counts.
Backups contain the full private database and files: store them with the same
access controls as the data directory, never in the checkout, and test a
restore periodically.

## Maker workflow rollout

The reviewed maker release adds workflow/history tables without replacing existing
records. Keep named-account activation disabled: do not set
`BENCHLEDGER_TEAM_ACCESS_PREVIEW=true` for this rollout. The existing workspace
access mode and credentials remain authoritative. Preserve a verified private
pre-deployment data/configuration backup and the previous immutable image.
See [maker workflows](maker-workflows.md) for shipped and gated functionality.
