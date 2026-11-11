# BenchLedger server

`@benchledger/server` exposes the versioned REST API at `/api/v1` and is
constructed with an `ApplicationPorts` implementation. `createApp({ demo: true
})` supplies a small synthetic inventory for local UI/MCP development; a
non-demo deployment must provide a 32-character session secret and an
environment-backed scrypt password hash. `hashAdminPassword` in `src/auth.ts`
generates the built-in scrypt format; an Argon2id hash requires an explicitly
provided `passwordVerifier` adapter.

Authentication has two explicit paths:

- the browser uses an HttpOnly, signed session cookie plus a double-submit CSRF
  token for writes;
- agents use a bearer token whose SHA-256 digest is configured with read/write
  scopes and, optionally, a project allow-list.

The server never stores plaintext bearer tokens, never logs credentials, and
does not make outbound requests to supplier URLs. `/api/v1/health`,
`/api/v1/ready`, `/api/v1/capabilities`, and `/api/v1/openapi.json` are safe
public discovery endpoints; all inventory, project, artifact, offer, audit, and
SSE endpoints require authentication.

The process loads bearer digests from `BENCHLEDGER_MCP_READ_TOKEN_HASHES`,
`BENCHLEDGER_MCP_WRITE_TOKEN_HASHES`, and the optional admin equivalent. Values
are comma-separated, lowercase SHA-256 digests; the corresponding token has
only that scope. `BENCHLEDGER_BEARER_TOKENS_JSON` is available when project
allow-lists or expiry metadata are needed. Invalid formats stop startup, and
plaintext token values are never accepted.

Leave `BENCHLEDGER_SECURE_COOKIES` unset: the server then derives the cookie
`Secure` flag from `BENCHLEDGER_PUBLIC_BASE_URL` (Secure for an `https://`
origin, not Secure for a plain-HTTP LAN origin). Set it to exactly `true` or
`false` only to override that; `true` over plain HTTP makes browsers withhold
the session cookie. Startup rejects the `.env.example` placeholder and other
low-entropy values for `BENCHLEDGER_SESSION_SECRET`.

Requests are accepted only for the public base URL host, `localhost`,
`127.0.0.1`, `[::1]` and any names listed in `BENCHLEDGER_ALLOWED_HOSTS`
(comma-separated host names or IP addresses, no scheme or port); any other
`Host` receives `421 host_not_allowed`, which blocks DNS rebinding. List LAN IP
addresses or mDNS names there if people use them. `BENCHLEDGER_TRUST_PROXY` is
off by default; set it to the proxy hop count or to comma-separated proxy
addresses/CIDRs only behind a reverse proxy (the legacy value `true` means one
hop). Request bodies are limited per route (2 MiB by default, 16 KiB for
authentication); only upload routes accept up to
`BENCHLEDGER_MAX_UPLOAD_BYTES` (default 100 MiB).

The MCP JSON-RPC endpoint is `/api/v1/mcp` (the root `/mcp` path is not an API
alias).

Binary artifacts are uploaded through a bounded begin/upload/finalize flow and
are verified by the artifact port. MCP receives separate, short-lived,
header-bound capabilities for byte upload, finalize, and download; tokens are
never put in query strings. Configure the exact HTTP(S) origin in
`BENCHLEDGER_PUBLIC_BASE_URL`; production startup rejects a missing or
non-origin value and never derives links from a request Host header. The
in-memory implementation exists only for synthetic mode and tests; production
should replace it with the SQLite and content-addressed artifact adapters.
