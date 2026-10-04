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
- MCP writes require revocable, scoped personal access tokens. Deployments using
  structured token configuration can also enforce expiry.
- Tokens are stored hashed server-side; plaintext belongs in a client secret
  store such as macOS Keychain.
- Uploaded files are size- and quota-limited, hash-checked, and bound to an
  authorised project or work-item revision. Browser Files and the supported host
  helper share the 100 MiB limit and format policy, including JSON, ZIP and SVG.
- ZIP archives are stored opaquely for download and are never extracted or
  executed. SVG previews display verified, escaped source through the 1 MiB text
  preview, never SVG image Blob URLs, inline markup, objects or iframes.
  Supported CAD and image previews do not execute uploaded code or slice files.
- Both authenticated artifact download routes serve attachments with
  `Cache-Control: no-store`, `Referrer-Policy: no-referrer`,
  `X-Content-Type-Options: nosniff`, and
  `Content-Security-Policy: sandbox allow-downloads; default-src 'none'`. The
  download permission preserves ordinary attachment navigation without enabling
  scripts or same-origin access. Other excluded file
  types remain excluded.
- File operations accept logical identifiers, not arbitrary absolute paths.
- Supplier URLs are recorded but not fetched by the server.
- Every state mutation is attributable and audited.
- Purchase execution, printer control, and permanent artifact purge are not MCP
  capabilities.

## Deployment

The reference configuration is for a trusted LAN. Do not expose the default
installation directly to the public internet. Internet-facing deployments need
a maintained TLS reverse proxy, independent access controls, rate-limit and log
review, current backups, and a deployment-specific threat review.
