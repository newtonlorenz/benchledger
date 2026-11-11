# Changelog

Notable user-facing changes will be recorded here. BenchLedger has not made its
first public release; all current work is under **Unreleased**.

## Unreleased

### Upgrade notes (read before deploying this release)

- **Host allow-list.** Requests are accepted only when `Host` is the
  `BENCHLEDGER_PUBLIC_BASE_URL` host, `localhost`, `127.0.0.1` or `[::1]`.
  Any other name gets `421 host_not_allowed`. If people open BenchLedger by a
  LAN IP address or mDNS name that differs from the public URL, list those in
  the new `BENCHLEDGER_ALLOWED_HOSTS` (comma-separated, no scheme or port).
- **Session secret.** Startup now refuses the `.env.example` placeholder and
  other low-entropy `BENCHLEDGER_SESSION_SECRET` values; generate one with
  `openssl rand -base64 48`.
- **Trusted proxies.** `BENCHLEDGER_TRUST_PROXY` accepts `false` (default), a
  hop count or proxy IPs/CIDRs. The legacy `true` now means exactly one hop.
- **Secure cookies.** With `BENCHLEDGER_SECURE_COOKIES` unset, cookies are
  `Secure` when the public base URL is `https://`. Remove an explicit `false`
  if TLS now terminates in front of BenchLedger.
- **Body limits.** Request bodies are capped per route (2 MiB default, 16 KiB
  on authentication routes); only uploads accept up to
  `BENCHLEDGER_MAX_UPLOAD_BYTES`.
- **CI branch protection.** The single `test` job became the `check` jobs
  listed in `docs/development-workflow.md`; update required checks.

### Review fix pass (correctness, security and operations)

- Summary: a multi-agent review fix pass covering security hardening (Host
  allow-list, proxy trust, session-secret and cookie defaults, body limits),
  data-integrity fixes, MCP ergonomics, web UX, mobile client resilience, and
  CI/Docker/backup operations. Details are in the pull request.
- Security: production dependencies updated so the server image audits clean
  (Fastify 5.12.8, fast-uri, Zod 4.6.7, sharp 0.35.5, Vite 8.3.7; Expo tooling
  patches for shell-quote, node-forge and decode-uri-component); MCP SDK test
  dependency 1.32.2.
- Operations: `benchledger-backup` CLI (`npm run backup -- backup|verify|restore`)
  with in-use detection, non-overwriting restore and documented Docker
  procedures in the deployment guide.
- Container: runtime image ships only manifests, compiled output and production
  dependencies (no sources, tests, mobile app or Vite), adds a `HEALTHCHECK`,
  and pins the Node base image by digest.
- CI: parallel static/unit/e2e/container-smoke jobs, strict server-image
  audit, CodeQL, SHA-pinned actions, uploaded test results and Playwright
  traces, a path-filtered Expo export workflow, and a mobile-viewport smoke
  project with one CI retry.
- Tooling: the privacy scan checks the files Git would publish (tracked plus
  untracked-not-ignored) instead of every file on disk; `npm run check` no
  longer runs the Expo export (`npm run check:mobile`).
- Correctness and hardening fixes from the same review across the application,
  runtime, server, MCP and web surfaces (see the pull request for details).

### Added

- **Atomic version checks for stock commands.** `POST /inventory/{id}/count`
  and `POST /inventory/{id}/stock-events` honour an optional `If-Match` or body
  `expectedVersion` inside the audited command (409 `version_conflict` on
  mismatch); omitting both keeps the previous behaviour.
- **Inventory list thumbnails.** Inventory list rows carry an optional
  `primaryImage` (`id`, same-origin `url` of the image content route,
  `mediaType`, `width`, `height`) for the first gallery image; the web
  inventory table shows it.
- **Print item labels.** The item drawer previews and prints a label with a QR
  code for `benchledger://item/<id>` (error correction M, four-module quiet
  zone) plus name, variant and location, using a small built-in encoder and
  print CSS (no new dependency, no inline script).

- **Stock receiving policy.** Settings asks “When does stock count as in
  stock?” — when it's bought (`on_purchase`), when it's delivered
  (`on_delivery`) or when I've received and checked it (`on_receipt`, the
  default and previous behaviour). The policy changes only derived
  availability (BOM supply, reservations, available quantities, readiness,
  shopping, inspect-first queue); stored evidence is never rewritten and the
  web keeps it visible (“In stock · delivered, not counted”). The change is
  previewed against current inventory, versioned (`If-Match`), audited
  (actor, from/to), administrator-only, and refused while reserved stock would
  stop counting. New `GET/PUT /api/v1/workspace/preferences`,
  `GET /api/v1/workspace/preferences/stock-receiving-impact`, `preferences` in
  the workspace snapshot, `availability` on inventory items and BOM gap
  candidates, and read-only `stockReceivingPolicy`/`inStock`/
  `policyAvailability` in MCP outputs. MCP cannot change the policy. Migration
  `workspace_preferences_schema_version` 1 adds the
  `forge_workspace_preferences` singleton.

