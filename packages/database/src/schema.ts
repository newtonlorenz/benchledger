/** The schema is intentionally boring SQL: it is portable to the SQLite CLI,
 * easy to inspect during incident response, and does not hide ledger history
 * behind an ORM-specific materialized balance. */
const BASE_SCHEMA_SQL = `
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS forge_meta (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS inventory_items (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  variant TEXT,
  purchased_quantity REAL NOT NULL CHECK (purchased_quantity >= 0),
  unit TEXT NOT NULL,
  source_status TEXT NOT NULL,
  reuse_policy TEXT NOT NULL,
  confidence TEXT NOT NULL,
  reported_quantity REAL CHECK (reported_quantity IS NULL OR reported_quantity >= 0),
  manufacturer TEXT,
  model TEXT,
  dimensions_json TEXT,
  source_json TEXT,
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  retired_at TEXT
);

CREATE INDEX IF NOT EXISTS inventory_items_category_idx ON inventory_items(category);
CREATE INDEX IF NOT EXISTS inventory_items_confidence_idx ON inventory_items(confidence);
CREATE INDEX IF NOT EXISTS inventory_items_retired_idx ON inventory_items(retired_at);

CREATE TABLE IF NOT EXISTS stock_events (
  id TEXT PRIMARY KEY NOT NULL,
  item_id TEXT NOT NULL REFERENCES inventory_items(id),
  kind TEXT NOT NULL,
  semantics TEXT NOT NULL,
  quantity REAL NOT NULL,
  unit TEXT NOT NULL,
  reason TEXT NOT NULL,
  actor_json TEXT,
  source TEXT,
  evidence_json TEXT,
  correlation_id TEXT,
  idempotency_key TEXT UNIQUE,
  occurred_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS stock_events_item_idx ON stock_events(item_id, occurred_at, id);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  description TEXT,
  status TEXT NOT NULL,
  visibility TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  retired_at TEXT,
  removed_at TEXT,
  removed_by_json TEXT,
  last_lifecycle_status TEXT,
  removed_reservation_ids_json TEXT
);

CREATE TABLE IF NOT EXISTS work_items (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id),
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  description TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  retired_at TEXT
);

CREATE INDEX IF NOT EXISTS work_items_project_idx ON work_items(project_id, name, id);

CREATE TABLE IF NOT EXISTS project_revisions (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id),
  revision_number INTEGER NOT NULL CHECK (revision_number > 0),
  label TEXT NOT NULL,
  status TEXT NOT NULL,
  machine_id TEXT,
  material TEXT,
  notes TEXT,
  created_at TEXT NOT NULL,
  supersedes_revision_id TEXT REFERENCES project_revisions(id),
  UNIQUE(project_id, revision_number)
);

CREATE TABLE IF NOT EXISTS work_item_revisions (
  id TEXT PRIMARY KEY NOT NULL,
  work_item_id TEXT NOT NULL REFERENCES work_items(id),
  revision_number INTEGER NOT NULL CHECK (revision_number > 0),
  label TEXT NOT NULL,
  status TEXT NOT NULL,
  source_path TEXT,
  created_at TEXT NOT NULL,
  supersedes_revision_id TEXT REFERENCES work_item_revisions(id),
  UNIQUE(work_item_id, revision_number)
);

CREATE TABLE IF NOT EXISTS bom_lines (
  id TEXT PRIMARY KEY NOT NULL,
  revision_id TEXT NOT NULL REFERENCES project_revisions(id),
  name TEXT NOT NULL,
  quantity REAL NOT NULL CHECK (quantity > 0),
  unit TEXT NOT NULL,
  required INTEGER NOT NULL CHECK (required IN (0, 1)),
  optional INTEGER NOT NULL CHECK (optional IN (0, 1)),
  item_id TEXT REFERENCES inventory_items(id),
  alternative_item_ids_json TEXT,
  constraints_json TEXT,
  notes TEXT,
  retired_at TEXT
);

CREATE INDEX IF NOT EXISTS bom_lines_revision_idx ON bom_lines(revision_id, id);

CREATE TABLE IF NOT EXISTS bom_alternatives (
  id TEXT PRIMARY KEY NOT NULL,
  bom_line_id TEXT NOT NULL REFERENCES bom_lines(id),
  item_id TEXT REFERENCES inventory_items(id),
  label TEXT NOT NULL,
  constraints_json TEXT
);

CREATE TABLE IF NOT EXISTS reservations (
  id TEXT PRIMARY KEY NOT NULL,
  project_revision_id TEXT NOT NULL REFERENCES project_revisions(id),
  bom_line_id TEXT NOT NULL REFERENCES bom_lines(id),
  item_id TEXT NOT NULL REFERENCES inventory_items(id),
  quantity REAL NOT NULL CHECK (quantity > 0),
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  released_at TEXT
);

CREATE INDEX IF NOT EXISTS reservations_item_idx ON reservations(item_id, status);

CREATE TABLE IF NOT EXISTS suppliers (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  website TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS offer_snapshots (
  id TEXT PRIMARY KEY NOT NULL,
  item_id TEXT NOT NULL REFERENCES inventory_items(id),
  supplier_id TEXT NOT NULL REFERENCES suppliers(id),
  url TEXT NOT NULL,
  title TEXT,
  package_quantity REAL NOT NULL CHECK (package_quantity > 0),
  package_unit TEXT NOT NULL,
  price_minor INTEGER NOT NULL CHECK (price_minor >= 0),
  currency TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  availability TEXT,
  notes TEXT
);

CREATE INDEX IF NOT EXISTS offer_snapshots_item_idx ON offer_snapshots(item_id, observed_at DESC);

CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY NOT NULL,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  actor_json TEXT NOT NULL,
  source_surface TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  before_version INTEGER,
  after_version INTEGER,
  metadata_json TEXT
);

CREATE INDEX IF NOT EXISTS audit_log_entity_idx ON audit_log(entity_type, entity_id, occurred_at, id);

`;

