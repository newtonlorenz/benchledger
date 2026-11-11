# Security policy

BenchLedger stores valuable inventory data, supplier history, project files, and
agent credentials. Treat every instance as private operational infrastructure.

## Supported versions

The current `main` branch receives security fixes. BenchLedger is pre-release;
there is no stable compatibility or long-term-support promise yet.

## Report a vulnerability privately

Do not publish a vulnerability, credential, database, or private instance sample
in an issue or discussion.

Use **Security → Report a vulnerability** in the GitHub repository so the
maintainers can coordinate privately. If that control is unavailable, do not
transmit sensitive details through an issue, discussion, or other public channel.

Include the affected version or commit, impact, reproduction steps using
synthetic data, and any suggested mitigation. Please allow maintainers a
reasonable opportunity to investigate before disclosure.

## Security boundaries

- Runtime data and secrets live outside the source checkout.
- Browser writes require an authenticated session and CSRF protection.
  State-changing browser requests must also be same-origin (`Origin` check),
  and the server only answers requests whose `Host` is the configured public
  host, a loopback name or an explicit `BENCHLEDGER_ALLOWED_HOSTS` entry, which
  blocks DNS rebinding against `lan_open` mode.
- The session secret must be random; startup rejects the documented
  placeholder and obviously low-entropy values.
- MCP writes require revocable, scoped personal access tokens. Deployments using
  structured token configuration can also enforce expiry.
- Tokens are stored hashed server-side; plaintext belongs in a client secret
  store such as macOS Keychain.
- Uploaded files are size- and quota-limited and hash-checked. BenchLedger
  never executes or slices them. It does parse some uploads server-side:
  inventory images are decoded and re-encoded (metadata stripped) with
  `sharp`, and GLB, STL and STEP assembly sources are read and parsed to
  inspect their geometry. Those
  parsers are part of the attack surface; keep dependencies current.
- Artifact downloads are always `Content-Disposition: attachment`, carry
  `X-Content-Type-Options: nosniff`, and use the recorded media type only for
  an allow-list of safe types (others become `application/octet-stream`).
- Request bodies are size-limited before authentication (16 KiB on login
  routes, 2 MiB by default, `BENCHLEDGER_MAX_UPLOAD_BYTES` on upload routes).
- Responses carry `nosniff`, `Referrer-Policy: no-referrer`, frame denial and
  a Content-Security-Policy restricting the web app to same-origin scripts.
- File operations accept logical identifiers, not arbitrary absolute paths.
- Supplier URLs are recorded but not fetched by the server.
- Every state mutation is attributable and audited.
- Purchase execution, printer control, and permanent artifact purge are not MCP
  capabilities.

## Browser sessions

Browser sessions are stateless signed cookies (HMAC with the session secret)
that expire after eight hours. Logging out clears the cookies in that browser
but does not revoke a copied cookie value before it expires. Changing the
workspace password or access mode bumps a durable credential revision and
invalidates every existing shared session; rotating the session secret
invalidates all sessions, including named-member sessions. Cookies are
`HttpOnly` and `SameSite=Lax`, and `Secure` by default whenever the public base
URL is HTTPS.

Login attempts are rate-limited per client address: after five failures in 15
minutes that address receives `429` until the window ends. A workspace-wide
ceiling (50 failures in 15 minutes, from any address) does not block anyone,
because a hard global limit would let a burst of wrong guesses lock out every
user, including one with the correct password. Instead, while the ceiling is
exceeded every login attempt is delayed by a fixed second before the password
is checked, and is still checked; correct and wrong passwords are delayed alike.
These counters are kept in memory, so a server restart clears them. Client
addresses come from `X-Forwarded-For` only when `BENCHLEDGER_TRUST_PROXY` names
the trusted proxy hops or addresses (the legacy value `true` means one hop);
invalid entries are rejected at startup.

Plain-HTTP access and `Secure` cookies: when `BENCHLEDGER_PUBLIC_BASE_URL` is
`https://`, cookies are `Secure` by default, so a browser that reaches the same
server over plain HTTP (for example a LAN IP listed in
`BENCHLEDGER_ALLOWED_HOSTS`) will not keep a session there. Prefer HTTPS for
every address. Setting `BENCHLEDGER_SECURE_COOKIES=false` makes plain-HTTP
sessions work but lets session cookies travel unencrypted on every connection,
including over HTTPS-capable addresses; only do this on a trusted network.

Reverse proxies and the Host check: the server answers only Hosts on its
allow-list (`421 host_not_allowed` otherwise). A proxy must forward the
original `Host` (nginx: `proxy_set_header Host $host;`; Caddy does this by
default), or the upstream name it uses must be listed in
`BENCHLEDGER_ALLOWED_HOSTS`. Health probes that address the container by a
Docker service name need the same entry; the bundled container healthcheck
uses `127.0.0.1`, which is always allowed.

## Deployment

The reference configuration is for a trusted LAN. Do not expose the default
installation directly to the public internet. Internet-facing deployments need
a maintained TLS reverse proxy, independent access controls, rate-limit and log
review, current backups, and a deployment-specific threat review.
