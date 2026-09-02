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

Do not record the exact host address in source-controlled files. Do not restart
containers, rebuild images, run imports, mutate data, rotate credentials, change
Compose files on the host, or inspect private volumes unless the maintainer gives
explicit approval for that action.

## Before deployment

1. Build and test from a clean checkout.
2. Create a private data directory with restricted ownership.
3. Generate a high-entropy session secret. For a fresh trusted-LAN install,
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
   any transfer credential.
8. Keep `BENCHLEDGER_SECURE_COOKIES=false` for the documented plain-HTTP LAN
   deployment. Set it to `true` only after TLS is configured and verified.
9. Configure MCP tokens with lowercase SHA-256 digests in the read/write hash
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
  origin, URL, header, or token. Do not enable a future bridge until it is
  transactional and host-mediated.
- Create an online SQLite backup and artifact manifest.
- Restore into a separate temporary directory and verify counts and hashes.
- Confirm neighbouring containers and services remain healthy.

Do not use broad Docker pruning, daemon restart, host reboot, or unrelated
Compose shutdown as part of deployment.
