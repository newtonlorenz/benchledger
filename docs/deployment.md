# Deployment

BenchLedger's initial reference deployment is a single-user installation on a
trusted LAN. It uses one application container and one private persistent data
directory outside the source checkout.

## Before deployment

1. Build and test from a clean checkout.
2. Create a private data directory with restricted ownership.
3. Generate a high-entropy session secret and a built-in scrypt admin password
   hash with `hashAdminPassword` from `apps/server/src/auth.ts`. If an Argon2id
   hash is required, the host must supply a tested `passwordVerifier` adapter;
   the default server does not pretend to verify Argon2id.
4. Set a storage quota below the host's safely available capacity.
5. Bind the port to the intended LAN interface only. In the example Compose
   file, set `BENCHLEDGER_BIND_ADDRESS` to that exact address; the safe default
   is loopback and no public LAN address is hardcoded.
6. Set `BENCHLEDGER_PUBLIC_BASE_URL` to the exact HTTP(S) origin that agents
   can reach (for example `http://benchledger.local:8792`). It must not contain a
   path, credentials, query, or fragment; the server never trusts a request
   Host header when constructing transfer links.
7. Keep `BENCHLEDGER_SECURE_COOKIES=false` for the documented plain-HTTP LAN
   deployment. Set it to `true` only after TLS is configured and verified.
8. Configure MCP tokens with lowercase SHA-256 digests in the read/write hash
   environment variables. A write token intentionally includes read access but
   not admin access. Never put plaintext bearer tokens in `.env` or logs.

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
- Sign in and complete a synthetic inventory count.
- Verify an MCP read token cannot write at `/api/v1/mcp`.
- Upload/download a synthetic artifact and compare its SHA-256. Use the
  `X-Bench-Transfer-Token` header returned by MCP; capabilities are scoped to
  one action and expire, and ordinary browser session routes remain separate.
- Create an online SQLite backup and artifact manifest.
- Restore into a separate temporary directory and verify counts and hashes.
- Confirm neighbouring containers and services remain healthy.

Do not use broad Docker pruning, daemon restart, host reboot, or unrelated
Compose shutdown as part of deployment.
