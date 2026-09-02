import { projectSetupPreviewSchema, type ProjectSetupPreview } from "@benchledger/api-contract";
import type { BenchDatabase, SqliteRow } from "./sqlite.js";

/** Durable actor-owned preview metadata. The payload is validated on both
 * writes and reads so a malformed row cannot become a commit basis. */
export class ProjectSetupRepository {
  constructor(private readonly database: BenchDatabase) {}

  save(preview: ProjectSetupPreview, actor: string): ProjectSetupPreview {
    const value = projectSetupPreviewSchema.parse(preview);
    this.database.run(
      "INSERT INTO project_setup_previews (id, actor, version, status, created_at, updated_at, expires_at, content_sha256, payload_json, correlation_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [value.id, actor, value.version, value.status, value.createdAt, value.updatedAt, value.expiresAt, value.contentSha256, JSON.stringify(value), value.correlationId]
    );
    return value;
  }

  get(id: string, actor: string): ProjectSetupPreview | null {
    const row = this.database.get<SqliteRow>("SELECT payload_json FROM project_setup_previews WHERE id = ? AND actor = ?", [id, actor]);
    if (typeof row?.payload_json !== "string") return null;
    try {
      return projectSetupPreviewSchema.parse(JSON.parse(row.payload_json) as unknown);
    } catch {
      return null;
    }
  }

  markCommitted(id: string, actor: string, updatedAt: string): ProjectSetupPreview {
    const current = this.get(id, actor);
    if (current === null) throw new Error("project setup preview not found");
    const committed = projectSetupPreviewSchema.parse({ ...current, status: "committed", version: current.version + 1, updatedAt });
    this.database.run("UPDATE project_setup_previews SET status = ?, version = ?, updated_at = ?, payload_json = ? WHERE id = ? AND actor = ?", [committed.status, committed.version, committed.updatedAt, JSON.stringify(committed), id, actor]);
    return committed;
  }
}
