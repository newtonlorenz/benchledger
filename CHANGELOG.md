# Changelog

Notable user-facing changes will be recorded here. BenchLedger has not made its
first public release; all current work is under **Unreleased**.

## Unreleased

### Added

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