/** Durable singleton access state. The hash column is storage-only and is
 * never included in API projections. */
export const WORKSPACE_SECURITY_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS forge_workspace_security (
  singleton_id INTEGER PRIMARY KEY NOT NULL CHECK (singleton_id = 1),
  mode TEXT NOT NULL CHECK (mode IN ('lan_open', 'password')),
  password_hash TEXT,
  version INTEGER NOT NULL CHECK (version > 0),
  credential_revision INTEGER NOT NULL CHECK (credential_revision > 0),
  updated_at TEXT NOT NULL,
  CHECK ((mode = 'lan_open' AND password_hash IS NULL) OR (mode = 'password' AND password_hash IS NOT NULL))
);
`;

/** Additive user-managed inventory taxonomy. It is not a replacement for the
 * closed semantic inventory kind or the legacy category text. */
export const INVENTORY_CATEGORY_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS inventory_categories (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  normalized_name TEXT NOT NULL,
  parent_id TEXT REFERENCES inventory_categories(id),
  sort_order INTEGER NOT NULL CHECK (sort_order >= 0),
  archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS inventory_categories_sibling_name_idx
  ON inventory_categories(COALESCE(parent_id, ''), normalized_name);
CREATE INDEX IF NOT EXISTS inventory_categories_parent_idx
  ON inventory_categories(parent_id, sort_order, normalized_name, id);
CREATE INDEX IF NOT EXISTS inventory_categories_archived_idx
  ON inventory_categories(archived, sort_order, normalized_name, id);

CREATE TABLE IF NOT EXISTS inventory_item_category_assignments (
  item_id TEXT PRIMARY KEY NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
  category_node_id TEXT NOT NULL REFERENCES inventory_categories(id),
  assigned_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS inventory_item_category_assignments_category_idx
  ON inventory_item_category_assignments(category_node_id, item_id);
`;

