# MCP client readiness corrections

Date: 7 September 2026. Baseline: release 90ad9b4.

## Findings and changes

The atomic setup tool published a complete object schema inside its properties
map. Two union-shaped tools also lacked the object root required by strict MCP
clients. All three discovery defects are corrected. Every advertised tool now
passes the official client envelope and JSON Schema checks. Setup payloads are
checked against both the advertised schema and application validation.

The legacy inventory tool now advertises its actual evidence and unit enums.
These remain distinct from the canonical atomic-setup and maker-workflow fields.
An exact inventory link no longer turns uncounted delivery into confirmed
candidate availability. The root decision and candidate facts agree.

The HTTP adapter returns authenticated 405 responses for optional unsupported
GET/SSE and DELETE methods, rather than falling through to the web application.
Explicit Origin headers must match the configured application origin. Browser
sessions do not replace MCP bearer authentication.

A standalone stdio-to-HTTP host client reads an owner-private configuration,
refuses redirects and public plain-HTTP endpoints, bounds requests/responses,
and retains an unchanged command key after an ambiguous response. It performs
no automatic retry and grants no new filesystem or shell capability to MCP.
Private host registration is a separate authorised operation, never repository
data. Use a project allow-list, no admin scope and a bounded credential lifetime.

The Files interface distinguishes ordinary documents, drawings, firmware and
photos from explicit validation artefacts. Unknown roles are labelled File.
Project context no longer uses the first workstream as its project identity.
The installed skill must be synchronised with its versioned references, including
the available authorised single-file host transfer path.

## Verification

A clean lockfile installation passed 945 unit/integration tests and 93 browser
flows. Builds, workspace typechecks and the existing coverage thresholds passed.
The production dependency audit reported zero known vulnerabilities.

New tests use the official MCP SDK over real loopback HTTP and through the
standalone stdio bridge. They cover discovery, atomic setup, scoped reads,
wrong-project and global-write denial, expired credentials, Origin checks,
notification responses, file permissions and unchanged-command retry identity.
The malformed discovery test failed before the fix and passed afterwards.
MCP source is explicitly resolved in integration tests to prevent stale compiled
output from concealing a regression. The SDK is a test dependency only.

## Release boundary

Local tests use synthetic isolated data. No physical evidence, live stock change,
purchase, printer operation or production approval follows from these results.
Live rollout must retain a verified private data/configuration backup and the
previous immutable image. Confirm the deployed identity, original records and
access mode independently. Record live MCP and browser outcomes in the release
handoff; this document is not evidence that deployment has happened.
