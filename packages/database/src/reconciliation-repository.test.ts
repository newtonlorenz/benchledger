import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { reconciliationCommitSchema, reconciliationDraftSchema, type ReconciliationCommit, type ReconciliationDraft } from "@benchledger/api-contract";
import { BenchDatabase } from "./index.js";
import { ReconciliationRepository } from "./reconciliation-repository.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function draftFixture(): ReconciliationDraft {
  return reconciliationDraftSchema.parse({
    id: "legacy-reconciliation-draft",
    projectId: "legacy-reconciliation-project",
    projectRevisionId: "legacy-reconciliation-revision",
    status: "draft",
    version: 1,
    lines: [
      { bomLineId: "legacy-set-line", outcomes: [{ reservationId: "legacy-set-reservation", itemId: "legacy-set-item", kind: "consumed", quantity: 1, unit: "set", evidence: { state: "physically_counted" } }] },
      { bomLineId: "legacy-empty-line", outcomes: [{ kind: "reviewed_no_change", quantity: 0, unit: "gram", evidence: { state: "physically_counted" } }] }
    ],
    basis: {
      hash: "a".repeat(64),
      bomLines: [
        { bomLineId: "legacy-set-line", version: 1, requiredQuantity: 1, unit: "each" },
        { bomLineId: "legacy-empty-line", version: 1, requiredQuantity: 1, unit: "gram" }
      ],
      reservations: [{ reservationId: "legacy-set-reservation", lineId: "legacy-set-line", itemId: "legacy-set-item", quantity: 1, unit: "set", status: "active", version: 1 }],
      items: [{ itemId: "legacy-set-item", version: 1, onHand: 1, allocated: 1, available: 0, unit: "set" }]
    },
    preview: {
      lines: [
        { bomLineId: "legacy-set-line", reservedQuantity: 1, accountedQuantity: 0, unaccountedQuantity: 1, outcomeCount: 1, unit: "set" },
        { bomLineId: "legacy-empty-line", reservedQuantity: 0, accountedQuantity: 0, unaccountedQuantity: 0, outcomeCount: 1, unit: "gram" }
      ],
      reservationChanges: [],
      stockChanges: [],
      createdAssets: []
    },
    createdAt: "2026-09-02T00:00:00.000Z",
    updatedAt: "2026-09-02T00:00:00.000Z"
  });
}

function commitFixture(draft: ReconciliationDraft): ReconciliationCommit {
  return reconciliationCommitSchema.parse({
    id: "legacy-reconciliation-commit",
    projectId: draft.projectId,
    projectRevisionId: draft.projectRevisionId,
    draftId: draft.id,
    status: "committed",
    basis: draft.basis,
    lines: draft.lines,
    stockChanges: [],
    reservationChanges: [],
    createdAssets: [],
    committedAt: "2026-09-02T00:01:00.000Z"
  });
}

function insertDraft(database: BenchDatabase, draft: ReconciliationDraft, payload: unknown): void {
  database.run(
    `INSERT INTO reconciliation_drafts
     (id, project_id, project_revision_id, status, version, basis_hash, payload_json, created_at, updated_at, committed_at, commit_id, audit_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [draft.id, draft.projectId, draft.projectRevisionId, draft.status, draft.version, draft.basis.hash, JSON.stringify(payload), draft.createdAt, draft.updatedAt, draft.committedAt ?? null, draft.commitId ?? null, draft.auditId ?? null]
  );
}

function seedProject(database: BenchDatabase, draft: ReconciliationDraft): void {
  database.run(
    `INSERT INTO projects (id, name, slug, status, visibility, created_at, updated_at)
     VALUES (?, ?, ?, 'planned', 'private', ?, ?)`,
    [draft.projectId, "Legacy reconciliation project", draft.projectId, draft.createdAt, draft.updatedAt]
  );
  database.run(
    `INSERT INTO project_revisions (id, project_id, revision_number, label, status, created_at)
     VALUES (?, ?, 1, 'Initial', 'concept', ?)`,
    [draft.projectRevisionId, draft.projectId, draft.createdAt]
  );
}

function insertCommit(database: BenchDatabase, commit: ReconciliationCommit): void {
  database.run(
    `INSERT INTO reconciliation_commits
     (id, draft_id, project_id, project_revision_id, basis_hash, payload_json, committed_at, audit_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [commit.id, commit.draftId, commit.projectId, commit.projectRevisionId, commit.basis.hash, JSON.stringify(commit), commit.committedAt, commit.auditId ?? null]
  );
}

describe("ReconciliationRepository legacy preview compatibility", () => {
  it("derives missing preview units from basis reservations or the BOM line after restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "benchledger-reconciliation-repository-"));
    directories.push(directory);
    const draft = draftFixture();
    const legacyPayload = structuredClone(draft) as unknown as Record<string, unknown>;
    const preview = structuredClone(draft.preview) as unknown as Record<string, unknown>;
    const previewLines = structuredClone(draft.preview.lines) as unknown as Array<Record<string, unknown>>;
    for (const line of previewLines) delete line.unit;
    preview.lines = previewLines;
    legacyPayload.preview = preview;

    const first = new BenchDatabase(join(directory, "benchledger.db"));
    seedProject(first, draft);
    insertDraft(first, draft, legacyPayload);
    insertCommit(first, commitFixture(draft));
    first.close();

    const second = new BenchDatabase(join(directory, "benchledger.db"));
    const repository = new ReconciliationRepository(second);
    expect(repository.getDraftByRevision(draft.projectRevisionId)?.preview.lines).toMatchObject([
      { bomLineId: "legacy-set-line", unit: "set" },
      { bomLineId: "legacy-empty-line", unit: "gram" }
    ]);
    expect(repository.getCommitByRevision(draft.projectRevisionId)?.id).toBe("legacy-reconciliation-commit");
    second.close();
  });

  it("fails closed when legacy active reservations use mixed units", () => {
    const database = new BenchDatabase(":memory:");
    const draft = draftFixture();
    seedProject(database, draft);
    const mixedDraft = structuredClone(draft) as unknown as Record<string, unknown>;
    const basis = structuredClone(draft.basis) as unknown as Record<string, unknown>;
    basis.reservations = [
      ...(draft.basis.reservations),
      { reservationId: "legacy-each-reservation", lineId: "legacy-set-line", itemId: "legacy-each-item", quantity: 1, unit: "each", status: "active", version: 1 }
    ];
    basis.items = [
      ...(draft.basis.items),
      { itemId: "legacy-each-item", version: 1, onHand: 1, allocated: 1, available: 0, unit: "each" }
    ];
    mixedDraft.basis = basis;
    const preview = structuredClone(draft.preview) as unknown as Record<string, unknown>;
    const previewLines = structuredClone(draft.preview.lines) as unknown as Array<Record<string, unknown>>;
    delete previewLines[0]!.unit;
    preview.lines = previewLines;
    mixedDraft.preview = preview;
    insertDraft(database, draft, mixedDraft);
    const repository = new ReconciliationRepository(database);

    expect(() => repository.getDraft(draft.id)).toThrow(/mixed active reservation units/i);
    database.close();
  });
});