/** Review-only project setup payloads. This table is additive and intentionally
 * has no foreign keys: previews must not create graph or stock state. */
export const PROJECT_SETUP_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS project_setup_previews (
  id TEXT PRIMARY KEY NOT NULL,
  actor TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  status TEXT NOT NULL CHECK (status IN ('active', 'committed', 'expired')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  content_sha256 TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  correlation_id TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS project_setup_previews_actor_idx ON project_setup_previews(actor, updated_at, id);
`;

/**
 * Additive v2 exact-product storage. These tables intentionally reference,
 * but never rewrite, the legacy inventory and revision tables. JSON payloads
 * preserve the closed API contract while the discriminator/version columns
 * keep common queries and compare-and-swap writes cheap and inspectable.
 */
export const CATALOG_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS catalog_products (
  id TEXT PRIMARY KEY NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('filament', 'printer')),
  payload_json TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS catalog_products_kind_idx ON catalog_products(kind, created_at, id);
CREATE INDEX IF NOT EXISTS catalog_products_updated_idx ON catalog_products(updated_at, id);

/**
 * Corrections to curated catalog facts replace the current payload, but the
 * superseded payload remains durable for provenance and incident review. This
 * table is append-only by repository design and is intentionally not part of
 * the public catalog contract.
 */
CREATE TABLE IF NOT EXISTS catalog_product_history (
  id TEXT PRIMARY KEY NOT NULL,
  catalog_product_id TEXT NOT NULL REFERENCES catalog_products(id),
  superseded_version INTEGER NOT NULL CHECK (superseded_version > 0),
  payload_json TEXT NOT NULL,
  superseded_at TEXT NOT NULL,
  UNIQUE(catalog_product_id, superseded_version)
);

CREATE INDEX IF NOT EXISTS catalog_product_history_product_idx ON catalog_product_history(catalog_product_id, superseded_version, id);

CREATE TABLE IF NOT EXISTS inventory_product_profiles (
  id TEXT PRIMARY KEY NOT NULL,
  item_id TEXT NOT NULL REFERENCES inventory_items(id),
  catalog_product_id TEXT NOT NULL REFERENCES catalog_products(id),
  profile_type TEXT NOT NULL CHECK (profile_type IN ('filament_spool', 'printer_asset')),
  link_state TEXT NOT NULL CHECK (link_state IN ('confirmed', 'reported', 'suggested')),
  details_json TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(item_id)
);

CREATE INDEX IF NOT EXISTS inventory_product_profiles_catalog_idx ON inventory_product_profiles(catalog_product_id, created_at, id);
CREATE INDEX IF NOT EXISTS inventory_product_profiles_type_idx ON inventory_product_profiles(profile_type, created_at, id);

CREATE TABLE IF NOT EXISTS build_configuration_snapshots (
  id TEXT PRIMARY KEY NOT NULL,
  project_revision_id TEXT NOT NULL REFERENCES project_revisions(id),
  payload_json TEXT NOT NULL,
  content_sha256 TEXT NOT NULL CHECK (length(content_sha256) = 64),
  supersedes_snapshot_id TEXT REFERENCES build_configuration_snapshots(id),
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS build_configuration_snapshots_revision_idx ON build_configuration_snapshots(project_revision_id, created_at, id);
CREATE INDEX IF NOT EXISTS build_configuration_snapshots_supersedes_idx ON build_configuration_snapshots(supersedes_snapshot_id);

CREATE TABLE IF NOT EXISTS artifact_build_configuration_bindings (
  id TEXT PRIMARY KEY NOT NULL,
  artifact_id TEXT NOT NULL,
  build_configuration_snapshot_id TEXT NOT NULL REFERENCES build_configuration_snapshots(id),
  project_revision_id TEXT NOT NULL REFERENCES project_revisions(id),
  created_at TEXT NOT NULL,
  UNIQUE(artifact_id, build_configuration_snapshot_id)
);

CREATE INDEX IF NOT EXISTS artifact_build_configuration_bindings_snapshot_idx ON artifact_build_configuration_bindings(build_configuration_snapshot_id, created_at, id);
CREATE INDEX IF NOT EXISTS artifact_build_configuration_bindings_revision_idx ON artifact_build_configuration_bindings(project_revision_id, created_at, id);
`;

/** Review-first project close-out storage. Payloads retain the strict API
 * document while the identity/version columns make optimistic writes and the
 * one-commit-per-revision invariant cheap to enforce in SQLite. */
export const RECONCILIATION_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS reconciliation_drafts (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id),
  project_revision_id TEXT NOT NULL REFERENCES project_revisions(id),
  status TEXT NOT NULL CHECK (status IN ('draft', 'committed')),
  version INTEGER NOT NULL CHECK (version > 0),
  basis_hash TEXT NOT NULL CHECK (length(basis_hash) = 64),
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  committed_at TEXT,
  commit_id TEXT,
  audit_id TEXT,
  UNIQUE(project_revision_id)
);

CREATE INDEX IF NOT EXISTS reconciliation_drafts_project_idx ON reconciliation_drafts(project_id, updated_at, id);

CREATE TABLE IF NOT EXISTS reconciliation_commits (
  id TEXT PRIMARY KEY NOT NULL,
  draft_id TEXT NOT NULL REFERENCES reconciliation_drafts(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  project_revision_id TEXT NOT NULL REFERENCES project_revisions(id),
  basis_hash TEXT NOT NULL CHECK (length(basis_hash) = 64),
  payload_json TEXT NOT NULL,
  committed_at TEXT NOT NULL,
  audit_id TEXT,
  UNIQUE(project_revision_id)
);

CREATE INDEX IF NOT EXISTS reconciliation_commits_draft_idx ON reconciliation_commits(draft_id, committed_at, id);
`;

/** Review-only inspection previews and append-only inspection evidence. The
 * queue itself is intentionally absent: actions are derived from BOM gaps. */
export const INSPECTION_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS inspection_previews (
  id TEXT PRIMARY KEY NOT NULL,
  actor TEXT NOT NULL,
  project_revision_id TEXT NOT NULL,
  action_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  content_sha256 TEXT NOT NULL CHECK (length(content_sha256) = 64),
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS inspection_previews_actor_idx ON inspection_previews(actor, created_at, id);
CREATE TABLE IF NOT EXISTS inspection_evidence (
  id TEXT PRIMARY KEY NOT NULL,
  project_revision_id TEXT NOT NULL,
  action_id TEXT NOT NULL,
  item_id TEXT NOT NULL REFERENCES inventory_items(id),
  kind TEXT NOT NULL CHECK (kind IN ('physical_quantity', 'compatibility', 'unit_conversion')),
  result TEXT NOT NULL CHECK (result IN ('confirmed', 'inconclusive')),
  payload_json TEXT NOT NULL,
  recorded_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS inspection_evidence_revision_idx ON inspection_evidence(project_revision_id, recorded_at, id);
CREATE INDEX IF NOT EXISTS inspection_evidence_action_idx ON inspection_evidence(action_id, recorded_at, id);
`;

/**
 * The eager base schema used by BenchDatabase. Managed inventory categories
 * are intentionally installed by migrateInventoryCategorySchema during the
 * real startup sequence so legacy category tables can be upgraded and their
 * persisted normalized keys backfilled before the unique/order indexes exist.
 */
export const SCHEMA_SQL = `${BASE_SCHEMA_SQL}\n${WORKSPACE_SECURITY_SCHEMA_SQL}\n${CATALOG_SCHEMA_SQL}\n${RECONCILIATION_SCHEMA_SQL}\n${INSPECTION_SCHEMA_SQL}`;
