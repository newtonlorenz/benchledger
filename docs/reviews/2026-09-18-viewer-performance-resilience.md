# App review: optional viewers and recovery

This review used current main, the product requirements, web/application
boundaries, existing regression tests and an isolated synthetic demo. Unfinished
native mobile work was preserved in its original checkout and was not included
in this change. This is local implementation and verification, not deployment.

## Findings and changes

| Priority | Finding | Outcome |
| --- | --- | --- |
| P1 | Assembly and PCB suspended while downloading the renderer, but had no error boundary for a rejected module. A failure could unmount the workspace, including local edits. | Each optional view contains its own failure. The 3D boundary sits inside the assembly editor so notes and draft protection remain available. |
| P2 | The main interface eagerly included Markdown parsing and the Assembly/PCB panels, even for inventory work. | These modules now load only when opened. Image and plain-text previews remain independent of Markdown. |
| P2 | Assembly graphics-loss recovery instructed users to leave the view; STL did not handle graphics loss. | Both dispose failed graphics resources and offer an explicit local retry. Assembly fields, selection and separation stay in the parent editor. |

The production build's main JavaScript bundle decreased from 971.82 kB to
831.84 kB; gzip decreased from 261.09 kB to 219.92 kB
(about 16%). Initial CSS also decreased from 191.52 kB to approximately 180 kB.
These are build sizes, not measured real-user loading times. The Three.js renderer
was already deferred before this change; that existing optimisation is retained.

Browser tests showed that failed module imports remain cached. Recovery therefore
distinguishes a rendering/graphics failure from a code-download failure. The
former supports local retry; the latter explains how to check the connection,
save open work and refresh. There is no automatic reload, cache-busting script
execution or bypass of content-security controls.

## Existing strengths retained

- Shared domain/application rules and explicit evidence states across surfaces.
- Protected drafts, optimistic concurrency and unchanged retries for uncertain writes.
- Authenticated, size-bounded, hash-verified artifact downloads.
- Safe Markdown rendering, self-hosted fonts, theme tokens and responsive layouts.
- Keyboard dialog boundaries and synthetic browser fixtures.

## Remaining priorities

- The main application bundle remains large. Extract further workflow boundaries
  incrementally, with draft-preservation tests; avoid a wholesale App rewrite.
- The dependency audit reports three moderate development-tool findings involving
  Vitest, its coverage provider and mocker. Updating that coordinated test toolchain
  needs a separate compatibility pass; this change does not resolve those findings.
- No full assistive-technology audit, real-device performance benchmark or native
  mobile review is claimed by this focused change.

## Verification and release

Focused tests cover deferred loading, shared modules, rendering recovery,
code-download failure, modal close/focus behaviour and graphics recovery with
unsaved assembly edits. Browser checks use synthetic files and the disposable
demo service, including desktop/phone layouts and automated accessibility checks.
The Impeccable detector reported no findings in the changed viewer components.

`npm run check` passed with Node 24.12.0 and npm 11.12.1: privacy/public-source
checks, all workspace builds and typechecks, 1,036 unit/integration tests and 134
Playwright tests. Coverage was 89.60% statements/lines, 82.29% branches and 81.96%
functions, exceeding the existing 80% thresholds. Desktop/phone recovery
screenshots were inspected. An initial run under the machine's Node 26 failed
11 existing browser-storage tests; the final clean installation and full run used
the repository's required Node 24 without changing those tests.

No API, database,
permissions or dependency change is required. Reverting the web changes restores
the prior loading behaviour without a data migration. No remote integration,
publication or deployment was performed.
