# Project artifact formats — 4 October 2026

## Result and scope

Project Files and the supported host helper now accept JSON metadata, ZIP source
bundles and SVG drawings without changing their bytes or filenames. The fix is
on `codex/project-artifact-formats`, based on main `3d496b2`.

- `application/json`, `application/zip`, `application/x-zip-compressed` and
  `image/svg+xml` are accepted. ZIP and SVG are no longer excluded extensions.
- ZIP files remain opaque attachments: no extraction, execution or automatic
  dependency import. SVG previews show escaped source through the existing
  verified 1 MiB text path. Original downloads preserve the uploaded bytes.
- Both download routes use attachment disposition, no-store, no-referrer,
  nosniff and a sandbox/default-src-none CSP. Raw SVG image Blob URLs are avoided
  because they can become active documents when opened in another tab.
- The 100 MiB upload limit, quotas, exact revision ancestry, project token scope,
  SHA-256 and length checks, other excluded formats and generic MCP transfer
  boundary are unchanged. There is no schema or storage migration.
- Shared inventory creation still requires workspace-authorised inventory
  access. Project requirements can retain purchase evidence; this file-format
  change does not expand stock permissions or infer physical counts.

## Verification

Node.js 24.19.0 and npm 11.19.0; dependencies installed from the lockfile.

- Application, preview, transfer-manager and host-helper focused tests: 132 pass.
  The host tests first hit the filesystem sandbox's local socket restriction;
  both passed with temporary loopback server access.
- New persistent-format regression tests: 2 pass, covering ten uploads across
  project and work-item revision scopes, restart/read-back, ZIP aliases and
  traversal entries remaining unextracted, active SVG bytes, JSON, integrity,
  authenticated downloads, incorrect project scope and one-use capabilities.
- Focused browser file test: passes for ZIP, SVG, JSON and existing previews;
  no SVG elements, active markup, image Blob or external SVG request is created.
- `npm run check`: public/privacy checks, all builds and typechecks passed;
  151 Vitest files / 1,254 tests passed. Coverage: statements 88.09%, branches
  82.85%, functions 82.71%, lines 88.09% (all above the 80% gates).
- The first complete browser run passed 171/172 tests. The unchanged stock
  commissioning test failed to dismiss a newly opened dialogue with Escape.
  It passed alone on a fresh server. A complete browser-only rerun then passed
  **172/172 tests** (3.4 minutes), without source changes or retry configuration.

The failure trace sent Escape about 9 ms after the dialogue appeared. Radix
installs keyboard handling through effects, so a timing race is a plausible
explanation, not a proven root cause. No artifact request or stock mutation
occurred during the failed interaction. The modal, stock code and affected test
are unchanged. The original trace and screenshot were retained outside public
source; no unrelated fix or retry setting was added.

An independent implementation review found no actionable issues. A read-only
integration readiness check returned HTTP 200, version 0.1.0, with database and
artifact checks healthy. That endpoint does not establish deployed commit parity.
The new formats have not been exercised against the live service.

## Release and rollback

Local implementation only: no commit, publication, merge or deployment performed.
Release the frontend and backend together after authorisation and required CI.
Existing uploaded artifacts need no migration. Reverting the format allow-list
will prevent new uploads of those types but retain stored bytes. Keep the escaped
SVG preview and protected download handling if reverting upload support; rolling
the frontend back to raw SVG Blob previews would reintroduce the navigation risk
for SVG files already stored.
