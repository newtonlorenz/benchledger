import type { WorkflowRecord, WorkflowKind } from "@benchledger/api-contract";
import { ApplicationError } from "@benchledger/application";
import type { MakerWorkflowPort } from "@benchledger/application";
export class MemoryMakerWorkflows implements MakerWorkflowPort {
  private records = new Map<string, WorkflowRecord>();
  private versions = new Map<string, WorkflowRecord[]>();
  snapshot() { const records = structuredClone(this.records), versions = structuredClone(this.versions); return () => { this.records = records; this.versions = versions; }; }
  async get(kind: WorkflowKind, id: string) { return structuredClone(this.records.get(`${kind}:${id}`) ?? null); }
  async list(kind: WorkflowKind, projectId: string, options: { revisionId?: string; limit: number; cursor?: string }) {
    const rows = [...this.records.values()].filter((entry) => entry.kind === kind && entry.projectId === projectId && (options.revisionId === undefined || entry.revisionId === options.revisionId)).sort((a,b) => a.id.localeCompare(b.id));
    const offset = Number(options.cursor ?? 0); return { data: structuredClone(rows.slice(offset, offset + options.limit)), limit: options.limit, ...(offset + options.limit < rows.length ? { nextCursor: String(offset + options.limit) } : {}) };
  }
  async put(record: WorkflowRecord, expectedVersion: number) {
    const key = `${record.kind}:${record.id}`, prior = this.records.get(key);
    if ((prior?.version ?? 0) !== expectedVersion || record.version !== expectedVersion + 1) throw new ApplicationError("conflict", "This workflow changed. Refresh its current version before saving.");
    if (prior && (prior.projectId !== record.projectId || prior.revisionId !== record.revisionId)) throw new ApplicationError("integrity_error", "Workflow ancestry cannot be changed");
    this.records.set(key, structuredClone(record)); this.versions.set(key, [...this.versions.get(key) ?? [], structuredClone(record)]); return structuredClone(record);
  }
  async history(kind: WorkflowKind, id: string, limit: number, cursor?: string) { const rows = [...this.versions.get(`${kind}:${id}`) ?? []].reverse(), offset = Number(cursor ?? 0); return { data: structuredClone(rows.slice(offset, offset + limit)), limit, ...(offset + limit < rows.length ? { nextCursor: String(offset + limit) } : {}) }; }
}