- iOS 27 design direction for the phone client, with native Liquid Glass tabs,
  large titles, native search, inset lists, dark appearance and Dynamic Type.

- Initial Expo native client for iPhone and Android: secure server connections,
  inventory/project search, evidence and requirement views, versioned item
  metadata edits and atomic project creation. See [mobile setup](docs/mobile-app.md).

- Inline draft protection, explicit unavailable-project recovery and rendered accessibility smoke checks

- Task-oriented home with project search, local pins, recent-project resume and direct attention actions
- A direct Build planning tab, scoped file search and explicit drag-and-drop file staging

- Technical workspace design with Light, Dark and System themes, compact rows and a collapsible navigation rail
- Keyboard workspace commands, a project register and counts from loaded records

- Reviewed maker templates and CSV project setup, plus atomic append-only BOM imports
- Requirement-bound supplier quotes, explicit fit review and currency-separated estimates
- Versioned repeated-part/plate planning, workstream progress and revision history
- HTTP/MCP parity and focused browser, DOM, persistence and recovery regressions

- Project details/stage editing, full requirement correction and reversible removal history
- Read-only JSON project briefs and spreadsheet-safe requirements CSV exports

- Integrity-checked browser downloads and an explicit-revision host file-transfer
  helper with project-scoped access, redirect rejection and no download overwrites

- Evidence-aware inventory ledger and availability states
- Projects, revisions, BOM evaluation, reservations, offers, and audit history
- Exact printer, filament, nozzle, accessory, and electronics product profiles
- Versioned project artifacts and build-configuration snapshots
- Post-project inventory reconciliation with reviewed drafts and atomic commit
- Responsive web workspace and scoped MCP interface
- LAN deployment, backup/restore, privacy scanning, and public-project community files

### Changed

- A physical count of delivered or ordered stock is now documented and audited
  as receiving it (`received: true`). Generic stock movements on delivered or
  ordered rows are refused until they are received. Descriptive edits no
  longer rewrite an item's recorded quantity.
- Demo mode lists projects in the same order as production (most recently
  updated first); the demo-only creation-order wrapper was removed.

- Freeze stock-review and inspection inputs while requests are pending or unconfirmed; recover with the exact reviewed payload
- Render saved stock outcomes as immutable receipts and use one keyboard/inert boundary for inline approval dialogs
- Protect quote selections and workstream paging from losing pending edits
- Clear workflow results after denied access; retain records only for transient read failures
- Add guarded project refresh for agent-to-browser handoffs and compact close-out task layouts

- Sourcing search and filters run across the full revision before pagination in HTTP and MCP
- Compact quote lists, task-first phone layouts and actionable project review shortcuts
- Confirmed workflow records remain visible after a failed refresh; new workstreams refresh file scope
- Recorded printers remain visible with explicit setup-check status

- Corrected atomic-setup MCP discovery, explicit evidence/unit enums and object-root tool unions
- Added official-client discovery and transport regression checks, including authenticated no-SSE responses
- Added a private-config host MCP bridge with scoped credentials, no redirects and unchanged-command recovery
- Uncounted candidates remain inspect-first; file roles and project context no longer imply validation or arbitrary workstream selection

- Project quotes now precede legacy inventory offers; requirement add/import actions sit above the plan
- Guided setup shows actual progress steps; import dialogs have explicit focus and isolated background controls

- Shared semantic colour tokens, locally served interface fonts and simplified technical copy
- Focus restoration respects later navigation and newly opened dialogs

- Search and decision-state filtering for larger requirement lists without changing the underlying plan
- Shared multi-word, accent- and punctuation-aware inventory discovery
- Explicit selected-item clearing and project-scoped HTTP requirement corrections
- Reserved planning fields now share one application/storage guard
- Acknowledged requirement saves survive failed readiness refreshes; ambiguous retries keep their command identity
- Removed the duplicate undecided build-approach card from project pages

- Beginner requirements can reuse owned stock without enabling technical mode
- Project next actions lead directly to setup, requirements and shopping
- Files and long mobile forms keep their primary actions accessible
- Upload notifications no longer cover or intercept the next modal action
- Removed non-editable preferences, duplicate setup prompts and unsupported MCP
  transfer actions from discovery; cached transfer calls still fail closed
- Browser file hashing works on trusted plain-HTTP LAN origins; Unicode
  download names and rejected-form recovery are preserved

- Adopted the BenchLedger name, package scope, MCP resource scheme, environment
  namespace, deployment identity, and visual lockup before the first public release
- Corrected reviewed Anycubic Kobra build volumes and kept reported exact-printer
  adds as inspect-first stock until explicit commissioning evidence is recorded
- Corrected the reviewed Prusament ASA and PC Blend nominal net masses to 800 g
  and 900 g, with history-preserving, edit-safe upgrades for version 1 starter
  catalogs; the upgrade fingerprints all previously corrected same-ID catalog
  payloads and their provenance

### Known pre-release limitations

- APIs, database schema, and MCP capabilities may change before 1.0
- No npm package or hosted service is published
