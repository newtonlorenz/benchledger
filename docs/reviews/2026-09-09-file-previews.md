# Project file previews — local verification

The Files tab now offers previews for supported images, formatted Markdown,
plain text/code/data, and interactive STL meshes. Other formats remain
available to download. STL rendering is loaded on demand. Existing upload
restrictions, authenticated downloads, and SHA-256 checks remain in force.
No API or MCP schema, persistent data, or migration changed.

## Checks

- Node 24.12.0, npm 11.12.1; dependencies reproduced with `npm ci`.
- `NODE_OPTIONS=--no-experimental-webstorage npm run check` passed in a clean
  source snapshot: public checks, builds, typechecks, 975 unit/integration
  tests, and 125 Playwright tests. Coverage: 89.72% statements/lines,
  82.06% branches, 82.64% functions.
- The Node option prevents experimental server-side storage from shadowing
  jsdom storage. Without it, 11 existing storage tests fail before assertions.
- The original checkout's public scan encounters an existing Git-ignored
  plugin cache containing a private local path. The clean source snapshot
  excluded ignored local state; the cache and scan rules were left intact.
- The final theme-token-only CSS adjustment passed the web build and focused
  preview/mobile-download browser checks separately in light and dark modes.
  A combined two-theme run reused the same synthetic database and produced
  duplicate fixture names; the dark checks passed with a fresh demo server.
- Final source privacy/public checks and `git diff --check` passed. The clean
  snapshot was compared with the working source after the final style change.
- The dependency audit reported three moderate findings in the existing Vitest
  toolchain and none in the added preview dependencies. No broad dependency
  upgrade was made as part of this feature.

Browser checks cover Markdown formatting, image decoding, an STL canvas and
reset control, mobile fit, modal isolation/focus return, unsupported formats,
and corrupted-download rejection. Unit checks also cover stream size limits,
URL cleanup, aborted previews, Markdown injection, and invalid STL headers.

This record describes the local implementation checkpoint before publication.
No deployment or remote integration test was included in that checkpoint.
Reverting the UI changes and dependency additions requires no data rollback.
