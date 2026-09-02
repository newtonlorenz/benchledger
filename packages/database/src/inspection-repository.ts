import {
  inspectionCompletionPreviewSchema,
  inspectionEvidenceSchema,
  type InspectionCompletionPreview,
  type InspectionEvidence,
} from "@benchledger/api-contract";
import type { BenchDatabase, SqliteRow } from "./sqlite.js";

function clone<T>(value: T): T { return structuredClone(value); }
function text(row: SqliteRow, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new Error(`inspection row ${key} is not text`);
  return value;
}
function integer(row: SqliteRow, key: string): number {
  const value = row[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) throw new Error(`inspection row ${key} is not a positive integer`);
  return value;
}
function payload<T>(row: SqliteRow, schema: { parse(value: unknown): T }): T {
  const raw = row.payload_json;
  if (typeof raw !== "string") throw new Error("inspection payload is not text");
  let value: unknown;
  try { value = JSON.parse(raw) as unknown; } catch { throw new Error("inspection payload is malformed JSON"); }
  return schema.parse(value);
}

function previewFromRow(row: SqliteRow): InspectionCompletionPreview {
  const preview = payload(row, inspectionCompletionPreviewSchema);
  if (preview.id !== text(row, "id") || preview.actor !== text(row, "actor") || preview.version !== integer(row, "version") || preview.contentSha256 !== text(row, "content_sha256")) {
    throw new Error("inspection preview identity or version disagrees with its columns");
  }
  return preview;
}

function evidenceFromRow(row: SqliteRow): InspectionEvidence {
  const evidence = payload(row, inspectionEvidenceSchema);
  if (evidence.id !== text(row, "id") || evidence.projectRevisionId !== text(row, "project_revision_id") || evidence.actionId !== text(row, "action_id") || evidence.itemId !== text(row, "item_id")) {
    throw new Error("inspection evidence identity disagrees with its columns");
  }
  return evidence;
}

export class InspectionRepository {
  constructor(private readonly database: BenchDatabase) {}

  getPreview(id: string, actor: string): InspectionCompletionPreview | undefined {
    const row = this.database.get<SqliteRow>("SELECT * FROM inspection_previews WHERE id = ? AND actor = ?", [id, actor]);
    return row === undefined ? undefined : clone(previewFromRow(row));
  }

  savePreview(preview: InspectionCompletionPreview): InspectionCompletionPreview {
    const parsed = inspectionCompletionPreviewSchema.parse(preview);
    this.database.run(
      `INSERT INTO inspection_previews
       (id, actor, project_revision_id, action_id, version, content_sha256, payload_json, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [parsed.id, parsed.actor, parsed.projectRevisionId, parsed.actionId, parsed.version, parsed.contentSha256, JSON.stringify(parsed), parsed.createdAt, parsed.expiresAt]
    );
    return clone(parsed);
  }

  appendEvidence(evidence: InspectionEvidence): InspectionEvidence {
    const parsed = inspectionEvidenceSchema.parse(evidence);
    this.database.run(
      `INSERT INTO inspection_evidence
       (id, project_revision_id, action_id, item_id, kind, result, payload_json, recorded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [parsed.id, parsed.projectRevisionId, parsed.actionId, parsed.itemId, parsed.kind, parsed.result, JSON.stringify(parsed), parsed.recordedAt]
    );
    return clone(parsed);
  }

  listEvidence(projectRevisionId: string): readonly InspectionEvidence[] {
    return this.database.all<SqliteRow>("SELECT * FROM inspection_evidence WHERE project_revision_id = ? ORDER BY recorded_at, id", [projectRevisionId]).map(evidenceFromRow).map(clone);
  }
}
