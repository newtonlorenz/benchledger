# Open-source release record

Review date: 2026-08-30
Release state: published and verified

## Assessment

BenchLedger has a credible open-source foundation: a documented public/private
data boundary, synthetic fixtures, modular architecture, Apache-2.0 licensing,
automated checks, deployment guidance, agent documentation, and explicit safety
and approval limits.

The BenchLedger name was selected after an exact-name search across the general
web, GitHub, and npm found no active collision. The npm package name was also
unregistered at the time of review. This is practical publication diligence,
not legal advice or a formal trademark clearance.

## Release matrix

| Area | State | Evidence |
| --- | --- | --- |
| Product story and quickstart | Ready | Root README explains the workflow, boundaries, setup, architecture, and agent path |
| License | Ready | Apache-2.0 text and all package metadata agree |
| Community health | Ready | Contribution guide, conduct policy, support guide, issue forms, and PR template |
| Security reporting | Enabled | GitHub private vulnerability reporting is available from the repository Security tab |
| Privacy boundary | Ready | Runtime data is external; automated privacy and release scans block common leaks |
| Dependency hygiene | Ready | Lockfile, automated updates, dependency review, and production audit in CI |
| Brand system | Ready | BenchLedger mark, lockup, voice, palette, favicon, and screenshot are checked in |
| Package publishing | Intentionally closed | Every workspace remains private until a coordinated package/versioning plan exists |
| Public repository | Published | [`newtonlorenz/benchledger`](https://github.com/newtonlorenz/benchledger) is public with topics, Discussions, protected `main`, and passing CI |
| Stable release | Not yet | The first source publication is pre-1.0 and carries no stable API guarantee |

## Publication checklist

- [x] Select the BenchLedger name and perform preliminary web/GitHub/npm checks
- [x] Apply the name to package scope, environment variables, MCP resource URIs,
  docs, deployment identity, code symbols, skill metadata, and brand assets
- [x] Keep runtime data, private history, build output, dependencies, and credentials out of the public tree
- [x] Run public/privacy checks, clean dependency installation, build, typecheck,
  focused tests, browser tests, and production dependency audit
- [x] Create and push the public GitHub repository
- [x] Enable private vulnerability reporting, branch rules, Dependabot, and secret scanning where available
- [x] Verify CI and a clean clone from the public repository

## Repository settings

- Require pull requests and the `check` and `dependency-review` jobs on `main`
- Require review for workflow and security-boundary changes
- Enable secret scanning, push protection, Dependabot alerts, and private
  vulnerability reporting where the hosting plan supports them
- Disable force-push and branch deletion on `main`
- Use Discussions for public questions; do not use public issues or Discussions for private support data

Package publishing, hosted-service operation, purchasing, and printer control
remain separate explicit actions.
