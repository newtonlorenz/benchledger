import type { MakerWorkflowPort } from "@benchledger/application";
import type { WorkflowKind, WorkflowRecord } from "@benchledger/api-contract";
import { MakerWorkflowRepository } from "@benchledger/database";
import { attempt } from "./utils.js";
export class ProductionMakerWorkflowAdapter implements MakerWorkflowPort {
  constructor(private readonly repository: MakerWorkflowRepository) {}
  get(kind: WorkflowKind, id: string) { return attempt(() => this.repository.get(kind, id)); }
  list(kind: WorkflowKind, projectId: string, options: { revisionId?: string; limit: number; cursor?: string }) { return attempt(() => this.repository.list(kind, projectId, options)); }
  put(record: WorkflowRecord, expectedVersion: number) { return attempt(() => this.repository.put(record, expectedVersion)); }
  history(kind: WorkflowKind, id: string, limit: number, cursor?: string) { return attempt(() => this.repository.history(kind, id, limit, cursor)); }
}
