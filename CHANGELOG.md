# Changelog

Notable user-facing changes will be recorded here. BenchLedger has not made its
first public release; all current work is under **Unreleased**.

## Unreleased

### Added

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
