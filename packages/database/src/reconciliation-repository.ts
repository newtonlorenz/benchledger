import {
  reconciliationCommitSchema,
  reconciliationDraftSchema,
  type ReconciliationCommit,
  type ReconciliationDraft
} from "@benchledger/api-contract";
import { DomainError } from "@benchledger/domain";
import type { BenchDatabase, SqliteRow } from "./sqlite.js";

function text(row: SqliteRow, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new Error(`reconciliation row ${key} is not text`);
  return value;
}

function optionalText(row: SqliteRow, key: string): string | undefined {
  const value = row[key];
  return typeof value === "string" ? value : undefined;
}

function integer(row: SqliteRow, key: string): number {
  const value = row[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) throw new Error(`reconciliation row ${key} is not a positive integer`);
  return value;
}

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : undefined;
}

/**
 * Preview lines gained an explicit unit after older reconciliation documents
 * had already been persisted. Reconstruct only that missing scalar from the
 * document's own immutable basis; ambiguous reservation units remain an
 * integrity failure rather than being guessed.
 */
function normalizeLegacyPreviewLineUnits(value: unknown): unknown {
  const root = record(value);
  const preview = record(root?.preview);
  const basis = record(root?.basis);
  if (root === undefined || preview === undefined || basis === undefined || !Array.isArray(preview.lines)) return value;

  const reservations = Array.isArray(basis.reservations)
    ? basis.reservations.map(record).filter((candidate): candidate is Readonly<Record<string, unknown>> => candidate !== undefined)
    : [];
  const bomLines = Array.isArray(basis.bomLines)
    ? basis.bomLines.map(record).filter((candidate): candidate is Readonly<Record<string, unknown>> => candidate !== undefined)
    : [];
  const lines = preview.lines.map((candidate) => {
    const line = record(candidate);
    if (line === undefined || Object.hasOwn(line, "unit") || typeof line.bomLineId !== "string") return candidate;
    const units = [...new Set(reservations
      .filter((reservation) => reservation.lineId === line.bomLineId && reservation.status === "active")
      .map((reservation) => reservation.unit))];
    if (units.length > 1) throw new Error(`reconciliation preview line '${line.bomLineId}' has mixed active reservation units`);
    const unit = units[0] ?? bomLines.find((bomLine) => bomLine.bomLineId === line.bomLineId)?.unit;
    return unit === undefined ? candidate : { ...line, unit };
  });
  return { ...root, preview: { ...preview, lines } };
}

function parsePayload<T>(row: SqliteRow, schema: { parse: (value: unknown) => T }): T {
  const raw = row.payload_json;
  if (typeof raw !== "string") throw new Error("reconciliation payload is not text");
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    throw new Error("reconciliation payload is malformed JSON");
  }
  return schema.parse(normalizeLegacyPreviewLineUnits(value));
}

function draftFromRow(row: SqliteRow): ReconciliationDraft {
  const payload = parsePayload(row, reconciliationDraftSchema);
  if (payload.id !== text(row, "id") || payload.projectId !== text(row, "project_id") || payload.projectRevisionId !== text(row, "project_revision_id") || payload.version !== integer(row, "version")) {
    throw new Error("reconciliation draft identity or version disagrees with its columns");
  }
  return payload;
}

function commitFromRow(row: SqliteRow): ReconciliationCommit {
  const payload = parsePayload(row, reconciliationCommitSchema);
  if (payload.id !== text(row, "id") || payload.draftId !== text(row, "draft_id") || payload.projectId !== text(row, "project_id") || payload.projectRevisionId !== text(row, "project_revision_id")) {
    throw new Error("reconciliation commit identity disagrees with its columns");
  }
  return payload;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

/** Durable draft/commit storage. Domain effects are performed by the runtime
 * reconciliation adapter in the same outer transaction. */
export class ReconciliationRepository {
  constructor(private readonly database: BenchDatabase) {}

  getDraftByRevision(projectRevisionId: string): ReconciliationDraft | undefined {
    const row = this.database.get<SqliteRow>("SELECT * FROM reconciliation_drafts WHERE project_revision_id = ?", [projectRevisionId]);
    return row === undefined ? undefined : clone(draftFromRow(row));
  }

  getDraft(id: string): ReconciliationDraft | undefined {
    const row = this.database.get<SqliteRow>("SELECT * FROM reconciliation_drafts WHERE id = ?", [id]);
    return row === undefined ? undefined : clone(draftFromRow(row));
  }

  getCommitByRevision(projectRevisionId: string): ReconciliationCommit | undefined {
    const row = this.database.get<SqliteRow>("SELECT * FROM reconciliation_commits WHERE project_revision_id = ?", [projectRevisionId]);
    return row === undefined ? undefined : clone(commitFromRow(row));
  }

  getCommit(id: string): ReconciliationCommit | undefined {
    const row = this.database.get<SqliteRow>("SELECT * FROM reconciliation_commits WHERE id = ?", [id]);
    return row === undefined ? undefined : clone(commitFromRow(row));
  }

  /** Insert the first draft or perform an optimistic update of an existing one. */
  saveDraft(draft: ReconciliationDraft, expectedVersion: number | undefined): ReconciliationDraft {
    const current = this.getDraftByRevision(draft.projectRevisionId);
    if (current === undefined) {
      if (expectedVersion !== undefined) throw new DomainError("version_conflict", "cannot apply an expected version to a new reconciliation draft");
      if (draft.version !== 1) throw new DomainError("version_conflict", "a new reconciliation draft must start at version 1");
      this.database.run(
        `INSERT INTO reconciliation_drafts
         (id, project_id, project_revision_id, status, version, basis_hash, payload_json, created_at, updated_at, committed_at, commit_id, audit_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [draft.id, draft.projectId, draft.projectRevisionId, draft.status, draft.version, draft.basis.hash, JSON.stringify(draft), draft.createdAt, draft.updatedAt, draft.committedAt ?? null, draft.commitId ?? null, draft.auditId ?? null]
      );
      return clone(draft);
    }
    if (current.id !== draft.id) throw new DomainError("reconciliation_conflict", `A different reconciliation draft already exists for revision ${draft.projectRevisionId}`);
    if (current.status !== "draft") throw new DomainError("reconciliation_committed", "A committed reconciliation cannot be edited");
    if (expectedVersion === undefined || expectedVersion !== current.version) throw new DomainError("version_conflict", `Reconciliation draft ${current.id} changed since it was read`);
    if (draft.version !== current.version + 1) throw new DomainError("version_conflict", "reconciliation draft version must increment by one");
    this.database.run(
      `UPDATE reconciliation_drafts
       SET status = ?, version = ?, basis_hash = ?, payload_json = ?, updated_at = ?, committed_at = ?, commit_id = ?, audit_id = ?
       WHERE id = ? AND version = ? AND status = 'draft'`,
      [draft.status, draft.version, draft.basis.hash, JSON.stringify(draft), draft.updatedAt, draft.committedAt ?? null, draft.commitId ?? null, draft.auditId ?? null, draft.id, expectedVersion]
    );
    const stored = this.getDraft(draft.id);
    if (stored === undefined || stored.version !== draft.version) throw new DomainError("version_conflict", "reconciliation draft update was not applied");
    return clone(stored);
  }

  /**
   * Mark a draft committed and persist the immutable commit record. This
   * method intentionally does not open its own transaction: callers compose
   * it with stock/reservation writes inside the outer UnitOfWork transaction.
   */
  markCommitted(draftId: string, commit: ReconciliationCommit): ReconciliationCommit {
    const current = this.getDraft(draftId);
    if (current === undefined) throw new DomainError("reconciliation_not_found", `reconciliation draft ${draftId} does not exist`);
    const existing = this.getCommitByRevision(current.projectRevisionId);
    if (existing !== undefined) {
      if (existing.id === commit.id) return clone(existing);
      throw new DomainError("reconciliation_committed", `revision ${current.projectRevisionId} already has a committed reconciliation`);
    }
    if (current.status !== "draft") throw new DomainError("reconciliation_committed", "reconciliation draft is already committed");
    if (commit.draftId !== current.id || commit.projectRevisionId !== current.projectRevisionId || commit.projectId !== current.projectId) {
      throw new DomainError("reconciliation_conflict", "reconciliation commit does not match its draft");
    }
    this.database.run(
      `INSERT INTO reconciliation_commits
       (id, draft_id, project_id, project_revision_id, basis_hash, payload_json, committed_at, audit_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [commit.id, commit.draftId, commit.projectId, commit.projectRevisionId, commit.basis.hash, JSON.stringify(commit), commit.committedAt, commit.auditId ?? null]
    );
    const committedDraft: ReconciliationDraft = {
      ...current,
      status: "committed",
      updatedAt: commit.committedAt,
      committedAt: commit.committedAt,
      commitId: commit.id,
      ...(commit.auditId === undefined ? {} : { auditId: commit.auditId })
    };
    this.database.run(
      `UPDATE reconciliation_drafts
       SET status = 'committed', payload_json = ?, updated_at = ?, committed_at = ?, commit_id = ?, audit_id = ?
       WHERE id = ? AND status = 'draft'`,
      [JSON.stringify(committedDraft), commit.committedAt, commit.committedAt, commit.id, commit.auditId ?? null, draftId]
    );
    return clone(commit);
  }

  /** Fill the audit reference after the surrounding application mutation has
   * appended its audit record. Kept separate so the audit ID remains the
   * authoritative ID generated by AuditPort. */
  attachAuditId(commitId: string, auditId: string): void {
    const commit = this.getCommit(commitId);
    if (commit === undefined) throw new DomainError("reconciliation_not_found", `reconciliation commit ${commitId} does not exist`);
    const next = { ...commit, auditId };
    this.database.run("UPDATE reconciliation_commits SET payload_json = ?, audit_id = ? WHERE id = ?", [JSON.stringify(next), auditId, commitId]);
    const draft = this.getDraft(commit.draftId);
    if (draft !== undefined) this.database.run("UPDATE reconciliation_drafts SET payload_json = ?, audit_id = ? WHERE id = ?", [JSON.stringify({ ...draft, auditId }), auditId, draft.id]);
  }
}
